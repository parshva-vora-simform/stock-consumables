# Functional Requirements Document — Stock & Consumables

| | |
|---|---|
| **POC** | Stock and Consumables |
| **Track** | Inventory · Status: Required |
| **Path** | React to Full Stack — 101 (2-week solo POC) |
| **Stack** | React 19 + TypeScript (Vite) · Express 5 + TypeScript · PostgreSQL 16 · Prisma |
| **Version** | 2.0 — revised against the built system |
| **Date** | 2026-09-17 |

> **Version 2.0** reconciles this document with what was actually built. Requirements that changed
> during implementation are marked **[revised]** with the reason; requirements added afterwards are
> marked **[added]**. §12 gives the status of every requirement, including what is still
> outstanding.

---

## 1. Purpose & Scope

### 1.1 Problem
Stock counts drift from reality because quantity is a number people type in. Two failure modes dominate:

1. **Untracked mutation** — someone issues an item and updates the count later, or not at all. There is no record of who changed what.
2. **Lost update under concurrency** — two handlers pull the last unit at nearly the same moment. Both reads see `qty = 1`, both writes succeed, the shelf goes to `-1` or the second write silently overwrites the first.

### 1.2 Solution statement
Every change to stock is an **immutable movement** appended to a ledger. Current quantity is **never** a directly writable field — it is arrived at only through movements. The system guarantees stock cannot be issued past zero **per item, per location**, including when two stock-out requests race for the same last unit.

### 1.3 In scope
- Items, locations, users, authentication.
- Immutable movement ledger (stock in / stock out).
- Derived current quantity with an enforced zero floor.
- Per-location stock tracking and per-location zero floor.
- Corrections via reversing movements (no edit, no delete).
- Low-stock view backed by a real SQL query.
- Paginated, filterable per-item movement history.
- Structured audit trace for every movement attempt — accepted **and** rejected.
- `docker compose up` bring-up with no manual steps beyond a documented `.env`.
- **[added]** Item lifecycle: create, edit, deactivate, delete (§3.11).
- **[added]** Team management: assigning handlers to locations, and an audited history of those
  changes (§3.12).
- **[added]** Password reset, and session invalidation on password change (§3.13).

### 1.4 Out of scope
- Purchase orders, suppliers, costing/valuation, barcode scanning.
- Stock transfers between locations as a first-class object (modelled as a paired out+in in v1; see §5.6).
- Multi-tenant / organisation hierarchy.
- Email or push notification of low-stock alerts (view only).
- Offline-first client.
- Outbound email. Password reset issues a token but does not deliver it; see §3.13.

### 1.5 Definitions
| Term | Meaning |
|---|---|
| **Movement** | An immutable ledger row: one stock-in or stock-out event against one item at one location. |
| **Balance** | Current quantity of one item at one location. Derived from movements, never typed in. |
| **Zero floor** | The invariant `balance >= 0` for every (item, location) pair, at all times. |
| **Reversal** | A movement that negates an earlier movement. The only correction mechanism. |
| **Stock-take** | A physical count entered against an item/location, reconciled by a generated correcting movement. |

---

## 2. Actors & Permissions

| Actor | Capabilities |
|---|---|
| **Stock Handler** | Record stock-in / stock-out movements, view current quantity and movement history — **only for locations they are granted access to**. |
| **Manager** | Everything a handler can do, across **all** locations. Configure item minimum thresholds. View the low-stock dashboard across locations. Perform stock-takes. |
| **System (unauthenticated)** | Nothing. There is no anonymous path through this system. |

### 2.1 Access rules
- **AC-1** Every write endpoint requires a valid authenticated session. No movement can exist without a `recordedByUserId` pointing at a real user.
- **AC-2** A handler's access is scoped by rows in `UserLocationAccess`. The scope is applied **as a predicate inside the query**, not as a post-fetch filter and not as a UI-only hide.
- **AC-3** A handler acting on a location they lack access to receives `403 FORBIDDEN_LOCATION`. This is proven by an integration test hitting the API directly, bypassing the UI.
- **AC-4** Threshold configuration is manager-only (`403` for handlers).
- **AC-5** A handler reading the low-stock view sees only their accessible locations. A manager sees all.

---

## 3. Functional Requirements

### 3.1 Items & Locations

| ID | Requirement |
|---|---|
| FR-1.1 | An item has: `name` (unique, required), `sku` (unique, required), `unitOfMeasure` (enum: `EACH`, `KG`, `LITRE`, `METRE`, `BOX`, `PACK`), `minThreshold` (integer ≥ 0, default 0), `isActive`. |
| FR-1.2 | A location has: `code` (unique), `name`, `isActive`. |
| FR-1.3 | Items may be created, renamed, and have their `minThreshold` changed. **No item field represents current quantity.** The `Item` model has no `quantity`/`stock`/`onHand` column — this is structural, not a convention. |
| FR-1.4 | An item cannot be hard-deleted once it has movements; it is deactivated (`isActive = false`). Deactivated items reject new movements with `422 ITEM_INACTIVE`. |
| FR-1.5 | Stock is tracked per **(item, location)** pair. There is no global quantity for an item; the "total across locations" shown in the UI is an explicit aggregate, labelled as such. |

