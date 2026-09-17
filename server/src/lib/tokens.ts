import { ERROR } from '@stock/shared';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from './AppError.js';
import type { UserRole } from '@stock/shared';

export type AccessPayload = {
  sub: string;
  email: string;
  role: UserRole;
  typ: 'access';
  /**
   * The user's token epoch when this was minted. Refused once it no longer
   * matches — which is how a password change ends existing sessions exactly,
   * with no dependence on clock precision.
   */
  ver: number;
};

type RefreshPayload = {
  sub: string;
  typ: 'refresh';
  ver: number;
  /**
   * Unique per mint. Without it two rotations for the same user in the same
   * second produce byte-identical tokens, which would collide on the stored
   * hash and make "has this one been spent?" unanswerable.
   */
  jti: string;
};

export function signAccessToken(user: {
  id: string;
  email: string;
  role: UserRole;
  tokenEpoch: number;
}): string {
  const payload: AccessPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    typ: 'access',
    ver: user.tokenEpoch,
  };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_ACCESS_TTL } as jwt.SignOptions);
}

export function signRefreshToken(userId: string, tokenEpoch: number, jti: string): string {
  const payload: RefreshPayload = { sub: userId, typ: 'refresh', ver: tokenEpoch, jti };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_REFRESH_TTL } as jwt.SignOptions);
}

/**
 * The `typ` check is not ceremony: without it a refresh token — which is
 * long-lived by design — would be accepted as an access token, quietly undoing
 * the short access lifetime.
 */
export function verifyAccessToken(token: string): AccessPayload {
  const decoded = verify(token);
  if (decoded.typ !== 'access') {
    throw AppError.unauthenticated('That is not an access token.');
  }
  return decoded as AccessPayload;
}

export function verifyRefreshToken(token: string): RefreshPayload {
  const decoded = verify(token);
  if (decoded.typ !== 'refresh') {
    throw AppError.unauthenticated('That is not a refresh token.');
  }
  return decoded as RefreshPayload;
}

function verify(token: string): { typ?: string } & jwt.JwtPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') throw AppError.unauthenticated('Malformed token.');
    return decoded;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      // Distinct from a bad token: the client should refresh rather than
      // bounce the user to the login screen.
      throw new AppError(ERROR.TOKEN_EXPIRED, 401, 'Your session has expired.');
    }
    throw AppError.unauthenticated('Invalid token.');
  }
}

/** Access-token lifetime in seconds, for the client's refresh scheduling. */
export function accessTokenSeconds(): number {
  const ttl = env.JWT_ACCESS_TTL;
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 900;
  const value = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  return value * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
}

/**
 * True when a token predates the user's current epoch and must be refused.
 *
 * A plain integer comparison. The earlier version of this compared a JWT's
 * `iat` against a millisecond timestamp, which cannot be made correct: strict
 * comparison locks out accounts created in the same second, and second-level
 * truncation lets a reset within that second invalidate nothing.
 */
export function isStaleEpoch(tokenEpoch: number | undefined, currentEpoch: number): boolean {
  return tokenEpoch !== currentEpoch;
}
