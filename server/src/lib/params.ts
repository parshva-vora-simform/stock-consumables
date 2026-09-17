import { ERROR } from '@stock/shared';
import type { Request } from 'express';
import { AppError } from './AppError.js';

/**
 * Express 5 types route params as `string | string[]`, because a repeated
 * wildcard can produce an array. Our routes never do, and the param has already
 * been through a Zod uuid check by the time a handler runs — this narrows the
 * type at one place instead of casting at every call site.
 */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') {
    throw new AppError(ERROR.VALIDATION_ERROR, 400, `Missing path parameter "${name}".`);
  }
  return value;
}
