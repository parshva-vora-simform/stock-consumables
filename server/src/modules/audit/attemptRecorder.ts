import { ATTEMPT_OUTCOME, ERROR } from '@stock/shared';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../lib/AppError.js';
import type { AttemptOutcome, Direction } from '@prisma/client';

export type AttemptContext = {
  userId: string;
  requestId: string;
  ipAddress?: string | null;
  itemId?: string | null;
  locationId?: string | null;
  direction?: Direction | null;
  quantity?: number | null;
};

/**
 * Every movement attempt leaves a trace — accepted AND rejected (FR-9.1).
 *
 * Two things about how this is written matter:
 *
 * 1. It runs OUTSIDE the business transaction. A stock-out that is refused
 *    rolls back; if the audit row were written inside that transaction it would
 *    roll back too, and the system would keep no record of the very events most
 *    worth recording (FR-9.3).
 *
 * 2. It never throws. An audit write that fails must not turn a successful
 *    movement into an error, nor mask the real rejection behind a second
 *    failure. It logs loudly instead, so the gap is visible.
 */
export async function recordAttempt(
  ctx: AttemptContext,
  outcome: AttemptOutcome,
  extra?: { failureDetail?: string; resultingMovementId?: string },
): Promise<void> {
  try {
    await prisma.movementAttempt.create({
      data: {
        userId: ctx.userId,
        itemId: ctx.itemId ?? null,
        locationId: ctx.locationId ?? null,
        direction: ctx.direction ?? null,
        quantity: ctx.quantity ?? null,
        outcome,
        failureDetail: extra?.failureDetail ?? null,
        resultingMovementId: extra?.resultingMovementId ?? null,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress ?? null,
      },
    });
  } catch (err) {
    logger.error(
      { err, requestId: ctx.requestId, outcome, userId: ctx.userId },
      'FAILED TO RECORD MOVEMENT ATTEMPT — the audit trail has a gap',
    );
  }

  // The same event in the log stream, tied by requestId (FR-9.4).
  logger.info(
    {
      requestId: ctx.requestId,
      userId: ctx.userId,
      itemId: ctx.itemId,
      locationId: ctx.locationId,
      direction: ctx.direction,
      quantity: ctx.quantity,
      outcome,
      movementId: extra?.resultingMovementId,
    },
    `movement attempt ${outcome}`,
  );
}

/** Maps a thrown error to the outcome recorded against the attempt. */
export function outcomeFor(err: unknown): AttemptOutcome {
  if (!(err instanceof AppError)) return ATTEMPT_OUTCOME.REJECTED_VALIDATION;

  switch (err.code) {
    case ERROR.INSUFFICIENT_STOCK:
      return ATTEMPT_OUTCOME.REJECTED_INSUFFICIENT_STOCK;
    case ERROR.FORBIDDEN:
    case ERROR.FORBIDDEN_LOCATION:
      return ATTEMPT_OUTCOME.REJECTED_FORBIDDEN;
    case ERROR.ITEM_NOT_FOUND:
    case ERROR.LOCATION_NOT_FOUND:
    case ERROR.MOVEMENT_NOT_FOUND:
    case ERROR.NOT_FOUND:
      return ATTEMPT_OUTCOME.REJECTED_NOT_FOUND;
    case ERROR.ALREADY_REVERSED:
    case ERROR.CANNOT_REVERSE_REVERSAL:
    case ERROR.DUPLICATE:
      return ATTEMPT_OUTCOME.REJECTED_CONFLICT;
    default:
      return ATTEMPT_OUTCOME.REJECTED_VALIDATION;
  }
}
