/**
 * Every API path, in one place.
 *
 * Paths are built here rather than interpolated at each call site so a route
 * rename is one edit, and so the client cannot drift from the server by a
 * typo in a template string — `/item/${id}` instead of `/items/${id}` compiles
 * happily and fails at runtime.
 */
export const API = {
  health: () => '/health',

  auth: {
    login: () => '/auth/login',
    refresh: () => '/auth/refresh',
    logout: () => '/auth/logout',
    me: () => '/auth/me',
    forgotPassword: () => '/auth/forgot-password',
    resetPassword: () => '/auth/reset-password',
    changePassword: () => '/auth/change-password',
  },

  items: {
    list: () => '/items',
    create: () => '/items',
    lowStock: () => '/items/low-stock',
    detail: (id: string) => `/items/${id}`,
    update: (id: string) => `/items/${id}`,
    remove: (id: string) => `/items/${id}`,
    balance: (id: string) => `/items/${id}/balance`,
    movements: (id: string) => `/items/${id}/movements`,
  },

  locations: {
    list: () => '/locations',
  },

  movements: {
    create: () => '/movements',
    reverse: (id: string) => `/movements/${id}/reverse`,
  },

  users: {
    list: () => '/users',
    create: () => '/users',
    update: (id: string) => `/users/${id}`,
    locations: (id: string) => `/users/${id}/locations`,
    accessHistory: (id: string) => `/users/${id}/access-history`,
    resetLink: (id: string) => `/users/${id}/reset-link`,
  },
} as const;

/** The client's own routes, so `<NavLink>` and `navigate()` agree. */
export const APP_ROUTE = {
  root: '/',
  items: '/items',
  itemDetail: (id: string) => `/items/${id}`,
  lowStock: '/low-stock',
  team: '/team',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
} as const;
