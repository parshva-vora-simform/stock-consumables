import argon2 from 'argon2';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from './setup.js';
import { createServer } from '../src/server.js';
import type { UnitOfMeasure, UserRole } from '@prisma/client';

export const TEST_PASSWORD = 'Password123!';

let cachedHash: string | null = null;
async function passwordHash(): Promise<string> {
  // argon2 is deliberately slow. Hashing once and reusing it keeps the suite
  // fast without weakening anything the tests actually assert.
  cachedHash ??= await argon2.hash(TEST_PASSWORD);
  return cachedHash;
}

export const app: Express = createServer();

export async function makeLocation(code: string, name = `${code} store`) {
  return prisma.location.create({ data: { code, name } });
}

export async function makeItem(
  sku: string,
  opts: { unit?: UnitOfMeasure; minThreshold?: number; isActive?: boolean } = {},
) {
  return prisma.item.create({
    data: {
      sku,
      name: `Item ${sku}`,
      unitOfMeasure: opts.unit ?? 'EACH',
      minThreshold: opts.minThreshold ?? 0,
      isActive: opts.isActive ?? true,
    },
  });
}

export async function makeUser(
  email: string,
  role: UserRole = 'HANDLER',
  locationIds: string[] = [],
) {
  const user = await prisma.user.create({
    data: { email, name: email.split('@')[0]!, role, passwordHash: await passwordHash() },
  });

  for (const locationId of locationIds) {
    await prisma.userLocationAccess.create({ data: { userId: user.id, locationId } });
  }

  return user;
}

/** Signs in through the real login route — no shortcut that skips auth. */
export async function signIn(email: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: TEST_PASSWORD });

  if (res.status !== 200) {
    throw new Error(`Sign-in failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.tokens.accessToken as string;
}

/** Puts stock on the shelf the only way there is: by recording a movement. */
export async function stockIn(args: {
  token: string;
  itemId: string;
  locationId: string;
  quantity: number;
}) {
  const res = await request(app)
    .post('/api/v1/movements')
    .set('Authorization', `Bearer ${args.token}`)
    .send({
      itemId: args.itemId,
      locationId: args.locationId,
      direction: 'IN',
      quantity: args.quantity,
    });

  if (res.status !== 201) {
    throw new Error(`stockIn failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

export async function balanceOf(itemId: string, locationId: string): Promise<number> {
  const row = await prisma.stockBalance.findUnique({
    where: { itemId_locationId: { itemId, locationId } },
  });
  return row?.quantity ?? 0;
}

/** A standard world: two warehouses, one site, a handler scoped to the warehouses. */
export async function seedWorld() {
  const whA = await makeLocation('WH-A');
  const whB = await makeLocation('WH-B');
  const site = await makeLocation('SITE-1');

  const handler = await makeUser('handler@test.local', 'HANDLER', [whA.id, whB.id]);
  const manager = await makeUser('manager@test.local', 'MANAGER');

  const item = await makeItem('WIDGET-1', { minThreshold: 5 });

  return { whA, whB, site, handler, manager, item };
}
