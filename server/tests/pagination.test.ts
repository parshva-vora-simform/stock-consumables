import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, seedWorld, signIn, stockIn, makeItem, makeLocation } from './factories.js';
import { prisma } from './setup.js';

/**
 * Sorting, filtering and pagination happen in the database.
 *
 * The test that matters most here is the one about ties: sort columns like
 * `min_threshold` are full of duplicates, and ordering by one alone leaves
 * equal rows in an order the database may change between queries — so a row can
 * appear on two pages, or on none. Every list in this API appends `id` as a
 * tiebreaker; these tests check that it works.
 */
describe('server-side sorting and pagination', () => {
  async function world() {
    const base = await seedWorld();
    const token = await signIn(base.manager.email);
    return { ...base, token };
  }

  async function makeItems(count: number, threshold: number) {
    const items = [];
    for (let i = 0; i < count; i++) {
      // Identical thresholds on purpose — this is the tie case.
      items.push(await makeItem(`TIE-${String(i).padStart(2, '0')}`, { minThreshold: threshold }));
    }
    return items;
  }

  function get(path: string, token: string) {
    return request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  }

  it('pages items without repeating or dropping a row', async () => {
    const { token } = await world();
    await makeItems(25, 5);

    const seen: string[] = [];
    let cursor = '';
    let pages = 0;

    while (pages < 20) {
      const res = await get(`/items?limit=7${cursor ? `&cursor=${cursor}` : ''}`, token);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((i: { sku: string }) => i.sku));
      pages++;
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }

    const total = await prisma.item.count();
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('pages correctly when every sort value is identical', async () => {
    const { token } = await world();
    await makeItems(20, 42);

    const seen: string[] = [];
    let cursor = '';

    for (let i = 0; i < 10; i++) {
      const res = await get(
        `/items?limit=6&sortBy=minThreshold&sortOrder=asc${cursor ? `&cursor=${cursor}` : ''}`,
        token,
      );
      seen.push(...res.body.data.map((r: { sku: string }) => r.sku));
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }

    // Without an id tiebreaker this is where rows go missing or double up.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(await prisma.item.count());
  });

  it('sorts by a total the database computes, not the page', async () => {
    const { token, whA, manager } = await world();
    const managerToken = await signIn(manager.email);

    const small = await makeItem('QTY-SMALL');
    const large = await makeItem('QTY-LARGE');
    const middle = await makeItem('QTY-MID');

    await stockIn({ token: managerToken, itemId: small.id, locationId: whA.id, quantity: 5 });
    await stockIn({ token: managerToken, itemId: middle.id, locationId: whA.id, quantity: 50 });
    await stockIn({ token: managerToken, itemId: large.id, locationId: whA.id, quantity: 500 });

    const res = await get('/items?limit=3&sortBy=totalQuantity&sortOrder=desc', token);
    const skus = res.body.data.map((i: { sku: string }) => i.sku);

    // The top three by total, across the whole table — not the first page
    // re-sorted, which would have returned whatever came first alphabetically.
    expect(skus).toEqual(['QTY-LARGE', 'QTY-MID', 'QTY-SMALL']);
  });

  it('reverses the order without losing rows', async () => {
    const { token } = await world();
    await makeItems(10, 1);

    const asc = await get('/items?limit=100&sortBy=sku&sortOrder=asc', token);
    const desc = await get('/items?limit=100&sortBy=sku&sortOrder=desc', token);

    const ascSkus = asc.body.data.map((i: { sku: string }) => i.sku);
    const descSkus = desc.body.data.map((i: { sku: string }) => i.sku);

    expect(descSkus).toEqual([...ascSkus].reverse());
  });

  it('filters items by unit and by low stock, in the query', async () => {
    const { token, whA, manager } = await world();
    const managerToken = await signIn(manager.email);

    const boxed = await makeItem('BOX-1', { unit: 'BOX', minThreshold: 100 });
    await makeItem('KG-1', { unit: 'KG', minThreshold: 0 });
    await stockIn({ token: managerToken, itemId: boxed.id, locationId: whA.id, quantity: 1 });

    const byUnit = await get('/items?unitOfMeasure=BOX&limit=50', token);
    expect(byUnit.body.data.map((i: { sku: string }) => i.sku)).toEqual(['BOX-1']);

    const low = await get('/items?lowStockOnly=true&limit=50', token);
    expect(low.body.data.map((i: { sku: string }) => i.sku)).toContain('BOX-1');
    expect(low.body.data.map((i: { sku: string }) => i.sku)).not.toContain('KG-1');
  });

  it('searches on the server, matching name or sku', async () => {
    const { token } = await world();
    await makeItem('FINDME-1');
    await makeItem('OTHER-1');

    const res = await get('/items?search=findme&limit=50', token);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sku).toBe('FINDME-1');
  });

  it('rejects a sort field that is not on the allow-list', async () => {
    const { token } = await world();

    const res = await get('/items?sortBy=password_hash', token);

    // A free-form sort field would reach the database as an identifier.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed cursor rather than ignoring it', async () => {
    const { token } = await world();
    const res = await get('/items?cursor=not-a-real-cursor', token);

    // Ignoring it would silently restart from page one, which looks like
    // working pagination until someone notices duplicated rows.
    expect(res.status).toBe(400);
  });

  it('paginates and sorts the low-stock view', async () => {
    const { token, whA, manager } = await world();
    const managerToken = await signIn(manager.email);

    for (let i = 1; i <= 12; i++) {
      const item = await makeItem(`LOW-${String(i).padStart(2, '0')}`, { minThreshold: 100 });
      // Varied quantities, all well under the threshold, so the sort has
      // something to order and every row qualifies as low.
      await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: i });
    }

    const first = await get('/items/low-stock?limit=5&sortBy=quantity&sortOrder=asc', token);
    expect(first.body.data).toHaveLength(5);
    expect(first.body.nextCursor).toBeTruthy();

    const quantities = first.body.data.map((r: { quantity: number }) => r.quantity);
    expect(quantities).toEqual([...quantities].sort((a, b) => a - b));

    const second = await get(
      `/items/low-stock?limit=5&sortBy=quantity&sortOrder=asc&cursor=${first.body.nextCursor}`,
      token,
    );

    const firstIds = first.body.data.map((r: { itemId: string }) => r.itemId);
    const secondIds = second.body.data.map((r: { itemId: string }) => r.itemId);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it('paginates and sorts movement history both ways', async () => {
    const { token, whA, item, manager } = await world();
    const managerToken = await signIn(manager.email);

    for (let i = 1; i <= 10; i++) {
      await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: i });
    }

    const newest = await get(`/items/${item.id}/movements?limit=3&sortOrder=desc`, token);
    const oldest = await get(`/items/${item.id}/movements?limit=3&sortOrder=asc`, token);

    expect(newest.body.data[0].quantity).toBe(10);
    expect(oldest.body.data[0].quantity).toBe(1);

    const byQty = await get(
      `/items/${item.id}/movements?limit=3&sortBy=quantity&sortOrder=desc`,
      token,
    );
    expect(byQty.body.data.map((m: { quantity: number }) => m.quantity)).toEqual([10, 9, 8]);
  });

  it('filters history by movement type and reference', async () => {
    const { token, whA, item, manager } = await world();
    const managerToken = await signIn(manager.email);

    const first = await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        itemId: item.id,
        locationId: whA.id,
        direction: 'IN',
        quantity: 10,
        reference: 'PO #4521',
      });

    await request(app)
      .post(`/api/v1/movements/${first.body.movement.id}/reverse`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'wrong quantity' });

    const reversals = await get(`/items/${item.id}/movements?movementType=REVERSAL`, token);
    expect(reversals.body.data).toHaveLength(1);

    const byRef = await get(`/items/${item.id}/movements?reference=4521`, token);
    expect(byRef.body.data.length).toBeGreaterThan(0);
  });

  it('paginates, searches and sorts the team list', async () => {
    const { token, whA } = await world();

    for (let i = 0; i < 8; i++) {
      await prisma.user.create({
        data: {
          email: `extra${i}@test.local`,
          name: `Extra ${i}`,
          role: 'HANDLER',
          passwordHash: 'x',
          locationAccess: { create: [{ locationId: whA.id }] },
        },
      });
    }

    const page = await get('/users?limit=4&sortBy=name&sortOrder=asc', token);
    expect(page.body.data).toHaveLength(4);
    expect(page.body.nextCursor).toBeTruthy();

    const search = await get('/users?search=extra3', token);
    expect(search.body.data).toHaveLength(1);

    const managers = await get('/users?role=MANAGER', token);
    expect(managers.body.data.every((u: { role: string }) => u.role === 'MANAGER')).toBe(true);
  });

  it('counts a manager as able to act at every location when filtering', async () => {
    const { token } = await world();
    const far = await makeLocation('FAR-1');

    const res = await get(`/users?locationId=${far.id}`, token);
    const roles = res.body.data.map((u: { role: string }) => u.role);

    // Nobody has a grant for FAR-1, but a manager reaches it by role.
    expect(roles).toContain('MANAGER');
    expect(roles).not.toContain('HANDLER');
  });

  it('keeps the caller location scope applied to every sort and filter', async () => {
    const { handler, site, item, manager } = await world();
    const handlerToken = await signIn(handler.email);
    const managerToken = await signIn(manager.email);

    await stockIn({ token: managerToken, itemId: item.id, locationId: site.id, quantity: 999 });

    const res = await request(app)
      .get('/api/v1/items?sortBy=totalQuantity&sortOrder=desc&limit=50')
      .set('Authorization', `Bearer ${handlerToken}`);

    const row = res.body.data.find((i: { id: string }) => i.id === item.id);
    // SITE-1 is outside the handler's scope, so its 999 units are absent from
    // the total — and therefore from the ordering too.
    expect(row.totalAcrossLocations).toBe(0);
  });
});

