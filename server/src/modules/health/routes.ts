import { API } from '@stock/shared';
import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';

export const healthRouter: Router = Router();

/**
 * Liveness plus a real database round-trip. Compose's healthcheck hits this, so
 * "the container is up" and "the API can actually serve a request" are the same
 * statement.
 *
 * `instance` is here for the two-instance race test, which needs to confirm the
 * burst really did hit both processes (T-6).
 */
healthRouter.get(API.health(), async (_req, res) => {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      instance: env.INSTANCE_ID,
      database: 'reachable',
      latencyMs: Date.now() - startedAt,
      uptimeSeconds: Math.round(process.uptime()),
    });
  } catch {
    res.status(503).json({
      status: 'degraded',
      instance: env.INSTANCE_ID,
      database: 'unreachable',
    });
  }
});
