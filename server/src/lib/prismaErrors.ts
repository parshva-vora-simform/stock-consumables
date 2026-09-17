/**
 * Prisma's error codes, named.
 *
 * `err.code === 'P2002'` tells a reader nothing and a typo in it fails silently
 * — the branch simply never matches, and a unique-constraint violation escapes
 * as a 500 instead of the 409 it should be.
 *
 * https://www.prisma.io/docs/reference/api-reference/error-reference
 */
export const PRISMA_ERROR = {
  /** Unique constraint violated. */
  UNIQUE_VIOLATION: 'P2002',
  /** Foreign key constraint violated — a referenced row does not exist. */
  FOREIGN_KEY_VIOLATION: 'P2003',
  /** An operation matched no rows where one was required. */
  RECORD_NOT_FOUND: 'P2025',
} as const;
