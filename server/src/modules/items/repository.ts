import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { decodeKeyset, keysetSql, type Keyset } from '../../lib/keyset.js';
import type { LocationScope } from '../../lib/locationAccess.js';
import type { ListItemsQuery, LowStockQuery, LowStockRow, SortOrder } from '@stock/shared';

/**
 * Item and low-stock queries.
 *
 * Both sort, filter and page entirely in SQL. Nothing here fetches a full table
 * for the client to work on — at 25 items that would be indistinguishable, and
 * at the volume this POC targets it is the difference between a page load and a
 * timeout.
 */

/** Sort field → the SQL expression it orders by. An allow-list, not a string. */
const ITEM_SORT: Record<ListItemsQuery['sortBy'], Prisma.Sql> = {
  name: Prisma.sql`i.name`,
  sku: Prisma.sql`i.sku`,
  minThreshold: Prisma.sql`i.min_threshold`,
  // The scoped total, computed in the database. Sorting this in the client
  // would only ever sort the page you already have.
  //
  // Cast to int deliberately: SUM() returns bigint, which JSON.stringify
  // refuses outright — and this value travels to the client inside the cursor.
  totalQuantity: Prisma.sql`COALESCE(b.total, 0)::int`,
};

const LOW_STOCK_SORT: Record<LowStockQuery['sortBy'], Prisma.Sql> = {
  headroom: Prisma.sql`(b.quantity - i.min_threshold)`,
  quantity: Prisma.sql`b.quantity`,
  name: Prisma.sql`i.name`,
  locationCode: Prisma.sql`l.code`,
};

export type ItemListRow = {
  id: string;
  sku: string;
  name: string;
  unitOfMeasure: string;
  minThreshold: number;
  isActive: boolean;
  totalQuantity: number;
  lowLocationCount: number;
  sortValue: string | number;
};

/**
 * One page of items, ordered and filtered by the database.
 *
 * The scoped total is a lateral aggregate rather than a join-and-group, so the
 * item row is produced once and the balance lookup runs per item against its
 * primary key — hundreds of rows, not the ledger.
 */
export async function findItems(args: {
  query: ListItemsQuery;
  scope: LocationScope;
  /** Rows to skip, for numbered pages. Ignored when a cursor is supplied. */
  offset?: number;
}): Promise<ItemListRow[]> {
  const { query } = args;
  const scopeIds = args.scope === 'ALL' ? null : args.scope;
  const cursor = query.cursor ? decodeKeyset(query.cursor) : null;
  const sortSql = ITEM_SORT[query.sortBy];
  const dir = query.sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  // The caller's scope narrowed further by an explicit location filter, so the
  // totals and the low-stock flag describe exactly what was asked for.
  const locationFilter = Prisma.sql`
    (${scopeIds}::uuid[] IS NULL OR sb.location_id = ANY(${scopeIds}::uuid[]))
    AND (${query.locationId ?? null}::uuid IS NULL OR sb.location_id = ${query.locationId ?? null}::uuid)
  `;

  return prisma.$queryRaw<ItemListRow[]>`
    SELECT
      i.id,
      i.sku,
      i.name,
      i.unit_of_measure::text                AS "unitOfMeasure",
      i.min_threshold                        AS "minThreshold",
      i.is_active                            AS "isActive",
      COALESCE(b.total, 0)::int              AS "totalQuantity",
      COALESCE(b.low_count, 0)::int          AS "lowLocationCount",
      ${sortSql}                             AS "sortValue"
    FROM items i
    LEFT JOIN LATERAL (
      SELECT
        SUM(sb.quantity)                                              AS total,
        COUNT(*) FILTER (WHERE sb.quantity <= i.min_threshold)        AS low_count
      FROM stock_balances sb
      WHERE sb.item_id = i.id AND ${locationFilter}
    ) b ON TRUE
    WHERE
      (${query.includeInactive} OR i.is_active)
      AND (
        ${query.search ?? null}::text IS NULL
        OR i.name ILIKE ${`%${query.search ?? ''}%`}
        OR i.sku  ILIKE ${`%${query.search ?? ''}%`}
      )
      AND (${query.unitOfMeasure ?? null}::text IS NULL
           OR i.unit_of_measure::text = ${query.unitOfMeasure ?? null})
      AND (${!query.lowStockOnly} OR COALESCE(b.low_count, 0) > 0)
      AND ${cursor ? keysetSql(sortSql, Prisma.sql`i.id`, cursor, query.sortOrder) : Prisma.sql`TRUE`}
    ORDER BY ${sortSql} ${dir}, i.id ${dir}
    LIMIT ${query.limit + 1}
    OFFSET ${cursor ? 0 : (args.offset ?? 0)}
  `;
}

