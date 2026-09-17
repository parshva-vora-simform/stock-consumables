# Stock & Consumables — project guide

A movement-ledger inventory POC. Read [docs/FRD.md](docs/FRD.md) for the requirements.
Requirement IDs (`FR-4.3`, `T-5`, `UI-4`) used in commits and comments refer to it.

## The four stock rules — read before touching anything

These four are the entire point of the POC. Code that breaks one is wrong even if it passes tests.

1. **No stored, settable quantity.** `Item` has no `quantity` column and never will. Current
   quantity is arrived at only through movements. If you find yourself adding a field or a route
   that accepts an absolute quantity, stop — that is the bug this project exists to prevent.
2. **The ledger is append-only.** `movements` rows are never updated or deleted. A database
   trigger enforces this, so `prisma.movement.update(...)` will throw at runtime. Mistakes are
   corrected by appending a reversal (`movementType = REVERSAL`), never by editing.
3. **The zero floor is one atomic statement.** Never read a balance, decide, then write. The
   check and the decrement are a single conditional `UPDATE ... WHERE quantity + $signed >= 0`.
   Zero rows returned means reject with `409 INSUFFICIENT_STOCK`. Any `findUnique`-then-`update`
   pair on `stock_balances` reintroduces the exact race this POC is about.
4. **Balances are only ever updated relatively.** `quantity = quantity + $signed`. Never
   `quantity = $absolute`, anywhere, including in seeds, scripts and stock-takes.

Only `server/src/modules/movements/repository.ts` may write to `stock_balances` — deletions
included, which is why `deleteBalancesForItem` lives there rather than in the item service that
calls it. A `no-restricted-syntax` rule in `server/eslint.config.js` enforces this, against both
`prisma.stockBalance.*` mutations and raw SQL, so `pnpm lint` fails on a violation. Two files are
exempt by name: the repository itself, and `tests/immutability.test.ts`, which writes the table
directly because proving the database refuses it is the thing under test. Do not add a third, and
do not reach for an inline eslint-disable — it would blend in with a genuine mistake.

## No hardcoded strings

Every enumerated value, error code and route lives in one place. Compare and throw against the
constant, never the literal.

| What | Where | Use |
|---|---|---|
| Roles, directions, movement types, units, outcomes | `shared/src/constants.ts` | `ROLE.MANAGER`, `DIRECTION.OUT`, `MOVEMENT_TYPE.REVERSAL` |
| Error codes | same file | `ERROR.INSUFFICIENT_STOCK` |
| API paths | `shared/src/apiRoutes.ts` | `API.items.detail(id)`; the server registers the same builders with `ID_PARAM` |
| Client routes | same file | `APP_ROUTE.itemDetail(id)` |
| TanStack Query keys | `client/src/api/queryKeys.ts` | `queryKeys.items.detail(id)` |
| Prisma error codes | `server/src/lib/prismaErrors.ts` | `PRISMA_ERROR.UNIQUE_VIOLATION` |

The Zod enums in `shared/src/enums.ts` are **built from** those constants, so a value cannot exist
in a schema without existing in the constant, and a comparison cannot be written against a value
the schema would reject.

Why it matters here specifically: `role === 'MANGER'` is a valid string that simply never matches,
so the permission check silently always fails. `invalidateQueries({ queryKey: ['item', id] })`
against a query registered as `['items', id]` does nothing at all — no error, just a screen that
never refreshes. Both are invisible to the compiler as literals and impossible as constants.

**One exception:** inside a raw SQL template the constant must be *interpolated as a bound value*
(`u.role::text = ${ROLE.MANAGER}`), never pasted into the SQL text. See
`users/service.ts` — getting this wrong produces a syntax error at query time, not compile time.

## Layout

```
client/   React 19 + Vite + TanStack Query   (@stock/client)
server/   Express 5 + Prisma + Postgres      (@stock/server)
shared/   Zod schemas + inferred types       (@stock/shared)  — used by BOTH sides
docs/     FRD
```

`shared/` must stay free of Prisma, Express and anything Node-only — it ships into the browser
bundle. Schemas live there so one definition validates both the form and the API boundary.

## Commands

```bash
pnpm dev                 # client + server concurrently
pnpm --filter @stock/server test          # all integration tests (real Postgres)
pnpm --filter @stock/server test concurrency   # the race test (T-5)
pnpm --filter @stock/server prisma:migrate    # create/apply a migration
pnpm --filter @stock/server seed
pnpm --filter @stock/server reconcile     # assert balance == SUM(ledger)  (T-14)
pnpm lint                                 # includes the stock_balances and useOptimistic rules
docker compose up                         # full stack, migrated + seeded
docker compose -f docker-compose.test.yml up   # two server instances for T-6
```

