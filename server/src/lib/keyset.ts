import { ERROR } from '@stock/shared';
import { Prisma } from '@prisma/client';
import { AppError } from './AppError.js';
import type { SortOrder } from '@stock/shared';

/**
 * Generic keyset (cursor) pagination.
 *
 * Every paginated list in this API sorts by some column plus `id` as a
 * tiebreaker, and pages by comparing that pair against the last row of the
 * previous page:
 *
 *     WHERE (sort_col, id) < ($lastSortValue, $lastId)   -- for DESC
 *
 * Why a tiebreaker is not optional: sort columns like `min_threshold` or
 * `quantity` are full of duplicates. Ordering by one alone leaves rows with
 * equal values in an arbitrary order that the database is free to change
 * between queries — so a row can appear on two consecutive pages, or on
 * neither. Appending a unique id makes the order total, and therefore makes
 * paging through it exact.
 *
 * And why not OFFSET: page 5,000 of a 100,000-row history costs the database
 * 5,000 pages of work to throw away 4,999 of them. Keyset costs the same at
 * page 5,000 as at page 1 (FR-8.3).
 */

export type SortValue = string | number | Date;

export type Keyset = {
  /** The sort column's value on the last row of the previous page. */
  value: SortValue;
  /** That row's id — the tiebreaker that makes the ordering total. */
  id: string;
};

export function encodeKeyset(cursor: Keyset): string {
  const value =
    cursor.value instanceof Date
      ? { t: 'd' as const, v: cursor.value.toISOString() }
      : typeof cursor.value === 'number'
        ? { t: 'n' as const, v: cursor.value }
        : { t: 's' as const, v: cursor.value };

  return Buffer.from(JSON.stringify({ ...value, i: cursor.id })).toString('base64url');
}

export function decodeKeyset(raw: string): Keyset {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      t: 'd' | 'n' | 's';
      v: string | number;
      i: string;
    };
    if (!parsed.i) throw new Error('missing id');

    const value: SortValue =
      parsed.t === 'd'
        ? new Date(parsed.v as string)
        : parsed.t === 'n'
          ? Number(parsed.v)
          : String(parsed.v);

    if (value instanceof Date && Number.isNaN(value.getTime())) throw new Error('bad date');

    return { value, id: parsed.i };
  } catch {
    throw new AppError(ERROR.VALIDATION_ERROR, 400, 'That pagination cursor is not valid.');
  }
}

/** The same comparison in raw SQL, for the queries Prisma cannot express. */
export function keysetSql(
  columnSql: Prisma.Sql,
  idColumnSql: Prisma.Sql,
  cursor: Keyset,
  order: SortOrder,
): Prisma.Sql {
  const value =
    cursor.value instanceof Date ? cursor.value : (cursor.value as string | number);

  // Row-value comparison: Postgres can satisfy it from a composite index as a
  // single range scan, which the equivalent OR chain does not always get.
  return order === 'asc'
    ? Prisma.sql`(${columnSql}, ${idColumnSql}) > (${value}, ${cursor.id}::uuid)`
    : Prisma.sql`(${columnSql}, ${idColumnSql}) < (${value}, ${cursor.id}::uuid)`;
}
