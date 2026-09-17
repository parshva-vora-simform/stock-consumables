import { ERROR, ROLE } from '@stock/shared';
import { createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/AppError.js';
import { logger } from '../../lib/logger.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  accessTokenSeconds,
  isStaleEpoch,
} from '../../lib/tokens.js';
import type { AuthUser } from '../../middleware/authenticate.js';
import type { CurrentUser, LoginResponse, AuthTokens } from '@stock/shared';

/** How long a refresh token family may live before a fresh sign-in is required. */
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function hashToken(token: string): string {
  // SHA-256, not argon2: the token is a signed JWT with 16 random bytes of
  // jti, so there is nothing to brute-force, and a slow hash on the refresh
  // path would be a denial-of-service lever.
  return createHash('sha256').update(token).digest('hex');
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // One message for both "no such user" and "wrong password", and the hash
  // verification runs either way, so response timing does not reveal which
  // emails exist.
  const invalid = new AppError(ERROR.INVALID_CREDENTIALS, 401, 'Email or password is incorrect.');

  if (!user || !user.isActive) {
    await argon2.verify(DUMMY_HASH, password).catch(() => false);
    throw invalid;
  }

  const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!ok) throw invalid;

  return {
    user: await toCurrentUser(user),
    // A sign-in starts a new family. Sessions on other devices are untouched:
    // signing in here is not a statement about anywhere else.
    tokens: await issueTokens(user, randomUUID()),
  };
}

/**
 * Exchanges a refresh token for a new pair — and spends the one presented.
 *
 * ### Why rotation, and why reuse is fatal to the family
 *
 * A refresh token is a full credential: it mints access tokens on demand. Left
 * un-rotated, a copy lifted from browser storage stays useful for its whole
 * seven days and nothing in the system can tell it was taken.
 *
 * Rotating on every use does not stop the theft, but it makes it observable.
 * After the thief refreshes once, the token the real client holds is spent —
 * and when the real client next refreshes, it presents a spent token. The
 * converse is equally true. Either way the system now knows that two parties
 * hold tokens from one lineage, which never happens in normal operation.
 *
 * There is no way to tell which of the two is the impostor, so the only safe
 * response is to end the family and make both sign in again. The legitimate
 * user is inconvenienced once; the attacker's foothold is gone.
 */
export async function refresh(presentedToken: string): Promise<AuthTokens> {
  const payload = verifyRefreshToken(presentedToken);

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive) {
    throw AppError.unauthenticated('That account is no longer active.');
  }

  // The same rule as the access path. Without it a refresh token from an
  // earlier epoch would keep minting valid access tokens indefinitely, which
  // would make a password reset cosmetic.
  if (isStaleEpoch(payload.ver, user.tokenEpoch)) {
    throw AppError.unauthenticated('Your password changed. Please sign in again.');
  }

  const tokenHash = hashToken(presentedToken);

  /**
   * Claim the token: check that it is spendable AND spend it, in one statement.
   *
   * This is the zero floor again, in a different costume. Reading `used_at`,
   * deciding, then writing it would leave a window in which two requests both
   * see an unspent token and both proceed — and the one thing this function
   * exists to detect is precisely two parties using one token. A read-then-write
   * here would make reuse detection blind to reuse that arrives concurrently,
   * which is the shape an attacker with a copied token actually produces.
   *
   * So the condition lives in the WHERE clause. Postgres takes a row lock for
   * the UPDATE; the second transaction re-evaluates against the committed row
   * under READ COMMITTED, matches nothing, and falls through to the reuse path.
   * Zero rows returned means "someone else already spent it".
   */
  const [claimed] = await prisma.$queryRaw<{ familyId: string }[]>`
    UPDATE refresh_tokens
    SET used_at = now()
    WHERE token_hash = ${tokenHash}
      AND used_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    RETURNING family_id AS "familyId"
  `;

  if (!claimed) {
    // Refused. Only now read the row, to say why — this read decides nothing.
    await explainFailedClaim(tokenHash);
  }

  // Issuing after the claim means a failure between the two costs the caller a
  // sign-in rather than leaving a spent token that still works. That is the
  // right way round: the alternative trades a security property for a
  // convenience one.
  return issueTokens(user, claimed!.familyId);
}

