-- When a transaction was created, in epoch milliseconds from the creating phone's clock.
-- Set once on create and never changed by updates. NULL means unknown (shown as date only).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_ts BIGINT;

-- Backfill: a never-edited transaction's updated_ts is still the creating phone's timestamp.
-- Phones apply the same rule to their local copies, so every device derives the same value.
UPDATE transactions
   SET created_ts = updated_ts
 WHERE created_ts IS NULL
   AND updated_by_id IS NULL
   AND updated_ts > 0;
