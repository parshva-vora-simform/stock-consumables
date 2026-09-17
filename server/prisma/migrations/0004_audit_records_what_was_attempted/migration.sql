-- ---------------------------------------------------------------------------
-- An audit log records what was ATTEMPTED, not what exists.
--
-- movement_attempts.item_id carried a foreign key to items. That made one
-- category of attempt impossible to record: a movement against an item id that
-- does not exist. The write failed, the audit row was dropped, and the trace of
-- that attempt was lost — while FR-9.2 requires exactly the opposite, because a
-- caller repeatedly referencing item ids that are not there is precisely the
-- pattern an audit trail should preserve.
--
-- The id is still stored, and still joinable when the item does exist. It is
-- simply no longer required to.
-- ---------------------------------------------------------------------------

ALTER TABLE "movement_attempts" DROP CONSTRAINT IF EXISTS "movement_attempts_item_id_fkey";

-- Same reasoning for the movement id: an attempt that was refused has no
-- resulting movement, and one that succeeded already points at a row that can
-- never be deleted (the ledger is append-only), so the constraint buys nothing
-- the trigger does not already guarantee.
ALTER TABLE "movement_attempts" DROP CONSTRAINT IF EXISTS "movement_attempts_resulting_movement_id_fkey";
