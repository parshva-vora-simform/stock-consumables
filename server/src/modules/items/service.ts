import { ERROR } from '@stock/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { PRISMA_ERROR } from '../../lib/prismaErrors.js';
import { AppError } from '../../lib/AppError.js';
import { getLocationScope, type LocationScope } from '../../lib/locationAccess.js';
import { encodeKeyset } from '../../lib/keyset.js';
import {
  findItems,
  balancesForItems,
  findLowStock,
  lowStockRowId,
  countItemsSql,
  countLowStockSql,
} from './repository.js';
import { countCapped, toPaged, offsetFor } from '../../lib/paging.js';
import { deleteBalancesForItem } from '../movements/repository.js';
import type { AuthUser } from '../../middleware/authenticate.js';
import type {
  CreateItemRequest,
  UpdateItemRequest,
  ItemWithBalances,
  ItemBalance,
  ListItemsQuery,
  LowStockQuery,
  LowStockRow,
  Paged,
} from '@stock/shared';

/**
 * A `?locationId=` filter the caller may not reach is a 403, never a silent
 * empty page.
 */
function assertInScope(scope: LocationScope, locationId: string): void {
  if (scope === 'ALL') return;
  if (!scope.includes(locationId)) throw AppError.forbiddenLocation(locationId);
}

/**
 * The caller's scope narrowed by an optional filter — an intersection, never a
 * replacement.
 *
 * Call `assertInScope` first: by the time a request reaches here the filter is
 * already known to be reachable, so the intersection is just the filter. This
 * function exists so that omitting the assert can never turn into a leak — the
 * result is still bounded by the scope either way.
 */
function narrowScope(scope: LocationScope, locationId?: string): LocationScope {
  if (!locationId) return scope;
  if (scope === 'ALL') return [locationId];
  return scope.includes(locationId) ? [locationId] : [];
}

/**
 * One page of items — sorted, filtered and paginated by the database.
 *
 * Two queries rather than one: the first picks the page in the requested order
 * (including by scoped total, which only the database can compute), the second
 * fetches balances for exactly those items. Both are page-sized and indexed.
 * The alternative — one query returning items joined to balances — multiplies
 * rows by location and makes LIMIT mean the wrong thing.
 */
export async function listItems(
  user: AuthUser,
  query: ListItemsQuery,
): Promise<Paged<ItemWithBalances>> {
  const scope = await getLocationScope(user);

  // A location outside the caller's scope is refused outright, the same way the
  // low-stock view and the movement history refuse it. Returning an empty list
  // instead would read as "no stock here", which is a different and misleading
  // statement (AC-3).
  if (query.locationId) assertInScope(scope, query.locationId);

  const offset = offsetFor(query.page, query.limit);

  // The count runs alongside the page rather than after it — it is a separate
  // question about the same filters, and there is no reason to wait.
  const [rows, counted] = await Promise.all([
    findItems({ query, scope, offset }),
    countCapped(countItemsSql({ query, scope })),
  ]);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  const balances = await balancesForItems({
    itemIds: page.map((r) => r.id),
    // The requested location NARROWS the caller's scope; it never replaces it.
    // Handing `[query.locationId]` straight through would have made the filter
    // the authority on what is visible, and any location id would then return
    // its quantities to anyone who asked.
    scope: narrowScope(scope, query.locationId),
  });

  const byItem = new Map<string, ItemBalance[]>();
  for (const b of balances) {
    const list = byItem.get(b.itemId) ?? [];
    list.push({
      locationId: b.locationId,
      locationCode: b.locationCode,
      locationName: b.locationName,
      quantity: Number(b.quantity),
      belowThreshold: b.belowThreshold,
    });
    byItem.set(b.itemId, list);
  }

  const last = page[page.length - 1];

  return {
    ...toPaged({
      rows: page.map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        unitOfMeasure: r.unitOfMeasure as ItemWithBalances['unitOfMeasure'],
        minThreshold: Number(r.minThreshold),
        isActive: r.isActive,
        balances: byItem.get(r.id) ?? [],
        totalAcrossLocations: Number(r.totalQuantity),
      })),
      page: query.page,
      pageSize: query.limit,
      total: counted.total,
      totalIsExact: counted.isExact,
      hasMore,
    }),
    // The cursor is still returned, so anything walking the whole list can keep
    // paying keyset costs instead of offset ones (FR-8.3).
    nextCursor: hasMore && last ? encodeKeyset({ value: last.sortValue, id: last.id }) : null,
  };
}

/** The low-stock view, paginated on the same keyset machinery. */
export async function listLowStock(
  user: AuthUser,
  query: LowStockQuery,
): Promise<Paged<LowStockRow>> {
  const scope = await getLocationScope(user);
  // A location outside the caller's scope is refused, not quietly emptied.
  if (query.locationId) assertInScope(scope, query.locationId);

  const offset = offsetFor(query.page, query.limit);

  const [rows, counted] = await Promise.all([
    findLowStock({ query, scope, offset }),
    countCapped(countLowStockSql({ query, scope })),
  ]);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    ...toPaged({
      rows: page.map(({ sortValue: _sortValue, ...row }) => row),
      page: query.page,
      pageSize: query.limit,
      total: counted.total,
      totalIsExact: counted.isExact,
      hasMore,
    }),
    nextCursor:
      hasMore && last ? encodeKeyset({ value: last.sortValue, id: lowStockRowId(last) }) : null,
  };
}