### 3.2 Movements — general

| ID | Requirement |
|---|---|
| FR-2.1 | A movement records: `itemId`, `locationId`, `direction` (`IN` \| `OUT`), `quantity` (positive integer, the magnitude), `signedQuantity` (`+quantity` for IN, `-quantity` for OUT — persisted, used for summation), `recordedByUserId`, `occurredAt`, `createdAt`, optional `reference` (e.g. `"PO #4521"`), optional `note` (e.g. `"issued to site A"`). |
| FR-2.2 | Movements are **append-only**. There is no `PATCH /movements/:id` and no `DELETE /movements/:id`. This is enforced at three layers: (a) no such route exists, (b) the Prisma service layer exposes only `create`, (c) a Postgres rule/trigger raises an exception on `UPDATE` or `DELETE` against `movements`, so even a stray `prisma.movement.update` or manual SQL fails. |
| FR-2.3 | Every movement gets a `movementType`: `NORMAL`, `REVERSAL`, or `STOCK_TAKE_ADJUSTMENT`. |
| FR-2.4 | A client-supplied `idempotencyKey` (UUID) may be sent with any movement. A repeat of the same key by the same user returns the **original** movement with `200` instead of creating a second one. This prevents double-issue from a double-clicked button or a retried request. Enforced by a unique index, not an application-level check-then-insert. |

### 3.3 Stock In

| ID | Requirement |
|---|---|
| FR-3.1 | Recording a stock-in always succeeds given valid input, and increases the derived quantity for that (item, location). |
| FR-3.2 | Input is validated **before business logic** by a Zod schema at the route boundary: `quantity` must be an integer `>= 1`; `itemId` / `locationId` must be well-formed identifiers; `occurredAt`, if supplied, must not be in the future. Failures return `400 VALIDATION_ERROR` with a field-level error list. |
| FR-3.3 | Referential validity (item exists, location exists, both active) is enforced by foreign keys **and** checked in the same transaction, returning `404 ITEM_NOT_FOUND` / `404 LOCATION_NOT_FOUND` rather than a raw FK violation. |

### 3.4 Stock Out & the Zero Floor — *the core requirement*

| ID | Requirement |
|---|---|
| FR-4.1 | A stock-out is accepted **only if** it would not take the balance for that (item, location) below zero. |
| FR-4.2 | If insufficient, the request is rejected with `409 INSUFFICIENT_STOCK`, a body carrying `{ itemId, locationId, requested, available }`. Not a generic 500, not a silent success. |
| FR-4.3 | **Concurrency guarantee:** given balance = 1 and two simultaneous stock-out requests for 1 unit, **exactly one** succeeds and the other returns `409 INSUFFICIENT_STOCK`. This holds regardless of how the two requests are interleaved, and regardless of whether they are served by the same application instance or two. |
| FR-4.4 | The guarantee does not rely on the application reading a balance and then deciding. See §5.3 for the mechanism (conditional atomic UPDATE + DB `CHECK` constraint). |
| FR-4.5 | A `CHECK (quantity >= 0)` constraint on the balance table is the last line of defence. If application logic is ever bypassed, the database refuses the write. |

### 3.5 Multiple Locations

| ID | Requirement |
|---|---|
| FR-5.1 | Balances are keyed by `(itemId, locationId)` with a unique constraint. |
| FR-5.2 | The zero-floor rule of FR-4.1 applies **independently per location**. A stock-out at Location A is never satisfied by stock at Location B, even when the item's total across all locations is sufficient. A test asserts exactly this. |
| FR-5.3 | A move between locations is recorded as two linked movements — an `OUT` at source and an `IN` at destination — created in one transaction and sharing a `transferGroupId`. The `OUT` leg is subject to the zero floor; if it fails, neither leg is written. |

### 3.6 Correcting a Mistake

**Rule (documented, and enforced):** *a movement is never edited or deleted. A mistake is corrected by appending a **reversal movement** that exactly negates the original, optionally followed by a fresh correct movement.*

| ID | Requirement |
|---|---|
| FR-6.1 | `POST /movements/:id/reverse` creates a new movement with `movementType = REVERSAL`, `reversesMovementId = :id`, the opposite `direction`, and the **same** `quantity` as the original. |
| FR-6.2 | A movement can be reversed **at most once** — enforced by a unique index on `reversesMovementId`. A second attempt returns `409 ALREADY_REVERSED`. |
| FR-6.3 | A reversal cannot itself be reversed (`409 CANNOT_REVERSE_REVERSAL`). To undo a reversal, record a new normal movement. |
| FR-6.4 | Reversing a stock-**in** removes stock, so it is subject to the zero floor exactly like any stock-out. If the stock has since been issued, the reversal is rejected with `409 INSUFFICIENT_STOCK` — the operator must resolve it as a stock-take instead. This is deliberate: the ledger never lies to make a correction convenient. |
| FR-6.5 | Reversals carry a mandatory `reason` string. |
| FR-6.6 | History displays a reversed movement struck through with a link to its reversal, and the reversal linked back. Neither row disappears. The audit trail is complete and reconstructible at any point in time. |
| FR-6.7 | Because history is intact, **balance as of any timestamp** is answerable: `SUM(signedQuantity) WHERE occurredAt <= T`. |

