import { ACCESS_CHANGE, ERROR, ROLE } from '@stock/shared';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/AppError.js';
import { logger } from '../../lib/logger.js';
import { decodeKeyset, encodeKeyset, keysetSql } from '../../lib/keyset.js';
import { countCapped, toPaged, offsetFor } from '../../lib/paging.js';
import type { AuthUser } from '../../middleware/authenticate.js';
import type {
  ListUsersQuery,
  Paged,
  CreateUserRequest,
  SetUserLocationsRequest,
  TeamMember,
  UpdateUserRequest,
  AccessChange,
} from '@stock/shared';

/**
 * Team management (manager only).
 *
 * This is where the location scoping that the rest of the system enforces
 * actually gets set. Everything here is an administrative act on who may move
 * stock where, so every change is attributed and recorded.
 */

/**
 * One page of the team — searched, filtered, sorted and paginated by the
 * database.
 *
 * `movementCount` is sortable, which means it has to be an aggregate the
 * database computes: counting in the client would only ever sort the page you
 * already have.
 */
export async function listTeam(query: ListUsersQuery): Promise<Paged<TeamMember>> {
  const cursor = query.cursor ? decodeKeyset(query.cursor) : null;
  const dir = query.sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  const sortSql: Prisma.Sql = {
    name: Prisma.sql`u.name`,
    email: Prisma.sql`u.email`,
    role: Prisma.sql`u.role::text`,
    // ::int because COUNT() returns bigint, which cannot be serialised to
    // JSON and would break the cursor this value is encoded into.
    movementCount: Prisma.sql`COALESCE(m.count, 0)::int`,
  }[query.sortBy];

  const filterSql = Prisma.sql`
    (${query.includeInactive} OR u.is_active)
    AND (
      ${query.search ?? null}::text IS NULL
      OR u.name  ILIKE ${`%${query.search ?? ''}%`}
      OR u.email ILIKE ${`%${query.search ?? ''}%`}
    )
    AND (${query.role ?? null}::text IS NULL OR u.role::text = ${query.role ?? null})
    AND (
      ${query.locationId ?? null}::uuid IS NULL
      -- Parameterised, not inlined: this is SQL text, so the constant has to
      -- be interpolated as a bound value rather than pasted in as an identifier.
      OR u.role::text = ${ROLE.MANAGER}
      OR EXISTS (
        SELECT 1 FROM user_location_access ula
        WHERE ula.user_id = u.id AND ula.location_id = ${query.locationId ?? null}::uuid
      )
    )
  `;

  const counted = await countCapped(Prisma.sql`SELECT 1 FROM users u WHERE ${filterSql}`);

  const rows = await prisma.$queryRaw<
    {
      id: string;
      email: string;
      name: string;
      role: TeamMember['role'];
      isActive: boolean;
      movementCount: number;
      sortValue: string | number;
    }[]
  >`
    SELECT
      u.id,
      u.email,
      u.name,
      u.role                       AS "role",
      u.is_active                  AS "isActive",
      COALESCE(m.count, 0)::int    AS "movementCount",
      ${sortSql}                   AS "sortValue"
    FROM users u
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS count FROM movements mv WHERE mv.recorded_by_user_id = u.id
    ) m ON TRUE
    -- Filtering by location asks "who can act here?", so a manager matches
    -- every location by role rather than by a grant row they do not have.
    -- The clause is shared with the count above, so the two describe the same
    -- set — if they ever drift, the last page silently misbehaves.
    WHERE ${filterSql}
      AND ${cursor ? keysetSql(sortSql, Prisma.sql`u.id`, cursor, query.sortOrder) : Prisma.sql`TRUE`}
    ORDER BY ${sortSql} ${dir}, u.id ${dir}
    LIMIT ${query.limit + 1}
    OFFSET ${cursor ? 0 : offsetFor(query.page, query.limit)}
  `;

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  // Grants for exactly this page, in one round trip.
  const access = await prisma.userLocationAccess.findMany({
    where: { userId: { in: page.map((u) => u.id) } },
    include: { location: { select: { id: true, code: true, name: true } } },
    orderBy: { location: { code: 'asc' } },
  });

  const byUser = new Map<string, TeamMember['locations']>();
  for (const a of access) {
    const list = byUser.get(a.userId) ?? [];
    list.push(a.location);
    byUser.set(a.userId, list);
  }

  const last = page[page.length - 1];

  return {
    ...toPaged({
      rows: page.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        isActive: u.isActive,
        locations: byUser.get(u.id) ?? [],
        movementCount: Number(u.movementCount),
      })),
      page: query.page,
      pageSize: query.limit,
      total: counted.total,
      totalIsExact: counted.isExact,
      hasMore,
    }),
    nextCursor: hasMore && last ? encodeKeyset({ value: last.sortValue, id: last.id }) : null,
  };
}

