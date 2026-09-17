# Stock &amp; Consumables

An inventory system where stock quantity is never a number anyone types in. Every change is an
immutable movement in a ledger, the current quantity is derived from it, and an item cannot be
issued past zero — even when two people go for the last unit at the same instant.

**What it requires and why it is built this way:** [docs/FRD.md](docs/FRD.md)
**Conventions for changing the code:** [CLAUDE.md](CLAUDE.md)

---

## Prerequisites

| | |
|---|---|
| Node | 22 or later |
| pnpm | 9 (`corepack enable` is enough) |
| Docker | For PostgreSQL 16. Compose is optional — see below |

---

## Setup

```bash
git clone <repo> && cd stock-consumables
cp .env.example .env
docker compose up
```

Compose starts Postgres, waits for it to be healthy, applies migrations, seeds demo data, and only
then starts the API — so the server never comes up against an unmigrated database.

| | |
|---|---|
| Web | http://localhost:5173 |
| API | http://localhost:4000/api/v1 |
| Health check | http://localhost:4000/api/v1/health |

### Without Docker Compose

If you only have the Docker CLI, run Postgres yourself and the apps on the host:

```bash
docker run -d --name stock-pg -p 5432:5432 \
  -e POSTGRES_USER=stock -e POSTGRES_PASSWORD=stock_dev_password \
  -e POSTGRES_DB=stock_consumables postgres:16-alpine

pnpm install
cp .env.example .env
pnpm --filter @stock/server prisma:deploy   # apply migrations
pnpm --filter @stock/server seed            # demo data
pnpm dev                                    # client :5173, server :4000
```

`.env` is read by host-side tooling only. Containers build their own `DATABASE_URL` from the
`POSTGRES_*` values, so the file can point at `localhost` and both work.

---

## Signing in

All demo accounts use the password **`Password123!`**

| Email | Role | Can record stock at |
|---|---|---|
| `manager@stock.local` | Manager | Every location, by role |
| `handler.a@stock.local` | Handler | WH-A, WH-B |
| `handler.b@stock.local` | Handler | SITE-1, SITE-2 |

The handlers' access is deliberately disjoint — the server refuses a movement at a location you
were not granted, whatever the interface shows.

Item `TNR-HP-26A` at WH-A is seeded to exactly one unit, for demonstrating the concurrency
guarantee.

---

## Running the tests

The suite needs its own database. Create it once:

```bash
# with compose
docker compose exec postgres createdb -U stock stock_test
# or, running Postgres directly
docker exec stock-pg createdb -U stock stock_test
```

Then:

```bash
pnpm test
```

137 tests across 13 files, all against a real PostgreSQL — never a mock, because a mock cannot
exhibit row-level locking, which is the main thing this system claims.

The headline one fires 50 simultaneous stock-out requests at a single remaining unit and asserts
exactly one succeeds:

```bash
pnpm --filter @stock/server test concurrency
```

The suite truncates every table between files, so it refuses to run against a database whose name
does not contain `test`.

---

## Commands

```bash
pnpm dev             # client + server together
pnpm test            # full test suite
pnpm typecheck       # all three workspaces
pnpm build           # production build
pnpm db:migrate      # create and apply a migration
pnpm db:seed         # reseed demo data
pnpm reconcile       # assert every cached balance still equals SUM(ledger)
```

---

## Project layout

```
client/   React 19 · Vite · TanStack Query · Tailwind
server/   Express 5 · Prisma · PostgreSQL 16
shared/   Zod schemas imported by both, so the form and the API cannot drift
docs/     FRD
```

The server is organised by module — `auth`, `items`, `movements`, `locations`, `users`, `audit` —
each with routes, a service and a repository. The one file worth reading first is
`server/src/modules/movements/repository.ts`: it is where the zero-floor guarantee lives.

---

## Environment variables

Everything is documented in [.env.example](.env.example). The ones you may want to change:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Host-side connection string (Prisma CLI, `pnpm dev`, tests) |
| `TEST_DATABASE_URL` | Test database. Its name must contain `test` |
| `JWT_SECRET` | At least 32 characters. Generate with `openssl rand -base64 48` |
| `PORT` | API port, default 4000 |
| `WEB_ORIGIN` | Allowed CORS origin, default `http://localhost:5173` |

The server validates all of these at boot and exits with a readable message if any is missing, so
a wrong `.env` fails in one line rather than as a mysterious runtime error.

---

## Troubleshooting

**Port 5173 already in use** — Vite picks the next free port and prints it. Check the terminal for
the actual URL.

**`Invalid environment configuration`** — copy `.env.example` to `.env`. The message names the
variable that is missing.

**Tests fail with "does not look like a test database"** — `TEST_DATABASE_URL` must point at a
database whose name contains `test`. The suite truncates tables, so this guard is deliberate.

**Tailwind classes not applying after editing `tailwind.config.js`** — restart the dev server;
Vite caches the config.

**`docker compose` not found** — the Compose plugin is separate from the Docker CLI
(`sudo apt install docker-compose-plugin`). The manual setup above works without it.

---

## What is not built yet

Transfers between locations, stock-take reconciliation, the audit read API and screen, and the
load-test and query-plan scripts. `docs/FRD.md` §12 lists the current status of every requirement.
