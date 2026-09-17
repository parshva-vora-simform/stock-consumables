import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { Paged } from '@stock/shared';

/**
 * Numbered pagination.
 *
 * Page numbers require the two things keyset pagination exists to avoid: a
 * count, and an offset. Both are cheap on bounded tables and expensive on the
 * ledger, so this module makes the expensive part bounded rather than pretending
 * it is free.
 */

/**
 * Counting stops here.
 *
 * `COUNT(*)` over a filtered set is O(matching rows) — at 500,000 movements
 * that is half a second spent working out a number whose only job is to size a
 * page strip. So the count runs against a LIMITed subquery: once it reaches the
 * cap we know there are "at least this many" and stop. The UI shows "1,000+"
 * and offers pages up to the cap; anything deeper is what the cursor API is for.
 */
export const COUNT_CAP = 1000;

/**
 * Counts up to the cap. Returns the exact figure when it is under, and the cap
 * with `isExact: false` when the set is larger.
 */
export async function countCapped(countSql: Prisma.Sql): Promise<{
  total: number;
  isExact: boolean;
}> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM (${countSql} LIMIT ${COUNT_CAP + 1}) capped
  `;

  const counted = Number(rows[0]?.count ?? 0);
  return counted > COUNT_CAP
    ? { total: COUNT_CAP, isExact: false }
    : { total: counted, isExact: true };
}

/** The same, for a count Prisma can express directly. */
export async function countCappedPrisma(
  count: (take: number) => Promise<number>,
): Promise<{ total: number; isExact: boolean }> {
  const counted = await count(COUNT_CAP + 1);
  return counted > COUNT_CAP
    ? { total: COUNT_CAP, isExact: false }
    : { total: counted, isExact: true };
}

/** Assembles the response envelope from a page of rows and a capped count. */
export function toPaged<T>(args: {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  totalIsExact: boolean;
  /**
   * Whether the `limit + 1` probe found another row. Every caller fetches one
   * row more than it needs precisely to answer this, so the answer is passed
   * in rather than guessed at here.
   */
  hasMore: boolean;
}): Paged<T> {
  const totalPages = Math.max(1, Math.ceil(args.total / args.pageSize));

  return {
    data: args.rows,
    page: args.page,
    pageSize: args.pageSize,
    total: args.total,
    totalPages,
    totalIsExact: args.totalIsExact,
    hasPrev: args.page > 1,
    /**
     * The probe row, not the count and not the page size.
     *
     * Inferring it from `rows.length === pageSize` is wrong on the last page
     * when that page happens to be exactly full: 25 items at 25 per page
     * reported `hasNext: true` alongside `totalPages: 1` and a null cursor —
     * three fields in one envelope, one of them lying, and a consumer that
     * trusted it would fetch an empty page.
     *
     * The count cannot answer it either: past `COUNT_CAP` the total is a floor,
     * so it would hide real pages.
     */
    hasNext: args.hasMore,
  };
}

/** Rows to skip for a 1-based page number. */
export function offsetFor(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}
