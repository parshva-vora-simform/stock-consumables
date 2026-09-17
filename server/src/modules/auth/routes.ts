import { Router } from 'express';
import { API, changePasswordRequest, forgotPasswordRequest, loginRequest, refreshRequest, resetPasswordRequest } from '@stock/shared';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireUser } from '../../middleware/authenticate.js';
import * as service from './service.js';
import * as passwordReset from './passwordReset.js';

export const authRouter: Router = Router();

authRouter.post(API.auth.login(), validate(loginRequest), async (req, res, next) => {
  try {
    res.json(await service.login(req.body.email, req.body.password));
  } catch (err) {
    next(err);
  }
});

authRouter.post(API.auth.refresh(), validate(refreshRequest), async (req, res, next) => {
  try {
    res.json(await service.refresh(req.body.refreshToken));
  } catch (err) {
    next(err);
  }
});

/**
 * Sign out: ends the refresh token's whole family server-side.
 *
 * Without this, clearing the client's storage only forgets the credential —
 * anything that already copied it keeps a working session for the remaining
 * seven days. Signing out has to mean something on the server or it means
 * nothing at all.
 *
 * Deliberately unauthenticated: an expired access token must not be able to
 * stop someone ending their session. Possession of the refresh token is the
 * authority here, and the only thing it authorises is revocation.
 */
authRouter.post(API.auth.logout(), validate(refreshRequest), async (req, res, next) => {
  try {
    await service.revokeRefreshToken(req.body.refreshToken);
    // Always 204, whether or not anything was revoked: the caller's intent is
    // satisfied either way, and a distinct answer would report whether a token
    // was live to anyone holding a guess.
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

authRouter.get(API.auth.me(), authenticate, async (req, res, next) => {
  try {
    res.json(await service.me(requireUser(req)));
  } catch (err) {
    next(err);
  }
});

/**
 * Start a reset. Always answers 200 with the same message, whether or not the
 * address is registered — a precise answer here would let anyone enumerate who
 * works at the company.
 */
authRouter.post(
  API.auth.forgotPassword(),
  validate(forgotPasswordRequest),
  async (req, res, next) => {
    try {
      res.json(
        await passwordReset.requestReset({
          email: req.body.email,
          ipAddress: req.ip,
          requestId: req.requestId,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

/** Redeem a reset link. Single use, 30 minutes, and it ends every old session. */
authRouter.post(API.auth.resetPassword(), validate(resetPasswordRequest), async (req, res, next) => {
  try {
    await passwordReset.resetPassword({
      token: req.body.token,
      password: req.body.password,
      requestId: req.requestId,
    });
    res.json({ message: 'Your password has been changed. Sign in with the new one.' });
  } catch (err) {
    next(err);
  }
});

/** Change your own password, which requires knowing the current one. */
authRouter.post(
  API.auth.changePassword(),
  authenticate,
  validate(changePasswordRequest),
  async (req, res, next) => {
    try {
      await passwordReset.changePassword({
        userId: requireUser(req).id,
        currentPassword: req.body.currentPassword,
        newPassword: req.body.newPassword,
        requestId: req.requestId,
      });
      // Every token minted before this moment — including the caller's own — is
      // now refused, so the client has to sign in again. That is the point.
      res.json({ message: 'Password changed. Please sign in again.' });
    } catch (err) {
      next(err);
    }
  },
);
