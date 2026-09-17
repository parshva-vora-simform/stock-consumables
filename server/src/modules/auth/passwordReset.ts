import { ERROR } from '@stock/shared';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/AppError.js';
import { logger } from '../../lib/logger.js';
import { env, isProduction } from '../../config/env.js';
import type { ForgotPasswordResponse } from '@stock/shared';

/** Long enough that guessing is not a strategy; short enough to paste. */
const TOKEN_BYTES = 32;
const TOKEN_TTL_MINUTES = 30;
/** Requests allowed per account per hour, before the endpoint starts refusing. */
const MAX_REQUESTS_PER_HOUR = 5;

/**
 * The same answer for every caller, registered or not.
 *
 * "No account with that email" is a useful sentence for a user and a very
 * useful sentence for someone mapping who works here. The cost of the vaguer
 * message is small; the cost of the precise one is an enumeration oracle.
 */
const NEUTRAL_MESSAGE =
  'If that email is registered, a reset link is on its way. It expires in 30 minutes.';

export async function requestReset(args: {
  email: string;
  ipAddress?: string | null;
  requestId: string;
}): Promise<ForgotPasswordResponse> {
  const user = await prisma.user.findUnique({ where: { email: args.email.toLowerCase() } });

  // Unknown or deactivated account: say exactly what we would have said anyway.
  if (!user || !user.isActive) {
    logger.info(
      { requestId: args.requestId, email: args.email },
      'password reset requested for unknown or inactive account',
    );
    return { message: NEUTRAL_MESSAGE };
  }

  // Throttled accounts get the neutral answer too, and no token. Returning a
  // 429 here would have undone everything above it: an unregistered address
  // always answers 200, so a sixth request that came back 429 would have said
  // "this address is registered" as plainly as the precise message this
  // endpoint refuses to send.
  if (await isThrottled(user.id)) {
    logger.warn(
      { requestId: args.requestId, userId: user.id },
      'password reset throttled — no token issued',
    );
    return { message: NEUTRAL_MESSAGE };
  }

  const { token, tokenHash } = generateToken();

  await prisma.$transaction([
    // Any earlier link for this account stops working. Two live links mean two
    // chances for an old one to be intercepted and still work.
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000),
        requestIp: args.ipAddress ?? null,
      },
    }),
  ]);

  const resetUrl = `${env.WEB_ORIGIN}/reset-password?token=${token}`;

  logger.info(
    { requestId: args.requestId, userId: user.id },
    'password reset token issued',
    // The token itself is deliberately absent from the log line. A log that
    // contains working reset links is a second copy of the password file.
  );

  if (isProduction) {
    // Where a mail provider belongs. Until one is wired in, production issues
    // the token and delivers nothing — which fails closed rather than leaking.
    return { message: NEUTRAL_MESSAGE };
  }

  // Outside production there is nothing to deliver the link, so hand it back
  // directly. Gated on NODE_ENV so this can never be the production path.
  console.log(`\n  Password reset link for ${user.email}:\n  ${resetUrl}\n`);
  return { message: NEUTRAL_MESSAGE, devResetUrl: resetUrl };
}

/**
 * Redeems a token and sets the new password.
 *
 * Three things happen together, or none of them do: the password changes, the
 * token is spent, and every token issued before this moment stops working.
 */
export async function resetPassword(args: {
  token: string;
  password: string;
  requestId: string;
}): Promise<void> {
  const tokenHash = hashToken(args.token);

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  const invalid = new AppError(
    ERROR.INVALID_RESET_TOKEN,
    400,
    'This reset link is no longer valid. Request a new one.',
  );

  // One message for unknown, spent and expired alike: the difference is of no
  // use to the person who legitimately holds the link, and of some use to
  // anyone probing.
  if (!record || record.usedAt || record.expiresAt < new Date() || !record.user.isActive) {
    logger.warn(
      { requestId: args.requestId, found: Boolean(record) },
      'invalid password reset attempt',
    );
    throw invalid;
  }

  const passwordHash = await argon2.hash(args.password);
  const now = new Date();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      // Bumping the epoch is what makes this a real reset: every token minted
      // under the old one is refused at authentication. Changing the lock has
      // to invalidate the keys, or a compromised account stays compromised
      // until the intruder's token happens to expire.
      data: { passwordHash, passwordChangedAt: now, tokenEpoch: { increment: 1 } },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: now },
    }),
    // Belt and braces: any other live link for this account is spent too.
    prisma.passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { usedAt: now },
    }),
  ]);

  logger.info({ requestId: args.requestId, userId: record.userId }, 'password reset completed');
}

/** Signed-in change, which requires knowing the current password. */
export async function changePassword(args: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  requestId: string;
}): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: args.userId } });

  const ok = await argon2.verify(user.passwordHash, args.currentPassword).catch(() => false);
  if (!ok) {
    throw new AppError(ERROR.INVALID_CREDENTIALS, 401, 'Your current password is incorrect.');
  }

  const now = new Date();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await argon2.hash(args.newPassword),
      passwordChangedAt: now,
      tokenEpoch: { increment: 1 },
    },
  });

  logger.info({ requestId: args.requestId, userId: user.id }, 'password changed');
}

/**
 * A manager issues a link on someone else's behalf.
 *
 * Warehouse handlers often have no work email to receive a link at, so without
 * this the practical fallback is a manager typing a password into a chat
 * window. This keeps the secret one-time and short-lived instead.
 */
export async function issueResetLinkFor(args: {
  targetUserId: string;
  issuedByUserId: string;
  requestId: string;
}): Promise<{ resetUrl: string; expiresAt: string }> {
  const user = await prisma.user.findUnique({ where: { id: args.targetUserId } });
  if (!user) throw new AppError(ERROR.USER_NOT_FOUND, 404, 'No such user.');
  if (!user.isActive) {
    throw AppError.forbidden('That account is deactivated. Reactivate it first.');
  }

  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);

  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        issuedByUserId: args.issuedByUserId,
      },
    }),
  ]);

  logger.info(
    { requestId: args.requestId, userId: user.id, issuedBy: args.issuedByUserId },
    'password reset link issued by a manager',
  );

  return {
    resetUrl: `${env.WEB_ORIGIN}/reset-password?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/**
 * SHA-256, not argon2. The token is 32 random bytes, so there is nothing to
 * brute-force and no benefit in a slow hash — while a slow hash on a lookup
 * path would be a denial-of-service lever.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Caps how many links one account can have issued in an hour.
 *
 * Returns a boolean rather than throwing, because the caller must answer
 * identically whether or not it fired. The cost is that a genuine user who
 * trips the limit waits for a link that is not coming — which is the right
 * trade at five requests an hour, and the alternative is an endpoint that
 * tells anyone who asks which addresses belong to real accounts.
 *
 * The limit is deliberately per account, not per IP. Per account it bounds the
 * mail one person can be made to receive; bounding the requests one attacker
 * can send is a job for a rate limiter in front of the app, not for this
 * function.
 */
async function isThrottled(userId: string): Promise<boolean> {
  const recent = await prisma.passwordResetToken.count({
    where: { userId, createdAt: { gt: new Date(Date.now() - 3_600_000) } },
  });
  return recent >= MAX_REQUESTS_PER_HOUR;
}
