import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn } from './factories.js';
import * as movementService from '../src/modules/movements/service.js';

/**
 * T-1, T-2 — bad input is refused before it reaches business logic (FR-3.2).
 *
 * "Before business logic" is asserted, not assumed: the service is spied on and
 * must not have been called.
 */
describe('input validation', () => {
  async function ctx() {
    const world = await seedWorld();
    return { ...world, token: await signIn(world.handler.email) };
  }

  const badQuantities = [
    { quantity: 0, why: 'zero' },
    { quantity: -5, why: 'negative' },
    { quantity: 1.5, why: 'fractional' },
    { quantity: 'many', why: 'not a number' },
  ];

  for (const { quantity, why } of badQuantities) {
    it(`rejects a ${why} quantity with 400, before the service runs`, async () => {
      const { token, item, whA } = await ctx();
      const spy = vi.spyOn(movementService, 'recordMovement');

      const res = await request(app)
        .post('/api/v1/movements')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: item.id, locationId: whA.id, direction: 'IN', quantity });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.issues[0].path).toBe('quantity');
      expect(spy).not.toHaveBeenCalled();

      // And nothing reached the ledger.
      expect(await prisma.movement.count()).toBe(0);
      spy.mockRestore();
    });
  }

  it('rejects an unknown direction', async () => {
    const { token, item, whA } = await ctx();
    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'SIDEWAYS', quantity: 1 });

    expect(res.status).toBe(400);
  });

  it('rejects a movement dated in the future', async () => {
    const { token, item, whA } = await ctx();
    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({
        itemId: item.id,
        locationId: whA.id,
        direction: 'IN',
        quantity: 1,
        occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

    expect(res.status).toBe(400);
  });

  it('rejects a movement against an item that does not exist (T-2)', async () => {
    const { token, whA } = await ctx();
    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({
        itemId: '00000000-0000-4000-8000-000000000000',
        locationId: whA.id,
        direction: 'IN',
        quantity: 1,
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ITEM_NOT_FOUND');
    expect(await prisma.movement.count()).toBe(0);
  });

  it('rejects a movement against a location that does not exist', async () => {
    const { token, item } = await ctx();
    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({
        itemId: item.id,
        locationId: '00000000-0000-4000-8000-000000000000',
        direction: 'IN',
        quantity: 1,
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LOCATION_NOT_FOUND');
  });

  it('rejects a malformed id before it becomes a database error', async () => {
    const { token, whA } = await ctx();
    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: 'not-a-uuid', locationId: whA.id, direction: 'IN', quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
