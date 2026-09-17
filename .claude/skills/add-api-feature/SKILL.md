---
name: add-api-feature
description: Add a new API feature to the server — its routes, business logic, database access, shared validation schemas and required tests — following this project's structure and error handling. Use when adding a new resource or group of endpoints under server/src/modules.
---

# Add a new API feature

Follow the layering in CLAUDE.md exactly: `route → validate → authenticate → location scope →
service → repository → Prisma`. Routes carry no business logic; repositories carry no HTTP.

## Files to create

```
shared/src/<name>.ts                         Zod schemas + inferred types
server/src/modules/<name>/routes.ts          express.Router, validation, auth, error mapping
server/src/modules/<name>/service.ts         business rules, orchestration
server/src/modules/<name>/repository.ts      Prisma / raw SQL only
server/tests/<name>.test.ts                  the three mandatory tests, below
```

Register the router in `server/src/server.ts` under `/api/v1`.

## Rules

**Contracts first.** Define the request and response schemas in `shared/` before writing the
route, and derive types with `z.infer`. Both sides import them — that is why the package exists.
Never redeclare a shape in the client.

**Validate at the boundary.** `validate(schema)` middleware runs before the handler. Bad input
must be rejected before any service call (FR-3.2). Numeric quantities are `z.number().int()` with
an explicit minimum — a schema that accepts `0` or a negative is the defect T-1 tests for.

**Authenticate everything.** Every route gets `authenticate`. There is no anonymous path through
this system. Manager-only routes add `requireRole('MANAGER')`.

**Scope by location in the query.** If the resource touches items, locations or movements, fold
the caller's accessible location IDs into the `WHERE` clause via `lib/locationAccess.ts`. Never
fetch then filter in JavaScript, and never rely on the client hiding the option (AC-2, AC-3).

**Throw `AppError`.** `throw new AppError('CODE', status, details)` with a code added to the
`ErrorCode` union in `shared/src/errors.ts`. Never `res.status(...).json({ error: ... })` inline —
the envelope is the error handler's job. Map Prisma codes at the repository boundary so a raw DB
error never reaches the client.

**Paginate by cursor.** Any list that can grow unbounded uses the keyset helpers in
`lib/cursor.ts` and returns `{ data, nextCursor }`. No `OFFSET`, no `COUNT(*)` by default.

**Never touch `stock_balances`.** Only the movements repository writes balances. If the new module
needs to change stock, it calls the movements service and lets it append a movement.

## Mandatory tests

Every new module ships with at least these three, or it is not done:

1. **Bad input** → `400 VALIDATION_ERROR`, and the service is never reached.
2. **No / invalid token** → `401`, on every write route.
3. **Wrong location or role** → `403`, asserted by hitting the API directly, proving the
   restriction is server-side rather than a hidden UI control.

Tests run against a real Postgres via `tests/setup.ts`. Do not mock Prisma.

## After scaffolding

Run the `inventory-rules-checker` agent over the new feature before considering it complete —
especially if it touches items, movements, stock-takes or seeds.
