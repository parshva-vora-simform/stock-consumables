import { createServer } from './server.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './db/prisma.js';

const app = createServer();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server listening');
});

/**
 * Graceful shutdown. This matters more than usual here: a movement transaction
 * interrupted mid-flight would be rolled back by Postgres anyway, but draining
 * first means an in-flight stock-out either completes or is never recorded —
 * never half-recorded.
 */
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await disconnectPrisma();
    process.exit(0);
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
