-- Indexes for the queries the sync server runs as data grows. Each one is tied to a real query:
--   * foreign keys without an index on the referencing column make every delete of the parent row
--     (group erase, member merge) scan the whole child table
--   * the push path checks duplicate member names on every member create
--   * group erase and idempotency-ledger cleanup filter client_mutations by group / age
--   * the notification dispatcher (cron, every minute) looks for targets that are due
-- IF NOT EXISTS makes this safe to run more than once, by hand or through npm run migrate.

-- Foreign keys (Postgres indexes the referenced side only).
CREATE INDEX IF NOT EXISTS idx_transactions_paid_by       ON transactions (paid_by_member_uid);
CREATE INDEX IF NOT EXISTS idx_transaction_splits_member  ON transaction_splits (member_uid);
CREATE INDEX IF NOT EXISTS idx_device_subscriptions_device ON device_group_subscriptions (device_id);

-- Duplicate-member-name check on every member create (syncService: lower(trim(name)) within a group).
CREATE INDEX IF NOT EXISTS idx_group_members_group_name
  ON group_members (group_uid, lower(trim(name))) WHERE is_deleted = false;

-- Idempotency ledger: erased per group on group delete; old rows removed by age.
CREATE INDEX IF NOT EXISTS idx_client_mutations_group   ON client_mutations (group_uid);
CREATE INDEX IF NOT EXISTS idx_client_mutations_created ON client_mutations (created_at);

-- Notification dispatcher: only targets that can be due.
CREATE INDEX IF NOT EXISTS idx_device_subscriptions_due ON device_group_subscriptions (next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_due ON webhook_subscriptions (next_attempt_at) WHERE is_active;

-- Fresh planner statistics for the new indexes.
ANALYZE groups, group_members, transactions, transaction_splits, sync_changes, client_mutations,
        devices, device_group_subscriptions, webhook_subscriptions, sync_users;
