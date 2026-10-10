import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_admin_only_permission_model(client: AsyncClient):
    group_uid = "grp_admin_only"
    admin_id = "user_admin"
    peer_id = "user_peer"

    # Create ADMIN_ONLY group by admin
    await client.post(
        "/sync/push",
        json={
            "groupUid": group_uid,
            "deviceId": "dev_1",
            "actorId": admin_id,
            "mutations": [
                {
                    "clientMutationId": "m_1",
                    "entityType": "group",
                    "entityUid": group_uid,
                    "operation": "create",
                    "expectedVersion": 0,
                    "payload": {"name": "Admin Only Group", "permissionModel": "ADMIN_ONLY"},
                }
            ],
        },
    )

    # Peer tries to add an expense -> REJECTED UNAUTHORIZED
    peer_tx_res = await client.post(
        "/sync/push",
        json={
            "groupUid": group_uid,
            "deviceId": "dev_2",
            "actorId": peer_id,
            "mutations": [
                {
                    "clientMutationId": "m_peer_tx",
                    "entityType": "transaction",
                    "entityUid": "tx_peer_1",
                    "operation": "create",
                    "expectedVersion": 0,
                    "payload": {
                        "title": "Unauthorized Expense",
                        "amount": 1000,
                        "paidByName": "Peer",
                        "splits": [{"memberName": "Peer", "share": 1000}],
                    },
                }
            ],
        },
    )
    result = peer_tx_res.json()["results"][0]
    assert result["status"] == "REJECTED"
    assert result["error"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_contributor_permission_model(client: AsyncClient):
    group_uid = "grp_contributor"
    admin_id = "user_admin"
    peer_alice = "user_alice"
    peer_bob = "user_bob"

    # 1. Create CONTRIBUTOR group
    await client.post(
        "/sync/push",
        json={
            "groupUid": group_uid,
            "deviceId": "dev_1",
            "actorId": admin_id,
            "mutations": [
                {
                    "clientMutationId": "m_1",
                    "entityType": "group",
                    "entityUid": group_uid,
                    "operation": "create",
                    "expectedVersion": 0,
                    "payload": {"name": "Contrib Group", "permissionModel": "CONTRIBUTOR"},
                },
                {
                    "clientMutationId": "m_m1",
                    "entityType": "member",
                    "entityUid": "mem_alice",
                    "operation": "create",
                    "expectedVersion": 0,
                    "payload": {"name": "Alice"},
                },
                {
                    "clientMutationId": "m_m2",
                    "entityType": "member",
                    "entityUid": "mem_bob",
                    "operation": "create",
                    "expectedVersion": 0,
                    "payload": {"name": "Bob"},
                },
            ],
        },
    )

    # 2. Peer Alice adds an expense -> ACCEPTED
    alice_tx_res = await client.post(
        "/sync/push",
        json={
            "groupUid": group_uid,
            "deviceId": "dev_2",
            "actorId": peer_alice,
            "mutations": [
                {
                    "clientMutationId": "m_tx_alice",
                    "entityType": "transaction",
                    "entityUid": "tx_alice_1",
                    "operation": "create",
                    "expectedVersion": 0,
                    "payload": {
                        "title": "Alice Coffee",
                        "amount": 500,
                        "paidByMemberUid": "mem_alice",
                        "splits": [{"memberUid": "mem_alice", "share": 500}],
                    },
                }
            ],
        },
    )
    assert alice_tx_res.json()["results"][0]["status"] == "ACCEPTED"

    # 3. Peer Bob tries to edit Alice's expense -> REJECTED UNAUTHORIZED
    bob_edit_res = await client.post(
        "/sync/push",
        json={
            "groupUid": group_uid,
            "deviceId": "dev_3",
            "actorId": peer_bob,
            "mutations": [
                {
                    "clientMutationId": "m_bob_edit",
                    "entityType": "transaction",
                    "entityUid": "tx_alice_1",
                    "operation": "update",
                    "expectedVersion": 1,
                    "payload": {
                        "title": "Hacked Title",
                        "amount": 500,
                    },
                }
            ],
        },
    )
    assert bob_edit_res.json()["results"][0]["status"] == "REJECTED"
    assert bob_edit_res.json()["results"][0]["error"] == "UNAUTHORIZED"

    # 4. Peer Bob tries to add a member in CONTRIBUTOR mode -> REJECTED UNAUTHORIZED
    bob_add_mem = await client.post(
        "/sync/push",
        json={
            "groupUid": group_uid,
            "deviceId": "dev_3",
            "actorId": peer_bob,
            "mutations": [
                {
                    "clientMutationId": "m_bob_add_mem",
                    "entityType": "member",
                    "entityUid": "mem_charlie",
                    "operation": "create",
                    "expectedVersion": 0,
                    "payload": {"name": "Charlie"},
                }
            ],
        },
    )
    assert bob_add_mem.json()["results"][0]["status"] == "REJECTED"
    assert bob_add_mem.json()["results"][0]["error"] == "UNAUTHORIZED"

    # 5. Admin adds a member in CONTRIBUTOR mode -> ACCEPTED
    admin_add_mem = await client.post(
        "/sync/push",
        json={
            "groupUid": group_uid,
            "deviceId": "dev_1",
            "actorId": admin_id,
            "mutations": [
                {
                    "clientMutationId": "m_admin_add_mem",
                    "entityType": "member",
                    "entityUid": "mem_charlie",
                    "operation": "create",
                    "expectedVersion": 0,
                    "payload": {"name": "Charlie"},
                }
            ],
        },
    )
    assert admin_add_mem.json()["results"][0]["status"] == "ACCEPTED"
