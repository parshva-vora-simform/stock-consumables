import { z } from 'zod';

/**
 * Keyset pagination (FR-8.3). A cursor is an opaque base64 of the last row's
 * sort key plus its id — deliberately opaque so clients can't hand-craft one
 * and can't come to depend on its shape.
 *
 * This is the paging mode for anything walking a whole list: an export, a sync,
 * the load test. It costs the same at page 5,000 as at page 1.
 *
 * Numbered pages exist too — see `pagePagination` below — because people think
 * in pages and a page strip cannot be built from a cursor. They are a separate
 * mode with a separate cost, not a replacement for this one.
 */
export const cursorPagination = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
export type CursorPagination = z.infer<typeof cursorPagination>;

export const dateRange = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type Paginated<T> = {
  data: T[];
  /** null means this is the last page. */
  nextCursor: string | null;
};

/**
 * Numbered pagination.
 *
 * Page numbers need two things keyset pagination deliberately avoids: a total
 * count, and the ability to jump to an arbitrary offset. Both are fine on the
 * bounded tables — items, locations, people number in the hundreds. Movement
 * history is the one that reaches hundreds of thousands, so its count is capped
 * (see `totalIsExact` below) and the cursor API stays available for anything
 * that needs to walk the whole ledger without paying offset costs.
 *
 * Send `page`, or send `cursor` — not both.
 */
export const pagePagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
export type PagePagination = z.infer<typeof pagePagination>;

export type Paged<T> = {
  data: T[];
  page: number;
  pageSize: number;
  /**
   * Rows matching the filters. Capped: past the cap this is the cap itself and
   * `totalIsExact` is false, so the UI can say "500+" instead of making the
   * database count half a million rows to render a page of ten.
   */
  total: number;
  totalPages: number;
  totalIsExact: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  /**
   * The keyset cursor for the row after this page.
   *
   * Both paging modes travel in one envelope on purpose. The UI uses page
   * numbers because people think in pages; anything walking the whole list —
   * an export, a sync, the load test — follows the cursor instead and never
   * pays the offset cost that page 5,000 would incur (FR-8.3).
   */
  nextCursor?: string | null;
};

export const sortOrder = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrder>;

/**
 * Sort fields are an explicit allow-list per resource, never a free string.
 *
 * Two reasons. A free-form field name reaches the database as an identifier,
 * which is an injection surface no amount of escaping makes comfortable. And
 * every option here has to be backed by an index — an allow-list is the place
 * where "can we actually sort by this at scale?" gets answered once, instead of
 * being discovered when someone sorts a 500,000-row table by an unindexed
 * column.
 */
export const itemSortField = z.enum(['name', 'sku', 'minThreshold', 'totalQuantity']);
export type ItemSortField = z.infer<typeof itemSortField>;

export const lowStockSortField = z.enum(['headroom', 'quantity', 'name', 'locationCode']);
export type LowStockSortField = z.infer<typeof lowStockSortField>;

export const movementSortField = z.enum(['occurredAt', 'quantity']);
export type MovementSortField = z.infer<typeof movementSortField>;

export const userSortField = z.enum(['name', 'email', 'role', 'movementCount']);
export type UserSortField = z.infer<typeof userSortField>;
