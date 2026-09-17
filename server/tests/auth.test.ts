import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, TEST_PASSWORD } from './factories.js';

/**
 * T-3 — there is no anonymous path through this system. Every movement is tied
 * to a real, authenticated, still-active user.
 */
describe('authentication', () => {
  const writeRoutes = [
    { method: 'post' as const, path: '/api/v1/movements' },
    { method: 'post' as const, path: '/api/v1/items' },
  ];

  for (const route of writeRoutes) {
    it(`refuses ${route.path} with no token`, async () => {
      const res = await request(app)[route.method](route.path).send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it(`refuses ${route.path} with a garbage token`, async () => {
      const res = await request(app)
        [route.method](route.path)
        .set('Authorization', 'Bearer not.a.real.token')
        .send({});
      expect(res.status).toBe(401);
    });
  }

  it('refuses a token signed with the wrong secret', async () => {
    const { handler } = await seedWorld();
    const forged = jwt.sign({ sub: handler.id, typ: 'access' }, 'a-different-secret-entirely');

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it('refuses an expired token, distinguishably so the client can refresh', async () => {
    const { handler } = await seedWorld();
    const expired = jwt.sign(
      { sub: handler.id, typ: 'access', role: 'HANDLER' },
      process.env['JWT_SECRET']!,
      { expiresIn: '-1s' },
    );

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('refuses a refresh token used as an access token', async () => {
    const { handler } = await seedWorld();
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: handler.email, password: TEST_PASSWORD });

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.tokens.refreshToken}`);

    expect(res.status).toBe(401);
  });

  it('stops honouring the token of a deactivated account', async () => {
    const { handler } = await seedWorld();
    const token = await signIn(handler.email);

    // Token is still cryptographically valid — the check is against the user.
    await prisma.user.update({ where: { id: handler.id }, data: { isActive: false } });

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await seedWorld();

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'handler@test.local', password: 'wrong' });

    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: TEST_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Otherwise login becomes an oracle for which accounts exist.
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('every movement in the ledger names a real user', async () => {
    const { whA, handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    await request(app)
      .post('/api/v1/movements')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemId: item.id, locationId: whA.id, direction: 'IN', quantity: 5 });

    const movements = await prisma.movement.findMany({ include: { recordedBy: true } });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.recordedBy.id).toBe(handler.id);
  });
});

/**
 * Refresh token rotation (and what happens when one is replayed).
 *
 * A refresh token mints access tokens on demand, so a copy of one is a copy of
 * the session. Rotation does not prevent it being taken — nothing at this layer
 * can — but it makes the theft observable the moment either party refreshes
 * with a token the other has already spent.
 */
describe('refresh token rotation', () => {
  async function signInFully(email: string) {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD });
    return res.body.tokens as { accessToken: string; refreshToken: string };
  }

  it('issues a different refresh token on every exchange', async () => {
    const { handler } = await seedWorld();
    const first = await signInFully(handler.email);

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(first.refreshToken);
  });

  it('refuses the old token once it has been exchanged', async () => {
    const { handler } = await seedWorld();
    const first = await signInFully(handler.email);

    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });

    // The spent token is still a valid, unexpired JWT — the signature check
    // passes and it is refused anyway. That is the point: validity is not the
    // same question as "is this still the live token?".
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken });

    expect(replay.status).toBe(401);
  });

  it('revokes the whole family when a spent token is replayed', async () => {
    const { handler } = await seedWorld();
    const first = await signInFully(handler.email);

    // The legitimate client rotates twice.
    const second = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    const third = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second.body.refreshToken });

    expect(third.status).toBe(200);

    // Then someone replays the first one — the copy they took earlier.
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });

    // The current token dies with the rest of the lineage. Revoking only the
    // replayed row would have left the attacker every descendant of it.
    const afterBreach = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: third.body.refreshToken });

    expect(afterBreach.status).toBe(401);

    const live = await prisma.refreshToken.count({
      where: { userId: handler.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('leaves other sessions alone when one family is revoked', async () => {
    const { handler } = await seedWorld();
    const laptop = await signInFully(handler.email);
    const phone = await signInFully(handler.email);

    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: laptop.refreshToken });
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: laptop.refreshToken });

    // Signing in on a second device starts its own family, so a breach on the
    // first must not sign the person out of the second.
    const stillWorks = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: phone.refreshToken });

    expect(stillWorks.status).toBe(200);
  });

  it('ends the session server-side on sign-out', async () => {
    const { handler } = await seedWorld();
    const tokens = await signInFully(handler.email);

    const out = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: tokens.refreshToken });
    expect(out.status).toBe(204);

    // Clearing the browser is not enough on its own — anything that already
    // copied this token would otherwise keep a working session for a week.
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });

    expect(res.status).toBe(401);
  });

  it('answers sign-out identically for a token it has never seen', async () => {
    const { handler } = await seedWorld();
    const tokens = await signInFully(handler.email);
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: tokens.refreshToken });

    // Already revoked: still 204. A different answer would report whether a
    // token was live to anyone holding a guess.
    const again = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: tokens.refreshToken });

    expect(again.status).toBe(204);
  });

  /**
   * The concurrent case, which is the one that matters.
   *
   * Reuse detection that only works when the replay arrives second is not
   * detection — an attacker with a copied token races the real client by
   * definition. Checking `used_at` and then writing it leaves a window where
   * both requests see an unspent token, so the claim has to be a single
   * conditional UPDATE, exactly like the zero floor.
   */
  it('lets exactly one of two simultaneous exchanges win', async () => {
    const { handler } = await seedWorld();
    const tokens = await signInFully(handler.email);

    // Twenty rounds, because a race that passes once proves nothing.
    for (let round = 0; round < 20; round++) {
      const fresh = await signInFully(handler.email);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app).post('/api/v1/auth/refresh').send({ refreshToken: fresh.refreshToken }),
        ),
      );

      const won = results.filter((r) => r.status === 200);
      expect(won).toHaveLength(1);

      // The four losers are replays of a token one of them spent, so the
      // family is revoked — the winner's brand-new token included.
      const winner = won[0]!.body.refreshToken as string;
      const after = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: winner });
      expect(after.status).toBe(401);
    }

    // The original session is untouched by any of that — different family.
    const unrelated = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });
    expect(unrelated.status).toBe(200);
  });

  it('refuses a refresh token minted before a password change', async () => {
    const { handler } = await seedWorld();
    const tokens = await signInFully(handler.email);

    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'AnotherPassword123!' });

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });

    expect(res.status).toBe(401);
  });
});