### 3.7 Low-Stock View

| ID | Requirement |
|---|---|
| FR-7.1 | A view listing every (item, location) whose current quantity is **at or below** the item's `minThreshold`. |
| FR-7.2 | This is a real SQL query — an indexed join between balances and items with the comparison in the `WHERE` clause. It is **not** "fetch all items, filter in JS". |
| FR-7.3 | Filterable by location; sortable by severity (`quantity - minThreshold` ascending, most critical first). |
| FR-7.4 | Scoped by the caller's location access (AC-5). |
| FR-7.5 | Paginated. |

### 3.8 Movement History

| ID | Requirement |
|---|---|
| FR-8.1 | Per-item list of all movements: who, when, direction, quantity, location, reference, note, resulting type. |
| FR-8.2 | Filterable by date range (`from`, `to` on `occurredAt`), by location, by direction, and by user. |
| FR-8.3 | **Keyset (cursor) pagination** on `(occurredAt DESC, id DESC)`, not `OFFSET`. Offset pagination degrades linearly — page 5,000 of a 100,000-row history forces the database to walk and discard 100,000 rows. Keyset stays constant-cost at any depth. |
| FR-8.4 | Response returns `{ data: [...], nextCursor: string | null }`. No total count by default (counting 100k+ rows on every page load is the same trap); an explicit `?includeTotal=true` returns an estimate. |
| FR-8.5 | The query is served by a composite index and must not load all rows into memory. Verified by `EXPLAIN ANALYZE` in the performance appendix. |

### 3.9 Audit Trace

| ID | Requirement |
|---|---|
| FR-9.1 | **Every** movement attempt leaves a structured record in `MovementAttempt` — whether accepted or rejected. |
| FR-9.2 | Each record holds: `userId`, `attemptedAt`, `itemId`, `locationId`, `direction`, `quantity`, `outcome` (`ACCEPTED` \| `REJECTED_INSUFFICIENT_STOCK` \| `REJECTED_VALIDATION` \| `REJECTED_FORBIDDEN` \| `REJECTED_NOT_FOUND`), `failureDetail`, `resultingMovementId` (null when rejected), `requestId`, `ipAddress`. |
| FR-9.3 | Rejected attempts are written **outside** the failed transaction, so a rolled-back business transaction does not roll back its own audit record. |
| FR-9.4 | The same event is emitted to structured JSON logs (pino) with the shared `requestId`, so a rejection is traceable across both the log stream and the database. |
| FR-9.5 | An audit view (manager-only) lists attempts filtered by user, item, outcome, and date range — paginated, keyset. |

### 3.10 Stock-Take Reconciliation *(stretch, §8 of brief)*

| ID | Requirement |
|---|---|
| FR-10.1 | A manager enters a physical count for an (item, location). |
| FR-10.2 | The system computes `delta = countedQuantity - currentBalance` and, if non-zero, appends **one** movement of `movementType = STOCK_TAKE_ADJUSTMENT` with that delta's direction and magnitude, linked to a `StockTake` record holding the counted figure, the system figure at the time, the counter, and a mandatory reason. |
| FR-10.3 | The derived quantity is **never** written to directly, even here. A stock-take is just another movement. This is the acid test of FR-1.3. |
| FR-10.4 | Batch mode: a stock-take session covers many items at one location, applied in one transaction. |

### 3.11 Item lifecycle **[added]**

| ID | Requirement |
|---|---|
| FR-11.1 | A manager can create an item with SKU, name, unit of measure and threshold. It starts with no stock anywhere — there is no field for an opening quantity. |
| FR-11.2 | Name, SKU and threshold are editable at any time. SKU changes are checked for uniqueness. |
| FR-11.3 | `unitOfMeasure` is editable **only while the item has no movements**. A quantity in the ledger is meaningless without its unit: relabelling 40 boxes as 40 kilograms would silently reinterpret every past row. Attempting it afterwards returns `409 ITEM_HAS_MOVEMENTS`. |
| FR-11.4 | Deleting an item removes it **only if no movement has ever referenced it**. Otherwise it is deactivated, and the response states which happened. Hard-deleting one with history would orphan immutable rows or cascade away part of the audit trail. |
| FR-11.5 | Deactivated items reject new movements with `422 ITEM_INACTIVE`, remain fully readable, and can be reactivated. |
| FR-11.6 | Handlers cannot create, edit or delete items. |

### 3.12 Team and location assignment **[added]**

Location scoping (§2.1) was specified but had no way to be configured. This is that mechanism.

| ID | Requirement |
|---|---|
| FR-12.1 | A manager can create a handler account, optionally pre-assigned to locations. |
| FR-12.2 | A manager can replace a handler's **whole set** of locations in one request. A full set rather than add/remove calls: moving someone from WH-A to SITE-1 must be atomic, with no instant in which they can reach both, or neither. |
| FR-12.3 | Every grant and revoke is appended to an immutable history with who changed it, when, and an optional reason. The grant table shows only the present; "who could issue stock at SITE-1 last March?" needs history. |
| FR-12.4 | Revoking access **never touches past movements**. They stay attributed to whoever recorded them — losing access from now on is not the same as never having been there. |
| FR-12.5 | A manager cannot be restricted to locations (the role grants all of them), and cannot deactivate or demote their own account. |
| FR-12.6 | Access changes take effect on the next request. Access is resolved per request, not baked into the token. |

