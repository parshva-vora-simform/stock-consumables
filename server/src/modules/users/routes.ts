import { ID_PARAM } from '../../lib/routeParams.js';
import { Router } from 'express';
import { z } from 'zod';
import { API, ROLE, createUserRequest, listUsersQuery, setUserLocationsRequest, updateUserRequest } from '@stock/shared';
import { validate } from '../../middleware/validate.js';
import { pathParam } from '../../lib/params.js';
import { authenticate, requireUser } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import * as service from './service.js';
import { issueResetLinkFor } from '../auth/passwordReset.js';

export const usersRouter: Router = Router();

const idParam = z.object({ id: z.string().uuid('Unknown user.') });

/**
 * Every route here is manager-only. Deciding who may move stock where is an
 * administrative act, and the gate is the middleware — not a hidden menu.
 */
usersRouter.use(API.users.list(), authenticate, requireRole(ROLE.MANAGER));

usersRouter.get(API.users.list(), validate(listUsersQuery, 'query'), async (req, res, next) => {
  try {
    res.json(await service.listTeam(req.query as never));
  } catch (err) {
    next(err);
  }
});

usersRouter.post(API.users.list(), validate(createUserRequest), async (req, res, next) => {
  try {
    res.status(201).json(await service.createUser(requireUser(req), req.body, req.requestId));
  } catch (err) {
    next(err);
  }
});

usersRouter.patch(
  API.users.update(ID_PARAM),
  validate(idParam, 'params'),
  validate(updateUserRequest),
  async (req, res, next) => {
    try {
      res.json(await service.updateUser(requireUser(req), pathParam(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Assign a handler to warehouses or sites, or move them between them.
 *
 * PUT with the full set rather than add/remove: it is idempotent, and moving
 * someone from WH-A to SITE-1 becomes one atomic change instead of two steps
 * with a gap in between.
 */
usersRouter.put(
  API.users.locations(ID_PARAM),
  validate(idParam, 'params'),
  validate(setUserLocationsRequest),
  async (req, res, next) => {
    try {
      res.json(
        await service.setUserLocations(
          requireUser(req),
          pathParam(req, 'id'),
          req.body,
          req.requestId,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

/** Who granted or revoked what, when, and why. */
usersRouter.get(API.users.accessHistory(ID_PARAM), validate(idParam, 'params'), async (req, res, next) => {
  try {
    res.json({ data: await service.getAccessHistory(pathParam(req, 'id')) });
  } catch (err) {
    next(err);
  }
});

/**
 * A manager issues a reset link for someone else.
 *
 * Warehouse handlers frequently have no work email to receive a link at, so
 * without this the practical fallback is a manager inventing a password and
 * sending it over chat. This keeps the secret single-use and short-lived, and
 * the manager never learns the password that results.
 */
usersRouter.post(API.users.resetLink(ID_PARAM), validate(idParam, 'params'), async (req, res, next) => {
  try {
    res.json(
      await issueResetLinkFor({
        targetUserId: pathParam(req, 'id'),
        issuedByUserId: requireUser(req).id,
        requestId: req.requestId,
      }),
    );
  } catch (err) {
    next(err);
  }
});
