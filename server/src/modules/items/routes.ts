import { ID_PARAM } from '../../lib/routeParams.js';
import { Router } from 'express';
import { z } from 'zod';
import { API, ROLE, createItemRequest, listItemsQuery, lowStockQuery, updateItemRequest } from '@stock/shared';
import { validate } from '../../middleware/validate.js';
import { pathParam } from '../../lib/params.js';
import { authenticate, requireUser } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import * as service from './service.js';
import { sumBalanceFromLedger } from '../movements/repository.js';
import { getLocationScope } from '../../lib/locationAccess.js';
import * as movements from '../movements/service.js';
import { movementHistoryQuery } from '@stock/shared';

export const itemsRouter: Router = Router();

const idParam = z.object({ id: z.string().uuid('Unknown item.') });

itemsRouter.get(
  API.items.list(),
  authenticate,
  validate(listItemsQuery, 'query'),
  async (req, res, next) => {
    try {
      res.json(await service.listItems(requireUser(req), req.query as never));
    } catch (err) {
      next(err);
    }
  },
);

// Mounted before /items/:id so "low-stock" is not read as an item id.
itemsRouter.get(
  API.items.lowStock(),
  authenticate,
  validate(lowStockQuery, 'query'),
  async (req, res, next) => {
    try {
      res.json(await service.listLowStock(requireUser(req), req.query as never));
    } catch (err) {
      next(err);
    }
  },
);

itemsRouter.get(
  API.items.detail(ID_PARAM),
  authenticate,
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      res.json(await service.getItem(requireUser(req), pathParam(req, 'id')));
    } catch (err) {
      next(err);
    }
  },
);

/** Per-item movement history: paginated, filterable (FR-8.1–8.4). */
/**
 * Balances for one item, from either source.
 *
 * `?mode=derived` sums the ledger instead of reading the cached balance. The
 * application never serves reads this way — it is O(n) in the movement count
 * and grows forever — but having both behind one route means the trade-off in
 * the README can be demonstrated rather than asserted, and it is the same query
 * the reconciliation job runs.
 */
itemsRouter.get(
  API.items.balance(ID_PARAM),
  authenticate,
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const itemId = pathParam(req, 'id');
      const item = await service.getItem(requireUser(req), itemId);

      if (req.query['mode'] !== 'derived') {
        res.json({
          mode: 'cached',
          source: 'stock_balances — a single indexed row per location, O(1)',
          balances: item.balances,
        });
        return;
      }

      const startedAt = Date.now();
      const summed = await sumBalanceFromLedger(itemId);
      const elapsedMs = Date.now() - startedAt;

      // Scoped the same way the cached path is: a derived figure that included
      // locations the caller cannot see would leak exactly what the scoping
      // exists to hide.
      const scope = await getLocationScope(requireUser(req));
      const visible =
        scope === 'ALL' ? summed : summed.filter((row) => scope.includes(row.locationId));

      res.json({
        mode: 'derived',
        source: 'SUM(signed_quantity) over movements — O(n) in the movement count',
        elapsedMs,
        balances: visible,
      });
    } catch (err) {
      next(err);
    }
  },
);

itemsRouter.get(
  API.items.movements(ID_PARAM),
  authenticate,
  validate(idParam, 'params'),
  validate(movementHistoryQuery, 'query'),
  async (req, res, next) => {
    try {
      res.json(await movements.getHistory(requireUser(req), pathParam(req, 'id'), req.query as never));
    } catch (err) {
      next(err);
    }
  },
);

itemsRouter.post(
  API.items.list(),
  authenticate,
  requireRole(ROLE.MANAGER),
  validate(createItemRequest),
  async (req, res, next) => {
    try {
      res.status(201).json(await service.createItem(req.body));
    } catch (err) {
      next(err);
    }
  },
);

itemsRouter.patch(
  API.items.detail(ID_PARAM),
  authenticate,
  requireRole(ROLE.MANAGER),
  validate(idParam, 'params'),
  validate(updateItemRequest),
  async (req, res, next) => {
    try {
      res.json(await service.updateItem(pathParam(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Remove an item.
 *
 * Deletes it outright only when no movement has ever referenced it. Once the
 * ledger has history for an item, the item is deactivated instead — the
 * response says which happened, so the UI can tell the truth rather than
 * claiming a deletion that did not occur (FR-1.4).
 */
itemsRouter.delete(
  API.items.detail(ID_PARAM),
  authenticate,
  requireRole(ROLE.MANAGER),
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      res.json(await service.deleteItem(pathParam(req, 'id')));
    } catch (err) {
      next(err);
    }
  },
);