### 3.13 Password reset and session invalidation **[added]**

| ID | Requirement |
|---|---|
| FR-13.1 | Anyone can request a reset link by email. The response is **identical** whether or not the address is registered — a precise answer turns the endpoint into a way to enumerate staff. |
| FR-13.2 | Only the SHA-256 **hash** of a token is stored. A leaked database must yield no usable links. |
| FR-13.3 | A token is single-use and expires in 30 minutes. Requesting a new one invalidates any earlier one. Unknown, spent and expired tokens return the same message. |
| FR-13.4 | Completing a reset **ends every existing session** for that account. Changing the lock has to invalidate the keys, or a compromised password leaves the intruder signed in until their token expires. |
| FR-13.5 | Reset requests are throttled to 5 per account per hour. |
| FR-13.6 | A manager can issue a reset link on someone's behalf, recorded against the manager. Handlers frequently have no work email; the alternative in practice is a manager inventing a password and sending it over chat. |
| FR-13.7 | A signed-in user can change their own password, which requires the current one and likewise ends their sessions. |
| FR-13.8 | There is no mail provider. Outside production the link is returned in the response; in production it is issued and not delivered, which fails closed rather than leaking. |

### 3.14 Sorting, filtering and pagination **[revised]**

FR-7.5 and FR-8.3 asked for pagination on two views. In the built system it is uniform across
every list, and page numbers were added on top of the cursor scheme.

| ID | Requirement |
|---|---|
| FR-14.1 | Every list — items, low stock, movement history, team — sorts, filters, searches and paginates **in the database**. No endpoint returns a whole table for the client to narrow. |
| FR-14.2 | Sort fields are an explicit allow-list per resource, never a free string. A free-form field name reaches the database as an identifier, and the list is also where "is this column indexed?" is answered. |
| FR-14.3 | Every keyset orders by `(sortColumn, id)`. Sort columns such as `min_threshold` are full of duplicates; without a unique tiebreaker equal rows sit in an order the planner may change between queries, so a row can appear on two pages or on none. |
| FR-14.4 | Lists accept **either** `?page=N` or `?cursor=…` and return both. Page numbers are for people; the cursor stays O(1) per page for anything traversing a whole list. |
| FR-14.5 | Counts are capped (1,000). Past the cap `total` is the cap and `totalIsExact` is false, so the UI shows "1,000+" rather than counting half a million rows to size a page strip. |
| FR-14.6 | A malformed cursor is a `400`, never ignored. Ignoring it silently restarts at page one, which looks like working pagination until rows start repeating. |

### 3.15 Movement idempotency **[revised]**

FR-2.4 specified idempotency keys. Implementation showed the obvious version is wrong.

| ID | Requirement |
|---|---|
| FR-15.1 | A repeated key returns the **original movement** with `201`, not a conflict. From the caller's point of view the submit happened exactly once. |
| FR-15.2 | The guarantee is the unique index, not a pre-flight check. Two concurrent requests with the same key both find nothing on a check-then-insert; the loser catches the constraint violation and returns the winner's movement. |
| FR-15.3 | Keys are scoped per user. Two people generating the same key is not a retry. |
| FR-15.4 | A key is not consumed by a refused movement — nothing was recorded, so retrying after a restock legitimately succeeds. |

---

## 4. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | **Bring-up:** `docker compose up` starts Postgres, runs migrations, seeds demo data, and serves API + web. No manual step beyond copying `.env.example` to `.env`. |
| NFR-2 | **Read performance:** current-quantity lookup is O(1) — a single indexed row read — independent of ledger depth. Balance for one item across all locations: ≤ 10ms at 500,000 movements. |
| NFR-3 | **History performance:** any page of movement history returns in ≤ 50ms at 500,000 movements, at any page depth. Demonstrated with `EXPLAIN (ANALYZE, BUFFERS)`. |
| NFR-4 | **Low-stock performance:** ≤ 100ms across 50 items × 10 locations. |
| NFR-5 | **Correctness:** the zero floor holds under 50 concurrent stock-out requests against a balance of 1 — exactly 1 success, 49 × `409`. Asserted in an automated test, not observed manually. |
| NFR-6 | **Consistency:** a reconciliation job asserts `balance.quantity == SUM(movements.signedQuantity)` for every (item, location). It runs in CI against the seeded + load-tested dataset. Any drift is a build failure. |
| NFR-7 | **Auth:** JWT access tokens (short-lived) + refresh tokens; passwords hashed with argon2. |
| NFR-8 | **Type safety:** shared TypeScript types between API and web; Zod schemas are the single source of truth for request/response shapes. |
| NFR-9 | **Test coverage:** integration tests run against a real Postgres (Testcontainers or a compose-managed test DB), never a mock — concurrency guarantees cannot be proven against a mock. |
| NFR-10 | **Observability:** structured JSON logging with a per-request `requestId` propagated into audit rows. |

---

## 5. Design Decisions (with rationale to defend)

### 5.1 Decision: running-total balance table, not sum-on-read

