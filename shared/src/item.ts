import { z } from 'zod';
import { unitOfMeasure } from './enums.js';
import { cursorPagination, itemSortField, lowStockSortField, sortOrder } from './query.js';

export const createItemRequest = z.object({
  sku: z
    .string()
    .trim()
    .min(1, 'SKU is required.')
    .max(40)
    .regex(/^[A-Z0-9-]+$/, 'SKU may use capitals, digits and hyphens only.'),
  name: z.string().trim().min(1, 'Name is required.').max(120),
  unitOfMeasure,
  minThreshold: z.number().int().min(0, 'Threshold cannot be negative.').default(0),
});
export type CreateItemRequest = z.infer<typeof createItemRequest>;

export const updateItemRequest = z
  .object({
    sku: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9-]+$/, 'SKU may use capitals, digits and hyphens only.')
      .optional(),
    name: z.string().trim().min(1).max(120).optional(),
    minThreshold: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    /**
     * Only changeable while the item has no movements. Once quantities have
     * been recorded in boxes, relabelling the item as kilograms would silently
     * reinterpret every number in its history.
     */
    unitOfMeasure: unitOfMeasure.optional(),
    // No quantity field, and there never will be. Stock changes only through
    // a movement (FR-1.3).
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });
export type UpdateItemRequest = z.infer<typeof updateItemRequest>;

export const itemBalance = z.object({
  locationId: z.string().uuid(),
  locationCode: z.string(),
  locationName: z.string(),
  quantity: z.number().int(),
  belowThreshold: z.boolean(),
});
export type ItemBalance = z.infer<typeof itemBalance>;

export const item = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  unitOfMeasure,
  minThreshold: z.number().int(),
  isActive: z.boolean(),
});
export type Item = z.infer<typeof item>;

export const itemWithBalances = item.extend({
  balances: z.array(itemBalance),
  /**
   * Sum across the locations this caller can see. Presented as an aggregate and
   * labelled as one — it is NOT an issuable figure, because stock at one
   * location can never satisfy a request at another (FR-1.5, FR-5.2).
   */
  totalAcrossLocations: z.number().int(),
});
export type ItemWithBalances = z.infer<typeof itemWithBalances>;

export const listItemsQuery = cursorPagination.extend({
  /** 1-based. Ignored when a cursor is supplied. */
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().trim().max(120).optional(),
  includeInactive: z.coerce.boolean().default(false),
  unitOfMeasure: unitOfMeasure.optional(),
  /** Only items at or below threshold somewhere the caller can see. */
  lowStockOnly: z.coerce.boolean().default(false),
  locationId: z.string().uuid().optional(),
  sortBy: itemSortField.default('name'),
  sortOrder: sortOrder.default('asc'),
});
export type ListItemsQuery = z.infer<typeof listItemsQuery>;

export const lowStockQuery = cursorPagination.extend({
  /** 1-based. Ignored when a cursor is supplied. */
  page: z.coerce.number().int().min(1).default(1),
  locationId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
  /** Default: worst shortfall first — the order this view exists to give. */
  sortBy: lowStockSortField.default('headroom'),
  sortOrder: sortOrder.default('asc'),
});
export type LowStockQuery = z.infer<typeof lowStockQuery>;

export const lowStockRow = z.object({
  itemId: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  unitOfMeasure,
  locationId: z.string().uuid(),
  locationCode: z.string(),
  quantity: z.number().int(),
  minThreshold: z.number().int(),
  /** quantity - minThreshold. Negative is worse; used to sort by severity. */
  headroom: z.number().int(),
});
export type LowStockRow = z.infer<typeof lowStockRow>;
