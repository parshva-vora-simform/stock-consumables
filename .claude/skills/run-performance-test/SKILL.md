---
name: run-performance-test
description: Fill the database with 500,000 movements and measure how fast the stock-total, movement-history and low-stock queries run, saving the evidence to docs/performance.md. Use when asked whether something stays fast at scale, when adding or changing an index, or when preparing the performance section for the walkthrough.
---

# Measure database speed at full scale

FRD NFR-2/3/4 and T-13 require that history and low-stock stay usable at hundreds of thousands of
movements, demonstrated with query plans rather than asserted.

## Load

```bash
pnpm --filter @stock/server loadtest      # 500k movements across 50 items x 10 locations
```

The load script must generate stock through **movements**, batched — never by writing
`stock_balances` directly (stock rule 4 in CLAUDE.md). It should spread `occurred_at` across a wide
date range, or the history date-range filters get measured against unrealistically clustered data
and every plan looks better than it is.

After loading, run `ANALYZE` so the planner has current statistics. Plans captured against stale
statistics are misleading and will be wrong in the walkthrough.

## Measure

Delegate to the `query-performance-checker` agent, or run directly:

```bash
pnpm --filter @stock/server explain       # writes docs/performance.md
```

Capture, at minimum:

| Query | What it proves |
|---|---|
| Balance read from `stock_balances` | Constant cost — the payoff for the running-total decision |
| Derived `SUM(signed_quantity)` for one item | The O(n) cost being traded away — quantify it |
| History page 1 | Baseline |
| History at deep cursor (~100k rows in) | **Keyset's whole claim** — same cost as page 1 |
| History filtered by location + date range | The composite index is actually used |
| Low-stock join | Comparison served from the balances table, not a ledger scan |

Always `EXPLAIN (ANALYZE, BUFFERS)`, run twice, report the second — the first measures cold cache,
not steady state. Record the row counts alongside every plan; a plan without its data volume is
not evidence.

## Red flags

- Sequential scan on `movements` in history or low-stock.
- A `Sort` node in the history query — the composite index should already supply the order; a sort
  means an `ASC`/`DESC` mismatch with the index definition.
- Deep-page cost exceeding page 1 — keyset has regressed to an offset, or the cursor comparison
  was split into separate `AND`ed conditions the planner cannot use as an index range.
- `Rows Removed by Filter` far exceeding rows returned.

## Fixing

Add indexes in a **new migration**, never by editing an applied one. Re-measure after each change
and keep the before/after in `docs/performance.md` — the walkthrough question is "what did you
change and what did it buy", and the answer should be two plans.

Resist adding indexes speculatively. Every index is a write cost on the hottest path in the
system: the movement insert. Add one only when a plan shows it is needed, and say in the appendix
which plan justified it.

## Then reconcile

```bash
pnpm --filter @stock/server reconcile
```

After a large load, assert `stock_balances.quantity == SUM(movements.signed_quantity)` for every
pair (T-14). Any drift means the running-total design has a hole and is a build failure — the
whole defence of that decision rests on this check passing.
