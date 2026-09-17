import type { RequestHandler } from 'express';
import { AppError } from '../lib/AppError.js';
import type { UserRole } from '@stock/shared';

/**
 * Role gate. Mount after `authenticate`.
 *
 * The client also hides manager-only controls, but that is cosmetic — this is
 * the control, and the test for it hits the API directly (AC-4).
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(AppError.unauthenticated());
    if (!roles.includes(req.user.role)) {
      return next(
        AppError.forbidden(
          `This action requires the ${roles.join(' or ')} role.`,
        ),
      );
    }
    next();
  };
}
