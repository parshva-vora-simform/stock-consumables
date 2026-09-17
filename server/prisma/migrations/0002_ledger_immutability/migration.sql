-- ---------------------------------------------------------------------------
-- The guarantees that Prisma cannot express.
--
-- Everything in this file is load-bearing. If you regenerate migrations, do
-- not drop it: the whole POC rests on these two objects holding even when the
-- application layer is bypassed entirely.
-- ---------------------------------------------------------------------------

-- 1. A balance can never go negative. ---------------------------------------
--
-- The application already refuses to take stock below zero, in a single atomic
-- statement. This constraint is the backstop for everything that isn't the
-- application: a psql session, a migration script, a future bug. With it in
-- place, a negative balance is not merely prevented — it is unrepresentable.

ALTER TABLE "stock_balances"
  ADD CONSTRAINT "stock_balances_quantity_non_negative" CHECK ("quantity" >= 0);

-- 2. The ledger is append-only. ---------------------------------------------
--
-- Movements are history. History that can be rewritten is not an audit trail,
-- so UPDATE and DELETE are refused at the table itself rather than merely
-- omitted from the API. A stray `prisma.movement.update()` throws at runtime;
-- so does a hand-typed UPDATE in psql.
--
-- Corrections go through a REVERSAL movement instead (FR-6.1).

CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted.', TG_TABLE_NAME, TG_OP
    USING
      ERRCODE = 'restrict_violation',
      HINT = CASE TG_TABLE_NAME
        WHEN 'movements' THEN 'Correct a mistake by appending a REVERSAL movement (see FR-6.1).'
        ELSE 'Audit records are evidence; they are written once and never revised.'
      END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "movements_immutable"
  BEFORE UPDATE OR DELETE ON "movements"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- Audit rows are immutable for the same reason: a record of a rejected attempt
-- that can be edited afterwards proves nothing.
CREATE TRIGGER "movement_attempts_immutable"
  BEFORE UPDATE OR DELETE ON "movement_attempts"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