> *"At 100,000 movements behind a single item, is current quantity summed from the ledger on every read, or kept as a running total?"*

**Chosen: a materialised `StockBalance` row per (item, location), updated inside the same transaction as every movement insert.**

| | Sum-on-read | Running total *(chosen)* |
|---|---|---|
| Read cost at 100k movements | Index scan + aggregate over 100k rows; ~40–120ms, and it grows forever | Single PK row read; ~0.2ms, constant |
| Low-stock view across 50 items | 50 aggregates, or one big `GROUP BY` over the whole ledger | Indexed join over ~500 balance rows |
| Zero-floor enforcement | Requires `SELECT … FOR UPDATE` on a *set* of rows, or `SERIALIZABLE` with retry loops | One conditional `UPDATE` on one row — the row lock *is* the mutual exclusion |
| Risk | None — single source of truth | Denormalisation can drift |

**Why the risk is acceptable and controlled:**
1. The balance is updated in the **same transaction** as the movement insert. Both commit or neither does — drift from partial failure is impossible.
2. No code path writes `StockBalance.quantity` to an absolute value. It is only ever `quantity = quantity + :signed` — a relative, commutative update. This is why "you can't set a quantity directly" survives even with a stored total.
3. A `CHECK (quantity >= 0)` constraint makes a negative balance unrepresentable.
4. NFR-6's reconciliation job proves equality against the ledger continuously.

**The ledger remains the source of truth.** `StockBalance` is a derived cache with a proof obligation, not an authority. It can be rebuilt from scratch at any time:

```sql
INSERT INTO stock_balances (item_id, location_id, quantity)
SELECT item_id, location_id, SUM(signed_quantity)
FROM movements GROUP BY item_id, location_id
ON CONFLICT (item_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;
```

### 5.2 The sum-on-read query (still implemented, for the walkthrough)

Exposed at `GET /items/:id/balance?mode=derived` so the two can be compared live, and used by the reconciliation job:

```sql
SELECT location_id, SUM(signed_quantity) AS quantity
FROM movements
WHERE item_id = $1
GROUP BY location_id;
```

Cost at 100,000 movements for one item: index-only scan on `(item_id, location_id, signed_quantity)` then aggregate — the whole 100k rows must be touched, so it is **O(n) and unbounded**. The walkthrough will show both plans side by side.

### 5.3 The zero-floor mechanism

A stock-out executes this, inside a transaction:

```sql
UPDATE stock_balances
SET quantity = quantity - $qty
WHERE item_id = $item AND location_id = $loc AND quantity >= $qty
RETURNING quantity;
```

- **Zero rows returned ⇒ reject** with `409 INSUFFICIENT_STOCK`; roll back; write the audit row.
- **One row returned ⇒ accept**; insert the movement; commit.

Why this is race-free without any application-level locking: Postgres takes a row-level exclusive lock for the duration of the `UPDATE`. A second concurrent transaction targeting the same row **blocks** until the first commits, then **re-evaluates its `WHERE` clause against the committed value** (`READ COMMITTED` re-check semantics for `UPDATE`). It therefore sees `quantity = 0`, matches no row, and is rejected. There is no window in which both requests observe `quantity = 1`, because neither ever *reads then decides* — the check and the decrement are one atomic statement.

The `CHECK (quantity >= 0)` constraint catches anything that ever gets past this.

**Deadlock avoidance:** multi-row operations (transfers, batch stock-takes) always lock balance rows in a deterministic order (`ORDER BY item_id, location_id`).

### 5.4 Indexes

| Index | Serves |
|---|---|
| `stock_balances (item_id, location_id)` UNIQUE | Balance lookup, zero-floor UPDATE |
| `stock_balances (location_id, quantity)` | Low-stock scan per location |
| `movements (item_id, occurred_at DESC, id DESC)` | History keyset pagination (FR-8.3) |
| `movements (item_id, location_id, occurred_at DESC, id DESC)` | Location-filtered history |
| `movements (item_id, location_id) INCLUDE (signed_quantity)` | Derived-sum reconciliation (index-only scan) |
| `movements (idempotency_key, recorded_by_user_id)` UNIQUE | FR-2.4 |
| `movements (reverses_movement_id)` UNIQUE | FR-6.2 |
| `movement_attempts (user_id, attempted_at DESC)` | Audit view |

### 5.5 Data model (outline)

```
User            id, email, passwordHash, name, role(HANDLER|MANAGER), isActive
Location        id, code!, name, isActive
UserLocationAccess  userId, locationId                       [unique pair]
Item            id, sku!, name!, unitOfMeasure, minThreshold, isActive
                -- deliberately NO quantity column

Movement        id, itemId, locationId, direction(IN|OUT), quantity(>0),
                signedQuantity, movementType(NORMAL|REVERSAL|STOCK_TAKE_ADJUSTMENT),
                recordedByUserId, occurredAt, createdAt, reference?, note?,
                reversesMovementId?, transferGroupId?, stockTakeId?, idempotencyKey?
                -- append-only, enforced by DB trigger

StockBalance    itemId, locationId, quantity CHECK(>=0), updatedAt   [unique pair]
                -- derived; only ever updated relatively

MovementAttempt id, userId, attemptedAt, itemId?, locationId?, direction, quantity,
                outcome, failureDetail?, resultingMovementId?, requestId, ipAddress

StockTake       id, itemId, locationId, countedQuantity, systemQuantity,
                countedByUserId, reason, createdAt, adjustmentMovementId?
```

