import { ID_PARAM } from '../../lib/routeParams.js';
import { Router } from 'express';
import { z } from 'zod';
import { API, ATTEMPT_OUTCOME, createMovementRequest, reverseMovementRequest } from '@stock/shared';
import { validate } from '../../middleware/validate.js';
import { pathParam } from '../../lib/params.js';
import { authenticate, requireUser } from '../../middleware/authenticate.js';
import { recordAttempt, outcomeFor, type AttemptContext } from '../audit/attemptRecorder.js';
import * as service from './service.js';

export const movementsRouter: Router = Router();

const idParam = z.object({ id: z.string().uuid('Unknown movement.') });

/**
 * Record a stock-in or stock-out.
 *
 * The try/catch here is not error handling — `errorHandler` does that. It is
 * the audit trail: every attempt leaves a row, accepted or rejected, and the
 * error is re-thrown untouched afterwards (FR-9.1).
 */
movementsRouter.post(
  API.movements.create(),
  authenticate,
  validate(createMovementRequest),
  async (req, res, next) => {
    const user = requireUser(req);
    const body = req.body as z.infer<typeof createMovementRequest>;

    const ctx: AttemptContext = {
      userId: user.id,
      requestId: req.requestId,
      ipAddress: req.ip,
      itemId: body.itemId,
      locationId: body.locationId,
      direction: body.direction,
      quantity: body.quantity,
    };

    try {
      const result = await service.recordMovement(user, body);
      await recordAttempt(ctx, ATTEMPT_OUTCOME.ACCEPTED, { resultingMovementId: result.movement.id });
      res.status(201).json(result);
    } catch (err) {
      await recordAttempt(ctx, outcomeFor(err), {
        failureDetail: err instanceof Error ? err.message : String(err),
      });
      next(err);
    }
  },
);

/** Correct a mistake (FR-6.1). There is no PATCH or DELETE for a movement. */
movementsRouter.post(
  API.movements.reverse(ID_PARAM),
  authenticate,
  validate(idParam, 'params'),
  validate(reverseMovementRequest),
  async (req, res, next) => {
    const user = requireUser(req);

    const ctx: AttemptContext = {
      userId: user.id,
      requestId: req.requestId,
      ipAddress: req.ip,
    };

    try {
      const result = await service.reverseMovement(user, pathParam(req, 'id'), req.body);
      await recordAttempt(
        { ...ctx, itemId: result.movement.itemId, locationId: result.movement.locationId,
          direction: result.movement.direction, quantity: result.movement.quantity },
        ATTEMPT_OUTCOME.ACCEPTED,
        { resultingMovementId: result.movement.id },
      );
      res.status(201).json(result);
    } catch (err) {
      await recordAttempt(ctx, outcomeFor(err), {
        failureDetail: err instanceof Error ? err.message : String(err),
      });
      next(err);
    }
  },
);
