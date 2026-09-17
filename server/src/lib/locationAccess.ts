import { ROLE } from '@stock/shared';
import { prisma } from '../db/prisma.js';
import { AppError } from './AppError.js';
import type { AuthUser } from '../middleware/authenticate.js';

/**
 * Location scoping (AC-2, AC-3).
 *
 * The rule this file exists to enforce: a handler's accessible locations are
 * folded into the WHERE clause of every query that touches stock. Never fetch
 * everything and filter afterwards — that leaks the existence and the figures
 * of locations the user cannot see, even if the UI never renders them.
 *
 * A manager is scoped to everything, represented as `'ALL'` rather than a list,
 * so a manager's queries carry no location predicate at all.
 */
export type LocationScope = 'ALL' | string[];

export async function getLocationScope(user: AuthUser): Promise<LocationScope> {
  if (user.role === ROLE.MANAGER) return 'ALL';

  const rows = await prisma.userLocationAccess.findMany({
    where: { userId: user.id },
    select: { locationId: true },
  });
  return rows.map((r) => r.locationId);
}

/**
 * Asserts the user may act on one specific location, BEFORE any transaction
 * opens. A handler reaching for a location they were not granted gets a 403,
 * not an empty result that looks like "no stock".
 */
export async function assertLocationAllowed(user: AuthUser, locationId: string): Promise<void> {
  const scope = await getLocationScope(user);
  if (scope === 'ALL') return;
  if (!scope.includes(locationId)) throw AppError.forbiddenLocation(locationId);
}

/** Prisma `where` fragment for the scope. Spread into a query's where clause. */
export function locationWhere(scope: LocationScope): { locationId?: { in: string[] } } {
  return scope === 'ALL' ? {} : { locationId: { in: scope } };
}

/**
 * The same scope for raw SQL. Returns null for a manager so the caller can omit
 * the predicate entirely rather than pass a list of every location.
 */
export function scopeToArray(scope: LocationScope): string[] | null {
  return scope === 'ALL' ? null : scope;
}
