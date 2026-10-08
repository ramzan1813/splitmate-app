import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestServer } from '../relay/test-support/testServer';
import { PushMutationsResponse } from '../src/data/types';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

// Helper for pushing single mutations to server
async function pushMutation(
  groupUid: string,
  actorId: string,
  actorName: string,
  mutation: {
    clientMutationId: string;
    entityType: 'group' | 'member' | 'transaction';
    entityUid: string;
    operation: 'create' | 'update' | 'delete';
    expectedVersion: number;
    payload: any;
  }
) {
  const res = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid,
      deviceId: `dev_${actorId}`,
      actorId,
      actorName,
      mutations: [mutation],
    },
  });
  assert.equal(res.status, 200);
  const data = res.body as PushMutationsResponse;
  return data.results[0]!;
}

// ============================================================================
// 1. ADMIN_ONLY Permission Model Tests
// ============================================================================

test('server authorization: ADMIN_ONLY model full matrix', async () => {
  const groupUid = 'grp_admin_perm_test';
  const adminId = 'usr_alice_admin';
  const memberId = 'usr_bob_guest';

  // 1. Admin creates ADMIN_ONLY group -> ACCEPTED
  const resGroup = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_a_grp',
    entityType: 'group',
    entityUid: groupUid,
    operation: 'create',
    expectedVersion: 0,
    payload: { name: 'Admin Only Project', permissionModel: 'ADMIN_ONLY', creatorId: adminId },
  });
  assert.equal(resGroup.status, 'ACCEPTED');

  // 2. Admin adds members -> ACCEPTED
  const resMem1 = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_a_mem_alice',
    entityType: 'member',
    entityUid: 'mem_alice',
    operation: 'create',
    expectedVersion: 0,
    payload: { name: 'Alice', userId: adminId, role: 'ADMIN' },
  });
  assert.equal(resMem1.status, 'ACCEPTED');

  const resMem2 = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_a_mem_bob',
    entityType: 'member',
    entityUid: 'mem_bob',
    operation: 'create',
    expectedVersion: 0,
    payload: { name: 'Bob', userId: memberId, role: 'MEMBER' },
  });
  assert.equal(resMem2.status, 'ACCEPTED');

  // 3. Admin creates, updates, and deletes transaction -> ALL ACCEPTED
  const resTxCreate = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_a_tx_1',
    entityType: 'transaction',
    entityUid: 'tx_server_cost',
    operation: 'create',
    expectedVersion: 0,
    payload: { title: 'Server Hosting', amount: 5000, paidByMemberUid: 'mem_alice', splits: [{ memberUid: 'mem_alice', value: 1, share: 5000 }], authorId: adminId },
  });
  assert.equal(resTxCreate.status, 'ACCEPTED');

  const resTxUpdate = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_a_tx_2',
    entityType: 'transaction',
    entityUid: 'tx_server_cost',
    operation: 'update',
    expectedVersion: 1,
    payload: { amount: 6000, splits: [{ memberUid: 'mem_alice', value: 1, share: 6000 }] },
  });
  assert.equal(resTxUpdate.status, 'ACCEPTED');

  // 4. Non-Admin (Bob) attempts any write operation -> ALL REJECTED (403 FORBIDDEN)
  // Bob tries to create transaction -> REJECTED
  const resBobCreateTx = await pushMutation(groupUid, memberId, 'Bob', {
    clientMutationId: 'mut_b_tx_unauth',
    entityType: 'transaction',
    entityUid: 'tx_bob_coffee',
    operation: 'create',
    expectedVersion: 0,
    payload: { title: 'Coffee', amount: 500 },
  });
  assert.equal(resBobCreateTx.status, 'REJECTED');
  assert.equal(resBobCreateTx.error, 'FORBIDDEN');

  // Bob tries to update admin transaction -> REJECTED
  const resBobUpdateTx = await pushMutation(groupUid, memberId, 'Bob', {
    clientMutationId: 'mut_b_tx_upd_unauth',
    entityType: 'transaction',
    entityUid: 'tx_server_cost',
    operation: 'update',
    expectedVersion: 2,
    payload: { title: 'Hacked Hosting' },
  });
  assert.equal(resBobUpdateTx.status, 'REJECTED');
  assert.equal(resBobUpdateTx.error, 'FORBIDDEN');

  // Bob tries to delete admin transaction -> REJECTED
  const resBobDelTx = await pushMutation(groupUid, memberId, 'Bob', {
    clientMutationId: 'mut_b_tx_del_unauth',
    entityType: 'transaction',
    entityUid: 'tx_server_cost',
    operation: 'delete',
    expectedVersion: 2,
    payload: {},
  });
  assert.equal(resBobDelTx.status, 'REJECTED');
  assert.equal(resBobDelTx.error, 'FORBIDDEN');

  // Bob tries to add member -> REJECTED
  const resBobAddMem = await pushMutation(groupUid, memberId, 'Bob', {
    clientMutationId: 'mut_b_mem_unauth',
    entityType: 'member',
    entityUid: 'mem_charlie',
    operation: 'create',
    expectedVersion: 0,
    payload: { name: 'Charlie' },
  });
  assert.equal(resBobAddMem.status, 'REJECTED');
  assert.equal(resBobAddMem.error, 'FORBIDDEN');

  // Bob tries to rename member -> REJECTED
  const resBobRenameMem = await pushMutation(groupUid, memberId, 'Bob', {
    clientMutationId: 'mut_b_rename_unauth',
    entityType: 'member',
    entityUid: 'mem_bob',
    operation: 'update',
    expectedVersion: 1,
    payload: { newName: 'Bobby' },
  });
  assert.equal(resBobRenameMem.status, 'REJECTED');
  assert.equal(resBobRenameMem.error, 'FORBIDDEN');

  // Bob tries to modify group settings -> REJECTED
  const resBobUpdGroup = await pushMutation(groupUid, memberId, 'Bob', {
    clientMutationId: 'mut_b_grp_upd_unauth',
    entityType: 'group',
    entityUid: groupUid,
    operation: 'update',
    expectedVersion: 1,
    payload: { name: 'Bob Project' },
  });
  assert.equal(resBobUpdGroup.status, 'REJECTED');
  assert.equal(resBobUpdGroup.error, 'FORBIDDEN');

  // Bob tries to delete group -> REJECTED
  const resBobDelGroup = await pushMutation(groupUid, memberId, 'Bob', {
    clientMutationId: 'mut_b_grp_del_unauth',
    entityType: 'group',
    entityUid: groupUid,
    operation: 'delete',
    expectedVersion: 1,
    payload: {},
  });
  assert.equal(resBobDelGroup.status, 'REJECTED');
  assert.equal(resBobDelGroup.error, 'FORBIDDEN');

  // Admin deletes transaction -> ACCEPTED
  const resAdminDelTx = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_a_tx_del',
    entityType: 'transaction',
    entityUid: 'tx_server_cost',
    operation: 'delete',
    expectedVersion: 2,
    payload: {},
  });
  assert.equal(resAdminDelTx.status, 'ACCEPTED');
});

