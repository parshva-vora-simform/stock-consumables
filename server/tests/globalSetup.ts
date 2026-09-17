import { execSync } from 'node:child_process';

/**
 * Creates and migrates a dedicated test database once, before any test file.
 *
 * Tests run against a REAL Postgres, never a mock (NFR-9). A mock cannot
 * exhibit row-level locking, and row-level locking is the only thing this POC
 * is really claiming — a suite that mocked Prisma would pass while proving
 * nothing at all.
 */
export default async function setup() {
  const url =
    process.env['TEST_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgresql://stock:stock_dev_password@localhost:5432/stock_test?schema=public';

  if (!url) {
    throw new Error(
      'DATABASE_URL must point at a test database.\n' +
        'Start one with:\n' +
        '  docker compose up postgres -d\n' +
        'then run the suite with DATABASE_URL set to a *_test database.',
    );
  }

  if (!/test/i.test(url)) {
    // These tests truncate every table between files. Refusing to run against a
    // database whose name does not say "test" is cheaper than the alternative.
    throw new Error(
      `Refusing to run: DATABASE_URL does not look like a test database (${redact(url)}).\n` +
        'The suite truncates all tables. Point it at a database named *test*.',
    );
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}

function redact(url: string): string {
  return url.replace(/:\/\/[^@]+@/, '://***@');
}
