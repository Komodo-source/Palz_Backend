'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const helpers = require('./helpers'); // must be first: installs db mock
const { buildApp, setQueryHandler, resetQueries, queryCalls, TEST_USER_ID } = helpers;

const { authRoutes } = require('../src/routes/auth');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

beforeEach(() => resetQueries());

test('POST /refresh rejects a missing token', async () => {
  const app = await buildApp(authRoutes, '/api/auth');
  const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {} });
  assert.strictEqual(res.statusCode, 400);
  await app.close();
});

test('POST /refresh rejects an unknown/revoked token', async () => {
  const app = await buildApp(authRoutes, '/api/auth');
  setQueryHandler(async (text) => {
    if (text.includes('FROM refresh_tokens')) return { rows: [] };
    return { rows: [] };
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    payload: { refresh_token: 'stolen-or-expired' },
  });
  assert.strictEqual(res.statusCode, 401);
  await app.close();
});

test('POST /refresh rotates: revokes old token, issues new pair', async () => {
  const app = await buildApp(authRoutes, '/api/auth');
  const rawToken = 'valid-refresh-token';

  setQueryHandler(async (text, params) => {
    if (text.includes('FROM refresh_tokens') && text.includes('SELECT')) {
      // Only the correct hash matches
      if (params[0] === sha256(rawToken)) {
        return { rows: [{ user_id: TEST_USER_ID, email: 'test@example.com' }] };
      }
      return { rows: [] };
    }
    return { rows: [], rowCount: 1 };
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    payload: { refresh_token: rawToken },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.token, 'new JWT issued');
  assert.ok(body.refresh_token, 'new refresh token issued');
  assert.notStrictEqual(body.refresh_token, rawToken, 'refresh token must rotate');

  const revoke = queryCalls.find((c) => c.text.includes('SET revoked_at'));
  assert.ok(revoke, 'old token revoked');
  assert.strictEqual(revoke.params[0], sha256(rawToken));

  const insert = queryCalls.find((c) => c.text.includes('INSERT INTO refresh_tokens'));
  assert.ok(insert, 'new token stored');
  assert.strictEqual(insert.params[0], sha256(body.refresh_token), 'only the hash is stored');
  await app.close();
});

test('POST /login returns a refresh token and no password field', async () => {
  const app = await buildApp(authRoutes, '/api/auth');
  const passwordHash = await bcrypt.hash('secret123', 4);

  setQueryHandler(async (text) => {
    if (text.includes('FROM users WHERE email')) {
      return {
        rows: [{
          id: TEST_USER_ID, full_name: 'Test', user_name: 'test',
          email: 'test@example.com', password: passwordHash,
        }],
      };
    }
    return { rows: [], rowCount: 1 };
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'test@example.com', password: 'secret123' },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.token);
  assert.ok(body.refresh_token);
  assert.strictEqual(body.user.password, undefined, 'password hash must not leak');
  await app.close();
});

test('POST /logout revokes the provided refresh token', async () => {
  const app = await buildApp(authRoutes, '/api/auth');
  setQueryHandler(async () => ({ rows: [], rowCount: 1 }));

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    payload: { refresh_token: 'device-token' },
  });
  assert.strictEqual(res.statusCode, 200);
  const revoke = queryCalls.find((c) => c.text.includes('UPDATE refresh_tokens SET revoked_at'));
  assert.ok(revoke, 'refresh token revocation must run');
  assert.strictEqual(revoke.params[0], sha256('device-token'));
  assert.strictEqual(revoke.params[1], TEST_USER_ID);
  await app.close();
});