// ============================================================================
// 2. CONTRIBUTOR Permission Model Tests
// ============================================================================

test('server authorization: CONTRIBUTOR model full matrix', async () => {
  const groupUid = 'grp_contrib_perm_test';
  const adminId = 'usr_alice_admin';
  const contributor1 = 'usr_bob_contrib';
  const contributor2 = 'usr_charlie_contrib';

  // 1. Create CONTRIBUTOR group
  await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_c_grp',
    entityType: 'group',
    entityUid: groupUid,
    operation: 'create',
    expectedVersion: 0,
    payload: { name: 'Contributor Project', permissionModel: 'CONTRIBUTOR', creatorId: adminId },
  });

  // 2. Contributor 1 (Bob) creates a transaction -> ACCEPTED
  const resBobCreate = await pushMutation(groupUid, contributor1, 'Bob', {
    clientMutationId: 'mut_bob_tx_create',
    entityType: 'transaction',
    entityUid: 'tx_bob_lunch',
    operation: 'create',
    expectedVersion: 0,
    payload: { title: 'Lunch', amount: 2000, paidByName: 'Payer', splits: [{ memberName: 'Payer', value: 1, share: 2000 }], authorId: contributor1 },
  });
  assert.equal(resBobCreate.status, 'ACCEPTED');

  // 3. Contributor 1 (Bob) updates HIS OWN transaction -> ACCEPTED
  const resBobUpdateOwn = await pushMutation(groupUid, contributor1, 'Bob', {
    clientMutationId: 'mut_bob_tx_upd',
    entityType: 'transaction',
    entityUid: 'tx_bob_lunch',
    operation: 'update',
    expectedVersion: 1,
    payload: { title: 'Lunch + Tip', amount: 2400, splits: [{ memberName: 'Payer', value: 1, share: 2400 }] },
  });
  assert.equal(resBobUpdateOwn.status, 'ACCEPTED');
  assert.equal(resBobUpdateOwn.serverVersion, 2);

  // 4. Contributor 2 (Charlie) tries to update Bob's transaction -> REJECTED (FORBIDDEN)
  const resCharlieUpdateBob = await pushMutation(groupUid, contributor2, 'Charlie', {
    clientMutationId: 'mut_charlie_upd_bob',
    entityType: 'transaction',
    entityUid: 'tx_bob_lunch',
    operation: 'update',
    expectedVersion: 2,
    payload: { title: 'Charlie edited lunch' },
  });
  assert.equal(resCharlieUpdateBob.status, 'REJECTED');
  assert.equal(resCharlieUpdateBob.error, 'FORBIDDEN');

  // 5. Contributor 2 (Charlie) tries to delete Bob's transaction -> REJECTED (FORBIDDEN)
  const resCharlieDeleteBob = await pushMutation(groupUid, contributor2, 'Charlie', {
    clientMutationId: 'mut_charlie_del_bob',
    entityType: 'transaction',
    entityUid: 'tx_bob_lunch',
    operation: 'delete',
    expectedVersion: 2,
    payload: {},
  });
  assert.equal(resCharlieDeleteBob.status, 'REJECTED');
  assert.equal(resCharlieDeleteBob.error, 'FORBIDDEN');

  // 6. Contributor tries to update group settings or delete member -> REJECTED (FORBIDDEN)
  const resBobUpdGroup = await pushMutation(groupUid, contributor1, 'Bob', {
    clientMutationId: 'mut_bob_upd_grp',
    entityType: 'group',
    entityUid: groupUid,
    operation: 'update',
    expectedVersion: 1,
    payload: { name: 'Bob takeover' },
  });
  assert.equal(resBobUpdGroup.status, 'REJECTED');
  assert.equal(resBobUpdGroup.error, 'FORBIDDEN');

  const resBobDelMem = await pushMutation(groupUid, contributor1, 'Bob', {
    clientMutationId: 'mut_bob_del_mem',
    entityType: 'member',
    entityUid: 'mem_charlie',
    operation: 'delete',
    expectedVersion: 1,
    payload: {},
  });
  assert.equal(resBobDelMem.status, 'REJECTED');
  assert.equal(resBobDelMem.error, 'FORBIDDEN');

  // 7. Admin CAN update and delete any contributor's transaction -> ACCEPTED
  const resAdminUpdBob = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_admin_upd_bob',
    entityType: 'transaction',
    entityUid: 'tx_bob_lunch',
    operation: 'update',
    expectedVersion: 2,
    payload: { title: 'Approved Lunch Expense', amount: 2400, splits: [{ memberName: 'Payer', value: 1, share: 2400 }] },
  });
  assert.equal(resAdminUpdBob.status, 'ACCEPTED');
  assert.equal(resAdminUpdBob.serverVersion, 3);

  // 8. Contributor 1 (Bob) deletes HIS OWN transaction -> ACCEPTED
  const resBobDelOwn = await pushMutation(groupUid, contributor1, 'Bob', {
    clientMutationId: 'mut_bob_del_own',
    entityType: 'transaction',
    entityUid: 'tx_bob_lunch',
    operation: 'delete',
    expectedVersion: 3,
    payload: {},
  });
  assert.equal(resBobDelOwn.status, 'ACCEPTED');
});

