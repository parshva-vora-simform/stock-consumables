import { defineConfig } from 'vitest/config';

/**
 * Test defaults. Each can be overridden from the shell or a .env — CI points
 * DATABASE_URL at its own service, and docker-compose.test.yml at the
 * containerised one.
 *
 * The database name must contain "test": the suite truncates every table
 * between files, and globalSetup refuses to run against anything else.
 */
const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://stock:stock_dev_password@localhost:5432/stock_test?schema=public';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: 'test',
      // 50 deliberately failing requests per test is not a log stream anyone
      // wants to read.
      LOG_LEVEL: process.env['LOG_LEVEL'] ?? 'silent',
      JWT_SECRET: process.env['JWT_SECRET'] ?? 'test_secret_at_least_32_characters_long_ok',
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '7d',
    },
    globalSetup: ['./tests/globalSetup.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Tests share one database and several deliberately contend on the same
    // rows. Running files in parallel would make failures look like races in
    // the application when they are races between test files.
    fileParallelism: false,
    // The concurrency tests fire 50 requests and loop 20 rounds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts'],
  },
});
