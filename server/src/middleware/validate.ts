import { ERROR } from '@stock/shared';
import type { RequestHandler } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { AppError } from '../lib/AppError.js';

type Source = 'body' | 'query' | 'params';

/**
 * Validates one part of the request against a schema from `shared/`, before the
 * handler — and therefore before any business logic — runs. A zero or negative
 * movement quantity never reaches the service layer (FR-3.2, T-1).
 *
 * The parsed value replaces the raw one, so handlers receive coerced, typed
 * data rather than strings.
 */
export function validate(schema: ZodSchema, source: Source = 'body'): RequestHandler {
  return (req, _res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      // Express 5 makes req.query a getter; assign through defineProperty.
      Object.defineProperty(req, source, { value: parsed, writable: true, configurable: true });
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(
          new AppError(ERROR.VALIDATION_ERROR, 400, 'The request could not be accepted.', {
            issues: err.issues.map((i) => ({
              path: i.path.join('.') || source,
              message: i.message,
            })),
          }),
        );
        return;
      }
      next(err);
    }
  };
}
