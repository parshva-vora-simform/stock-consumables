import { z } from 'zod';
import { userRole, accessChangeAction } from './enums.js';
import { locationSummary } from './auth.js';
import { cursorPagination, sortOrder, userSortField } from './query.js';

export const createUserRequest = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  name: z.string().trim().min(1, 'Name is required.').max(120),
  role: userRole.default('HANDLER'),
  password: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(200),
  /**
   * Which warehouses or sites this person may act on. Ignored for a manager,
   * who reaches every location by role (AC-5).
   */
  locationIds: z.array(z.string().uuid()).default([]),
});
export type CreateUserRequest = z.infer<typeof createUserRequest>;

/**
 * Replaces the whole set of locations for one person.
 *
 * A full set rather than add/remove calls: it is idempotent, and it makes
 * "move this employee from WH-A to SITE-1" one atomic change rather than a
 * revoke and a grant with a window in between where they can reach both, or
 * neither.
 */
export const setUserLocationsRequest = z.object({
  locationIds: z.array(z.string().uuid()),
  /** Why the access changed. Kept with the audit record. */
  reason: z.string().trim().max(500).optional(),
});
export type SetUserLocationsRequest = z.infer<typeof setUserLocationsRequest>;

export const updateUserRequest = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: userRole.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });
export type UpdateUserRequest = z.infer<typeof updateUserRequest>;

export const teamMember = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  role: userRole,
  isActive: z.boolean(),
  locations: z.array(locationSummary),
  /** Movements this person has recorded — shown before revoking access. */
  movementCount: z.number().int(),
});
export type TeamMember = z.infer<typeof teamMember>;

export const accessChange = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  userName: z.string(),
  locationId: z.string().uuid(),
  locationCode: z.string(),
  action: accessChangeAction,
  changedByName: z.string(),
  changedAt: z.string(),
  reason: z.string().nullable(),
});
export type AccessChange = z.infer<typeof accessChange>;

export const listUsersQuery = cursorPagination.extend({
  /** 1-based. Ignored when a cursor is supplied. */
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().trim().max(120).optional(),
  role: userRole.optional(),
  locationId: z.string().uuid().optional(),
  includeInactive: z.coerce.boolean().default(true),
  sortBy: userSortField.default('name'),
  sortOrder: sortOrder.default('asc'),
});
export type ListUsersQuery = z.infer<typeof listUsersQuery>;
