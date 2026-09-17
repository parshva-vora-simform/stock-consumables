import { PrismaClient } from '@prisma/client';
import { env, isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * One client for the process. Prisma manages its own connection pool; creating
 * more than one client exhausts Postgres connections under the concurrency this
 * project deliberately generates.
 */
export const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL } },
  log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  logger.debug('prisma disconnected');
}
