import { beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * A clean ledger before every test.
 *
 * TRUNCATE, not DELETE: the append-only trigger on `movements` fires per row on
 * DELETE and would refuse. TRUNCATE is a table-level operation, so it bypasses
 * the row trigger — which is exactly the distinction that lets the ledger be
 * immutable in the application while still being resettable in a test database.
 */
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      movement_attempts,
      location_access_changes,
      movements,
      stock_takes,
      stock_balances,
      password_reset_tokens,
      refresh_tokens,
      user_location_access,
      items,
      locations,
      users
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await prisma.$disconnect();
});
