import { DIRECTION, ERROR, MOVEMENT_TYPE } from '@stock/shared';
import { Prisma } from '@prisma/client';
import { PRISMA_ERROR } from '../../lib/prismaErrors.js';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/AppError.js';
import { assertLocationAllowed, getLocationScope } from '../../lib/locationAccess.js';
import { decodeKeyset, encodeKeyset } from '../../lib/keyset.js';
import { countCappedPrisma, toPaged, offsetFor } from '../../lib/paging.js';
import { appendMovement } from './repository.js';
import type { AuthUser } from '../../middleware/authenticate.js';
import type {
  CreateMovementRequest,
  CreateMovementResponse,
  Movement,
  MovementHistoryQuery,
  ReverseMovementRequest,
  Paged,
} from '@stock/shared';

/**
 * Records a stock-in or stock-out.
 *
 * Order of operations matters here. Everything that can be refused cheaply —
 * bad input (already done by the route's schema), unknown item or location,
 * inactive records, a location the user cannot reach — is refused BEFORE the
 * transaction opens. Only the zero floor is decided inside it, because only the
 * zero floor needs to be.
 */
export async function recordMovement(
  user: AuthUser,
  input: CreateMovementRequest,
): Promise<CreateMovementResponse> {
  // Idempotency (FR-2.4): a retried or double-clicked submit returns the
  // movement already recorded rather than recording a second one.
  //
  // This fast path handles the ordinary case — a retry arriving after the first
  // request finished. It is NOT the guarantee: two requests racing with the
  // same key both find nothing here. The unique index is what actually prevents
  // the duplicate, and the catch below turns its rejection into the right
  // answer. Checking first and inserting second is exactly the pattern this
  // project exists to distrust; here it is an optimisation, not a decision.
  if (input.idempotencyKey) {
    const replay = await findByIdempotencyKey(user.id, input.idempotencyKey);
    if (replay) return replay;
  }

  const [item, location] = await Promise.all([
    prisma.item.findUnique({ where: { id: input.itemId } }),
    prisma.location.findUnique({ where: { id: input.locationId } }),
  ]);

  if (!item) throw AppError.itemNotFound(input.itemId);
  if (!location) throw AppError.locationNotFound(input.locationId);
  if (!item.isActive) {
    throw new AppError(ERROR.ITEM_INACTIVE, 422, `${item.name} is no longer in use.`, {
      itemId: item.id,
    });
  }
  if (!location.isActive) {
    throw new AppError(ERROR.LOCATION_INACTIVE, 422, `${location.code} is no longer in use.`, {
      locationId: location.id,
    });
  }

  await assertLocationAllowed(user, input.locationId);

  try {
    const result = await appendMovement({
      itemId: input.itemId,
      locationId: input.locationId,
      direction: input.direction,
      quantity: input.quantity,
      recordedByUserId: user.id,
      occurredAt: input.occurredAt,
      reference: input.reference ?? null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    return {
      movement: await loadMovement(result.movementId),
      balanceAfter: result.balanceAfter,
    };
  } catch (err) {
    // Lost an idempotency race: another request with this same key committed
    // first. Its transaction is the one that counts, so return ITS movement
    // rather than reporting a conflict — from the caller's point of view the
    // submit succeeded exactly once, which is the whole point of the key.
    if (
      input.idempotencyKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === PRISMA_ERROR.UNIQUE_VIOLATION
    ) {
      const winner = await findByIdempotencyKey(user.id, input.idempotencyKey);
      if (winner) return winner;
    }

    // Re-thrown with the location code, so the message names a place the
    // operator recognises rather than a UUID.
    if (err instanceof AppError && err.code === ERROR.INSUFFICIENT_STOCK) {
      throw AppError.insufficientStock({
        itemId: input.itemId,
        locationId: input.locationId,
        locationCode: location.code,
        requested: input.quantity,
        available: Number(err.details?.['available'] ?? 0),
      });
    }
    throw err;
  }
}

/**
 * Returns the movement already recorded under this key, with the balance as it
 * stands now. Null when the key has not been used.
 */
async function findByIdempotencyKey(
  userId: string,
  idempotencyKey: string,
): Promise<CreateMovementResponse | null> {
  const existing = await prisma.movement.findUnique({
    where: { recordedByUserId_idempotencyKey: { recordedByUserId: userId, idempotencyKey } },
    select: { id: true, itemId: true, locationId: true },
  });
  if (!existing) return null;

  const balance = await prisma.stockBalance.findUnique({
    where: { itemId_locationId: { itemId: existing.itemId, locationId: existing.locationId } },
    select: { quantity: true },
  });

  return { movement: await loadMovement(existing.id), balanceAfter: balance?.quantity ?? 0 };
}

/**
 * Corrects a mistake by appending a reversal (FR-6.1).
 *
 * The original row is never touched — the database would refuse it anyway. Both
 * the error and its correction stay visible in history, which is the only kind
 * of audit trail worth keeping.
 */
export async function reverseMovement(
  user: AuthUser,
  movementId: string,
  input: ReverseMovementRequest,
): Promise<CreateMovementResponse> {
  const original = await prisma.movement.findUnique({
    where: { id: movementId },
    include: { location: true, reversedBy: true },
  });

  if (!original) {
    throw new AppError(ERROR.MOVEMENT_NOT_FOUND, 404, 'No such movement.', { movementId });
  }

  // A reversal of a reversal would make the ledger's intent unreadable. To undo
  // one, record a fresh normal movement instead (FR-6.3).
  if (original.movementType === MOVEMENT_TYPE.REVERSAL) {
    throw new AppError(
      ERROR.CANNOT_REVERSE_REVERSAL,
      409,
      'A reversal cannot itself be reversed. Record a new movement instead.',
      { movementId },
    );
  }

  if (original.reversedBy) {
    throw new AppError(ERROR.ALREADY_REVERSED, 409, 'That movement has already been reversed.', {
      movementId,
      reversalId: original.reversedBy.id,
    });
  }

  await assertLocationAllowed(user, original.locationId);

  // Reversing a stock-IN removes stock, so it faces the zero floor like any
  // stock-out. If the stock has since been issued, this legitimately fails and
  // the situation is resolved as a stock-take — the ledger is not bent to make
  // a correction convenient (FR-6.4).
  const opposite = original.direction === DIRECTION.IN ? DIRECTION.OUT : DIRECTION.IN;

  try {
    const result = await appendMovement({
      itemId: original.itemId,
      locationId: original.locationId,
      direction: opposite,
      quantity: original.quantity,
      recordedByUserId: user.id,
      movementType: MOVEMENT_TYPE.REVERSAL,
      reversesMovementId: original.id,
      note: input.reason,
      reference: original.reference,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    return {
      movement: await loadMovement(result.movementId),
      balanceAfter: result.balanceAfter,
    };
  } catch (err) {
    if (err instanceof AppError && err.code === ERROR.INSUFFICIENT_STOCK) {
      throw new AppError(
        ERROR.INSUFFICIENT_STOCK,
        409,
        `Cannot reverse this stock-in: only ${err.details?.['available'] ?? 0} of the ${original.quantity} received remain at ${original.location.code}. Record a stock-take instead.`,
        err.details,
      );
    }
    throw err;
  }
}

/**
 * Per-item movement history (FR-8.1–8.4).
 *
 * Keyset pagination on (occurred_at DESC, id DESC), served by the composite
 * index. No OFFSET, and no COUNT(*) — either would make page 5,000 of a 100,000
 * row history cost what the first 5,000 pages cost put together.
 */
export async function getHistory(
  user: AuthUser,
  itemId: string,
  query: MovementHistoryQuery,
): Promise<Paged<Movement>> {
  const item = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true } });
  if (!item) throw AppError.itemNotFound(itemId);

  const scope = await getLocationScope(user);

  // A requested location outside the caller's scope is refused outright rather
  // than quietly returning nothing — an empty list reads as "no movements",
  // which is a different and misleading statement (AC-3).
  if (query.locationId) await assertLocationAllowed(user, query.locationId);

  const cursor = query.cursor ? decodeKeyset(query.cursor) : null;

  // Both sort fields are backed by a composite index ending in id, so the
  // ordering is total and the keyset comparison below is an index range rather
  // than a filter over everything the query matched.
  const sortField = query.sortBy === 'quantity' ? 'quantity' : 'occurredAt';
  const dir = query.sortOrder;
  const after = dir === 'asc' ? 'gt' : 'lt';

  const where = {
      itemId,
      ...(scope === 'ALL' ? {} : { locationId: { in: scope } }),
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.userId ? { recordedByUserId: query.userId } : {}),
      ...(query.movementType ? { movementType: query.movementType } : {}),
      ...(query.reference
        ? { reference: { contains: query.reference, mode: 'insensitive' as const } }
        : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(cursor
        ? {
            // Equivalent to (sortField, id) </> (value, id). Prisma has no
            // row-value syntax, but the planner treats this form the same way.
            OR: [
              { [sortField]: { [after]: cursor.value } },
              { [sortField]: cursor.value, id: { [after]: cursor.id } },
            ],
          }
        : {}),
  };

  // The count is capped (lib/paging.ts). Counting every movement behind an item
  // to render a page strip is precisely the cost FR-8.5 rules out — past the cap
  // the UI says "1,000+" and the cursor below remains the way to walk it all.
  const [rows, counted] = await Promise.all([
    prisma.movement.findMany({
      where,
      orderBy: [{ [sortField]: dir }, { id: dir }],
      // One extra row tells us a next page exists without consulting the count.
      take: query.limit + 1,
      skip: cursor ? 0 : offsetFor(query.page, query.limit),
      include: MOVEMENT_INCLUDE,
    }),
    countCappedPrisma((take) => prisma.movement.count({ where, take })),
  ]);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    ...toPaged({
      rows: page.map(toMovement),
      page: query.page,
      pageSize: query.limit,
      total: counted.total,
      totalIsExact: counted.isExact,
      hasMore,
    }),
    nextCursor:
      hasMore && last
        ? encodeKeyset({
            value: sortField === 'quantity' ? last.quantity : last.occurredAt,
            id: last.id,
          })
        : null,
  };
}

const MOVEMENT_INCLUDE = {
  item: { select: { sku: true, name: true } },
  location: { select: { code: true } },
  recordedBy: { select: { id: true, name: true } },
  reversedBy: { select: { id: true } },
} satisfies Prisma.MovementInclude;

type MovementRow = Prisma.MovementGetPayload<{ include: typeof MOVEMENT_INCLUDE }>;

async function loadMovement(id: string): Promise<Movement> {
  const row = await prisma.movement.findUniqueOrThrow({
    where: { id },
    include: MOVEMENT_INCLUDE,
  });
  return toMovement(row);
}

function toMovement(row: MovementRow): Movement {
  return {
    id: row.id,
    itemId: row.itemId,
    itemSku: row.item.sku,
    itemName: row.item.name,
    locationId: row.locationId,
    locationCode: row.location.code,
    direction: row.direction,
    quantity: row.quantity,
    signedQuantity: row.signedQuantity,
    movementType: row.movementType,
    recordedBy: { id: row.recordedBy.id, name: row.recordedBy.name },
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    reference: row.reference,
    note: row.note,
    reversesMovementId: row.reversesMovementId,
    reversedByMovementId: row.reversedBy?.id ?? null,
  };
}
