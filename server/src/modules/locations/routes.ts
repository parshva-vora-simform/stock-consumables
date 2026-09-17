import { API } from '@stock/shared';
import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { authenticate, requireUser } from '../../middleware/authenticate.js';
import { getLocationScope } from '../../lib/locationAccess.js';

export const locationsRouter: Router = Router();

/**
 * Only the locations this caller may act on. A handler cannot enumerate the
 * locations they were not granted — the scope is a query predicate, not a
 * filter applied to a full list (AC-2).
 */
locationsRouter.get(API.locations.list(), authenticate, async (req, res, next) => {
  try {
    const scope = await getLocationScope(requireUser(req));
    const locations = await prisma.location.findMany({
      where: {
        isActive: true,
        ...(scope === 'ALL' ? {} : { id: { in: scope } }),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    });
    res.json({ data: locations });
  } catch (err) {
    next(err);
  }
});
