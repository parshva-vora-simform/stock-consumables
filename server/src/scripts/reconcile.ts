/**
 * Proves the cached balance still agrees with the ledger (T-14).
 *
 * The running-total design in FRD §5.1 is only defensible while this passes.
 * It runs in CI after the load test and after the concurrency tests, and any
 * drift is a build failure — not a warning.
 */
import { prisma } from '../db/prisma.js';

type Drift = {
  itemId: string;
  sku: string;
  locationCode: string;
  cached: number;
  ledger: number;
};

async function main() {
  const startedAt = Date.now();

  // One full-outer-join pass rather than a query per item: an item that has
  // movements but no balance row, or a balance row with no movements, is
  // exactly the kind of drift worth catching, and a per-item loop would miss
  // the second case entirely.
  const rows = await prisma.$queryRaw<
    { item_id: string; sku: string; location_code: string; cached: number; ledger: bigint }[]
  >`
    WITH ledger AS (
      SELECT item_id, location_id, SUM(signed_quantity) AS quantity
      FROM movements
      GROUP BY item_id, location_id
    )
    SELECT
      COALESCE(b.item_id, l.item_id)         AS item_id,
      i.sku                                  AS sku,
      loc.code                               AS location_code,
      COALESCE(b.quantity, 0)                AS cached,
      COALESCE(l.quantity, 0)                AS ledger
    FROM stock_balances b
    FULL OUTER JOIN ledger l
      ON l.item_id = b.item_id AND l.location_id = b.location_id
    JOIN items i     ON i.id   = COALESCE(b.item_id, l.item_id)
    JOIN locations loc ON loc.id = COALESCE(b.location_id, l.location_id)
    WHERE COALESCE(b.quantity, 0) <> COALESCE(l.quantity, 0)
  `;

  const drift: Drift[] = rows.map((r) => ({
    itemId: r.item_id,
    sku: r.sku,
    locationCode: r.location_code,
    cached: Number(r.cached),
    ledger: Number(r.ledger),
  }));

  const [pairs, movements] = await Promise.all([
    prisma.stockBalance.count(),
    prisma.movement.count(),
  ]);

  const elapsed = Date.now() - startedAt;

  if (drift.length === 0) {
    console.log(
      `✓ Reconciled ${pairs} item/location balances against ${movements} movements in ${elapsed}ms. No drift.`,
    );
    return;
  }

  console.error(`✗ ${drift.length} balance(s) disagree with the ledger:\n`);
  for (const d of drift) {
    console.error(
      `  ${d.sku} @ ${d.locationCode}: cached ${d.cached}, ledger ${d.ledger} (off by ${d.cached - d.ledger})`,
    );
  }
  console.error(`
This means the running-total design has a hole. Something wrote stock_balances
outside the movement transaction, or a movement was written without its balance
update. Find it before doing anything else — the cached figure is only safe to
read while this check passes.

Rebuild the cache from the ledger with:
  INSERT INTO stock_balances (item_id, location_id, quantity, updated_at)
  SELECT item_id, location_id, SUM(signed_quantity), now()
  FROM movements GROUP BY item_id, location_id
  ON CONFLICT (item_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;

…but rebuilding hides the cause. Find the write first.
`);
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Reconciliation failed to run:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