### 5.6 Session invalidation is a counter, not a timestamp **[added]**

A password change must end existing sessions. The obvious implementation compares a JWT's `iat`
against a `passwordChangedAt` timestamp. That cannot be made correct: `iat` is in whole seconds and
the timestamp carries milliseconds, so

- compared strictly, a token minted in the same second as account creation looks older than the
  account and the user is locked out immediately;
- compared at second precision, a reset within a second of signing in invalidates nothing.

Both failures were observed in tests. There is no precision at which both hold, so the decision
moved to `users.token_epoch`: an integer bumped on every password change and carried in each token,
refused the moment the two disagree. No clocks, no window. (Migration `0007`.)

### 5.7 The audit table has no foreign keys **[added]**

`movement_attempts.item_id` originally referenced `items`. That made one category of attempt
impossible to record: a movement against an item id that does not exist. The insert failed, the
audit row was dropped, and the trace was lost — while FR-9.2 requires the opposite, because a
caller repeatedly referencing absent item ids is exactly the pattern an audit trail should
preserve. The constraint was removed in migration `0004`; the id is still stored and still joinable
when the item exists.

### 5.8 Deferred decisions
- Transfers are modelled as paired movements (FR-5.3) rather than a first-class `Transfer` entity — sufficient for the POC, and a `transferGroupId` leaves the upgrade path open. **Not yet implemented.**
- `quantity` is an integer. Fractional units (0.5 kg) would need `Decimal`; noted as a known v1 limitation since the zero-floor logic is identical either way.
- Page numbers use `OFFSET`, which is acceptable at the depths a person clicks to but not at the depths FR-8.3 is concerned with. The cursor API remains for that, and both ship in one response envelope (FR-14.4).

---

## 6. API Surface

All routes under `/api/v1`. Everything except `/health` and `/auth/*` requires
`Authorization: Bearer <token>`.

### Auth

| Method | Route | Notable responses |
|---|---|---|
| `POST` | `/auth/login` | `401 INVALID_CREDENTIALS` |
| `POST` | `/auth/refresh` | Rotates the token; `401` on a spent, revoked or expired one |
| `POST` | `/auth/logout` | `204`; revokes the refresh token's whole family |
| `GET` | `/auth/me` | Current user and accessible locations |
| `POST` | `/auth/forgot-password` | Always `200`, identically — throttled, unknown or sent |
| `POST` | `/auth/reset-password` | `400 INVALID_RESET_TOKEN` |
| `POST` | `/auth/change-password` | `401` if the current password is wrong |

### Items and stock

| Method | Route | Notable responses |
|---|---|---|
| `GET` | `/items` | Search, filter, sort, paginate |
| `POST` | `/items` | Manager. `409 SKU_EXISTS` |
| `GET` | `/items/:id` | `404 ITEM_NOT_FOUND` |
| `PATCH` | `/items/:id` | Manager. `409 SKU_EXISTS`, `409 ITEM_HAS_MOVEMENTS` |
| `DELETE` | `/items/:id` | Manager. Returns `{ deleted, movements }` (FR-11.4) |
| `GET` | `/items/:id/balance` | `?mode=derived` sums the ledger instead of reading the cache |
| `GET` | `/items/:id/movements` | History — filter, sort, paginate |
| `GET` | `/items/low-stock` | At or below threshold, worst first |
| `GET` | `/locations` | Only locations the caller may act on |

### Movements

| Method | Route | Notable responses |
|---|---|---|
| `POST` | `/movements` | `400`, `403 FORBIDDEN_LOCATION`, `404`, `409 INSUFFICIENT_STOCK`, `422 ITEM_INACTIVE` |
| `POST` | `/movements/:id/reverse` | `409 ALREADY_REVERSED`, `409 CANNOT_REVERSE_REVERSAL`, `409 INSUFFICIENT_STOCK` |

### Team — manager only

| Method | Route | Notable responses |
|---|---|---|
| `GET` | `/users` | Search, filter, sort, paginate |
| `POST` | `/users` | `409 EMAIL_EXISTS` |
| `PATCH` | `/users/:id` | `403` on self-deactivation or self-demotion |
| `PUT` | `/users/:id/locations` | `403` for a manager, `404 LOCATION_NOT_FOUND` |
| `GET` | `/users/:id/access-history` | Grants and revokes, with who and why |
| `POST` | `/users/:id/reset-link` | Issues a link on someone's behalf |

### Error envelope

```json
{ "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Only 1 available at WH-A; 3 requested.",
    "details": { "itemId": "...", "locationId": "...", "requested": 3, "available": 1 },
    "requestId": "req_01H..." } }
```

`details.available` is the point of FR-4.2: a rejection the operator cannot act on is barely better
than a 500.

### Pagination envelope

```json
{ "data": [], "page": 2, "pageSize": 10, "total": 247, "totalPages": 25,
  "totalIsExact": true, "hasPrev": true, "hasNext": true, "nextCursor": "eyJ0..." }
```