/**
 * How many items match, for the page strip. Shares its WHERE clause with
 * findItems — if the two ever drift, the count describes a different set than
 * the rows and the last page silently misbehaves.
 */
export function countItemsSql(args: { query: ListItemsQuery; scope: LocationScope }): Prisma.Sql {
  const { query } = args;
  const scopeIds = args.scope === 'ALL' ? null : args.scope;

  const locationFilter = Prisma.sql`
    (${scopeIds}::uuid[] IS NULL OR sb.location_id = ANY(${scopeIds}::uuid[]))
    AND (${query.locationId ?? null}::uuid IS NULL OR sb.location_id = ${query.locationId ?? null}::uuid)
  `;

  return Prisma.sql`
    SELECT 1
    FROM items i
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE sb.quantity <= i.min_threshold) AS low_count
      FROM stock_balances sb
      WHERE sb.item_id = i.id AND ${locationFilter}
    ) b ON TRUE
    WHERE
      (${query.includeInactive} OR i.is_active)
      AND (
        ${query.search ?? null}::text IS NULL
        OR i.name ILIKE ${`%${query.search ?? ''}%`}
        OR i.sku  ILIKE ${`%${query.search ?? ''}%`}
      )
      AND (${query.unitOfMeasure ?? null}::text IS NULL
           OR i.unit_of_measure::text = ${query.unitOfMeasure ?? null})
      AND (${!query.lowStockOnly} OR COALESCE(b.low_count, 0) > 0)
  `;
}

/** Per-location balances for a page of items, in one round trip. */
export async function balancesForItems(args: { itemIds: string[]; scope: LocationScope }) {
  if (args.itemIds.length === 0) return [];
  const scopeIds = args.scope === 'ALL' ? null : args.scope;

  return prisma.$queryRaw<
    {
      itemId: string;
      locationId: string;
      locationCode: string;
      locationName: string;
      quantity: number;
      belowThreshold: boolean;
    }[]
  >`
    SELECT
      b.item_id                        AS "itemId",
      l.id                             AS "locationId",
      l.code                           AS "locationCode",
      l.name                           AS "locationName",
      b.quantity::int                  AS "quantity",
      (b.quantity <= i.min_threshold)  AS "belowThreshold"
    FROM stock_balances b
    JOIN items i     ON i.id = b.item_id
    JOIN locations l ON l.id = b.location_id
    WHERE b.item_id = ANY(${args.itemIds}::uuid[])
      AND (${scopeIds}::uuid[] IS NULL OR b.location_id = ANY(${scopeIds}::uuid[]))
    ORDER BY l.code ASC
  `;
}

/**
 * The low-stock view (FR-7.1, FR-7.2), now with real pagination.
 *
 * The threshold comparison is in the WHERE clause, the scope is a predicate,
 * and the ordering is the database's. It reads `stock_balances` — hundreds of
 * rows — never the ledger.
 */
