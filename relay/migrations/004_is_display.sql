-- is_display: rows set to false (manually, in the database) are never returned by the server.
-- Phones that already downloaded a row keep their copy; the server only stops serving it.
--
-- Hiding cascades, so a phone never receives a partial picture:
--   * a hidden user hides the groups they created, the transactions they added, and members linked to them
--   * a hidden group hides everything in it (members, transactions, splits, changes, notifications)
--   * a hidden member hides the transactions they paid or are split into
--   * a hidden split hides its transaction
-- All reads go through the visible_* views below, so the rules live in one place.

ALTER TABLE groups                     ADD COLUMN IF NOT EXISTS is_display BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE group_members              ADD COLUMN IF NOT EXISTS is_display BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE transactions               ADD COLUMN IF NOT EXISTS is_display BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE transaction_splits         ADD COLUMN IF NOT EXISTS is_display BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE sync_changes               ADD COLUMN IF NOT EXISTS is_display BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE client_mutations           ADD COLUMN IF NOT EXISTS is_display BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE devices                    ADD COLUMN IF NOT EXISTS is_display BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE device_group_subscriptions ADD COLUMN IF NOT EXISTS is_display BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE webhook_subscriptions      ADD COLUMN IF NOT EXISTS is_display BOOLEAN NOT NULL DEFAULT true;

-- Accounts (the actorId phones sync as). Filled in automatically on every push, so a user can be
-- hidden with: UPDATE sync_users SET is_display = false WHERE user_id = '...';
-- Named sync_users because the database may be shared with other apps that have their own "users".
CREATE TABLE IF NOT EXISTS sync_users (
  user_id    TEXT PRIMARY KEY,
  user_name  TEXT,
  is_display BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sync_users ENABLE ROW LEVEL SECURITY;

INSERT INTO sync_users (user_id, user_name)
SELECT DISTINCT ON (user_id) user_id, user_name FROM (
  SELECT creator_id AS user_id, creator_name AS user_name, 1 AS pref FROM groups
  UNION ALL SELECT author_id, author_name, 2 FROM transactions
  UNION ALL SELECT user_id, user_name, 0 FROM devices
  UNION ALL SELECT user_id, name, 3 FROM group_members
) known
WHERE user_id IS NOT NULL AND user_id <> ''
ORDER BY user_id, pref
ON CONFLICT (user_id) DO NOTHING;

-- Visibility views. They ignore is_deleted on purpose: tombstones are still synced as deletes.
CREATE OR REPLACE VIEW hidden_users AS
  SELECT user_id FROM sync_users WHERE NOT is_display;

CREATE OR REPLACE VIEW visible_groups AS
  SELECT g.* FROM groups g
   WHERE g.is_display
     AND NOT EXISTS (SELECT 1 FROM hidden_users h WHERE h.user_id = g.creator_id);

CREATE OR REPLACE VIEW visible_members AS
  SELECT m.* FROM group_members m
    JOIN visible_groups g ON g.uid = m.group_uid
   WHERE m.is_display
     AND NOT EXISTS (SELECT 1 FROM hidden_users h WHERE h.user_id = m.user_id);

CREATE OR REPLACE VIEW visible_transactions AS
  SELECT t.* FROM transactions t
    JOIN visible_groups g ON g.uid = t.group_uid
   WHERE t.is_display
     AND NOT EXISTS (SELECT 1 FROM hidden_users h WHERE h.user_id = t.author_id)
     AND EXISTS (SELECT 1 FROM visible_members m WHERE m.member_uid = t.paid_by_member_uid)
     AND NOT EXISTS (
       SELECT 1 FROM transaction_splits s
        WHERE s.transaction_uid = t.tx_uid
          AND (NOT s.is_display OR NOT EXISTS (SELECT 1 FROM visible_members m WHERE m.member_uid = s.member_uid))
     );

CREATE OR REPLACE VIEW visible_splits AS
  SELECT s.* FROM transaction_splits s
    JOIN visible_transactions t ON t.tx_uid = s.transaction_uid;

-- A change is served only if the change row and the entity it describes are both visible.
CREATE OR REPLACE VIEW visible_changes AS
  SELECT c.* FROM sync_changes c
    JOIN visible_groups g ON g.uid = c.group_uid
   WHERE c.is_display
     AND CASE c.entity_type
           WHEN 'group'       THEN true
           WHEN 'member'      THEN EXISTS (SELECT 1 FROM visible_members m WHERE m.member_uid = c.entity_uid)
           WHEN 'transaction' THEN EXISTS (SELECT 1 FROM visible_transactions t WHERE t.tx_uid = c.entity_uid)
           ELSE false
         END;

CREATE OR REPLACE VIEW visible_devices AS
  SELECT d.* FROM devices d
   WHERE d.is_display
     AND NOT EXISTS (SELECT 1 FROM hidden_users h WHERE h.user_id = d.user_id);

CREATE OR REPLACE VIEW visible_device_group_subscriptions AS
  SELECT s.* FROM device_group_subscriptions s
    JOIN visible_groups g ON g.uid = s.group_uid
    JOIN visible_devices d ON d.device_id = s.device_id
   WHERE s.is_display;

CREATE OR REPLACE VIEW visible_webhook_subscriptions AS
  SELECT w.* FROM webhook_subscriptions w
    JOIN visible_groups g ON g.uid = w.group_uid
   WHERE w.is_display;
