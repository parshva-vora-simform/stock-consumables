---
name: test-race-condition
description: Proves that two people cannot both take the last item — fires many stock-out requests at the same moment against a single remaining unit and checks that exactly one succeeds (FRD T-5/T-6). Use when asked to prove, demo, verify or re-check this, after any change to how movements are saved, or when preparing the walkthrough demo.
---

# Prove two people can't take the last item

The headline claim of this POC: with one unit left, N concurrent stock-out requests yield exactly
one `201` and N−1 × `409 INSUFFICIENT_STOCK`. This skill runs that proof and reports the evidence.

## Before running

Confirm the stack is up (`docker compose ps`) and the database is migrated and seeded. A race
test against an empty schema passes vacuously — check that the seeded item actually exists.

## Single-instance proof (T-5)

```bash
pnpm --filter @stock/server test concurrency
```

What the test must do, and what to verify if you are writing or repairing it:

1. Seed one item at one location to **exactly 1** unit, via a stock-in movement — never by
   writing `stock_balances` directly (that would break stock rule 4 in CLAUDE.md).
2. Fire the stock-outs with `Promise.all`, not sequentially, not with `await` in a loop. Sequential
   requests prove nothing; they are the happy path wearing a disguise.
3. Run both a 2-way and a 50-way race.
4. Loop the whole thing **20 times**. A race that passes once has not been proven — it has been
   sampled.

Assertions that must all hold, per iteration:
- Exactly one response is `201`.
- Every other response is `409` with code `INSUFFICIENT_STOCK` — not 500, not a Prisma error
  string, not a timeout.
- Final `stock_balances.quantity` is `0`. Never negative.
- Exactly one new `movements` row exists for that item and location.
- `movement_attempts` has **N** rows, not 1 — every rejected attempt is recorded too (FR-9.2).
  This is the assertion most often forgotten, and its absence means the audit trail silently
  loses every failure.

## Two-instance proof (T-6)

```bash
docker compose -f docker-compose.test.yml up -d
pnpm --filter @stock/server test multiInstance
docker compose -f docker-compose.test.yml down
```

Fires the same race through nginx round-robin across `server-a` and `server-b`. This proves the
guarantee lives in Postgres rather than in process-local state — an in-memory mutex would pass
T-5 and fail here, which is exactly why this test exists.

## If it fails

The failure mode tells you where to look:

| Symptom | Cause |
|---|---|
| Two or more `201`s | The write path reads a balance and then decides. Find the `findUnique`/`SELECT` on `stock_balances` feeding an `if`, and replace the pair with the single conditional `UPDATE`. |
| Balance went negative | The atomic statement is in place but its `WHERE` predicate is wrong — it is checking `quantity >= 0` rather than `quantity + $signed >= 0`. The `CHECK` constraint should have caught this; verify migration `0002` is applied. |
| `500`s instead of `409`s | A Prisma or Postgres error is escaping the boundary. Map it in `errorHandler` — a rejection must be specific (FR-4.2). |
| Deadlock errors | Multi-row operations are locking balance rows in inconsistent order. Add `ORDER BY item_id, location_id` to batch paths. |
| Passes T-5, fails T-6 | Mutual exclusion is in application memory, not the database. Whatever lock or queue was added, remove it — the row lock is the mechanism. |
| Flaky — passes some iterations | Almost always a genuine race with a narrow window. Do not raise the retry count or loosen the assertion. Increase concurrency until it fails reliably, then fix it. |

Never "fix" a failure by making the test sequential, adding a sleep, retrying the assertion, or
catching the second request's error. The test is the specification.

## Reporting

State the concurrency level, the iteration count, the response distribution, the final balance,
and the movement and attempt row counts. Report failures with the actual numbers — "2 of 50
requests returned 201" — not "the race test failed".
