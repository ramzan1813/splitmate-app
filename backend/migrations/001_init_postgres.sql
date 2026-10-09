-- SplitMate PostgreSQL Schema

CREATE TABLE IF NOT EXISTS groups (
  id               BIGSERIAL UNIQUE,
  uid              TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  currency         TEXT NOT NULL DEFAULT 'USD',
  permission_model TEXT NOT NULL DEFAULT 'COLLABORATIVE'
                   CHECK (permission_model IN ('ADMIN_ONLY', 'CONTRIBUTOR', 'COLLABORATIVE')),
  creator_id       TEXT NOT NULL,
  creator_name     TEXT NOT NULL,
  sync_key         TEXT NOT NULL DEFAULT '',
  server_version   INTEGER NOT NULL DEFAULT 1,
  last_sequence    BIGINT NOT NULL DEFAULT 0,
  is_deleted       BOOLEAN NOT NULL DEFAULT false,
  is_display       BOOLEAN NOT NULL DEFAULT true,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  id             BIGSERIAL UNIQUE,
  member_uid     TEXT PRIMARY KEY,
  group_uid      TEXT NOT NULL REFERENCES groups(uid),
  name           TEXT NOT NULL,
  user_id        TEXT,
  role           TEXT NOT NULL DEFAULT 'MEMBER',
  server_version INTEGER NOT NULL DEFAULT 1,
  is_deleted     BOOLEAN NOT NULL DEFAULT false,
  is_display     BOOLEAN NOT NULL DEFAULT true,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members (group_uid);

CREATE TABLE IF NOT EXISTS transactions (
  id                 BIGSERIAL UNIQUE,
  tx_uid             TEXT PRIMARY KEY,
  group_uid          TEXT NOT NULL REFERENCES groups(uid),
  type               TEXT NOT NULL CHECK (type IN ('expense', 'payment')),
  title              TEXT NOT NULL,
  amount             BIGINT NOT NULL CHECK (amount > 0),
  paid_by_member_uid TEXT NOT NULL REFERENCES group_members(member_uid),
  split_type         TEXT NOT NULL DEFAULT 'equal'
                     CHECK (split_type IN ('equal', 'unequal', 'percent', 'shares', 'exact', 'percentage')),
  category           TEXT NOT NULL DEFAULT 'General',
  note               TEXT NOT NULL DEFAULT '',
  date               TEXT NOT NULL,
  author_id          TEXT NOT NULL,
  author_name        TEXT NOT NULL,
  updated_by_id      TEXT,
  updated_by_name    TEXT,
  updated_ts         BIGINT NOT NULL DEFAULT 0,
  created_ts         BIGINT,
  server_version     INTEGER NOT NULL DEFAULT 1,
  is_deleted         BOOLEAN NOT NULL DEFAULT false,
  is_display         BOOLEAN NOT NULL DEFAULT true,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_group ON transactions (group_uid);

CREATE TABLE IF NOT EXISTS transaction_splits (
  transaction_uid TEXT NOT NULL REFERENCES transactions(tx_uid),
  member_uid      TEXT NOT NULL REFERENCES group_members(member_uid),
  value           DOUBLE PRECISION NOT NULL DEFAULT 1,
  share           BIGINT NOT NULL CHECK (share >= 0),
  is_display      BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (transaction_uid, member_uid)
);

CREATE TABLE IF NOT EXISTS sync_changes (
  group_uid      TEXT NOT NULL REFERENCES groups(uid),
  sequence       BIGINT NOT NULL,
  change_id      TEXT NOT NULL UNIQUE,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('group', 'member', 'transaction')),
  entity_uid     TEXT NOT NULL,
  operation      TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  actor_id       TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  payload        JSONB NOT NULL,
  is_display     BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_uid, sequence)
);

CREATE TABLE IF NOT EXISTS client_mutations (
  client_mutation_id TEXT PRIMARY KEY,
  group_uid          TEXT NOT NULL,
  actor_id           TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'CONFLICT', 'REJECTED')),
  response           JSONB NOT NULL,
  is_display         BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  device_id       TEXT PRIMARY KEY,
  user_id         TEXT,
  user_name       TEXT,
  expo_push_token TEXT,
  push_enabled    BOOLEAN NOT NULL DEFAULT false,
  is_display      BOOLEAN NOT NULL DEFAULT true,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_users (
  user_id    TEXT PRIMARY KEY,
  user_name  TEXT,
  is_display BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Visibility Views
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
