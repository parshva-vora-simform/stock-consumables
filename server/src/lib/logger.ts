import pino from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Structured JSON logs. Every movement outcome is logged with the same
 * requestId that is written to movement_attempts, so a rejection can be traced
 * from the log stream into the database and back (FR-9.4).
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { instance: env.INSTANCE_ID },
  // Pretty output is a development nicety; production emits raw JSON for
  // whatever collects it.
  transport: isProduction ? undefined : { target: 'pino-pretty', options: { colorize: true } },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.passwordHash', '*.password'],
    remove: true,
  },
});
