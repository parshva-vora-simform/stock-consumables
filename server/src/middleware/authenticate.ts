import { ERROR } from '@stock/shared';
import type { RequestHandler } from 'express';
import { verifyAccessToken, isStaleEpoch } from '../lib/tokens.js';
import { AppError } from '../lib/AppError.js';
import { prisma } from '../db/prisma.js';
import type { UserRole } from '@stock/shared';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * There is no anonymous path through this system (FRD §6). Every movement is
 * attributed to a real user, so the token is not merely checked — the user is
 * loaded and confirmed still active, otherwise a deactivated account would keep
 * working until its token happened to expire.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw AppError.unauthenticated('Missing bearer token.');
    }

    const payload = verifyAccessToken(header.slice('Bearer '.length).trim());

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        tokenEpoch: true,
      },
    });

    if (!user) throw AppError.unauthenticated('That account no longer exists.');
    if (!user.isActive) throw AppError.unauthenticated('That account has been deactivated.');

    // A token from an earlier epoch is refused, even though it is still
    // cryptographically valid and unexpired. This is what makes a password
    // reset actually end the old sessions — otherwise resetting a compromised
    // password changes the lock while leaving the intruder's key working until
    // it happens to expire.
    if (isStaleEpoch(payload.ver, user.tokenEpoch)) {
      throw new AppError(
        ERROR.TOKEN_EXPIRED,
        401,
        'Your password changed. Please sign in again.',
      );
    }

    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
};

/** Narrows `req.user` for handlers that run behind `authenticate`. */
export function requireUser(req: Express.Request): AuthUser {
  if (!req.user) throw AppError.unauthenticated();
  return req.user;
}