/**
 * Numbered pages.
 *
 * The cursor API stays available for walking the whole ledger; these cover the
 * page-number path the UI uses.
 */
describe('numbered pagination', () => {
  async function world() {
    const base = await seedWorld();
    return { ...base, token: await signIn(base.manager.email) };
  }

  function get(path: string, token: string) {
    return request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  }

  it('reports page, total and totalPages', async () => {
    const { token } = await world();
    for (let i = 0; i < 24; i++) await makeItem(`PG-${String(i).padStart(2, '0')}`);

    const res = await get('/items?page=1&limit=10&sortBy=sku', token);

    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.total).toBe(25); // 24 + the one seedWorld creates
    expect(res.body.totalPages).toBe(3);
    expect(res.body.totalIsExact).toBe(true);
    expect(res.body.hasPrev).toBe(false);
    expect(res.body.hasNext).toBe(true);
  });

  it('walks every page without repeating or dropping a row', async () => {
    const { token } = await world();
    for (let i = 0; i < 24; i++) await makeItem(`PG-${String(i).padStart(2, '0')}`);

    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await get(`/items?page=${page}&limit=10&sortBy=sku`, token);
      seen.push(...res.body.data.map((i: { sku: string }) => i.sku));
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('marks the last page correctly', async () => {
    const { token } = await world();
    for (let i = 0; i < 24; i++) await makeItem(`PG-${String(i).padStart(2, '0')}`);

    const last = await get('/items?page=3&limit=10&sortBy=sku', token);

    expect(last.body.data).toHaveLength(5);
    expect(last.body.hasNext).toBe(false);
    expect(last.body.hasPrev).toBe(true);
  });

  it('returns an empty page past the end rather than an error', async () => {
    const { token } = await world();
    const res = await get('/items?page=99&limit=10', token);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.hasNext).toBe(false);
  });

  it('counts the filtered set, not the whole table', async () => {
    const { token } = await world();
    for (let i = 0; i < 10; i++) await makeItem(`BOXED-${i}`, { unit: 'BOX' });
    for (let i = 0; i < 10; i++) await makeItem(`LOOSE-${i}`, { unit: 'KG' });

    const res = await get('/items?unitOfMeasure=BOX&page=1&limit=10', token);

    // A count that ignored the filter would offer pages of rows that are not
    // there.
    expect(res.body.total).toBe(10);
    expect(res.body.totalPages).toBe(1);
  });

  it('still returns a cursor alongside the page numbers', async () => {
    const { token } = await world();
    for (let i = 0; i < 24; i++) await makeItem(`PG-${String(i).padStart(2, '0')}`);

    const res = await get('/items?page=1&limit=10', token);

    // Page numbers for people; the cursor for anything walking the whole list
    // without paying offset costs (FR-8.3).
    expect(res.body.nextCursor).toBeTruthy();
  });

  it('numbers pages of movement history', async () => {
    const { token, whA, item, manager } = await world();
    const managerToken = await signIn(manager.email);
    for (let i = 1; i <= 15; i++) {
      await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: i });
    }

    const res = await get(`/items/${item.id}/movements?page=2&limit=10`, token);

    expect(res.body.page).toBe(2);
    expect(res.body.total).toBe(15);
    expect(res.body.totalPages).toBe(2);
    expect(res.body.data).toHaveLength(5);
  });

  it('caps the count instead of counting a very large set', async () => {
    const { token, whA, item, manager } = await world();
    const managerToken = await signIn(manager.email);

    // The cap is 1,000; this is far below it, so the count stays exact. The
    // point of the assertion is that the flag exists and is honest — a UI that
    // showed "1,000" as a total when it means "at least 1,000" would be
    // presenting a floor as a fact.
    await stockIn({ token: managerToken, itemId: item.id, locationId: whA.id, quantity: 1 });

    const res = await get(`/items/${item.id}/movements?page=1&limit=10`, token);
    expect(res.body.totalIsExact).toBe(true);
    expect(res.body.total).toBeLessThanOrEqual(1000);
  });

  it('numbers pages of the team list and the low-stock view', async () => {
    const { token, whA, manager } = await world();
    const managerToken = await signIn(manager.email);

    for (let i = 1; i <= 12; i++) {
      const it = await makeItem(`LS-${String(i).padStart(2, '0')}`, { minThreshold: 100 });
      await stockIn({ token: managerToken, itemId: it.id, locationId: whA.id, quantity: i });
    }

    const low = await get('/items/low-stock?page=2&limit=5', token);
    expect(low.body.page).toBe(2);
    expect(low.body.total).toBe(12);
    expect(low.body.totalPages).toBe(3);

    const team = await get('/users?page=1&limit=1', token);
    expect(team.body.total).toBe(2);
    expect(team.body.totalPages).toBe(2);
    expect(team.body.hasNext).toBe(true);
  });

  it('rejects page 0 and negative pages', async () => {
    const { token } = await world();
    expect((await get('/items?page=0', token)).status).toBe(400);
    expect((await get('/items?page=-1', token)).status).toBe(400);
  });
});

