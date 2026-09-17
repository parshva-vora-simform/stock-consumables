import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthRouter } from './modules/health/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { itemsRouter } from './modules/items/routes.js';
import { locationsRouter } from './modules/locations/routes.js';
import { movementsRouter } from './modules/movements/routes.js';
import { usersRouter } from './modules/users/routes.js';

/**
 * Builds the app without listening, so tests can mount it with supertest and
 * docker-compose.test.yml can run two of them.
 */
export function createServer(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);

  const api = express.Router();
  api.use(healthRouter);
  api.use(authRouter);
  api.use(locationsRouter);
  api.use(itemsRouter);
  api.use(movementsRouter);
  api.use(usersRouter);

  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
