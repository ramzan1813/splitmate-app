"""Errors and group visibility must match the relay, because phones act on the error code."""
import pytest
from httpx import AsyncClient


async def _push(client: AsyncClient, group_uid: str, mutations):
    res = await client.post(
        "/sync/push",
        json={"groupUid": group_uid, "deviceId": "dev_1", "actorId": "user_a", "actorName": "Alice", "mutations": mutations},
    )
    assert res.status_code == 200
    assert all(r["status"] == "ACCEPTED" for r in res.json()["results"]), res.json()


async def _group_with_expense(client: AsyncClient, group_uid: str):
    await _push(client, group_uid, [
        {"clientMutationId": f"{group_uid}_g", "entityType": "group", "entityUid": group_uid, "operation": "create",
         "payload": {"uid": group_uid, "name": "G", "currency": "USD", "permissionModel": "COLLABORATIVE"}},
        {"clientMutationId": f"{group_uid}_m1", "entityType": "member", "entityUid": f"{group_uid}_a", "operation": "create", "payload": {"name": "Alice"}},
        {"clientMutationId": f"{group_uid}_m2", "entityType": "member", "entityUid": f"{group_uid}_b", "operation": "create", "payload": {"name": "Bob"}},
        {"clientMutationId": f"{group_uid}_t1", "entityType": "transaction", "entityUid": f"{group_uid}_t1", "operation": "create",
         "payload": {"type": "expense", "title": "Dinner", "amount": 1000, "paidByMemberUid": f"{group_uid}_a", "splitType": "equal",
                     "date": "2026-10-09", "splits": [{"memberUid": f"{group_uid}_a", "share": 500}, {"memberUid": f"{group_uid}_b", "share": 500}]}},
    ])


@pytest.mark.asyncio
async def test_cursor_ahead_uses_relay_error_body(client: AsyncClient):
    await _group_with_expense(client, "grp_ahead")
    res = await client.get("/sync/changes/grp_ahead", params={"after": 999})
    assert res.status_code == 409
    body = res.json()
    assert body["error"] == "CURSOR_AHEAD", body
    assert "detail" not in body
    assert "ahead" in body["message"]


@pytest.mark.asyncio
async def test_unknown_group_is_group_not_found(client: AsyncClient):
    for path in ("/sync/bootstrap/grp_never", "/sync/changes/grp_never"):
        res = await client.get(path)
        assert res.status_code == 404
        assert res.json()["error"] == "GROUP_NOT_FOUND"


@pytest.mark.asyncio
async def test_hidden_group_is_unavailable_not_deleted(client: AsyncClient, test_db):
    await _group_with_expense(client, "grp_hidden")
    await test_db.execute("UPDATE groups SET is_display = false WHERE uid = $1", ["grp_hidden"])
    for path in ("/sync/bootstrap/grp_hidden", "/sync/changes/grp_hidden"):
        res = await client.get(path)
        assert res.status_code == 404
        assert res.json()["error"] == "GROUP_UNAVAILABLE", "phones must not treat a hidden group as deleted"


@pytest.mark.asyncio
async def test_bootstrap_serves_only_live_rows(client: AsyncClient, test_db):
    await _group_with_expense(client, "grp_live")
    await _push(client, "grp_live", [
        {"clientMutationId": "grp_live_t2", "entityType": "transaction", "entityUid": "grp_live_t2", "operation": "create",
         "payload": {"type": "expense", "title": "Taxi", "amount": 400, "paidByMemberUid": "grp_live_b", "splitType": "equal",
                     "date": "2026-10-09", "splits": [{"memberUid": "grp_live_a", "share": 200}, {"memberUid": "grp_live_b", "share": 200}]}},
        {"clientMutationId": "grp_live_del", "entityType": "transaction", "entityUid": "grp_live_t2", "operation": "delete", "expectedVersion": 1, "payload": {}},
    ])
    snap = (await client.get("/sync/bootstrap/grp_live")).json()
    assert [t["uid"] for t in snap["transactions"]] == ["grp_live_t1"], "a deleted expense is not part of the snapshot"
    assert all(not t["isDeleted"] for t in snap["transactions"])
    # The delete is still delivered through the change feed.
    changes = (await client.get("/sync/changes/grp_live", params={"after": 0})).json()["changes"]
    assert any(c["entityUid"] == "grp_live_t2" and c["operation"] == "delete" for c in changes)


@pytest.mark.asyncio
async def test_deleted_group_is_group_not_found(client: AsyncClient, test_db):
    await _group_with_expense(client, "grp_gone")
    await test_db.execute("UPDATE groups SET is_deleted = true WHERE uid = $1", ["grp_gone"])
    res = await client.get("/sync/bootstrap/grp_gone")
    assert res.status_code == 404
    assert res.json()["error"] == "GROUP_NOT_FOUND"
