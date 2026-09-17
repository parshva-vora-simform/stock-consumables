import { ERROR } from '@stock/shared';
import type { ErrorCode } from '@stock/shared';

/**
 * The only error type routes and services should throw. `errorHandler` turns it
 * into the uniform envelope from FRD §6.
 *
 * Rejections in this system must be specific — "only 1 available" is a usable
 * answer, "something went wrong" is not (FR-4.2) — which is why `details`
 * exists and why the client reads it.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace?.(this, AppError);
  }

  static unauthenticated(message = 'Authentication required.') {
    return new AppError(ERROR.UNAUTHENTICATED, 401, message);
  }

  static forbidden(message = 'You do not have permission to do that.') {
    return new AppError(ERROR.FORBIDDEN, 403, message);
  }

  static forbiddenLocation(locationId: string) {
    return new AppError(ERROR.FORBIDDEN_LOCATION, 403, 'You do not have access to this location.', {
      locationId,
    });
  }

  static itemNotFound(itemId: string) {
    return new AppError(ERROR.ITEM_NOT_FOUND, 404, 'No such item.', { itemId });
  }

  static locationNotFound(locationId: string) {
    return new AppError(ERROR.LOCATION_NOT_FOUND, 404, 'No such location.', { locationId });
  }

  /**
   * The zero floor (FR-4.2). `available` is the whole point: the operator needs
   * to know how many there actually are, not merely that they can't have this many.
   */
  static insufficientStock(args: {
    itemId: string;
    locationId: string;
    locationCode?: string;
    requested: number;
    available: number;
  }) {
    const where = args.locationCode ?? 'this location';
    return new AppError(
      ERROR.INSUFFICIENT_STOCK,
      409,
      `Only ${args.available} available at ${where}; ${args.requested} requested.`,
      args,
    );
  }
}
