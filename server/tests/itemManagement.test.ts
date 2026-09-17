import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, stockIn, makeItem } from './factories.js';

/**
 * Creating, editing and removing items.
 *
 * The interesting rules are the ones that protect the ledger: an item with
 * history cannot be deleted, and its unit of measure cannot be changed —
 * because both would quietly alter the meaning of movements already recorded.
 */
describe('managing items', () => {
  async function ctx() {
    const world = await seedWorld();
    return {
      ...world,
      managerToken: await signIn(world.manager.email),
      handlerToken: await signIn(world.handler.email),
    };
  }

  const NEW_ITEM = {
    sku: 'NEW-SKU-1',
    name: 'Brand new item',
    unitOfMeasure: 'BOX',
    minThreshold: 12,
  };

  it('lets a manager create an item', async () => {
    const { managerToken } = await ctx();

    const res = await request(app)
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(NEW_ITEM);

    expect(res.status).toBe(201);
    expect(res.body.sku).toBe('NEW-SKU-1');
    expect(res.body.minThreshold).toBe(12);
    expect(res.body.isActive).toBe(true);
  });

  it('refuses creation by a handler', async () => {
    const { handlerToken } = await ctx();

    const res = await request(app)
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${handlerToken}`)
      .send(NEW_ITEM);

    expect(res.status).toBe(403);
    expect(await prisma.item.count({ where: { sku: NEW_ITEM.sku } })).toBe(0);
  });

  it('refuses a duplicate SKU', async () => {
    const { managerToken, item } = await ctx();

    const res = await request(app)
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ ...NEW_ITEM, sku: item.sku });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SKU_EXISTS');
  });

  it('rejects a malformed SKU and a negative threshold', async () => {
    const { managerToken } = await ctx();
    const auth = `Bearer ${managerToken}`;

    const badSku = await request(app)
      .post('/api/v1/items')
      .set('Authorization', auth)
      .send({ ...NEW_ITEM, sku: 'lower case!' });

    const badThreshold = await request(app)
      .post('/api/v1/items')
      .set('Authorization', auth)
      .send({ ...NEW_ITEM, minThreshold: -5 });

    expect(badSku.status).toBe(400);
    expect(badThreshold.status).toBe(400);
  });

  it('edits name, SKU and threshold', async () => {
    const { managerToken, item } = await ctx();

    const res = await request(app)
      .patch(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: 'Renamed', sku: 'RENAMED-1', minThreshold: 99 });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.sku).toBe('RENAMED-1');
    expect(res.body.minThreshold).toBe(99);
  });

  it('refuses an edit that would duplicate another SKU', async () => {
    const { managerToken, item } = await ctx();
    await makeItem('TAKEN-1');

    const res = await request(app)
      .patch(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ sku: 'TAKEN-1' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SKU_EXISTS');
  });

  it('allows a unit change only while the item has no history', async () => {
    const { managerToken, item, whA } = await ctx();
    const auth = `Bearer ${managerToken}`;

    const before = await request(app)
      .patch(`/api/v1/items/${item.id}`)
      .set('Authorization', auth)
      .send({ unitOfMeasure: 'KG' });
    expect(before.status).toBe(200);

    await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: 40 });

    const after = await request(app)
      .patch(`/api/v1/items/${item.id}`)
      .set('Authorization', auth)
      .send({ unitOfMeasure: 'BOX' });

    // 40 kilograms must not silently become 40 boxes.
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe('ITEM_HAS_MOVEMENTS');
    expect(after.body.error.details.movements).toBe(1);
  });

  it('deletes an item that has no movements', async () => {
    const { managerToken } = await ctx();
    const doomed = await makeItem('DELETE-ME');

    const res = await request(app)
      .delete(`/api/v1/items/${doomed.id}`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(await prisma.item.findUnique({ where: { id: doomed.id } })).toBeNull();
  });

  it('deactivates rather than deletes an item that has history', async () => {
    const { managerToken, item, whA } = await ctx();
    await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: 5 });

    const res = await request(app)
      .delete(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
    expect(res.body.movements).toBe(1);

    // The item survives, deactivated — and so does every movement behind it.
    const stored = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.isActive).toBe(false);
    expect(await prisma.movement.count({ where: { itemId: item.id } })).toBe(1);
  });

  it('refuses new movements against a deactivated item', async () => {
    const { managerToken, item, whA } = await ctx();
    await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: 5 });
    await request(app)
      .delete(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${managerToken}`);

    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'IN', quantity: 1 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ITEM_INACTIVE');
  });

  it('can be reactivated after deactivation', async () => {
    const { managerToken, item, whA } = await ctx();
    await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: 5 });
    await request(app)
      .delete(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${managerToken}`);

    const res = await request(app)
      .patch(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isActive: true });

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
  });

  it('refuses deletion by a handler', async () => {
    const { handlerToken } = await ctx();
    const doomed = await makeItem('DELETE-ME');

    const res = await request(app)
      .delete(`/api/v1/items/${doomed.id}`)
      .set('Authorization', `Bearer ${handlerToken}`);

    expect(res.status).toBe(403);
    expect(await prisma.item.findUnique({ where: { id: doomed.id } })).not.toBeNull();
  });

  it('returns 404 for an item that does not exist', async () => {
    const { managerToken } = await ctx();
    const res = await request(app)
      .delete('/api/v1/items/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(404);
  });

  it('hides inactive items from the default list but keeps them findable', async () => {
    const { managerToken, item, whA } = await ctx();
    await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: 5 });
    await request(app)
      .delete(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${managerToken}`);

    const auth = `Bearer ${managerToken}`;
    const normal = await request(app).get('/api/v1/items?limit=50').set('Authorization', auth);
    const withInactive = await request(app)
      .get('/api/v1/items?limit=50&includeInactive=true')
      .set('Authorization', auth);

    const ids = (r: typeof normal) => r.body.data.map((i: { id: string }) => i.id);
    expect(ids(normal)).not.toContain(item.id);
    expect(ids(withInactive)).toContain(item.id);
  });
});
