import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_full_sync_lifecycle(client: AsyncClient):
    group_uid = "grp_test_life"
    actor_id = "user_alice"
    device_id = "dev_phone_1"

    # 1. Create group and members via push
    push_req = {
        "groupUid": group_uid,
        "deviceId": device_id,
        "actorId": actor_id,
        "actorName": "Alice",
        "mutations": [
            {
                "clientMutationId": "m_grp_1",
                "entityType": "group",
                "entityUid": group_uid,
                "operation": "create",
                "expectedVersion": 0,
                "payload": {
                    "uid": group_uid,
                    "name": "Life Group",
                    "description": "Lifecycle Test",
                    "currency": "USD",
                    "permissionModel": "collaborative",
                },
            },
            {
                "clientMutationId": "m_mem_1",
                "entityType": "member",
                "entityUid": "mem_alice_1",
                "operation": "create",
                "expectedVersion": 0,
                "payload": {"name": "Alice", "isMe": True},
            },
            {
                "clientMutationId": "m_mem_2",
                "entityType": "member",
                "entityUid": "mem_bob_1",
                "operation": "create",
                "expectedVersion": 0,
                "payload": {"name": "Bob", "isMe": False},
            },
        ],
    }
    res = await client.post("/sync/push", json=push_req)
    assert res.status_code == 200
    push_data = res.json()
    assert len(push_data["results"]) == 3
    assert all(r["status"] == "ACCEPTED" for r in push_data["results"])

    # 2. Add an expense transaction
    tx_req = {
        "groupUid": group_uid,
        "deviceId": device_id,
        "actorId": actor_id,
        "actorName": "Alice",
        "mutations": [
            {
                "clientMutationId": "m_tx_1",
                "entityType": "transaction",
                "entityUid": "tx_dinner_1",
                "operation": "create",
                "expectedVersion": 0,
                "payload": {
                    "title": "Dinner",
                    "amount": 6000,
                    "paidByMemberUid": "mem_alice_1",
                    "splitType": "equal",
                    "category": "Food",
                    "date": "2026-10-08",
                    "splits": [
                        {"memberUid": "mem_alice_1", "value": 1, "share": 3000},
                        {"memberUid": "mem_bob_1", "value": 1, "share": 3000},
                    ],
                },
            }
        ],
    }
    tx_res = await client.post("/sync/push", json=tx_req)
    assert tx_res.status_code == 200
    assert tx_res.json()["results"][0]["status"] == "ACCEPTED"

    # 3. Bootstrap fetch
    boot_res = await client.get(f"/sync/bootstrap/{group_uid}")
    assert boot_res.status_code == 200
    boot_data = boot_res.json()
    assert boot_data["group"]["name"] == "Life Group"
    assert len(boot_data["members"]) == 2
    assert len(boot_data["transactions"]) == 1
    assert boot_data["transactions"][0]["title"] == "Dinner"
    assert boot_data["serverSequence"] == 4

    # 4. Incremental Delta pull
    delta_res = await client.get(f"/sync/changes/{group_uid}?after=0")
    assert delta_res.status_code == 200
    delta_data = delta_res.json()
    assert len(delta_data["changes"]) == 4
    assert delta_data["latestServerSequence"] == 4

    # Pulling after sequence 3 should only return the transaction change
    delta_after_3 = await client.get(f"/sync/changes/{group_uid}?after=3")
    assert len(delta_after_3.json()["changes"]) == 1
    assert delta_after_3.json()["changes"][0]["entityUid"] == "tx_dinner_1"


@pytest.mark.asyncio
async def test_optimistic_concurrency_rejection(client: AsyncClient):
    group_uid = "grp_concurrency"
    actor_id = "user_alice"

    # Create group
    await client.post(
        "/sync/push",
        json={
            "groupUid": group_uid,
            "deviceId": "dev_1",
            "actorId": actor_id,
            "mutations": [
                {
                    "clientMutationId": "m_c_1",
                    "entityType": "group",
                    "entityUid": group_uid,
                    "operation": "create",
                    "expectedVersion": 0,
                    "payload": {"name": "Concur Group"},
                }
            ],
        },
    )

    # Stale update with wrong expectedVersion (e.g. 5 instead of 1)
    stale_res = await client.post(
        "/sync/push",
        json={
            "groupUid": group_uid,
            "deviceId": "dev_1",
            "actorId": actor_id,
            "mutations": [
                {
                    "clientMutationId": "m_c_stale",
                    "entityType": "group",
                    "entityUid": group_uid,
                    "operation": "update",
                    "expectedVersion": 5,
                    "payload": {"name": "Stale Update"},
                }
            ],
        },
    )
    result = stale_res.json()["results"][0]
    assert result["status"] == "CONFLICT"
    assert result["error"] == "VERSION_MISMATCH"
    assert result["serverVersion"] == 1


@pytest.mark.asyncio
async def test_duplicate_mutation_idempotency(client: AsyncClient):
    group_uid = "grp_idempotency"
    mutation_req = {
        "groupUid": group_uid,
        "deviceId": "dev_1",
        "actorId": "user_alice",
        "mutations": [
            {
                "clientMutationId": "m_idem_1",
                "entityType": "group",
                "entityUid": group_uid,
                "operation": "create",
                "expectedVersion": 0,
                "payload": {"name": "Idempotent Group"},
            }
        ],
    }

    # First call: ACCEPTED
    res1 = await client.post("/sync/push", json=mutation_req)
    assert res1.json()["results"][0]["status"] == "ACCEPTED"

    # Duplicate call: replayed idempotently as ACCEPTED without incrementing sequence twice
    res2 = await client.post("/sync/push", json=mutation_req)
    assert res2.json()["results"][0]["status"] == "ACCEPTED"

    boot = await client.get(f"/sync/bootstrap/{group_uid}")
    assert boot.json()["serverSequence"] == 1
