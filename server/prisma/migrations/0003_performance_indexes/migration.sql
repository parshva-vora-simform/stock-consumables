-- ---------------------------------------------------------------------------
-- Indexes Prisma's schema language cannot express.
--
-- The ones it CAN express live in schema.prisma as @@index and were created in
-- 0001. Only add to this file what a query plan has shown to be necessary —
-- every index here is a write cost on the movement insert, which is the
-- hottest path in the system. `docs/performance.md` records the plan that
-- justified each one.
-- ---------------------------------------------------------------------------

-- Covering index for the derived-quantity sum:
--   SELECT location_id, SUM(signed_quantity) FROM movements
--   WHERE item_id = $1 GROUP BY location_id;
--
-- INCLUDE puts signed_quantity in the leaf pages, so the aggregate is served by
-- an index-only scan and never touches the heap. This query is the O(n) path we
-- deliberately traded away for the running total (FRD §5.1) — but the
-- reconciliation job (T-14) runs it over every item, so it still has to be as
-- cheap as an O(n) scan can be.
CREATE INDEX "movements_item_location_signed_qty_covering_idx"
  ON "movements" ("item_id", "location_id") INCLUDE ("signed_quantity");

-- Low-stock scan (FR-7.2). The threshold comparison itself cannot be indexed,
-- because it spans two tables (b.quantity <= i.min_threshold). What this index
-- does is let the planner walk stock_balances in quantity order and stop early,
-- since the rows this view wants are the low ones — and it carries location_id
-- and item_id so the join keys come from the index rather than the heap.
CREATE INDEX "stock_balances_quantity_location_idx"
  ON "stock_balances" ("quantity", "location_id", "item_id");

-- Rejected attempts are the interesting ones in an audit review, and they are a
-- small minority of rows. A partial index keeps that lookup cheap without
-- paying for the accepted majority.
CREATE INDEX "movement_attempts_rejected_idx"
  ON "movement_attempts" ("attempted_at" DESC, "id" DESC)
  WHERE "outcome" <> 'ACCEPTED';

-- Reversal lookups: history renders "reversed by" links, which asks this
-- question once per page of movements.
CREATE INDEX "movements_reverses_lookup_idx"
  ON "movements" ("reverses_movement_id")
  WHERE "reverses_movement_id" IS NOT NULL;
