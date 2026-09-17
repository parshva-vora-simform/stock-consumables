import { z } from 'zod';
import { direction, movementType } from './enums.js';
import { cursorPagination, dateRange, movementSortField, sortOrder } from './query.js';

/**
 * The validation that keeps bad input away from business logic (FR-3.2, T-1).
 *
 * `quantity` is the magnitude and must be a positive integer. Zero is rejected
 * because a movement that changes nothing is not a movement; negatives are
 * rejected because direction — not sign — is what says which way stock went.
 */
export const createMovementRequest = z.object({
  itemId: z.string().uuid('Unknown item.'),
  locationId: z.string().uuid('Unknown location.'),
  direction,
  quantity: z
    .number({ invalid_type_error: 'Quantity must be a number.' })
    .int('Quantity must be a whole number.')
    .positive('Quantity must be greater than zero.')
    .max(1_000_000, 'That quantity looks like a mistake.'),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
  /** Defaults to now. Never in the future — stock cannot move before it moves. */
  occurredAt: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now() + 60_000, 'Cannot record a movement in the future.')
    .optional(),
  /** Makes a retried or double-clicked submit safe (FR-2.4). */
  idempotencyKey: z.string().uuid().optional(),
});
export type CreateMovementRequest = z.infer<typeof createMovementRequest>;

export const reverseMovementRequest = z.object({
  /** Mandatory: a correction without a stated reason is not auditable (FR-6.5). */
  reason: z.string().trim().min(3, 'Give a reason for the reversal.').max(500),
  idempotencyKey: z.string().uuid().optional(),
});
export type ReverseMovementRequest = z.infer<typeof reverseMovementRequest>;

export const transferRequest = z.object({
  itemId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  quantity: z.number().int().positive('Quantity must be greater than zero.'),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().uuid().optional(),
}).refine((v) => v.fromLocationId !== v.toLocationId, {
  message: 'Source and destination must differ.',
  path: ['toLocationId'],
});
export type TransferRequest = z.infer<typeof transferRequest>;

export const movement = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  itemSku: z.string(),
  itemName: z.string(),
  locationId: z.string().uuid(),
  locationCode: z.string(),
  direction,
  quantity: z.number().int(),
  signedQuantity: z.number().int(),
  movementType,
  recordedBy: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }),
  occurredAt: z.string(),
  createdAt: z.string(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  /** Set when THIS row undoes another. */
  reversesMovementId: z.string().uuid().nullable(),
  /** Set when this row HAS BEEN undone — history strikes it through (FR-6.6). */
  reversedByMovementId: z.string().uuid().nullable(),
});
export type Movement = z.infer<typeof movement>;

export const createMovementResponse = z.object({
  movement,
  /** The balance at that location immediately after this movement. */
  balanceAfter: z.number().int(),
});
export type CreateMovementResponse = z.infer<typeof createMovementResponse>;

export const movementHistoryQuery = cursorPagination.merge(dateRange).extend({
  /** 1-based. Ignored when a cursor is supplied. */
  page: z.coerce.number().int().min(1).default(1),
  locationId: z.string().uuid().optional(),
  direction: direction.optional(),
  userId: z.string().uuid().optional(),
  movementType: movementType.optional(),
  reference: z.string().trim().max(120).optional(),
  sortBy: movementSortField.default('occurredAt'),
  sortOrder: sortOrder.default('desc'),
});
export type MovementHistoryQuery = z.infer<typeof movementHistoryQuery>;