export async function createUser(
  actor: AuthUser,
  input: CreateUserRequest,
  requestId: string,
): Promise<TeamMember> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new AppError(ERROR.EMAIL_EXISTS, 409, `${input.email} is already registered.`, {
      email: input.email,
    });
  }

  // A manager reaches every location by role, so grants are meaningless for
  // one — silently storing them would suggest a restriction that is not there.
  const locationIds = input.role === ROLE.MANAGER ? [] : input.locationIds;
  await assertLocationsExist(locationIds);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: await argon2.hash(input.password),
      locationAccess: { create: locationIds.map((locationId) => ({ locationId })) },
    },
  });

  await recordAccessChanges({
    userId: user.id,
    granted: locationIds,
    revoked: [],
    actorId: actor.id,
    requestId,
    reason: 'Account created',
  });

  return (await findTeamMember(user.id))!;
}

/**
 * Replaces a person's locations in one transaction.
 *
 * Moving someone from WH-A to SITE-1 is a single atomic change, not a revoke
 * followed by a grant — there is no instant where they can reach both, or
 * neither. That matters because a movement recorded in that window would be
 * attributed to access they were not supposed to have.
 */
export async function setUserLocations(
  actor: AuthUser,
  userId: string,
  input: SetUserLocationsRequest,
  requestId: string,
): Promise<TeamMember> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { locationAccess: true },
  });
  if (!user) throw new AppError(ERROR.USER_NOT_FOUND, 404, 'No such user.', { userId });

  if (user.role === ROLE.MANAGER) {
    throw AppError.forbidden(
      'A manager reaches every location by role. Change their role to handler first if you want to restrict them.',
    );
  }

  await assertLocationsExist(input.locationIds);

  const before = new Set(user.locationAccess.map((a) => a.locationId));
  const after = new Set(input.locationIds);

  const granted = input.locationIds.filter((id) => !before.has(id));
  const revoked = [...before].filter((id) => !after.has(id));

  if (granted.length === 0 && revoked.length === 0) {
    return (await findTeamMember(userId))!;
  }

  await prisma.$transaction([
    prisma.userLocationAccess.deleteMany({ where: { userId, locationId: { in: revoked } } }),
    prisma.userLocationAccess.createMany({
      data: granted.map((locationId) => ({ userId, locationId })),
      skipDuplicates: true,
    }),
  ]);

  await recordAccessChanges({
    userId,
    granted,
    revoked,
    actorId: actor.id,
    requestId,
    reason: input.reason ?? null,
  });

  // Revoking access does NOT touch past movements. Those are immutable and stay
  // attributed to whoever recorded them — losing access from now on is not the
  // same as never having been there.
  return (await findTeamMember(userId))!;
}

export async function updateUser(
  actor: AuthUser,
  userId: string,
  input: UpdateUserRequest,
): Promise<TeamMember> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(ERROR.USER_NOT_FOUND, 404, 'No such user.', { userId });

  // Locking yourself out, or demoting yourself, leaves nobody able to undo it.
  if (userId === actor.id && (input.isActive === false || input.role === ROLE.HANDLER)) {
    throw AppError.forbidden('You cannot deactivate or demote your own account.');
  }

  await prisma.user.update({ where: { id: userId }, data: input });
  return (await findTeamMember(userId))!;
}

/** The access history for one person — who changed what, when, and why. */
export async function getAccessHistory(userId: string): Promise<AccessChange[]> {
  const rows = await prisma.locationAccessChange.findMany({
    where: { userId },
    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    take: 100,
    include: {
      user: { select: { name: true } },
      changedBy: { select: { name: true } },
      location: { select: { code: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    userName: r.user.name,
    locationId: r.locationId,
    locationCode: r.location.code,
    action: r.action,
    changedByName: r.changedBy.name,
    changedAt: r.changedAt.toISOString(),
    reason: r.reason,
  }));
}

async function findTeamMember(userId: string): Promise<TeamMember | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      locationAccess: {
        include: { location: { select: { id: true, code: true, name: true } } },
        orderBy: { location: { code: 'asc' } },
      },
      _count: { select: { movements: true } },
    },
  });
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    locations: user.locationAccess.map((a) => a.location),
    movementCount: user._count.movements,
  };
}

async function assertLocationsExist(locationIds: string[]): Promise<void> {
  if (locationIds.length === 0) return;

  const found = await prisma.location.findMany({
    where: { id: { in: locationIds }, isActive: true },
    select: { id: true },
  });

  const missing = locationIds.filter((id) => !found.some((f) => f.id === id));
  if (missing.length > 0) {
    throw AppError.locationNotFound(missing[0]!);
  }
}

async function recordAccessChanges(args: {
  userId: string;
  granted: string[];
  revoked: string[];
  actorId: string;
  requestId: string;
  reason: string | null;
}): Promise<void> {
  const rows = [
    ...args.granted.map((locationId) => ({ locationId, action: ACCESS_CHANGE.GRANTED })),
    ...args.revoked.map((locationId) => ({ locationId, action: ACCESS_CHANGE.REVOKED })),
  ].map((r) => ({
    ...r,
    userId: args.userId,
    changedByUserId: args.actorId,
    reason: args.reason,
    requestId: args.requestId,
  }));

  if (rows.length === 0) return;

  await prisma.locationAccessChange.createMany({ data: rows });

  logger.info(
    {
      requestId: args.requestId,
      subjectUserId: args.userId,
      actorUserId: args.actorId,
      granted: args.granted,
      revoked: args.revoked,
    },
    'location access changed',
  );
}