### Not built

`POST /transfers` (FR-5.3), `POST /stock-takes` (FR-10), and `GET /audit/attempts` (FR-9.5) are
specified above but not implemented. Attempts *are* recorded and tested — there is simply no
endpoint to read them back.

## 7. Frontend Requirements (React 19 + TypeScript)

| ID | Screen | Status |
|---|---|---|
| UI-1 | Sign in, with forgot-password | Built |
| UI-2 | Items list — search, filters, sortable columns, pagination, stock-level bars | Built |
| UI-3 | Item detail — per-location balances, headline figures | Built |
| UI-4 | Record movement | Built |
| UI-5 | Movement history — filters, sorting, pagination, reversal | Built |
| UI-6 | Reverse dialog | Built (inline prompt for the reason, not a full dialog) |
| UI-7 | Low-stock view | Built |
| UI-8 | Audit log | **Not built** — needs FR-9.5 |
| UI-9 | Race demo page | **Not built** |
| UI-10 | Item create / edit / delete **[added]** | Built |
| UI-11 | Team management **[added]** | Built |
| UI-12 | Password reset screens **[added]** | Built |

### Rules that apply across the client

**No optimistic update on stock-out.** React 19 makes `useOptimistic` easy and using it here would
be wrong: it would tell the operator they got the last unit before the database has decided whether
they did — the human version of the race in FR-4.3. It is used only to prepend to history *after*
the action resolves.

**Rejections are rendered specifically.** A `409 INSUFFICIENT_STOCK` shows the real available
figure at the field. Flattening it into "something went wrong" discards the only useful part.

**Every filter and sort is a server query.** Sorting rows already on screen answers a different
question, and is wrong as soon as there is more than one page.

**Role and location gating in the UI is cosmetic.** Every restriction is enforced independently
server-side, which is what T-4 proves by calling the API directly.

**Access tokens live in memory**, never `localStorage`. Only the refresh token is stored, so a
reload does not sign the user out.

## 8. Test Plan — what this POC is checked for

**137 tests across 13 files**, run against a real PostgreSQL. Never a mock: a mock cannot exhibit
row-level locking, which is the only thing this system is really claiming, so a mocked suite would
pass while proving nothing.

| File | Tests | Covers |
|---|---|---|
| `concurrency.test.ts` | 6 | **T-5.** The zero floor under 2, 10, 20 and 50 concurrent claims, plus a 20-round loop — a race that passes once has been sampled, not proven |
| `perLocation.test.ts` | 4 | T-7. Stock at WH-B never satisfies a request at WH-A, including simultaneous races at two locations |
| `immutability.test.ts` | 8 | T-8, T-9. `UPDATE`/`DELETE` refused at the database, through raw SQL and the ORM; no quantity column exists; no route accepts one |
| `locationAccess.test.ts` | 9 | T-4. A handler refused at the query, asserted at the API; balances and history scoped |
| `validation.test.ts` | 9 | T-1, T-2. Zero, negative, fractional and non-numeric quantities; unknown item and location — with a spy asserting the service was never reached |
| `auth.test.ts` | 10 | T-3. No anonymous path; forged, expired, refresh-as-access and deactivated-account tokens all refused |
| `reversal.test.ts` | 7 | T-10, T-11. Corrections append; reversal happens at most once, including concurrently; a reversal that would breach the floor is refused |
| `idempotency.test.ts` | 5 | T-12. Five concurrent submits with one key move stock once |
| `audit.test.ts` | 6 | T-15. Every attempt recorded, including refusals and attempts against absent items |
| `passwordReset.test.ts` | 20 | FR-13. Hashing, single use, enumeration resistance, throttling, session invalidation |
| `teamManagement.test.ts` | 15 | FR-12. Atomic location moves, audited, manager-only, past movements untouched |
| `itemManagement.test.ts` | 14 | FR-11. An item with history cannot be deleted or re-measured |
| `pagination.test.ts` | 24 | FR-14. Pages never repeat or drop a row, even when every sort value ties |

### Still outstanding

| ID | Test | Why it matters |
|---|---|---|
| T-6 | Two application instances racing the same last unit | Proves the guarantee lives in Postgres, not in process memory. `docker-compose.test.yml` and its nginx config are written but have never been run — the Compose plugin was not installed on the development machine |
| T-13 | 500,000 movements, with `EXPLAIN ANALYZE` output | The largest gap. The running-total decision in §5.1 is argued but not measured |
| T-14 | Reconciliation after the load test | The script exists and passes on current data; it has not been run at scale |
| T-16 | Stock-take | The flow itself is not implemented |

## 9. What was built, in order

| Phase | Output |
|---|---|
| 1. Foundation | Workspace, compose files, Prisma schema, migrations `0001`–`0003`, seed, health check |
| 2. The ledger core | `recordMovement`, the conditional balance update, the append-only triggers |
| 3. Auth and scoping | JWT, location scope as a query predicate, role gates |
| 4. API surface | Items, locations, movements, reversals, history, low stock |
| 5. Audit | `MovementAttempt` on every outcome, written outside the business transaction |
| 6. Frontend | Login, items, item detail, record movement, history, low stock |
| 7. Test suite | 13 files against a real Postgres, replacing the manual probes used until then |
| 8. Team management | Location assignment with an audited change history (§3.12) |
| 9. Password reset | Hashed single-use tokens, session invalidation by token epoch (§3.13) |
| 10. Query surface | Server-side sort, filter and pagination on every list; page numbers (§3.14) |
| 11. Item lifecycle | Create, edit, deactivate, delete with ledger protection (§3.11) |
| 12. UI pass | Design tokens, icon set, skeletons, stock-level bars, accessible focus states |