export async function findLowStock(args: {
  query: LowStockQuery;
  scope: LocationScope;
  offset?: number;
}): Promise<(LowStockRow & { sortValue: string | number })[]> {
  const { query } = args;
  const scopeIds = args.scope === 'ALL' ? null : args.scope;
  const cursor = query.cursor ? decodeKeyset(query.cursor) : null;
  const sortSql = LOW_STOCK_SORT[query.sortBy];
  const dir = query.sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  const rows = await prisma.$queryRaw<
    {
      itemId: string;
      sku: string;
      name: string;
      unitOfMeasure: string;
      locationId: string;
      locationCode: string;
      quantity: number;
      minThreshold: number;
      headroom: number;
      rowId: string;
      sortValue: string | number;
    }[]
  >`
    SELECT
      i.id                            AS "itemId",
      i.sku                           AS "sku",
      i.name                          AS "name",
      i.unit_of_measure::text         AS "unitOfMeasure",
      l.id                            AS "locationId",
      l.code                          AS "locationCode",
      b.quantity::int                 AS "quantity",
      i.min_threshold::int            AS "minThreshold",
      (b.quantity - i.min_threshold)::int AS "headroom",
      -- A balance has no id of its own; the (item, location) pair is its key.
      -- Concatenating them gives the keyset a stable, unique tiebreaker.
      (i.id::text || ':' || l.id::text)   AS "rowId",
      ${sortSql}                      AS "sortValue"
    FROM stock_balances b
    JOIN items i     ON i.id = b.item_id AND i.is_active
    JOIN locations l ON l.id = b.location_id AND l.is_active
    WHERE b.quantity <= i.min_threshold
      AND (${scopeIds}::uuid[] IS NULL OR b.location_id = ANY(${scopeIds}::uuid[]))
      AND (${query.locationId ?? null}::uuid IS NULL OR b.location_id = ${query.locationId ?? null}::uuid)
      AND (
        ${query.search ?? null}::text IS NULL
        OR i.name ILIKE ${`%${query.search ?? ''}%`}
        OR i.sku  ILIKE ${`%${query.search ?? ''}%`}
      )
      AND ${cursor ? lowStockKeyset(sortSql, cursor, query.sortOrder) : Prisma.sql`TRUE`}
    ORDER BY ${sortSql} ${dir}, (i.id::text || ':' || l.id::text) ${dir}
    LIMIT ${query.limit + 1}
    OFFSET ${cursor ? 0 : (args.offset ?? 0)}
  `;

  return rows.map((r) => ({
    itemId: r.itemId,
    sku: r.sku,
    name: r.name,
    unitOfMeasure: r.unitOfMeasure as LowStockRow['unitOfMeasure'],
    locationId: r.locationId,
    locationCode: r.locationCode,
    quantity: Number(r.quantity),
    minThreshold: Number(r.minThreshold),
    headroom: Number(r.headroom),
    sortValue: r.sortValue,
  }));
}

/** Matching count for the low-stock page strip. */
export function countLowStockSql(args: {
  query: LowStockQuery;
  scope: LocationScope;
}): Prisma.Sql {
  const { query } = args;
  const scopeIds = args.scope === 'ALL' ? null : args.scope;

  return Prisma.sql`
    SELECT 1
    FROM stock_balances b
    JOIN items i     ON i.id = b.item_id AND i.is_active
    JOIN locations l ON l.id = b.location_id AND l.is_active
    WHERE b.quantity <= i.min_threshold
      AND (${scopeIds}::uuid[] IS NULL OR b.location_id = ANY(${scopeIds}::uuid[]))
      AND (${query.locationId ?? null}::uuid IS NULL OR b.location_id = ${query.locationId ?? null}::uuid)
      AND (
        ${query.search ?? null}::text IS NULL
        OR i.name ILIKE ${`%${query.search ?? ''}%`}
        OR i.sku  ILIKE ${`%${query.search ?? ''}%`}
      )
  `;
}

/** The composite key here is text, not a uuid, so it needs its own comparison. */
function lowStockKeyset(sortSql: Prisma.Sql, cursor: Keyset, order: SortOrder): Prisma.Sql {
  const rowId = Prisma.sql`(i.id::text || ':' || l.id::text)`;
  const value = cursor.value instanceof Date ? cursor.value : (cursor.value as string | number);
  return order === 'asc'
    ? Prisma.sql`(${sortSql}, ${rowId}) > (${value}, ${cursor.id})`
    : Prisma.sql`(${sortSql}, ${rowId}) < (${value}, ${cursor.id})`;
}

/** The keyset id for a low-stock row. */
export function lowStockRowId(row: { itemId: string; locationId: string }): string {
  return `${row.itemId}:${row.locationId}`;
}
