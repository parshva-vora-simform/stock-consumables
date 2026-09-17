import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, stockIn } from './factories.js';

/**
 * Managers assign handlers to warehouses and sites, and move them between them.
 *
 * This is where the location scoping the rest of the system enforces actually
 * gets set, so the tests care about two things: that only a manager can do it,
 * and that a change takes effect immediately at the point of the query.
 */
describe('team management', () => {
  async function ctx() {
    const world = await seedWorld();
    return {
      ...world,
      managerToken: await signIn(world.manager.email),
      handlerToken: await signIn(world.handler.email),
    };
  }

  it('refuses the whole surface to a handler', async () => {
    const { handlerToken, handler, whA } = await ctx();
    const auth = `Bearer ${handlerToken}`;

    const list = await request(app).get('/api/v1/users').set('Authorization', auth);
    const assign = await request(app)
      .put(`/api/v1/users/${handler.id}/locations`)
      .set('Authorization', auth)
      .send({ locationIds: [whA.id] });

    expect(list.status).toBe(403);
    expect(assign.status).toBe(403);
  });

  it('refuses without a token at all', async () => {
    const { handler, whA } = await ctx();
    const res = await request(app)
      .put(`/api/v1/users/${handler.id}/locations`)
      .send({ locationIds: [whA.id] });
    expect(res.status).toBe(401);
  });

  it('lists the team with their locations', async () => {
    const { managerToken } = await ctx();

    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    const handler = res.body.data.find((u: { role: string }) => u.role === 'HANDLER');
    expect(handler.locations.map((l: { code: string }) => l.code)).toEqual(['WH-A', 'WH-B']);
  });

  it('adds a handler to a site they could not previously reach', async () => {
    const { managerToken, handlerToken, handler, site, item } = await ctx();

    // Refused before the grant.
    const before = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${handlerToken}`)
      .send({ itemId: item.id, locationId: site.id, direction: 'IN', quantity: 5 });
    expect(before.status).toBe(403);

    await request(app)
      .put(`/api/v1/users/${handler.id}/locations`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ locationIds: [site.id], reason: 'Covering SITE-1 this month' });

    // Allowed after it — the same token, because access is looked up per
    // request rather than baked into the token.
    const after = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${handlerToken}`)
      .send({ itemId: item.id, locationId: site.id, direction: 'IN', quantity: 5 });
    expect(after.status).toBe(201);
  });

  it('moves a handler from a warehouse to a site in one step', async () => {
    const { managerToken, handlerToken, handler, whA, site, item } = await ctx();

    const res = await request(app)
      .put(`/api/v1/users/${handler.id}/locations`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ locationIds: [site.id], reason: 'Transferred to SITE-1' });

    expect(res.status).toBe(200);
    expect(res.body.locations.map((l: { code: string }) => l.code)).toEqual(['SITE-1']);

    // The old warehouse is now refused…
    const old = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${handlerToken}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'IN', quantity: 1 });
    expect(old.status).toBe(403);

    // …and the new site is allowed.
    const now = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${handlerToken}`)
      .send({ itemId: item.id, locationId: site.id, direction: 'IN', quantity: 1 });
    expect(now.status).toBe(201);
  });

  it('leaves past movements attributed after access is revoked', async () => {
    const { managerToken, handlerToken, handler, whA, item } = await ctx();

    await stockIn({ token: handlerToken, itemId: item.id, locationId: whA.id, quantity: 10 });

    await request(app)
      .put(`/api/v1/users/${handler.id}/locations`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ locationIds: [], reason: 'Left the company' });

    // Losing access from now on is not the same as never having been there.
    // The ledger is immutable; the movement stands, still attributed.
    const movement = await prisma.movement.findFirstOrThrow();
    expect(movement.recordedByUserId).toBe(handler.id);
    expect(await prisma.movement.count()).toBe(1);
  });

  it('records every grant and revoke, with who and why', async () => {
    const { managerToken, manager, handler, site } = await ctx();

    await request(app)
      .put(`/api/v1/users/${handler.id}/locations`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ locationIds: [site.id], reason: 'Transferred to SITE-1' });

    const history = await request(app)
      .get(`/api/v1/users/${handler.id}/access-history`)
      .set('Authorization', `Bearer ${managerToken}`);

    const actions = history.body.data as { action: string; locationCode: string; reason: string; changedByName: string }[];

    // One grant for SITE-1, two revokes for the warehouses they left.
    expect(actions.filter((a) => a.action === 'GRANTED').map((a) => a.locationCode)).toEqual(['SITE-1']);
    expect(actions.filter((a) => a.action === 'REVOKED').map((a) => a.locationCode).sort()).toEqual([
      'WH-A',
      'WH-B',
    ]);
    expect(actions.every((a) => a.changedByName === manager.name)).toBe(true);
    expect(actions.every((a) => a.reason === 'Transferred to SITE-1')).toBe(true);
  });

  it('keeps the access history immutable', async () => {
    const { managerToken, handler, site } = await ctx();
    await request(app)
      .put(`/api/v1/users/${handler.id}/locations`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ locationIds: [site.id] });

    const row = await prisma.locationAccessChange.findFirstOrThrow();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM location_access_changes WHERE id = '${row.id}'`),
    ).rejects.toThrow(/append-only/i);
  });

  it('is idempotent — reassigning the same locations records nothing new', async () => {
    const { managerToken, handler, whA, whB } = await ctx();

    await request(app)
      .put(`/api/v1/users/${handler.id}/locations`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ locationIds: [whA.id, whB.id] });

    expect(await prisma.locationAccessChange.count()).toBe(0);
  });

  it('refuses to restrict a manager, who reaches everywhere by role', async () => {
    const { managerToken, manager, whA } = await ctx();

    const res = await request(app)
      .put(`/api/v1/users/${manager.id}/locations`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ locationIds: [whA.id] });

    // Storing grants for a manager would imply a restriction that is not there.
    expect(res.status).toBe(403);
  });

  it('rejects a location that does not exist', async () => {
    const { managerToken, handler } = await ctx();

    const res = await request(app)
      .put(`/api/v1/users/${handler.id}/locations`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ locationIds: ['00000000-0000-4000-8000-000000000000'] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LOCATION_NOT_FOUND');
  });

  it('creates a handler already assigned to a warehouse', async () => {
    const { managerToken, whA, item } = await ctx();

    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        email: 'newstarter@test.local',
        name: 'New Starter',
        role: 'HANDLER',
        password: 'a-long-enough-password',
        locationIds: [whA.id],
      });

    expect(created.status).toBe(201);
    expect(created.body.locations.map((l: { code: string }) => l.code)).toEqual(['WH-A']);

    // And they can sign in and work immediately.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'newstarter@test.local', password: 'a-long-enough-password' });
    expect(login.status).toBe(200);

    const movement = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${login.body.tokens.accessToken}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'IN', quantity: 1 });
    expect(movement.status).toBe(201);
  });

  it('refuses a duplicate email', async () => {
    const { managerToken, handler } = await ctx();

    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        email: handler.email,
        name: 'Impostor',
        role: 'HANDLER',
        password: 'a-long-enough-password',
        locationIds: [],
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_EXISTS');
  });

  it('stops a manager locking themselves out', async () => {
    const { managerToken, manager } = await ctx();

    const deactivate = await request(app)
      .patch(`/api/v1/users/${manager.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isActive: false });

    const demote = await request(app)
      .patch(`/api/v1/users/${manager.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ role: 'HANDLER' });

    expect(deactivate.status).toBe(403);
    expect(demote.status).toBe(403);
  });

  it('cuts off a deactivated handler immediately', async () => {
    const { managerToken, handlerToken, handler, whA, item } = await ctx();

    await request(app)
      .patch(`/api/v1/users/${handler.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isActive: false });

    const res = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${handlerToken}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'IN', quantity: 1 });

    // The token is still valid; the account is not.
    expect(res.status).toBe(401);
  });
});
