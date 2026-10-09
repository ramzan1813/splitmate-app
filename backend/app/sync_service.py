import uuid
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from app.db import Database, db
from app.permissions import check_permission
from app.schemas import (
    GroupBootstrapResponse,
    GroupSnapshot,
    MemberSnapshot,
    PullChangesResponse,
    PushMutation,
    PushMutationResult,
    PushMutationsRequest,
    PushMutationsResponse,
    ServerChange,
    SplitSnapshot,
    TransactionSnapshot,
)

logger = logging.getLogger("splitmate.sync")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def norm_name(name: Optional[str]) -> str:
    return (name or "").strip().lower()


def format_iso(val: Any) -> str:
    if isinstance(val, datetime):
        return val.isoformat()
    if isinstance(val, str):
        return val
    return now_iso()


class SyncService:
    def __init__(self, database: Database):
        self.db = database

    # --- 1. Bootstrap Snapshot ---
    async def get_group_bootstrap(self, group_uid: str) -> GroupBootstrapResponse:
        async with self.db.transaction() as tx:
            group = await tx.fetch_one(
                "SELECT * FROM visible_groups WHERE uid = $1",
                [group_uid],
            )
            if not group:
                raise HTTPException(status_code=404, detail={"error": "GROUP_NOT_FOUND", "message": "Group not found or deleted"})

            members_rows = await tx.fetch_all(
                "SELECT * FROM visible_members WHERE group_uid = $1 ORDER BY id ASC",
                [group_uid],
            )
            members = [
                MemberSnapshot(
                    id=m.get("id"),
                    uid=m["member_uid"],
                    memberUid=m["member_uid"],
                    name=m["name"],
                    userId=m.get("user_id"),
                    role=m.get("role", "MEMBER"),
                    isMe=False,
                    serverVersion=m.get("server_version", 1),
                    isDeleted=bool(m.get("is_deleted", False)),
                )
                for m in members_rows
            ]

            member_id_map = {m["member_uid"]: m.get("id", 0) for m in members_rows}

            tx_rows = await tx.fetch_all(
                "SELECT * FROM visible_transactions WHERE group_uid = $1 ORDER BY date DESC, id DESC",
                [group_uid],
            )

            splits_rows = await tx.fetch_all(
                "SELECT * FROM visible_splits WHERE transaction_uid IN ("
                "  SELECT tx_uid FROM visible_transactions WHERE group_uid = $1"
                ")",
                [group_uid],
            )
            splits_by_tx: Dict[str, List[SplitSnapshot]] = {}
            for s in splits_rows:
                tx_uid = s["transaction_uid"]
                if tx_uid not in splits_by_tx:
                    splits_by_tx[tx_uid] = []
                splits_by_tx[tx_uid].append(
                    SplitSnapshot(
                        memberUid=s["member_uid"],
                        memberName=s.get("member_name"),
                        value=float(s.get("value", 1.0)),
                        share=int(s.get("share", 0)),
                    )
                )

            transactions = [
                TransactionSnapshot(
                    id=t.get("id"),
                    uid=t["tx_uid"],
                    groupId=group.get("id"),
                    type=t.get("type", "expense"),
                    title=t["title"],
                    amount=int(t["amount"]),
                    paidBy=member_id_map.get(t["paid_by_member_uid"], 0),
                    paidByMemberUid=t["paid_by_member_uid"],
                    splitType=t.get("split_type", "equal"),
                    category=t.get("category", "General"),
                    note=t.get("note", ""),
                    date=str(t["date"]),
                    authorId=t["author_id"],
                    authorName=t["author_name"],
                    updatedById=t.get("updated_by_id"),
                    updatedByName=t.get("updated_by_name"),
                    updatedTs=t.get("updated_ts", 0),
                    createdTs=t.get("created_ts"),
                    serverVersion=t.get("server_version", 1),
                    isDeleted=bool(t.get("is_deleted", False)),
                    createdAt=format_iso(t.get("created_at")),
                    updatedAt=format_iso(t.get("updated_at")),
                    splits=splits_by_tx.get(t["tx_uid"], []),
                )
                for t in tx_rows
            ]

            return GroupBootstrapResponse(
                groupUid=group["uid"],
                serverSequence=int(group.get("last_sequence", 0)),
                group=GroupSnapshot(
                    id=group.get("id"),
                    uid=group["uid"],
                    name=group["name"],
                    description=group.get("description", ""),
                    currency=group.get("currency", "USD"),
                    permissionModel=str(group.get("permission_model", "collaborative")).lower(),
                    creatorId=group["creator_id"],
                    creatorName=group["creator_name"],
                    serverVersion=group.get("server_version", 1),
                    isDeleted=bool(group.get("is_deleted", False)),
                    createdAt=format_iso(group.get("created_at")),
                    updatedAt=format_iso(group.get("updated_at")),
                ),
                members=members,
                transactions=transactions,
            )

    # --- 2. Delta Changes Pull ---
    async def get_changes_since(self, group_uid: str, after: int = 0, limit: int = 100) -> PullChangesResponse:
        safe_limit = min(max(1, limit), 500)
        after_seq = max(0, after)

        async with self.db.transaction() as tx:
            group = await tx.fetch_one(
                "SELECT last_sequence FROM visible_groups WHERE uid = $1",
                [group_uid],
            )
            if not group:
                raise HTTPException(status_code=404, detail={"error": "GROUP_NOT_FOUND", "message": "Group not found"})

            last_sequence = int(group.get("last_sequence", 0))
            if after_seq > last_sequence:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "CURSOR_AHEAD",
                        "message": f"Cursor {after_seq} is ahead of server sequence {last_sequence}; re-bootstrap required",
                    },
                )

            rows = await tx.fetch_all(
                "SELECT * FROM visible_changes WHERE group_uid = $1 AND sequence > $2 AND sequence <= $3 "
                "ORDER BY sequence ASC LIMIT $4",
                [group_uid, after_seq, last_sequence, safe_limit + 1],
            )

            has_more = len(rows) > safe_limit
            page = rows[:safe_limit] if has_more else rows

            changes = [
                ServerChange(
                    sequence=int(r["sequence"]),
                    changeId=r["change_id"],
                    groupUid=r["group_uid"],
                    entityType=r["entity_type"],
                    entityUid=r["entity_uid"],
                    operation=r["operation"],
                    actorId=r["actor_id"],
                    deviceId=r["device_id"],
                    entityVersion=int(r["entity_version"]),
                    payload=r.get("payload") if isinstance(r.get("payload"), dict) else json.loads(r.get("payload", "{}")),
                    createdAt=format_iso(r.get("created_at")),
                )
                for r in page
            ]

            latest_sequence = changes[-1].sequence if (has_more and changes) else last_sequence
            return PullChangesResponse(
                groupUid=group_uid,
                latestServerSequence=latest_sequence,
                hasMore=has_more,
                changes=changes,
            )

    # --- 3. Push Outbox Mutations ---
    async def process_push_mutations(self, req: PushMutationsRequest) -> PushMutationsResponse:
        results: List[PushMutationResult] = []
        actor_id = req.actorId or "anonymous"
        actor_name = req.actorName or "Anonymous"

        # Record device presence
        await self._touch_device(req.groupUid, req.deviceId, actor_id, actor_name)

        for mut in req.mutations:
            res = await self._process_single_mutation(req.groupUid, req.deviceId, actor_id, actor_name, mut)
            results.append(res)

        return PushMutationsResponse(groupUid=req.groupUid, results=results)

    async def _touch_device(self, group_uid: str, device_id: str, actor_id: str, actor_name: str):
        try:
            async with self.db.transaction() as tx:
                await tx.execute(
                    "INSERT INTO devices (device_id, user_id, user_name, last_seen_at) "
                    "VALUES ($1, $2, $3, CURRENT_TIMESTAMP) "
                    "ON CONFLICT (device_id) DO UPDATE SET user_id = $2, user_name = $3, last_seen_at = CURRENT_TIMESTAMP",
                    [device_id, actor_id, actor_name],
                )
                await tx.execute(
                    "INSERT INTO sync_users (user_id, user_name) VALUES ($1, $2) "
                    "ON CONFLICT (user_id) DO UPDATE SET user_name = $2, updated_at = CURRENT_TIMESTAMP",
                    [actor_id, actor_name],
                )
        except Exception:
            pass

    async def _process_single_mutation(
        self,
        group_uid: str,
        device_id: str,
        actor_id: str,
        actor_name: str,
        mut: PushMutation,
    ) -> PushMutationResult:
        # Check idempotency ledger
        existing_mut = await self.db.fetch_one(
            "SELECT * FROM client_mutations WHERE client_mutation_id = $1",
            [mut.clientMutationId],
        )
        if existing_mut:
            resp = existing_mut.get("response")
            if isinstance(resp, str):
                resp = json.loads(resp)
            return PushMutationResult(
                clientMutationId=mut.clientMutationId,
                status=existing_mut["status"],
                entityUid=resp.get("entityUid", mut.entityUid),
                serverVersion=resp.get("serverVersion"),
                serverSequence=resp.get("serverSequence"),
                error=resp.get("error"),
                message=resp.get("message"),
            )

        async with self.db.transaction() as tx:
            group = await tx.fetch_one("SELECT * FROM groups WHERE uid = $1", [group_uid])

            # Authorization Check
            allowed, reason = await check_permission(
                tx=tx,
                group=group,
                actor_id=actor_id,
                entity_type=mut.entityType,
                operation=mut.operation,
                entity_uid=mut.entityUid,
            )
            if not allowed:
                res = PushMutationResult(
                    clientMutationId=mut.clientMutationId,
                    status="REJECTED",
                    entityUid=mut.entityUid,
                    error="UNAUTHORIZED",
                    message=reason or "Unauthorized",
                )
                await self._record_outcome(tx, mut.clientMutationId, group_uid, actor_id, device_id, res)
                return res

            try:
                # Dispatch entity handler
                if mut.entityType == "group":
                    v, s = await self._handle_group_mutation(tx, group_uid, actor_id, actor_name, device_id, mut, group)
                elif mut.entityType == "member":
                    v, s = await self._handle_member_mutation(tx, group_uid, actor_id, actor_name, device_id, mut, group)
                elif mut.entityType == "transaction":
                    v, s = await self._handle_transaction_mutation(tx, group_uid, actor_id, actor_name, device_id, mut, group)
                else:
                    raise ValueError(f"Unknown entity type: {mut.entityType}")

                res = PushMutationResult(
                    clientMutationId=mut.clientMutationId,
                    status="ACCEPTED",
                    entityUid=mut.entityUid,
                    serverVersion=v,
                    serverSequence=s,
                )
                await self._record_outcome(tx, mut.clientMutationId, group_uid, actor_id, device_id, res)
                return res

            except ConcurrencyError as e:
                res = PushMutationResult(
                    clientMutationId=mut.clientMutationId,
                    status="CONFLICT",
                    entityUid=mut.entityUid,
                    serverVersion=e.server_version,
                    error=e.code,
                    message=e.message,
                )
                await self._record_outcome(tx, mut.clientMutationId, group_uid, actor_id, device_id, res)
                return res

            except ValidationError as e:
                res = PushMutationResult(
                    clientMutationId=mut.clientMutationId,
                    status="REJECTED",
                    entityUid=mut.entityUid,
                    error=e.code,
                    message=e.message,
                )
                await self._record_outcome(tx, mut.clientMutationId, group_uid, actor_id, device_id, res)
                return res

    async def _record_outcome(self, tx: Any, mutation_id: str, group_uid: str, actor_id: str, device_id: str, res: PushMutationResult):
        await tx.execute(
            "INSERT INTO client_mutations (client_mutation_id, group_uid, actor_id, device_id, status, response, created_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) "
            "ON CONFLICT (client_mutation_id) DO NOTHING",
            [mutation_id, group_uid, actor_id, device_id, res.status, res.model_dump(exclude_none=True)],
        )

    async def _append_change(
        self,
        tx: Any,
        group_uid: str,
        actor_id: str,
        device_id: str,
        entity_type: str,
        entity_uid: str,
        operation: str,
        entity_version: int,
        payload: Dict[str, Any],
    ) -> int:
        await tx.execute(
            "UPDATE groups SET last_sequence = last_sequence + 1, updated_at = CURRENT_TIMESTAMP WHERE uid = $1",
            [group_uid],
        )
        group = await tx.fetch_one("SELECT last_sequence FROM groups WHERE uid = $1", [group_uid])
        seq = int(group["last_sequence"])
        change_id = f"chg_{uuid.uuid4().hex}"

        await tx.execute(
            "INSERT INTO sync_changes (group_uid, sequence, change_id, entity_type, entity_uid, operation, actor_id, device_id, entity_version, payload, created_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)",
            [group_uid, seq, change_id, entity_type, entity_uid, operation, actor_id, device_id, entity_version, payload],
        )
        return seq

    # --- Entity Handlers ---
    async def _handle_group_mutation(
        self, tx: Any, group_uid: str, actor_id: str, actor_name: str, device_id: str, mut: PushMutation, group: Optional[Dict[str, Any]]
    ) -> Tuple[int, int]:
        p = mut.payload or {}
        if mut.operation == "create":
            if group:
                raise ConcurrencyError("ALREADY_EXISTS", "Group with this uid already exists", group.get("server_version", 1))
            name = (p.get("name") or "New Group").strip()
            desc = p.get("description", "")
            currency = p.get("currency", "USD")
            model = str(p.get("permissionModel") or "COLLABORATIVE").upper()

            await tx.execute(
                "INSERT INTO groups (uid, name, description, currency, permission_model, creator_id, creator_name, server_version, last_sequence, is_deleted, created_at, updated_at) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 0, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                [group_uid, name, desc, currency, model, actor_id, actor_name],
            )
            seq = await self._append_change(tx, group_uid, actor_id, device_id, "group", group_uid, "create", 1, p)
            return 1, seq

        if not group or group.get("is_deleted"):
            raise ConcurrencyError("GROUP_NOT_FOUND", "Group does not exist or was deleted", 0)

        curr_ver = int(group.get("server_version", 1))
        if mut.expectedVersion != curr_ver:
            raise ConcurrencyError("VERSION_MISMATCH", f"Expected version {mut.expectedVersion} but found {curr_ver}", curr_ver)

        next_ver = curr_ver + 1
        if mut.operation == "update":
            name = p.get("name", group["name"]).strip()
            desc = p.get("description", group["description"])
            currency = p.get("currency", group["currency"])
            model = str(p.get("permissionModel") or group["permission_model"]).upper()

            await tx.execute(
                "UPDATE groups SET name = $1, description = $2, currency = $3, permission_model = $4, server_version = $5, updated_at = CURRENT_TIMESTAMP WHERE uid = $6",
                [name, desc, currency, model, next_ver, group_uid],
            )
            seq = await self._append_change(tx, group_uid, actor_id, device_id, "group", group_uid, "update", next_ver, p)
            return next_ver, seq

        if mut.operation == "delete":
            await tx.execute(
                "UPDATE groups SET is_deleted = true, deleted_at = CURRENT_TIMESTAMP, server_version = $1, updated_at = CURRENT_TIMESTAMP WHERE uid = $2",
                [next_ver, group_uid],
            )
            seq = await self._append_change(tx, group_uid, actor_id, device_id, "group", group_uid, "delete", next_ver, p)
            return next_ver, seq

        raise ValidationError("INVALID_OPERATION", f"Unsupported group operation {mut.operation}")

    async def _handle_member_mutation(
        self, tx: Any, group_uid: str, actor_id: str, actor_name: str, device_id: str, mut: PushMutation, group: Optional[Dict[str, Any]]
    ) -> Tuple[int, int]:
        p = mut.payload or {}
        existing = await tx.fetch_one(
            "SELECT * FROM group_members WHERE member_uid = $1 AND group_uid = $2",
            [mut.entityUid, group_uid],
        )

        if mut.operation == "create":
            if existing and not existing.get("is_deleted"):
                raise ConcurrencyError("ALREADY_EXISTS", "Member already exists in this group", existing.get("server_version", 1))
            name = (p.get("name") or "Member").strip()
            # Deduplicate by name
            same_name = await tx.fetch_one(
                "SELECT * FROM group_members WHERE group_uid = $1 AND LOWER(TRIM(name)) = $2 AND is_deleted = false",
                [group_uid, norm_name(name)],
            )
            if same_name:
                raise ConcurrencyError("DUPLICATE_MEMBER_NAME", f"A member named '{name}' already exists in this group as {same_name['member_uid']}", same_name.get("server_version", 1))

            await tx.execute(
                "INSERT INTO group_members (member_uid, group_uid, name, user_id, role, server_version, is_deleted, created_at, updated_at) "
                "VALUES ($1, $2, $3, $4, 'MEMBER', 1, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                [mut.entityUid, group_uid, name, p.get("userId") or actor_id],
            )
            seq = await self._append_change(tx, group_uid, actor_id, device_id, "member", mut.entityUid, "create", 1, p)
            return 1, seq

        if not existing or existing.get("is_deleted"):
            raise ConcurrencyError("MEMBER_NOT_FOUND", "Member does not exist or was deleted", 0)

        curr_ver = int(existing.get("server_version", 1))
        if mut.expectedVersion != curr_ver:
            raise ConcurrencyError("VERSION_MISMATCH", f"Expected version {mut.expectedVersion} but found {curr_ver}", curr_ver)

        next_ver = curr_ver + 1
        if mut.operation == "update":
            name = (p.get("newName") or p.get("name") or existing["name"]).strip()
            await tx.execute(
                "UPDATE group_members SET name = $1, server_version = $2, updated_at = CURRENT_TIMESTAMP WHERE member_uid = $3",
                [name, next_ver, mut.entityUid],
            )
            seq = await self._append_change(tx, group_uid, actor_id, device_id, "member", mut.entityUid, "update", next_ver, p)
            return next_ver, seq

        if mut.operation == "delete":
            await tx.execute(
                "UPDATE group_members SET is_deleted = true, deleted_at = CURRENT_TIMESTAMP, server_version = $1, updated_at = CURRENT_TIMESTAMP WHERE member_uid = $2",
                [next_ver, mut.entityUid],
            )
            seq = await self._append_change(tx, group_uid, actor_id, device_id, "member", mut.entityUid, "delete", next_ver, p)
            return next_ver, seq

        raise ValidationError("INVALID_OPERATION", f"Unsupported member operation {mut.operation}")

    async def _handle_transaction_mutation(
        self, tx: Any, group_uid: str, actor_id: str, actor_name: str, device_id: str, mut: PushMutation, group: Optional[Dict[str, Any]]
    ) -> Tuple[int, int]:
        p = mut.payload or {}
        existing = await tx.fetch_one(
            "SELECT * FROM transactions WHERE tx_uid = $1 AND group_uid = $2",
            [mut.entityUid, group_uid],
        )

        if mut.operation == "create":
            if existing and not existing.get("is_deleted"):
                raise ConcurrencyError("ALREADY_EXISTS", "Transaction already exists", existing.get("server_version", 1))
            amount = int(p.get("amount", 0))
            if amount <= 0:
                raise ValidationError("INVALID_AMOUNT", "Transaction amount must be positive")

            # Resolve payer
            payer_uid = await self._resolve_member_uid(tx, group_uid, actor_id, p.get("paidByMemberUid"), p.get("paidByName"))
            splits_input = p.get("splits") or []
            if not splits_input:
                raise ValidationError("SPLITS_REQUIRED", "Transaction requires splits array")

            resolved_splits = await self._resolve_splits(tx, group_uid, actor_id, splits_input, amount)
            created_ts = p.get("createdTs") or p.get("updatedTs") or int(datetime.now(timezone.utc).timestamp() * 1000)

            await tx.execute(
                "INSERT INTO transactions (tx_uid, group_uid, type, title, amount, paid_by_member_uid, split_type, category, note, date, "
                "author_id, author_name, updated_by_id, updated_by_name, updated_ts, created_ts, server_version, is_deleted, created_at, updated_at) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 1, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                [
                    mut.entityUid,
                    group_uid,
                    p.get("type", "expense"),
                    (p.get("title") or "Expense").strip(),
                    amount,
                    payer_uid,
                    p.get("splitType", "equal"),
                    p.get("category", "General"),
                    p.get("note", ""),
                    p.get("date") or now_iso()[:10],
                    p.get("authorId") or actor_id,
                    p.get("authorName") or actor_name,
                    p.get("updatedById"),
                    p.get("updatedByName"),
                    p.get("updatedTs", 0),
                    created_ts,
                ],
            )
            for s in resolved_splits:
                await tx.execute(
                    "INSERT INTO transaction_splits (transaction_uid, member_uid, value, share) VALUES ($1, $2, $3, $4)",
                    [mut.entityUid, s["memberUid"], s.get("value", 1.0), s["share"]],
                )

            change_payload = dict(p)
            change_payload["paidByMemberUid"] = payer_uid
            change_payload["createdTs"] = created_ts
            change_payload["splits"] = resolved_splits
            seq = await self._append_change(tx, group_uid, actor_id, device_id, "transaction", mut.entityUid, "create", 1, change_payload)
            return 1, seq

        if not existing or existing.get("is_deleted"):
            raise ConcurrencyError("TRANSACTION_NOT_FOUND", "Transaction does not exist or was deleted", 0)

        curr_ver = int(existing.get("server_version", 1))
        if mut.expectedVersion != curr_ver:
            raise ConcurrencyError("VERSION_MISMATCH", f"Expected version {mut.expectedVersion} but found {curr_ver}", curr_ver)

        next_ver = curr_ver + 1
        if mut.operation == "update":
            amount = int(p.get("amount", existing["amount"]))
            payer_uid = (
                await self._resolve_member_uid(tx, group_uid, actor_id, p.get("paidByMemberUid"), p.get("paidByName"))
                if (p.get("paidByMemberUid") or p.get("paidByName"))
                else existing["paid_by_member_uid"]
            )
            splits_input = p.get("splits")
            resolved_splits = None
            if splits_input:
                resolved_splits = await self._resolve_splits(tx, group_uid, actor_id, splits_input, amount)
            elif amount != existing["amount"]:
                raise ValidationError("SPLITS_REQUIRED", "Changing transaction amount requires new splits")

            await tx.execute(
                "UPDATE transactions SET title = COALESCE($1, title), amount = $2, paid_by_member_uid = $3, split_type = COALESCE($4, split_type), "
                "category = COALESCE($5, category), note = COALESCE($6, note), date = COALESCE($7, date), updated_by_id = $8, updated_by_name = $9, "
                "updated_ts = $10, server_version = $11, updated_at = CURRENT_TIMESTAMP WHERE tx_uid = $12",
                [
                    p.get("title"),
                    amount,
                    payer_uid,
                    p.get("splitType"),
                    p.get("category"),
                    p.get("note"),
                    p.get("date"),
                    actor_id,
                    actor_name,
                    p.get("updatedTs", int(datetime.now(timezone.utc).timestamp() * 1000)),
                    next_ver,
                    mut.entityUid,
                ],
            )

            if resolved_splits:
                await tx.execute("DELETE FROM transaction_splits WHERE transaction_uid = $1", [mut.entityUid])
                for s in resolved_splits:
                    await tx.execute(
                        "INSERT INTO transaction_splits (transaction_uid, member_uid, value, share) VALUES ($1, $2, $3, $4)",
                        [mut.entityUid, s["memberUid"], s.get("value", 1.0), s["share"]],
                    )

            change_payload = dict(p)
            change_payload["paidByMemberUid"] = payer_uid
            change_payload["createdTs"] = existing.get("created_ts")
            if resolved_splits:
                change_payload["splits"] = resolved_splits

            seq = await self._append_change(tx, group_uid, actor_id, device_id, "transaction", mut.entityUid, "update", next_ver, change_payload)
            return next_ver, seq

        if mut.operation == "delete":
            await tx.execute(
                "UPDATE transactions SET is_deleted = true, deleted_at = CURRENT_TIMESTAMP, server_version = $1, updated_at = CURRENT_TIMESTAMP WHERE tx_uid = $2",
                [next_ver, mut.entityUid],
            )
            seq = await self._append_change(tx, group_uid, actor_id, device_id, "transaction", mut.entityUid, "delete", next_ver, p)
            return next_ver, seq

        raise ValidationError("INVALID_OPERATION", f"Unsupported transaction operation {mut.operation}")

    async def _resolve_member_uid(self, tx: Any, group_uid: str, actor_id: str, member_uid: Optional[str], member_name: Optional[str]) -> str:
        if member_uid:
            m = await tx.fetch_one("SELECT member_uid FROM group_members WHERE member_uid = $1 AND group_uid = $2", [member_uid, group_uid])
            if m:
                return m["member_uid"]
        if member_name:
            m = await tx.fetch_one(
                "SELECT member_uid FROM group_members WHERE group_uid = $1 AND LOWER(TRIM(name)) = $2 AND is_deleted = false",
                [group_uid, norm_name(member_name)],
            )
            if m:
                return m["member_uid"]
            # Auto-create member
            new_uid = f"mem_{uuid.uuid4().hex}"
            await tx.execute(
                "INSERT INTO group_members (member_uid, group_uid, name, user_id, role, server_version, is_deleted, created_at, updated_at) "
                "VALUES ($1, $2, $3, NULL, 'MEMBER', 1, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                [new_uid, group_uid, member_name.strip()],
            )
            return new_uid
        raise ValidationError("INVALID_MEMBER", "Payer member could not be resolved")

    async def _resolve_splits(self, tx: Any, group_uid: str, actor_id: str, splits: List[Dict[str, Any]], total_amount: int) -> List[Dict[str, Any]]:
        resolved = []
        total_shares = 0
        seen = set()
        for s in splits:
            m_uid = await self._resolve_member_uid(tx, group_uid, actor_id, s.get("memberUid"), s.get("memberName"))
            if m_uid in seen:
                raise ValidationError("DUPLICATE_SPLIT_MEMBER", "Member appears more than once in splits")
            seen.add(m_uid)
            share = int(s.get("share", 0))
            if share < 0:
                raise ValidationError("INVALID_SHARE", "Split share cannot be negative")
            total_shares += share
            resolved.append({
                "memberUid": m_uid,
                "memberName": s.get("memberName"),
                "value": float(s.get("value", 1.0)),
                "share": share,
            })

        if total_shares != total_amount:
            raise ValidationError("SPLIT_TOTAL_MISMATCH", f"Split shares sum ({total_shares}) must equal total amount ({total_amount})")
        return resolved


class ConcurrencyError(Exception):
    def __init__(self, code: str, message: str, server_version: int):
        self.code = code
        self.message = message
        self.server_version = server_version


class ValidationError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message


sync_service = SyncService(db)
