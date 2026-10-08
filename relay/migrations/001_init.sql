-- SplitMate sync backend schema (Supabase Postgres).
-- Source of truth for every synchronized entity. Clients hold replicas and an outbox.
--
-- Invariants:
--   * Each entity row carries server_version, incremented by exactly 1 per accepted mutation.
--   * groups.last_sequence is the per-group change cursor. It is incremented while the group
--     row is locked, in the same transaction that writes the sync_changes row, so sequences
--     become visible in commit order and a reader at `after = N` can never skip a change.
--   * Deletes are tombstones (is_deleted = true); rows are never physically removed.

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
  amount             BIGINT NOT NULL CHECK (amount > 0), -- minor units (cents)
  paid_by_member_uid TEXT NOT NULL REFERENCES group_members(member_uid),
  split_type         TEXT NOT NULL DEFAULT 'equal'
                     CHECK (split_type IN ('equal', 'unequal', 'percent', 'shares', 'exact', 'percentage')),
  category           TEXT NOT NULL DEFAULT 'General',
  note               TEXT NOT NULL DEFAULT '',
  date               TEXT NOT NULL, -- YYYY-MM-DD, as entered on the client
  author_id          TEXT NOT NULL,
  author_name        TEXT NOT NULL,
  updated_by_id      TEXT,
  updated_by_name    TEXT,
  updated_ts         BIGINT NOT NULL DEFAULT 0,
  server_version     INTEGER NOT NULL DEFAULT 1,
  is_deleted         BOOLEAN NOT NULL DEFAULT false,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_group ON transactions (group_uid);

CREATE TABLE IF NOT EXISTS transaction_splits (
  transaction_uid TEXT NOT NULL REFERENCES transactions(tx_uid),
  member_uid      TEXT NOT NULL REFERENCES group_members(member_uid),
  value           DOUBLE PRECISION NOT NULL DEFAULT 1,
  share           BIGINT NOT NULL CHECK (share >= 0), -- minor units; shares sum to transactions.amount
  PRIMARY KEY (transaction_uid, member_uid)
);

-- Append-only, per-group monotonic change log consumed by GET /sync/changes.
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
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_uid, sequence)
);

-- Idempotency ledger: the stored response is replayed verbatim when a client retries.
CREATE TABLE IF NOT EXISTS client_mutations (
  client_mutation_id TEXT PRIMARY KEY,
  group_uid          TEXT NOT NULL,
  actor_id           TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'CONFLICT', 'REJECTED')),
  response           JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  device_id       TEXT PRIMARY KEY,
  user_id         TEXT,
  user_name       TEXT,
  expo_push_token TEXT,
  push_enabled    BOOLEAN NOT NULL DEFAULT false,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Push-notification target per (group, device). A target is pending while
-- delivered_sequence < groups.last_sequence, so notifications coalesce and survive crashes.
CREATE TABLE IF NOT EXISTS device_group_subscriptions (
  group_uid          TEXT NOT NULL REFERENCES groups(uid),
  device_id          TEXT NOT NULL REFERENCES devices(device_id),
  delivered_sequence BIGINT NOT NULL DEFAULT 0,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_uid, device_id)
);

-- Outbound webhook target per group, same pending rule as device_group_subscriptions.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_uid            TEXT NOT NULL REFERENCES groups(uid),
  url                  TEXT NOT NULL,
  secret               TEXT NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  delivered_sequence   BIGINT NOT NULL DEFAULT 0,
  attempts             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error           TEXT,
  last_delivered_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_group ON webhook_subscriptions (group_uid);

-- Supabase exposes the public schema through its Data API (anon/authenticated keys).
-- RLS with no policies denies that path; the Worker connects as the table owner and is unaffected.
ALTER TABLE groups                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members              ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_splits         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_changes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_mutations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_group_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions      ENABLE ROW LEVEL SECURITY;
