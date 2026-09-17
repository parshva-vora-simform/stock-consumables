/**
 * TanStack Query keys, built from one place.
 *
 * Invalidation is the reason this matters. `invalidateQueries({ queryKey:
 * ['item', id] })` silently does nothing if the query was registered as
 * `['items', id]` — no error, no warning, just a screen that does not refresh
 * after a movement is recorded. Built here, the two cannot disagree.
 */
export const queryKeys = {
  health: ['health'] as const,

  items: {
    all: ['items'] as const,
    list: (filters: unknown, page: number) => ['items', filters, page] as const,
    detail: (id: string | undefined) => ['item', id] as const,
  },

  movements: {
    history: (itemId: string) => ['history', itemId] as const,
    historyPage: (itemId: string, filters: unknown, sort: unknown, page: number) =>
      ['history', itemId, filters, sort, page] as const,
  },

  lowStock: {
    all: ['lowStock'] as const,
    list: (filters: unknown, page: number) => ['lowStock', filters, page] as const,
  },

  locations: {
    all: ['locations'] as const,
  },

  team: {
    all: ['team'] as const,
    list: (filters: unknown, page: number) => ['team', filters, page] as const,
    accessHistory: (userId: string) => ['accessHistory', userId] as const,
  },
} as const;