// ============================================================================
// 3. COLLABORATIVE Permission Model Tests
// ============================================================================

test('server authorization: COLLABORATIVE model full matrix', async () => {
  const groupUid = 'grp_collab_perm_test';
  const adminId = 'usr_alice_admin';
  const memberA = 'usr_bob_collab';
  const memberB = 'usr_charlie_collab';

  // 1. Create COLLABORATIVE group
  await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_collab_grp',
    entityType: 'group',
    entityUid: groupUid,
    operation: 'create',
    expectedVersion: 0,
    payload: { name: 'Collaborative Trip', permissionModel: 'COLLABORATIVE', creatorId: adminId },
  });

  // 2. Member A creates a transaction -> ACCEPTED
  const resCreate = await pushMutation(groupUid, memberA, 'Bob', {
    clientMutationId: 'mut_bob_create_tx',
    entityType: 'transaction',
    entityUid: 'tx_groceries',
    operation: 'create',
    expectedVersion: 0,
    payload: { title: 'Groceries', amount: 8000, paidByName: 'Payer', splits: [{ memberName: 'Payer', value: 1, share: 8000 }], authorId: memberA },
  });
  assert.equal(resCreate.status, 'ACCEPTED');

  // 3. Member B edits Member A's transaction in collaborative mode -> ACCEPTED (with audit record)
  const resEdit = await pushMutation(groupUid, memberB, 'Charlie', {
    clientMutationId: 'mut_charlie_edit_tx',
    entityType: 'transaction',
    entityUid: 'tx_groceries',
    operation: 'update',
    expectedVersion: 1,
    payload: { title: 'Groceries + Drinks', amount: 9500, splits: [{ memberName: 'Payer', value: 1, share: 9500 }] },
  });
  assert.equal(resEdit.status, 'ACCEPTED');
  assert.equal(resEdit.serverVersion, 2);

  // 4. Member B (not author, not admin) tries to DELETE Member A's transaction -> REJECTED (Delete protection)
  const resUnauthDel = await pushMutation(groupUid, memberB, 'Charlie', {
    clientMutationId: 'mut_charlie_del_tx',
    entityType: 'transaction',
    entityUid: 'tx_groceries',
    operation: 'delete',
    expectedVersion: 2,
    payload: {},
  });
  assert.equal(resUnauthDel.status, 'REJECTED');
  assert.equal(resUnauthDel.error, 'FORBIDDEN');

  // 5. Member B tries to delete a member -> REJECTED (Creator only)
  const resDelMem = await pushMutation(groupUid, memberB, 'Charlie', {
    clientMutationId: 'mut_charlie_del_mem',
    entityType: 'member',
    entityUid: 'mem_bob',
    operation: 'delete',
    expectedVersion: 1,
    payload: {},
  });
  assert.equal(resDelMem.status, 'REJECTED');
  assert.equal(resDelMem.error, 'FORBIDDEN');

  // 6. Member A (Original Author) deletes HIS OWN transaction -> ACCEPTED
  const resAuthorDel = await pushMutation(groupUid, memberA, 'Bob', {
    clientMutationId: 'mut_bob_del_tx',
    entityType: 'transaction',
    entityUid: 'tx_groceries',
    operation: 'delete',
    expectedVersion: 2,
    payload: {},
  });
  assert.equal(resAuthorDel.status, 'ACCEPTED');
  assert.equal(resAuthorDel.serverVersion, 3);

  // 7. Member A creates another transaction
  await pushMutation(groupUid, memberA, 'Bob', {
    clientMutationId: 'mut_bob_create_tx2',
    entityType: 'transaction',
    entityUid: 'tx_fuel',
    operation: 'create',
    expectedVersion: 0,
    payload: { title: 'Fuel', amount: 5000, paidByName: 'Payer', splits: [{ memberName: 'Payer', value: 1, share: 5000 }], authorId: memberA },
  });

  // 8. Admin deletes Member A's transaction -> ACCEPTED (Admin always has full authority)
  const resAdminDel = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_admin_del_tx2',
    entityType: 'transaction',
    entityUid: 'tx_fuel',
    operation: 'delete',
    expectedVersion: 1,
    payload: {},
  });
  assert.equal(resAdminDel.status, 'ACCEPTED');
  assert.equal(resAdminDel.serverVersion, 2);
});