export async function getItem(user: AuthUser, itemId: string): Promise<ItemWithBalances> {
  const scope = await getLocationScope(user);

  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: {
      balances: {
        where: scope === 'ALL' ? {} : { locationId: { in: scope } },
        include: { location: { select: { id: true, code: true, name: true } } },
      },
    },
  });

  if (!item) throw AppError.itemNotFound(itemId);
  return toItemWithBalances(item);
}

export async function createItem(input: CreateItemRequest) {
  // The lookup is a courtesy, not the guarantee: two creates racing on one SKU
  // both find nothing here. The unique index decides, and the catch below turns
  // its rejection into the same answer the sequential path gives — otherwise
  // the loser of a race gets a generic DUPLICATE and the form has nothing
  // specific to show at the SKU field.
  const existing = await prisma.item.findUnique({ where: { sku: input.sku } });
  if (existing) throw skuExists(input.sku);

  try {
    return await prisma.item.create({ data: input });
  } catch (err) {
    if (isUniqueViolation(err)) throw skuExists(input.sku);
    throw err;
  }
}

function skuExists(sku: string): AppError {
  return new AppError(ERROR.SKU_EXISTS, 409, `SKU ${sku} is already in use.`, { sku });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === PRISMA_ERROR.UNIQUE_VIOLATION
  );
}

export async function updateItem(itemId: string, input: UpdateItemRequest) {
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item) throw AppError.itemNotFound(itemId);

  if (input.sku && input.sku !== item.sku) {
    const clash = await prisma.item.findUnique({ where: { sku: input.sku } });
    if (clash) throw skuExists(input.sku);
  }

  // The unit of measure is the meaning of every quantity in this item's
  // history. Changing it after movements exist would silently reinterpret them
  // all — 40 boxes becoming 40 kilograms — so it is fixed once the ledger has
  // anything to say about this item.
  if (input.unitOfMeasure && input.unitOfMeasure !== item.unitOfMeasure) {
    const movements = await prisma.movement.count({ where: { itemId } });
    if (movements > 0) {
      throw new AppError(
        ERROR.ITEM_HAS_MOVEMENTS,
        409,
        `${item.name} already has ${movements} movement${movements === 1 ? '' : 's'} recorded in ${item.unitOfMeasure.toLowerCase()}. Changing the unit now would reinterpret every one of them.`,
        { itemId, movements, currentUnit: item.unitOfMeasure },
      );
    }
  }

  // Note what is NOT updatable here: there is no quantity field to update.
  // Stock changes only by appending a movement (FR-1.3).
  try {
    return await prisma.item.update({ where: { id: itemId }, data: input });
  } catch (err) {
    // Same race as createItem: the check above can be overtaken.
    if (isUniqueViolation(err) && input.sku) throw skuExists(input.sku);
    throw err;
  }
}

/**
 * Removes an item — but only one that never existed as far as the ledger is
 * concerned (FR-1.4).
 *
 * An item with movements cannot be deleted. Its rows are immutable history:
 * deleting the item would either orphan them or force a cascade that erases
 * part of the audit trail, and "we deleted the record of what happened" is the
 * one outcome this system is built to prevent.
 *
 * The answer for those is deactivation, which stops new movements while leaving
 * the history readable. This function does it automatically rather than
 * refusing, so the operator gets the outcome they wanted — the item stops being
 * usable — and is told which of the two happened.
 */
export async function deleteItem(
  itemId: string,
): Promise<{ deleted: boolean; movements: number; item: { id: string; name: string } }> {
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item) throw AppError.itemNotFound(itemId);

  const movements = await prisma.movement.count({ where: { itemId } });

  if (movements > 0) {
    const deactivated = await prisma.item.update({
      where: { id: itemId },
      data: { isActive: false },
    });
    return { deleted: false, movements, item: { id: deactivated.id, name: deactivated.name } };
  }

  // No history: nothing to preserve, so it can go for real. The balance rows go
  // with it — they are derived, and with no movements behind them they are all
  // zero. The deletion is delegated to the movement repository because that is
  // the only module allowed to write stock_balances, deletions included.
  await prisma.$transaction(async (tx) => {
    await deleteBalancesForItem(itemId, tx);
    await tx.item.delete({ where: { id: itemId } });
  });

  return { deleted: true, movements: 0, item: { id: item.id, name: item.name } };
}

type ItemRow = {
  id: string;
  sku: string;
  name: string;
  unitOfMeasure: ItemWithBalances['unitOfMeasure'];
  minThreshold: number;
  isActive: boolean;
  balances: {
    locationId: string;
    quantity: number;
    location: { id: string; code: string; name: string };
  }[];
};

/**
 * Used by getItem only. The balances of ONE item are bounded by the number of
 * locations — a handful — so they are ordered in the query and returned whole
 * rather than paginated. Pagination exists for lists that grow without limit;
 * this one cannot.
 */
function toItemWithBalances(item: ItemRow): ItemWithBalances {
  const balances = item.balances
    .map((b) => ({
      locationId: b.location.id,
      locationCode: b.location.code,
      locationName: b.location.name,
      quantity: b.quantity,
      belowThreshold: b.quantity <= item.minThreshold,
    }))
    .sort((a, b) => a.locationCode.localeCompare(b.locationCode));

  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    unitOfMeasure: item.unitOfMeasure,
    minThreshold: item.minThreshold,
    isActive: item.isActive,
    balances,
    // An aggregate, and labelled as one in the UI. It is NOT issuable: stock at
    // one location can never satisfy a request at another (FR-1.5, FR-5.2).
    totalAcrossLocations: balances.reduce((sum, b) => sum + b.quantity, 0),
  };
}

export type { LocationScope };
