import { z } from 'zod';

/**
 * Environment is validated once, at boot, and never read from `process.env`
 * again. A missing or malformed variable fails in one readable line here rather
 * than as a mysterious runtime error three screens into the app (NFR-1).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  // 'silent' is pino's own off switch — used by the test suite, which has no
  // interest in the log stream of 50 deliberately failing requests.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgresql:// URL'),

  // 32 chars is not a formality: a short secret makes the tokens forgeable, and
  // every movement in this system is attributed on the strength of one.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

  /** Set by docker-compose.test.yml so a response can say which instance served it (T-6). */
  INSTANCE_ID: z.string().default('server'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Deliberately console.error and not the logger: the logger's own config
    // comes from the env we just failed to read.
    console.error(
      ['Invalid environment configuration:', ...lines, '', 'See .env.example for the full list.'].join('\n'),
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
