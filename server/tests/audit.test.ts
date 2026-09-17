import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, stockIn } from './factories.js';

/**
 * T-15 — every movement attempt leaves a structured trace: who, when, what was
 * attempted, and what the outcome was (FR-9).
 *
 * Failures are the interesting half. A system that only records successes has
 * no record of the events most worth investigating.
 */
describe('audit trail', () => {
  it('records an accepted movement with the resulting id', async () => {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);
    const res = await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 7 });

    const attempt = await prisma.movementAttempt.findFirstOrThrow();
    expect(attempt.outcome).toBe('ACCEPTED');
    expect(attempt.userId).toBe(handler.id);
    expect(attempt.itemId).toBe(item.id);
    expect(attempt.locationId).toBe(whA.id);
    expect(attempt.direction).toBe('IN');
    expect(attempt.quantity).toBe(7);
    expect(attempt.resultingMovementId).toBe(res.movement.id);
    expect(attempt.requestId).toMatch(/^req_/);
  });

  it('records a refusal, surviving the rolled-back transaction', async () => {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'OUT', quantity: 5 });

    const attempt = await prisma.movementAttempt.findFirstOrThrow();

    // The business transaction rolled back. The audit row did not — it is
    // written on its own connection precisely so this holds (FR-9.3).
    expect(attempt.outcome).toBe('REJECTED_INSUFFICIENT_STOCK');
    expect(attempt.resultingMovementId).toBeNull();
    expect(attempt.failureDetail).toMatch(/available/i);
    expect(await prisma.movement.count()).toBe(0);
  });

  it('records an attempt against an item that does not exist', async () => {
    const { whA, handler } = await seedWorld();
    const token = await signIn(handler.email);
    const ghost = '00000000-0000-4000-8000-000000000000';

    await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: ghost, locationId: whA.id, direction: 'IN', quantity: 1 });

    // There is no foreign key on movement_attempts.item_id (migration 0004)
    // exactly so this attempt can be recorded rather than silently dropped.
    const attempt = await prisma.movementAttempt.findFirstOrThrow();
    expect(attempt.outcome).toBe('REJECTED_NOT_FOUND');
    expect(attempt.itemId).toBe(ghost);
  });

  it('records one row per attempt in a burst, not one per success', async () => {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);
    await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 1 });

    await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app)
          .post('/api/v1/movements')
          .set('Authorization', `Bearer ${token}`)
          .send({ itemId: item.id, locationId: whA.id, direction: 'OUT', quantity: 1 }),
      ),
    );

    // 26 = the setup stock-in plus 25 racing stock-outs.
    expect(await prisma.movementAttempt.count()).toBe(26);
    expect(
      await prisma.movementAttempt.count({ where: { outcome: 'REJECTED_INSUFFICIENT_STOCK' } }),
    ).toBe(24);
  });

  it('ties the audit row to the request id in the response header', async () => {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'IN', quantity: 1 });

    const attempt = await prisma.movementAttempt.findFirstOrThrow();
    expect(attempt.requestId).toBe(res.headers['x-request-id']);
  });

  it('honours an inbound request id, so a trace survives the load balancer', async () => {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'trace-from-upstream')
      .send({ itemId: item.id, locationId: whA.id, direction: 'IN', quantity: 1 });

    const attempt = await prisma.movementAttempt.findFirstOrThrow();
    expect(attempt.requestId).toBe('trace-from-upstream');
  });
});
