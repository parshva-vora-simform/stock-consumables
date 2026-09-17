import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, stockIn, balanceOf } from './factories.js';

/**
 * T-12 — a retried or double-clicked submit must not issue stock twice
 * (FR-2.4).
 *
 * The concurrent case is the one that matters. A check-then-insert would pass
 * the sequential test and fail this one, which is exactly the class of bug this
 * project exists to be suspicious of.
 */
describe('idempotency', () => {
  async function ctx(stock = 100) {
    const world = await seedWorld();
    const token = await signIn(world.handler.email);
    await stockIn({ token, itemId: world.item.id, locationId: world.whA.id, quantity: stock });
    return { ...world, token };
  }

  it('returns the original movement on a sequential retry', async () => {
    const { token, item, whA } = await ctx();
    const key = randomUUID();
    const body = {
      itemId: item.id,
      locationId: whA.id,
      direction: 'OUT',
      quantity: 5,
      idempotencyKey: key,
    };

    const first = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    const second = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.movement.id).toBe(first.body.movement.id);

    // Stock left the shelf once, not twice.
    expect(await balanceOf(item.id, whA.id)).toBe(95);
  });

  it('holds when five requests with one key arrive together', async () => {
    const { token, item, whA } = await ctx();
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post('/api/v1/movements')
          .set('Authorization', `Bearer ${token}`)
          .send({
            itemId: item.id,
            locationId: whA.id,
            direction: 'OUT',
            quantity: 5,
            idempotencyKey: key,
          }),
      ),
    );

    // All five succeed, all five describe the SAME movement. A 409 here would
    // be wrong: from the caller's point of view the submit happened once.
    expect(responses.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(responses.map((r) => r.body.movement.id));
    expect(ids.size).toBe(1);

    expect(await prisma.movement.count({ where: { direction: 'OUT' } })).toBe(1);
    expect(await balanceOf(item.id, whA.id)).toBe(95);
  });

  it('treats different keys as different movements', async () => {
    const { token, item, whA } = await ctx();

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/v1/movements')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: item.id,
          locationId: whA.id,
          direction: 'OUT',
          quantity: 5,
          idempotencyKey: randomUUID(),
        });
    }

    expect(await balanceOf(item.id, whA.id)).toBe(85);
  });

  it('scopes keys to the user who sent them', async () => {
    const { token, manager, item, whA } = await ctx();
    const managerToken = await signIn(manager.email);
    const key = randomUUID();

    const body = {
      itemId: item.id,
      locationId: whA.id,
      direction: 'OUT',
      quantity: 5,
      idempotencyKey: key,
    };

    await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(body);

    // Two different people happening to generate the same key is not a retry.
    expect(await prisma.movement.count({ where: { direction: 'OUT' } })).toBe(2);
    expect(await balanceOf(item.id, whA.id)).toBe(90);
  });

  it('does not let a key resurrect a refused movement', async () => {
    const { token, item, whA } = await ctx(3);
    const key = randomUUID();
    const body = {
      itemId: item.id,
      locationId: whA.id,
      direction: 'OUT',
      quantity: 10,
      idempotencyKey: key,
    };

    const first = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    expect(first.status).toBe(409);

    // The key was never consumed, because nothing was recorded. Retrying after
    // a restock legitimately succeeds.
    await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 20 });

    const retry = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(retry.status).toBe(201);
    expect(await balanceOf(item.id, whA.id)).toBe(13);
  });
});
