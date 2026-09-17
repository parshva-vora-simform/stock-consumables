import { z } from 'zod';
import {
  ROLE,
  DIRECTION,
  MOVEMENT_TYPE,
  UNIT,
  ATTEMPT_OUTCOME,
  ACCESS_CHANGE,
} from './constants.js';

/**
 * Zod enums, built from the constants in `constants.ts` so there is one list of
 * valid values rather than two that can drift.
 *
 * These mirror the Prisma enums exactly — if you change one, change the other
 * and add a migration.
 */

export const unitOfMeasure = z.enum([
  UNIT.EACH,
  UNIT.KG,
  UNIT.LITRE,
  UNIT.METRE,
  UNIT.BOX,
  UNIT.PACK,
]);
export type UnitOfMeasure = z.infer<typeof unitOfMeasure>;

export const direction = z.enum([DIRECTION.IN, DIRECTION.OUT]);
export type Direction = z.infer<typeof direction>;

export const movementType = z.enum([
  MOVEMENT_TYPE.NORMAL,
  MOVEMENT_TYPE.REVERSAL,
  MOVEMENT_TYPE.STOCK_TAKE_ADJUSTMENT,
]);
export type MovementType = z.infer<typeof movementType>;

export const userRole = z.enum([ROLE.HANDLER, ROLE.MANAGER]);
export type UserRole = z.infer<typeof userRole>;

export const attemptOutcome = z.enum([
  ATTEMPT_OUTCOME.ACCEPTED,
  ATTEMPT_OUTCOME.REJECTED_INSUFFICIENT_STOCK,
  ATTEMPT_OUTCOME.REJECTED_VALIDATION,
  ATTEMPT_OUTCOME.REJECTED_FORBIDDEN,
  ATTEMPT_OUTCOME.REJECTED_NOT_FOUND,
  ATTEMPT_OUTCOME.REJECTED_CONFLICT,
]);
export type AttemptOutcome = z.infer<typeof attemptOutcome>;

export const accessChangeAction = z.enum([ACCESS_CHANGE.GRANTED, ACCESS_CHANGE.REVOKED]);
export type AccessChangeAction = z.infer<typeof accessChangeAction>;