## Conventions

**Server**
- Layering is `route → validate → authenticate → location scope → service → repository → Prisma`.
  Routes hold no business logic; repositories hold no HTTP concepts.
- Validation happens at the route boundary with a Zod schema from `shared/`, before any service
  call. Bad input must never reach business logic (FR-3.2).
- Errors are thrown as `AppError(code, status, details)` and rendered by `errorHandler` into the
  uniform envelope. Never `res.status(500).send(err.message)`. Prisma error codes are mapped at
  the boundary so a raw DB error never escapes.
- Raw SQL (`tx.$queryRaw`) is expected and correct for the conditional balance update and the
  keyset history query — Prisma's query builder cannot express either. Always parameterised,
  never string-interpolated.
- Every movement attempt, accepted or rejected, writes a `MovementAttempt` row **outside** the
  business transaction, so a rollback cannot erase its own audit record (FR-9.3).
- Lists support BOTH paging modes in one envelope: `?page=N` for the UI (people think in pages),
  and `?cursor=` for anything walking the whole list. Send one or the other — a cursor wins.
- The page-number path uses `OFFSET`, which is acceptable for the depths a person clicks to. Deep
  or programmatic traversal must use the cursor, which stays O(1) per page (FR-8.3).
- Counts are **capped** at `COUNT_CAP` (1,000) in `lib/paging.ts`. Past it, `total` is the cap and
  `totalIsExact` is false, so the UI shows "1,000+" and withholds the last-page button rather than
  claiming a page number nobody counted to. Never remove the cap: an uncapped `COUNT(*)` over
  500,000 movements costs more than the page it decorates.
- A count query must share its WHERE clause with the rows query. If they drift, the count
  describes a different set and the last page silently misbehaves.
- A `?locationId=` filter **narrows** the caller's scope; it never replaces it. Refuse an
  unreachable one with 403 (`assertInScope`) and intersect the rest (`narrowScope`). Passing the
  filter straight into a query makes it the authority on what is visible, and then any location id
  returns its quantities to anyone who asks — which is how `GET /items?locationId=` leaked.
- `hasNext` comes from the `limit + 1` probe row, never from `rows.length === pageSize`. The
  latter is right until the last page is exactly full, and then contradicts `totalPages` and the
  null cursor sitting beside it in the same envelope.
- **Every list sorts, filters and pages in SQL.** No endpoint returns a whole table for the client
  to narrow. Sorting a page you already have is not sorting the data — it answers a different
  question and is wrong as soon as there is more than one page.
- Sort fields are an **allow-list per resource** in `shared/src/query.ts`, never a free string: a
  free-form field name reaches the database as an identifier, and the list is also where "is this
  column actually indexed?" gets answered once.
- Every keyset orders by `(sortColumn, id)`. The `id` tiebreaker is not optional — sort columns
  like `min_threshold` are full of duplicates, and without it equal rows sit in an order the
  planner may change between queries, so a row can appear on two pages or on none.
- Aggregates that are sortable (`totalQuantity`, `movementCount`) are computed in SQL via a
  lateral join, and cast with `::int` — `SUM()`/`COUNT()` return bigint, which cannot be
  serialised to JSON and travels inside the cursor.
- A malformed cursor is a `400`, never silently ignored. Ignoring it restarts at page one, which
  looks like working pagination until someone notices duplicated rows.

**Team management (manager only)**
- Location access is set through `PUT /users/:id/locations` with the FULL set, not add/remove
  calls. Moving someone from WH-A to SITE-1 must be one atomic change — there is no instant where
  they can reach both, or neither.
- Every grant and revoke is appended to `location_access_changes`, attributed and timestamped,
  and that table is append-only too. Who could move stock where, and since when, is a question
  the system must be able to answer about the past — the grant table only shows the present.
- Revoking access never touches past movements. They are immutable and stay attributed to whoever
  recorded them; losing access from now on is not the same as never having been there.
- A manager has no grant rows at all — the role reaches every location. Restricting one is
  refused rather than silently stored, because stored grants would imply a limit that is not there.

**Passwords and sessions**
- Reset tokens are stored as a SHA-256 hash, never in the clear. A leaked database must not yield
  usable reset links.
