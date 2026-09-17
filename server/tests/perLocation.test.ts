import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, seedWorld, signIn, stockIn, balanceOf } from './factories.js';

/**
 * T-7 — the below-zero rule applies independently per location (FR-5.2).
 *
 * Stock sitting at WH-B must never satisfy a request at WH-A, however much of
 * it there is.
 */
describe('per-location zero floor', () => {
  it('refuses a stock-out at an empty location while another is full', async () => {
    const { whA, whB, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    await stockIn({ token, itemId: item.id, locationId: whB.id, quantity: 1000 });

    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'OUT', quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details.available).toBe(0);

    // WH-B is untouched — it was never a candidate.
    expect(await balanceOf(item.id, whB.id)).toBe(1000);
    expect(await balanceOf(item.id, whA.id)).toBe(0);
  });

  it('names the location in the rejection', async () => {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'OUT', quantity: 5 });

    // "Only 0 available at WH-A" is actionable; a UUID is not.
    expect(res.body.error.message).toContain('WH-A');
  });

  it('keeps balances independent as movements interleave', async () => {
    const { whA, whB, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 10 });
    await stockIn({ token, itemId: item.id, locationId: whB.id, quantity: 20 });

    await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'OUT', quantity: 10 });

    expect(await balanceOf(item.id, whA.id)).toBe(0);
    expect(await balanceOf(item.id, whB.id)).toBe(20);

    // WH-A is empty; WH-B still has 20. The next request at WH-A still fails.
    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'OUT', quantity: 1 });

    expect(res.status).toBe(409);
  });

  it('races at two locations do not interfere', async () => {
    const { whA, whB, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 1 });
    await stockIn({ token, itemId: item.id, locationId: whB.id, quantity: 1 });

    const take = (locationId: string) =>
      request(app)
        .post('/api/v1/movements')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: item.id, locationId, direction: 'OUT', quantity: 1 });

    // 10 requests at each location, all at once. Each location has exactly one
    // unit, so exactly one winner at each — 2 in total, not 1 and not 20.
    const responses = await Promise.all([
      ...Array.from({ length: 10 }, () => take(whA.id)),
      ...Array.from({ length: 10 }, () => take(whB.id)),
    ]);

    expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
    expect(await balanceOf(item.id, whA.id)).toBe(0);
    expect(await balanceOf(item.id, whB.id)).toBe(0);
  });
});
