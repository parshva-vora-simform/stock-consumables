import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, stockIn, balanceOf } from './factories.js';

/**
 * T-5 — the sharpest test in this POC.
 *
 * Two people reach for the last unit at the same instant. Exactly one gets it.
 *
 * Everything here fires with Promise.all. Sequential requests would pass
 * trivially and prove nothing: they are the happy path wearing a disguise.
 */
describe('zero floor under concurrency', () => {
  async function raceFor(concurrency: number, stock = 1, takeEach = 1) {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: stock });

    const responses = await Promise.all(
      Array.from({ length: concurrency }, () =>
        request(app)
          .post('/api/v1/movements')
          .set('Authorization', `Bearer ${token}`)
          .send({
            itemId: item.id,
            locationId: whA.id,
            direction: 'OUT',
            quantity: takeEach,
          }),
      ),
    );

    return { responses, item, whA, token };
  }

  it('accepts exactly one of two simultaneous claims on the last unit', async () => {
    const { responses, item, whA } = await raceFor(2);

    const accepted = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 409);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await balanceOf(item.id, whA.id)).toBe(0);
  });

  it('accepts exactly one of fifty, and never goes negative', async () => {
    const { responses, item, whA } = await raceFor(50);

    const accepted = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 409);
    const unexpected = responses.filter((r) => r.status !== 201 && r.status !== 409);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(49);

    // A 500 here would mean the rejection escaped as a raw database error. The
    // requirement is a clear, specific refusal — not merely "did not succeed".
    expect(unexpected).toHaveLength(0);

    expect(await balanceOf(item.id, whA.id)).toBe(0);

    // The ledger gained exactly one row: the stock-in, plus the single
    // successful stock-out.
    const movements = await prisma.movement.count({ where: { itemId: item.id } });
    expect(movements).toBe(2);
  });

  it('rejects with a specific code and the real available figure', async () => {
    const { responses } = await raceFor(10);
    const rejected = responses.filter((r) => r.status === 409);

    for (const res of rejected) {
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(res.body.error.details.available).toBe(0);
      expect(res.body.error.details.requested).toBe(1);
      // A rejection the operator cannot act on is barely better than a 500.
      expect(res.body.error.message).toMatch(/available/i);
    }
  });

  it('records every attempt, accepted and rejected (T-15)', async () => {
    const { responses } = await raceFor(20);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);

    const attempts = await prisma.movementAttempt.groupBy({
      by: ['outcome'],
      _count: true,
    });
    const counts = Object.fromEntries(attempts.map((a) => [a.outcome, a._count]));

    // 21 = the setup stock-in, plus the 20 racing stock-outs. The rejections
    // are the point: a system that only logs successes has no audit trail of
    // the events most worth investigating.
    expect(counts['ACCEPTED']).toBe(2);
    expect(counts['REJECTED_INSUFFICIENT_STOCK']).toBe(19);
  });

  it('holds when the requested quantity exceeds one unit', async () => {
    // 10 on the shelf, 20 requests for 4 each. At most 2 can succeed.
    const { responses, item, whA } = await raceFor(20, 10, 4);

    const accepted = responses.filter((r) => r.status === 201);
    expect(accepted).toHaveLength(2);
    expect(await balanceOf(item.id, whA.id)).toBe(2);
  });

  // A race that passes once has not been proven — it has been sampled.
  it('holds across 20 consecutive rounds', async () => {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    for (let round = 1; round <= 20; round++) {
      // Back to exactly one unit — by appending a movement, never by writing
      // the balance. A test that cheated here would be proving nothing.
      await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 1 });
      expect(await balanceOf(item.id, whA.id)).toBe(1);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app)
            .post('/api/v1/movements')
            .set('Authorization', `Bearer ${token}`)
            .send({ itemId: item.id, locationId: whA.id, direction: 'OUT', quantity: 1 }),
        ),
      );

      const accepted = responses.filter((r) => r.status === 201).length;
      const balance = await balanceOf(item.id, whA.id);

      expect(accepted, `round ${round}: expected exactly one winner`).toBe(1);
      expect(balance, `round ${round}: balance must not go negative`).toBe(0);
    }
  });
});
