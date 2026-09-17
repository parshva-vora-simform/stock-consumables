import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from './setup.js';
import { app, seedWorld, signIn, TEST_PASSWORD } from './factories.js';

/**
 * Password reset.
 *
 * The properties worth testing here are the ones that are easy to get subtly
 * wrong: not leaking which emails exist, tokens that work exactly once, and a
 * reset that actually ends the old sessions rather than only changing the hash.
 */
describe('password reset', () => {
  const NEW_PASSWORD = 'a-brand-new-password';

  async function requestLink(email: string) {
    const res = await request(app).post('/api/v1/auth/forgot-password').send({ email });
    expect(res.status).toBe(200);
    return res;
  }

  function tokenFrom(res: { body: { devResetUrl?: string } }): string {
    const url = res.body.devResetUrl;
    if (!url) throw new Error('no dev reset url in response');
    return new URL(url).searchParams.get('token')!;
  }

  it('gives the same answer for a registered and an unregistered email', async () => {
    const { handler } = await seedWorld();

    const known = await requestLink(handler.email);
    const unknown = await requestLink('nobody@test.local');

    // Otherwise this endpoint becomes a way to discover who works here.
    expect(known.body.message).toBe(unknown.body.message);
    expect(known.status).toBe(unknown.status);
  });

  it('issues no token for an unknown address', async () => {
    await seedWorld();
    await requestLink('nobody@test.local');
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('issues no token for a deactivated account, without saying so', async () => {
    const { handler } = await seedWorld();
    await prisma.user.update({ where: { id: handler.id }, data: { isActive: false } });

    const res = await requestLink(handler.email);
    expect(res.body.devResetUrl).toBeUndefined();
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('never stores the token itself', async () => {
    const { handler } = await seedWorld();
    const res = await requestLink(handler.email);
    const token = tokenFrom(res);

    const stored = await prisma.passwordResetToken.findFirstOrThrow();

    // A leaked database must not yield usable reset links.
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resets the password and lets the new one sign in', async () => {
    const { handler } = await seedWorld();
    const token = tokenFrom(await requestLink(handler.email));

    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    const withNew = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: handler.email, password: NEW_PASSWORD });
    const withOld = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: handler.email, password: TEST_PASSWORD });

    expect(withNew.status).toBe(200);
    expect(withOld.status).toBe(401);
  });

  it('spends the token — a second use is refused', async () => {
    const { handler } = await seedWorld();
    const token = tokenFrom(await requestLink(handler.email));

    const first = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });
    const second = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'another-password-entirely' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVALID_RESET_TOKEN');

    // And the first reset still stands.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: handler.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('refuses an expired token', async () => {
    const { handler } = await seedWorld();
    const token = tokenFrom(await requestLink(handler.email));

    await prisma.passwordResetToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('refuses an invented token', async () => {
    await seedWorld();
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'made-up-token-value', password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('gives the same error for unknown, spent and expired tokens', async () => {
    const { handler } = await seedWorld();
    const token = tokenFrom(await requestLink(handler.email));
    await request(app).post('/api/v1/auth/reset-password').send({ token, password: NEW_PASSWORD });

    const spent = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });
    const unknown = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'never-existed', password: NEW_PASSWORD });

    expect(spent.body.error.message).toBe(unknown.body.error.message);
  });

  it('invalidates an earlier link when a new one is requested', async () => {
    const { handler } = await seedWorld();
    const first = tokenFrom(await requestLink(handler.email));
    const second = tokenFrom(await requestLink(handler.email));

    const useFirst = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: first, password: NEW_PASSWORD });
    expect(useFirst.status).toBe(400);

    const useSecond = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: second, password: NEW_PASSWORD });
    expect(useSecond.status).toBe(200);
  });

  it('ends existing sessions — the whole point of a reset', async () => {
    const { handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    // The session works before the reset.
    const before = await request(app)
      .get(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    const resetToken = tokenFrom(await requestLink(handler.email));
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: resetToken, password: NEW_PASSWORD });

    // The old access token is still cryptographically valid and unexpired, and
    // is refused anyway. Changing the lock has to invalidate the keys.
    const after = await request(app)
      .get(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('stops an old refresh token minting new access tokens', async () => {
    const { handler } = await seedWorld();
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: handler.email, password: TEST_PASSWORD });
    const refreshToken = login.body.tokens.refreshToken;

    const resetToken = tokenFrom(await requestLink(handler.email));
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: resetToken, password: NEW_PASSWORD });

    const refresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });

    // Otherwise the reset would be cosmetic: the intruder keeps refreshing.
    expect(refresh.status).toBe(401);
  });

  it('enforces a minimum password length', async () => {
    const { handler } = await seedWorld();
    const token = tokenFrom(await requestLink(handler.email));

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('throttles repeated requests for one account without saying so', async () => {
    const { handler } = await seedWorld();

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: handler.email });
      expect(res.status).toBe(200);
    }

    const sixth = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: handler.email });

    // Throttled, and indistinguishable from not being throttled. A 429 here
    // would have been an enumeration oracle: an unregistered address always
    // answers 200, so a different status on the sixth request would confirm
    // the address is real — the exact question this endpoint refuses to answer.
    expect(sixth.status).toBe(200);
    expect(sixth.body.devResetUrl).toBeUndefined();

    // The cap is real, not just quiet: no sixth token was issued.
    expect(await prisma.passwordResetToken.count({ where: { userId: handler.id } })).toBe(5);
  });

  it('answers a throttled account exactly as it answers an unknown address', async () => {
    const { handler } = await seedWorld();

    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/v1/auth/forgot-password').send({ email: handler.email });
    }

    const throttled = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: handler.email });

    const unknown = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@test.local' });

    expect(throttled.status).toBe(unknown.status);
    expect(throttled.body).toEqual(unknown.body);
  });
});

