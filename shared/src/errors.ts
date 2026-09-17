import { z } from 'zod';
import { ERROR_VALUES } from './constants.js';

/**
 * Every error this API can return. The server throws these codes; the client
 * switches on them. Adding a failure mode means adding it here first, so both
 * sides stay in step (FRD §6).
 */
/**
 * The error code list, derived from `ERROR` in constants.ts so the values exist
 * in exactly one place. Throw and compare with `ERROR.X`, never the string.
 */
export const ERROR_CODES = ERROR_VALUES as [string, ...string[]];

export const errorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCode>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCode,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Shape of `details` on an INSUFFICIENT_STOCK rejection. */
export const insufficientStockDetails = z.object({
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  requested: z.number().int(),
  available: z.number().int(),
});
export type InsufficientStockDetails = z.infer<typeof insufficientStockDetails>;

/** Field-level failures on a VALIDATION_ERROR, so forms can mark the right input. */
export const validationDetails = z.object({
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
export type ValidationDetails = z.infer<typeof validationDetails>;
