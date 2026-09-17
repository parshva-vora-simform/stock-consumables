import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, stockIn, balanceOf, makeUser } from './factories.js';

/**
 * T-4 — a handler acting on a location they were not granted is refused at the
 * query, proven here by hitting the API directly. The UI plays no part in this
 * test, which is the whole point: hiding a control is not a control.
 */
describe('location-scoped access', () => {
  it('refuses a movement at a location the handler was not granted', async () => {
    const { site, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: site.id, direction: 'IN', quantity: 10 });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_LOCATION');

    // Refused, not silently dropped: no movement, no balance row.
    expect(await prisma.movement.count()).toBe(0);
    expect(await balanceOf(item.id, site.id)).toBe(0);
  });

  it('records the refusal in the audit trail', async () => {
    const { site, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: site.id, direction: 'IN', quantity: 10 });

    const attempts = await prisma.movementAttempt.findMany();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('REJECTED_FORBIDDEN');
    expect(attempts[0]!.userId).toBe(handler.id);
  });

  it('hides balances at locations the handler cannot reach', async () => {
    const { whA, site, handler, manager, item } = await seedWorld();
    const managerToken = await signIn(manager.email);
    const handlerToken = await signIn(handler.email);

    await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: 10 });
    await stockIn({ token: managerToken, itemId: item.id, locationId: site.id, quantity: 999 });

    const res = await request(app)
      .get(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${handlerToken}`);

    const codes = res.body.balances.map((b: { locationCode: string }) => b.locationCode);
    expect(codes).toEqual(['WH-A']);

    // And the aggregate excludes it too — a total that silently included
    // unreachable stock would be worse than showing nothing.
    expect(res.body.totalAcrossLocations).toBe(10);
  });

  /**
   * The item list takes the same `?locationId=` filter the low-stock view and
   * the history do, and it has to refuse an unreachable one the same way.
   *
   * It did not. The filter was passed straight to the balance lookup in place
   * of the caller's scope, so any location id returned its quantities to
   * anyone who asked — while the item's own total, computed by a different
   * query that DID scope correctly, came back as 0 in the same response.
   */
  it('refuses an item list filtered to an unreachable location', async () => {
    const { site, handler, manager, item } = await seedWorld();
    const managerToken = await signIn(manager.email);
    const handlerToken = await signIn(handler.email);

    await stockIn({ token: managerToken, itemId: item.id, locationId: site.id, quantity: 999 });

    const res = await request(app)
      .get(`/api/v1/items?locationId=${site.id}`)
      .set('Authorization', `Bearer ${handlerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_LOCATION');
    expect(JSON.stringify(res.body)).not.toContain('999');
  });

  it('keeps the item list scoped when no location filter is given', async () => {
    const { whA, site, handler, manager, item } = await seedWorld();
    const managerToken = await signIn(manager.email);
    const handlerToken = await signIn(handler.email);

    await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: 7 });
    await stockIn({ token: managerToken, itemId: item.id, locationId: site.id, quantity: 999 });

    const res = await request(app)
      .get('/api/v1/items')
      .set('Authorization', `Bearer ${handlerToken}`);

    const row = res.body.data.find((r: { id: string }) => r.id === item.id);
    expect(row.balances.map((b: { locationCode: string }) => b.locationCode)).toEqual(['WH-A']);
    // The two queries behind this response must agree about what is visible.
    expect(row.totalAcrossLocations).toBe(7);
  });

  it('lists only the locations a handler may act on', async () => {
    const { handler } = await seedWorld();
    const token = await signIn(handler.email);

    const res = await request(app)
      .get('/api/v1/locations')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data.map((l: { code: string }) => l.code).sort()).toEqual(['WH-A', 'WH-B']);
  });

  it('refuses a history query filtered to an unreachable location', async () => {
    const { site, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    const res = await request(app)
      .get(`/api/v1/items/${item.id}/movements?locationId=${site.id}`)
      .set('Authorization', `Bearer ${token}`);

    // 403, not an empty list: "no movements" and "not allowed to look" are
    // different statements and the caller deserves the true one.
    expect(res.status).toBe(403);
  });

  it('excludes unreachable locations from history even without a filter', async () => {
    const { whA, site, handler, manager, item } = await seedWorld();
    const managerToken = await signIn(manager.email);
    const handlerToken = await signIn(handler.email);

    await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: 5 });
    await stockIn({ token: managerToken, itemId: item.id, locationId: site.id, quantity: 5 });

    const res = await request(app)
      .get(`/api/v1/items/${item.id}/movements`)
      .set('Authorization', `Bearer ${handlerToken}`);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].locationCode).toBe('WH-A');
  });

  it('gives a manager every location without needing grants', async () => {
    const { manager } = await seedWorld();
    const token = await signIn(manager.email);

    const res = await request(app)
      .get('/api/v1/locations')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data).toHaveLength(3);
    // The manager has no user_location_access rows at all.
    expect(await prisma.userLocationAccess.count({ where: { userId: manager.id } })).toBe(0);
  });

  it('refuses a manager-only route to a handler (AC-4)', async () => {
    const { handler } = await seedWorld();
    const token = await signIn(handler.email);

    const res = await request(app)
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'NEW-1', name: 'New item', unitOfMeasure: 'EACH', minThreshold: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses a handler with no grants at all', async () => {
    const { whA, item } = await seedWorld();
    const stranger = await makeUser('stranger@test.local', 'HANDLER', []);
    const token = await signIn(stranger.email);

    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'IN', quantity: 1 });

    expect(res.status).toBe(403);
  });
});