describe('changing your own password', () => {
  it('requires the current password', async () => {
    const { handler } = await seedWorld();
    const token = await signIn(handler.email);

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'not-the-right-one', newPassword: 'a-long-new-password' });

    expect(res.status).toBe(401);
  });

  it('changes the password and ends the current session', async () => {
    const { handler, item } = await seedWorld();
    const token = await signIn(handler.email);

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-long-new-password' });
    expect(res.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/items/${item.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: handler.email, password: 'a-long-new-password' });
    expect(login.status).toBe(200);
  });

  it('refuses without authentication', async () => {
    await seedWorld();
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-long-new-password' });
    expect(res.status).toBe(401);
  });
});

describe('manager-issued reset links', () => {
  it('lets a manager issue a link for a handler', async () => {
    const { manager, handler } = await seedWorld();
    const managerToken = await signIn(manager.email);

    const res = await request(app)
      .post(`/api/v1/users/${handler.id}/reset-link`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.resetUrl).toContain('/reset-password?token=');

    const token = new URL(res.body.resetUrl).searchParams.get('token')!;
    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'handler-chosen-password' });
    expect(reset.status).toBe(200);

    // The manager never learns the resulting password.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: handler.email, password: 'handler-chosen-password' });
    expect(login.status).toBe(200);
  });

  it('records who issued it', async () => {
    const { manager, handler } = await seedWorld();
    const managerToken = await signIn(manager.email);

    await request(app)
      .post(`/api/v1/users/${handler.id}/reset-link`)
      .set('Authorization', `Bearer ${managerToken}`);

    const stored = await prisma.passwordResetToken.findFirstOrThrow();
    expect(stored.issuedByUserId).toBe(manager.id);
  });

  it('refuses a handler issuing one for anybody', async () => {
    const { handler, manager } = await seedWorld();
    const handlerToken = await signIn(handler.email);

    const res = await request(app)
      .post(`/api/v1/users/${manager.id}/reset-link`)
      .set('Authorization', `Bearer ${handlerToken}`);

    expect(res.status).toBe(403);
  });
});
