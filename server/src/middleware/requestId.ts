import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Stamps every request with an id that follows it into the logs and into
 * movement_attempts, so one rejection can be traced across both (FR-9.4).
 * An inbound x-request-id is honoured, which keeps the chain intact when the
 * request arrives through the load balancer in the two-instance test.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.header('x-request-id');
  req.requestId = inbound && inbound.length <= 128 ? inbound : `req_${randomUUID()}`;
  res.setHeader('x-request-id', req.requestId);
  next();
};