// ============================================================================
// 4. Non-Existent & Deleted Group Rejection Tests
// ============================================================================

test('server authorization: operations on non-existent or deleted groups are rejected', async () => {
  // 1. Non-existent group
  const resNonExistent = await pushMutation('grp_ghost_999', 'usr_alice', 'Alice', {
    clientMutationId: 'mut_ghost_1',
    entityType: 'transaction',
    entityUid: 'tx_ghost',
    operation: 'create',
    expectedVersion: 0,
    payload: { title: 'Ghost Expense', amount: 100 },
  });
  assert.equal(resNonExistent.status, 'REJECTED');
  assert.equal(resNonExistent.error, 'GROUP_NOT_FOUND');

  // 2. Create group and soft delete it
  const groupUid = 'grp_deleted_test';
  const adminId = 'usr_alice';
  await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_del_grp_create',
    entityType: 'group',
    entityUid: groupUid,
    operation: 'create',
    expectedVersion: 0,
    payload: { name: 'To Be Deleted', creatorId: adminId },
  });

  const resDelete = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_del_grp_delete',
    entityType: 'group',
    entityUid: groupUid,
    operation: 'delete',
    expectedVersion: 1,
    payload: {},
  });

  assert.equal(resDelete.status, 'ACCEPTED');

  // 3. Mutation on deleted group is REJECTED
  const resOnDeleted = await pushMutation(groupUid, adminId, 'Alice', {
    clientMutationId: 'mut_on_deleted_tx',
    entityType: 'transaction',
    entityUid: 'tx_after_del',
    operation: 'create',
    expectedVersion: 0,
    payload: { title: 'After Delete', amount: 500 },
  });
  assert.equal(resOnDeleted.status, 'REJECTED');
  assert.equal(resOnDeleted.error, 'GROUP_NOT_FOUND');
});
