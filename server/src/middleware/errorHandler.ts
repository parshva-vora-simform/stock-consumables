import { ERROR } from '@stock/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { PRISMA_ERROR } from '../lib/prismaErrors.js';
import { AppError } from '../lib/AppError.js';
import { logger } from '../lib/logger.js';
import { isProduction } from '../config/env.js';
import type { ApiError } from '@stock/shared';

/** 404 for anything that reached the end of the router stack. */
export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiError = {
    error: {
      code: ERROR.ROUTE_NOT_FOUND,
      message: `No route for ${req.method} ${req.path}.`,
      requestId: req.requestId,
    },
  };
  res.status(404).json(body);
};

/**
 * The single place an error becomes a response. Routes throw; they never build
 * an error body themselves, so the envelope stays uniform and the client can
 * switch on `code` with confidence.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId ?? 'unknown';

  if (err instanceof AppError) {
    // Expected outcomes — an insufficient-stock rejection is the system working,
    // not failing, so it logs at info rather than error.
    logger[err.status >= 500 ? 'error' : 'info'](
      { requestId, code: err.code, status: err.status, details: err.details },
      err.message,
    );
    const body: ApiError = {
      error: { code: err.code, message: err.message, details: err.details, requestId },
    };
    res.status(err.status).json(body);
    return;
  }

  // Prisma errors are mapped here so a raw database error never escapes as a
  // 500 with a driver message in it.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = mapPrismaError(err);
    if (mapped) {
      logger.info({ requestId, prismaCode: err.code }, mapped.message);
      const body: ApiError = {
        error: { code: mapped.code, message: mapped.message, details: mapped.details, requestId },
      };
      res.status(mapped.status).json(body);
      return;
    }
  }

  logger.error({ requestId, err }, 'unhandled error');
  const body: ApiError = {
    error: {
      code: ERROR.INTERNAL_ERROR,
      // Never leak an internal message to a client in production.
      message: isProduction ? 'Something went wrong.' : (err as Error)?.message ?? 'Unknown error',
      requestId,
    },
  };
  res.status(500).json(body);
};

function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): AppError | null {
  switch (err.code) {
    case PRISMA_ERROR.UNIQUE_VIOLATION: // unique constraint
      return new AppError(ERROR.DUPLICATE, 409, 'That value already exists.', {
        target: err.meta?.['target'],
      });
    case PRISMA_ERROR.FOREIGN_KEY_VIOLATION: // foreign key constraint
      return new AppError(ERROR.NOT_FOUND, 404, 'A referenced record does not exist.', {
        field: err.meta?.['field_name'],
      });
    case PRISMA_ERROR.RECORD_NOT_FOUND: // record not found
      return new AppError(ERROR.NOT_FOUND, 404, 'Record not found.');
    default:
      return null;
  }
}