/**
 * Turns a refused claim into the right error — and, when it was reuse, ends the
 * family before it does.
 *
 * Always throws.
 */
async function explainFailedClaim(tokenHash: string): Promise<never> {
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  // Signed by us, unexpired, and yet we have no record of issuing it: a token
  // from before this table existed, or one whose family was pruned.
  if (!stored) throw AppError.unauthenticated('Please sign in again.');

  if (stored.revokedAt) {
    throw AppError.unauthenticated('This session was ended. Please sign in again.');
  }

  if (stored.usedAt) {
    // Reuse. Revoke the lineage, not just this row — whoever else holds a
    // token from it is holding a descendant, and revoking one link would leave
    // them all the others.
    await revokeFamily(stored.familyId, 'refresh token reuse detected');
    throw AppError.unauthenticated(
      'This session was ended for your security. Please sign in again.',
    );
  }

  throw AppError.unauthenticated('Your session has expired. Please sign in again.');
}

/**
 * Ends every session descended from one sign-in.
 *
 * Rows are marked rather than deleted: "this family was revoked, at this time"
 * is the fact worth keeping, and a deleted row is indistinguishable from one
 * that never existed when someone asks what happened to an account.
 */
async function revokeFamily(familyId: string, reason: string): Promise<void> {
  const revoked = await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  logger.warn({ familyId, reason, revoked: revoked.count }, 'refresh token family revoked');
}

/** Ends the family the given token belongs to. Used when signing out. */
export async function revokeRefreshToken(presentedToken: string): Promise<void> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(presentedToken) },
    select: { familyId: true },
  });
  // Nothing to revoke is a successful sign-out, not an error: the caller's
  // intent — "this token should stop working" — already holds.
  if (stored) await revokeFamily(stored.familyId, 'signed out');
}

export async function me(user: AuthUser): Promise<CurrentUser> {
  const full = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  return toCurrentUser(full);
}

/**
 * Mints a pair and records the refresh token, so it can be spent exactly once.
 *
 * `familyId` threads through every rotation of one sign-in — a fresh uuid at
 * login, the existing one on refresh.
 */
async function issueTokens(
  user: { id: string; email: string; role: AuthUser['role']; tokenEpoch: number },
  familyId: string,
): Promise<AuthTokens> {
  // A jti makes each token distinct even when minted in the same second with
  // the same claims, which is what lets two rotations be told apart at all.
  const refreshToken = signRefreshToken(user.id, user.tokenEpoch, randomUUID());

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });

  return {
    accessToken: signAccessToken(user),
    refreshToken,
    expiresIn: accessTokenSeconds(),
  };
}

/**
 * Includes the locations this user may act on. A manager gets every active
 * location; a handler gets only their grants. The client uses this to populate
 * pickers — the server still checks each request independently (AC-3).
 */
async function toCurrentUser(user: {
  id: string;
  email: string;
  name: string;
  role: AuthUser['role'];
}): Promise<CurrentUser> {
  const locations =
    user.role === ROLE.MANAGER
      ? await prisma.location.findMany({
          where: { isActive: true },
          select: { id: true, code: true, name: true },
          orderBy: { code: 'asc' },
        })
      : (
          await prisma.userLocationAccess.findMany({
            where: { userId: user.id, location: { isActive: true } },
            select: { location: { select: { id: true, code: true, name: true } } },
            orderBy: { location: { code: 'asc' } },
          })
        ).map((r) => r.location);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    locations,
  };
}

/**
 * A real argon2 hash of a value nobody uses, so the failure path does the same
 * work as the success path.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFy';
