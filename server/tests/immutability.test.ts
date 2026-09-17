import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, stockIn } from './factories.js';

/**
 * T-8, T-9 — the two structural guarantees.
 *
 * These are the tests that would catch someone "helpfully" adding a quantity
 * field or an edit endpoint months from now.
 */
describe('the ledger is append-only', () => {
  async function oneMovement() {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);
    const res = await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 10 });
    return { movementId: res.movement.id as string, token, item, whA };
  }

  it('refuses an UPDATE at the database, not merely in the API', async () => {
    const { movementId } = await oneMovement();

    await expect(
      prisma.$executeRawUnsafe(`UPDATE movements SET quantity = 999 WHERE id = '${movementId}'`),
    ).rejects.toThrow(/append-only/i);

    const after = await prisma.movement.findUniqueOrThrow({ where: { id: movementId } });
    expect(after.quantity).toBe(10);
  });

  it('refuses a DELETE at the database', async () => {
    const { movementId } = await oneMovement();

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM movements WHERE id = '${movementId}'`),
    ).rejects.toThrow(/append-only/i);

    expect(await prisma.movement.count()).toBe(1);
  });

  it('refuses even through the ORM', async () => {
    const { movementId } = await oneMovement();

    // The trigger does not care which client issued the statement.
    await expect(
      prisma.movement.update({ where: { id: movementId }, data: { quantity: 1 } }),
    ).rejects.toThrow();
  });

  it('keeps audit rows immutable too', async () => {
    await oneMovement();
    const attempt = await prisma.movementAttempt.findFirstOrThrow();

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM movement_attempts WHERE id = '${attempt.id}'`),
    ).rejects.toThrow(/append-only/i);
  });

  it('exposes no route that edits or deletes a movement (T-9)', async () => {
    const { movementId, token } = await oneMovement();
    const auth = `Bearer ${token}`;

    const patch = await request(app)
      .patch(`/api/v1/movements/${movementId}`)
      .set('Authorization', auth)
      .send({ quantity: 1 });

    const del = await request(app)
      .delete(`/api/v1/movements/${movementId}`)
      .set('Authorization', auth);

    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
    expect(patch.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('quantity cannot be set directly', () => {
  it('has no quantity column on items at all', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'items'
    `;
    const names = columns.map((c) => c.column_name);

    // The absence IS the requirement (FR-1.3). There is no field for a stray
    // PATCH to reach.
    expect(names).not.toContain('quantity');
    expect(names).not.toContain('stock');
    expect(names).not.toContain('on_hand');
  });

  it('ignores a quantity smuggled into an item update', async () => {
    const { manager, item } = await seedWorld();
    const token = await signIn(manager.email);

    const res = await request(app)
      .patch(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ minThreshold: 7, quantity: 500, stock: 500 });

    expect(res.status).toBe(200);
    expect(res.body.minThreshold).toBe(7);
    // The unknown keys changed nothing, because there is nothing to change.
    expect(await prisma.stockBalance.count()).toBe(0);
  });

  it('refuses a negative balance at the database (the last line of defence)', async () => {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);
    await stockIn({ token, itemId: item.id, locationId: whA.id, quantity: 3 });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE stock_balances SET quantity = -1 WHERE item_id = '${item.id}'`,
      ),
    ).rejects.toThrow(/quantity_non_negative/i);
  });
});
