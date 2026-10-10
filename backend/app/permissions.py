from typing import Any, Dict, Optional, Tuple


async def check_permission(
    tx: Any,
    group: Optional[Dict[str, Any]],
    actor_id: str,
    entity_type: str,
    operation: str,
    entity_uid: str,
) -> Tuple[bool, Optional[str]]:
    """Server-authoritative permission validation against the group row and actor identity."""
    # Creating a group makes the actor its creator
    if entity_type == "group" and operation == "create":
        return True, None

    if not group or group.get("is_deleted"):
        return False, "Group not found or deleted"

    # Group creator has full permissions in all models
    if group.get("creator_id") == actor_id:
        return True, None

    # Modifying group details (name, settings, currency, delete) is always restricted to creator
    if entity_type == "group":
        return False, "Only the group creator can modify group settings or delete the group"

    model = str(group.get("permission_model") or "COLLABORATIVE").upper()

    async def is_author() -> bool:
        row = await tx.fetch_one(
            "SELECT author_id FROM transactions WHERE tx_uid = $1 AND group_uid = $2",
            [entity_uid, group["uid"]],
        )
        return bool(row and row.get("author_id") == actor_id)

    # 1. ADMIN_ONLY: Only group creator can create/update/delete any entity
    if model == "ADMIN_ONLY":
        return False, "This group is ADMIN_ONLY: only the admin can add, edit, or delete records"

    # 2. CONTRIBUTOR: Non-admin can create transactions and edit/delete their own transactions
    if model == "CONTRIBUTOR":
        if entity_type == "transaction":
            if operation == "create" or (await is_author()):
                return True, None
            return False, "In CONTRIBUTOR mode, you can only modify or delete your own transactions"
        if entity_type == "member":
            if operation == "create":
                return False, "Only the group creator can add members in CONTRIBUTOR mode"
            return False, "Only the group creator can modify or remove members in CONTRIBUTOR mode"
        return False, "Only the group creator can modify this entity in CONTRIBUTOR mode"

    # 3. COLLABORATIVE: Any member can create/edit transactions; only author/creator can delete
    if entity_type == "transaction":
        if operation != "delete" or (await is_author()):
            return True, None
        return False, "Only the author or group creator can delete this transaction"

    if operation == "delete":
        return False, "Only the group creator can delete members"

    return True, None