- `/auth/forgot-password` always answers 200 with the same message, registered or not. A precise
  answer turns it into a way to enumerate who works here.
- Changing a password bumps `users.token_epoch`, and every token carries the epoch it was minted
  under. Do NOT replace this with an `iat`-vs-timestamp comparison: `iat` is whole seconds and the
  timestamp has milliseconds, so strict comparison locks out accounts created in the same second
  while second-level truncation lets a reset within that second invalidate nothing. An integer has
  no such window.
- `/auth/forgot-password` throttles at five requests per account per hour, and a throttled
  request returns the SAME 200 and message as an unthrottled one. It must never answer 429: an
  unregistered address always gets 200, so a distinguishable response on the sixth request states
  "this address is registered" as plainly as the precise message the endpoint refuses to send.
  The cost is that a genuine user who trips the limit waits for a link that is not coming.
- Refresh tokens rotate. Every exchange spends the presented token and issues a replacement in the
  same family; presenting a spent one is replay, and revokes the whole family rather than that one
  row — the other party is holding a descendant of it. Sign-out revokes the family server-side via
  `POST /auth/logout`, because clearing browser storage only forgets a credential that anything
  which copied it can still use for a week.
- The refresh token is in `localStorage` and it is a FULL credential — it mints access tokens on
  demand. Keeping the access token in memory narrows what an accidental leak exposes; it buys
  nothing against a script running on the page. Rotation is what limits the damage, not storage.
- There is no mail provider. Outside production the reset link is returned in the response and
  logged; in production it is issued and not delivered, which fails closed. Wiring a provider into
  `passwordReset.ts` is the one remaining production step.

**Items**
- `DELETE /items/:id` deletes only an item **no movement has ever referenced**. One with history is
  deactivated instead, and the response says which happened (`deleted: true|false`) so the UI can
  tell the truth. Never make this a hard delete: movements are immutable history, and removing the
  item would either orphan them or cascade away part of the audit trail.
- `unitOfMeasure` is editable only while the item has no movements. Quantities in the ledger mean
  nothing without it — relabelling 40 boxes as 40 kilograms silently rewrites every past row.
- Deactivated items reject new movements with `422 ITEM_INACTIVE` but stay fully readable.

**Client**
- TanStack Query for all server state; no server data in `useState`.
- React 19: use `useActionState` for form submits, `ref` as a prop (no `forwardRef`).
  **Do not use `useOptimistic` for stock-out** — the server is the sole authority on whether it
  succeeded; an optimistic decrement is the UI version of the race in FR-4.3. A lint rule in
  `client/eslint.config.js` refuses the call outright rather than leaving it to review.
- An idempotency key identifies an INTENT, not a request. Mint it once per form
  (`useState(() => crypto.randomUUID())`) and replace it only after a movement is recorded.
  Generating one inside the submit handler gives every attempt a different key, so the server's
  unique index never matches and a resubmit after a timeout records a second movement — FR-2.4
  defeated by the client while the server holds up its end perfectly.
- On `409 INSUFFICIENT_STOCK`, render `error.details.available` inline at the field. Never
  flatten a specific rejection into a generic toast.
- Access token lives in memory, not `localStorage`.
- UI role/location gating is cosmetic. The server enforces it independently; never rely on a
  hidden button as the control.

**Testing**
- Integration tests run against a real Postgres (Testcontainers). Do not mock Prisma — a mock
  cannot exhibit row-level locking, which is the only thing worth proving here.
- Concurrency tests fire with `Promise.all` and loop 20× — a race that passes once proves nothing.
- Every new endpoint needs: a bad-input test, an unauthenticated test, and a wrong-location test.

## Migrations

Prisma cannot express `CHECK` constraints or triggers. Those live in hand-written SQL inside
`server/prisma/migrations/0002_ledger_immutability/`. If you regenerate migrations, do not drop
them — the `CHECK (quantity >= 0)` and the append-only trigger are load-bearing.

## Gotchas

- A first-ever movement needs its balance row to exist; `recordMovement` does an
  `INSERT ... ON CONFLICT DO NOTHING` at qty 0 before the conditional update. Don't remove it.
- Reversing a stock-**in** removes stock, so it is subject to the zero floor like any stock-out
  and can legitimately fail with `409`. This is intended (FR-6.4) — resolve as a stock-take.
- Transaction isolation is `ReadCommitted` deliberately. `Serializable` adds retry loops for no
  extra guarantee here; don't "upgrade" it.