Four migrations beyond the original three were added by work that was not foreseen: `0004`
(audit foreign keys removed), `0005` (location access history), `0006` (password reset), `0007`
(token epoch).

## 10. Walkthrough Answers (prepared)

**Q. A movement is entered with the wrong quantity. How is it corrected?**
Never by editing or deleting — the route doesn't exist and the database refuses the write. A reversal movement is appended (`movementType = REVERSAL`, opposite direction, same quantity, `reversesMovementId` set, reason mandatory), then the correct movement is recorded. Both the mistake and its correction stay visible in history. A movement can be reversed only once. If reversing a stock-in would drive the balance negative because the stock has already been issued, the reversal is refused and the situation is resolved as a stock-take — the ledger is not bent to make the correction tidy.

**Q. Current quantity is derived from movements. Show me the query and tell me what it costs at 100,000 movements.**
Two answers, and the POC implements both so they can be compared live. The derived query is `SELECT location_id, SUM(signed_quantity) FROM movements WHERE item_id = $1 GROUP BY location_id` — an index-only scan over every one of those 100,000 rows, so tens of milliseconds and growing linearly forever. The system serves reads from `StockBalance` instead: one indexed row, constant cost. It is safe to do so because the balance is only ever updated relatively (`quantity = quantity ± n`) in the same transaction as the movement insert, a `CHECK (quantity >= 0)` makes a negative value unrepresentable, and a reconciliation job asserts it still equals the ledger sum. The ledger stays the source of truth; the balance is a cache carrying a proof obligation.

**Q. How does the below-zero rule apply per location?**
Balances are keyed `(item_id, location_id)` with a unique constraint, and the stock-out is a single conditional `UPDATE … WHERE item_id = $1 AND location_id = $2 AND quantity >= $3`. The location is part of the predicate, so stock at another location is not merely ignored — it is not in the row being touched. A stock-out at A with 0 on hand fails even when B holds a thousand units. Two concurrent requests for the same last unit contend on the same row: Postgres blocks the second until the first commits, then re-evaluates the `WHERE` against the committed `quantity = 0`, matches nothing, and returns `409`. There is no read-then-decide window for a race to slip through.

---

## 11. Acceptance Criteria — status

| # | Criterion | Status |
|---|---|---|
| 1 | `cp .env.example .env && docker compose up` yields a working, seeded system | **Unverified.** The Compose plugin was unavailable; the manual path in the README is verified |
| 2 | No column, route or service method can set a quantity to an absolute value | **Met** — `immutability.test.ts` |
| 3 | Movements cannot be updated or deleted, proven at the database | **Met** — trigger tested through raw SQL and the ORM |
| 4 | Exactly one winner in a concurrent race, repeatably | **Met** — `concurrency.test.ts`, 20 rounds |
| 5 | Every attempt traceable to a user, a time and an outcome | **Met** — `audit.test.ts` |
| 6 | History and low stock meet their targets at 500,000 movements | **Not met.** The load test is not written |
| 7 | Reconciliation shows zero drift | **Met** on current data; not yet run at scale |
| 8 | README documents the correction rule and the derived-quantity trade-off | **Met** — README and §5.1 |

---

## 12. Requirement status

| Requirement | Status |
|---|---|
| §3.1 Items and locations | Built |
| §3.2 Movements — general | Built |
| §3.3 Stock in | Built |
| §3.4 **Stock out and the zero floor** | Built, tested to 50-way concurrency |
| §3.5 Multiple locations | Built, except transfers (FR-5.3) |
| §3.6 Correcting a mistake | Built |
| §3.7 Low-stock view | Built |
| §3.8 Movement history | Built |
| §3.9 Audit trace | Recorded and tested; **no read API** (FR-9.5) |
| §3.10 Stock-take reconciliation | **Not built** — model and enum exist only |
| §3.11 Item lifecycle | Built |
| §3.12 Team and location assignment | Built |
| §3.13 Password reset | Built, except mail delivery (FR-13.8) |
| §3.14 Sorting, filtering, pagination | Built |
| §3.15 Movement idempotency | Built |

**Outstanding, in the order worth doing them:**

1. **Load test and query plans (T-13).** The derived-quantity trade-off is the sharpest walkthrough
   question and is currently defended with reasoning rather than numbers.
2. **Two-instance race (T-6).** Needs the Compose plugin. Proves the guarantee is in the database.
3. **Stock-take (§3.10).** The acid test of "no path sets a quantity".
4. **Audit read API (FR-9.5)** and its screen.
5. **Transfers (FR-5.3).**
6. **The ESLint rule** confining `stock_balances` writes to one file. CLAUDE.md describes it; there
   is no ESLint config yet, so it is a convention rather than an enforcement.
