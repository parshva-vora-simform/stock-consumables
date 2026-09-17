import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, stockIn, balanceOf } from './factories.js';

/**
 * T-10, T-11 — corrections (FR-6).
 *
 * The rule: a movement is never edited or deleted. A mistake is corrected by
 * appending a reversal, and both rows stay visible forever.
 */
describe('correcting a mistake', () => {
  async function ctx() {
    const world = await seedWorld();
    return { ...world, token: await signIn(world.handler.email) };
  }

  it('reverses a wrong quantity by appending, not editing', async () => {
    const { token, item, whA } = await ctx();

    // Meant 10, typed 100.
    const wrong = await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 100 });
    expect(await balanceOf(item.id, whA.id)).toBe(100);

    const res = await request(app)
      .post(`/api/v1/movements/${wrong.movement.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Typed 100, should have been 10' });

    expect(res.status).toBe(201);
    expect(res.body.movement.movementType).toBe('REVERSAL');
    expect(res.body.movement.direction).toBe('OUT');
    expect(res.body.movement.quantity).toBe(100);
    expect(res.body.balanceAfter).toBe(0);

    // Both rows survive: the error and its correction.
    const movements = await prisma.movement.findMany({ orderBy: { createdAt: 'asc' } });
    expect(movements).toHaveLength(2);
    expect(movements[0]!.quantity).toBe(100);
    expect(movements[1]!.reversesMovementId).toBe(wrong.movement.id);
  });

  it('allows a movement to be reversed only once (T-10)', async () => {
    const { token, item, whA } = await ctx();
    const original = await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 50 });

    const first = await request(app)
      .post(`/api/v1/movements/${original.movement.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'first' });

    const second = await request(app)
      .post(`/api/v1/movements/${original.movement.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'second' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_REVERSED');
    expect(await prisma.movement.count()).toBe(2);
  });

  it('survives two concurrent reversals of the same movement', async () => {
    const { token, item, whA } = await ctx();
    const original = await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 50 });

    // The unique index on reverses_movement_id is what actually guarantees
    // this, not the check-first read.
    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/v1/movements/${original.movement.id}/reverse`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'first concurrent attempt' }),
      request(app)
        .post(`/api/v1/movements/${original.movement.id}/reverse`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'second concurrent attempt' }),
    ]);

    const statuses = [a!.status, b!.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await balanceOf(item.id, whA.id)).toBe(0);
  });

  it('refuses to reverse a reversal', async () => {
    const { token, item, whA } = await ctx();
    const original = await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 20 });

    const reversal = await request(app)
      .post(`/api/v1/movements/${original.movement.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'wrong' });

    const res = await request(app)
      .post(`/api/v1/movements/${reversal.body.movement.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'undo the undo' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_REVERSE_REVERSAL');
  });

  it('refuses a reversal that would breach the zero floor (T-11)', async () => {
    const { token, item, whA } = await ctx();

    // 10 received, then 8 issued. Reversing the receipt would need 10 back.
    const receipt = await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 10 });
    await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'OUT', quantity: 8 });

    const res = await request(app)
      .post(`/api/v1/movements/${receipt.movement.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'goods returned to supplier' });

    // Refused on purpose: the ledger is not bent to make a correction tidy.
    // The resolution is a stock-take (FR-6.4).
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.message).toMatch(/stock-take/i);

    // Nothing changed.
    expect(await balanceOf(item.id, whA.id)).toBe(2);
    expect(await prisma.movement.count()).toBe(2);
  });

  it('requires a reason', async () => {
    const { token, item, whA } = await ctx();
    const original = await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 5 });

    const res = await request(app)
      .post(`/api/v1/movements/${original.movement.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('marks the original as reversed in history', async () => {
    const { token, item, whA } = await ctx();
    const original = await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 5 });

    await request(app)
      .post(`/api/v1/movements/${original.movement.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'mistake' });

    const history = await request(app)
      .get(`/api/v1/items/${item.id}/movements`)
      .set('Authorization', `Bearer ${token}`);

    const rows = history.body.data as { id: string; reversedByMovementId: string | null }[];
    const originalRow = rows.find((r) => r.id === original.movement.id)!;

    // The UI strikes this through and links to the reversal — neither row
    // disappears (FR-6.6).
    expect(originalRow.reversedByMovementId).not.toBeNull();
  });
});
