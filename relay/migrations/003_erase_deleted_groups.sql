-- Deleting a group now erases every record of it. Groups deleted before that change were only
-- marked deleted; erase their data the same way.
DELETE FROM transaction_splits
 WHERE transaction_uid IN (SELECT t.tx_uid FROM transactions t JOIN groups g ON g.uid = t.group_uid WHERE g.is_deleted);
DELETE FROM transactions               WHERE group_uid IN (SELECT uid FROM groups WHERE is_deleted);
DELETE FROM group_members              WHERE group_uid IN (SELECT uid FROM groups WHERE is_deleted);
DELETE FROM sync_changes               WHERE group_uid IN (SELECT uid FROM groups WHERE is_deleted);
DELETE FROM client_mutations           WHERE group_uid IN (SELECT uid FROM groups WHERE is_deleted);
DELETE FROM device_group_subscriptions WHERE group_uid IN (SELECT uid FROM groups WHERE is_deleted);
DELETE FROM webhook_subscriptions      WHERE group_uid IN (SELECT uid FROM groups WHERE is_deleted);
DELETE FROM groups                     WHERE is_deleted;