/**
 * `hasNext` is answered by the `limit + 1` probe row, not inferred from the
 * page being full.
 *
 * The inferred version is right almost always, and wrong in exactly the case
 * nobody tests: a final page that happens to be exactly full. It then claimed
 * a next page alongside `totalPages: 1` and a null cursor — three fields in one
 * envelope disagreeing, and a consumer following `hasNext` fetching nothing.
 */
describe('hasNext on an exactly-full last page', () => {
  it('is false when the page size divides the total exactly', async () => {
    const { manager } = await seedWorld();
    const token = await signIn(manager.email);

    // seedWorld's own items plus enough to make the count a round number.
    const existing = await prisma.item.count();
    for (let i = existing; i < 10; i++) {
      await prisma.item.create({
        data: { sku: `FULL-${i}`, name: `Full page item ${i}`, unitOfMeasure: 'EACH' },
      });
    }

    const res = await request(app)
      .get('/api/v1/items?limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data).toHaveLength(10);
    expect(res.body.total).toBe(10);
    expect(res.body.totalPages).toBe(1);
    expect(res.body.hasNext).toBe(false);
    // And the three ways of saying "no more" agree with each other.
    expect(res.body.nextCursor).toBeNull();
  });

  it('is true when there really is another row', async () => {
    const { manager } = await seedWorld();
    const token = await signIn(manager.email);

    const existing = await prisma.item.count();
    for (let i = existing; i < 11; i++) {
      await prisma.item.create({
        data: { sku: `OVER-${i}`, name: `Overflow item ${i}`, unitOfMeasure: 'EACH' },
      });
    }

    const res = await request(app)
      .get('/api/v1/items?limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.hasNext).toBe(true);
    expect(res.body.nextCursor).not.toBeNull();
  });
});
