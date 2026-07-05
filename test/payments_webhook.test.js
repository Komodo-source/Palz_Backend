'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers'); // must be first: installs db mock
const { buildApp, setQueryHandler, resetQueries, queryCalls, TEST_USER_ID } = helpers;

const paymentsModulePath = require.resolve('../src/routes/payments');
const SECRET = 'test-revenuecat-secret';

function loadPaymentRoutes({ withSecret }) {
  delete require.cache[paymentsModulePath];
  if (withSecret) {
    process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  } else {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
  }
  return require(paymentsModulePath).paymentRoutes;
}

beforeEach(() => resetQueries());

test('webhook is disabled (503) when no secret is configured', async () => {
  const routes = loadPaymentRoutes({ withSecret: false });
  const app = await buildApp(routes, '/api/payments');
  const res = await app.inject({
    method: 'POST',
    url: '/api/payments/webhook',
    payload: { event: { type: 'INITIAL_PURCHASE', app_user_id: TEST_USER_ID } },
  });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(queryCalls.length, 0, 'no db writes without a configured secret');
  await app.close();
});

test('webhook rejects missing or wrong Authorization', async () => {
  const routes = loadPaymentRoutes({ withSecret: true });
  const app = await buildApp(routes, '/api/payments');

  const noAuth = await app.inject({
    method: 'POST',
    url: '/api/payments/webhook',
    payload: { event: { type: 'INITIAL_PURCHASE', app_user_id: TEST_USER_ID } },
  });
  assert.strictEqual(noAuth.statusCode, 401);

  const wrongAuth = await app.inject({
    method: 'POST',
    url: '/api/payments/webhook',
    headers: { authorization: 'wrong-secret' },
    payload: { event: { type: 'INITIAL_PURCHASE', app_user_id: TEST_USER_ID } },
  });
  assert.strictEqual(wrongAuth.statusCode, 401);

  assert.strictEqual(queryCalls.length, 0, 'unsigned requests must never touch the db');
  await app.close();
});

test('webhook skips non-UUID app_user_id without touching the db', async () => {
  const routes = loadPaymentRoutes({ withSecret: true });
  const app = await buildApp(routes, '/api/payments');
  const res = await app.inject({
    method: 'POST',
    url: '/api/payments/webhook',
    headers: { authorization: SECRET },
    payload: { event: { type: 'INITIAL_PURCHASE', app_user_id: '$RCAnonymousID:abc123' } },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(queryCalls.length, 0);
  await app.close();
});

test('signed INITIAL_PURCHASE grants premium to the given user', async () => {
  const routes = loadPaymentRoutes({ withSecret: true });
  const app = await buildApp(routes, '/api/payments');
  setQueryHandler(async () => ({ rows: [], rowCount: 1 }));

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments/webhook',
    headers: { authorization: SECRET },
    payload: {
      event: {
        type: 'INITIAL_PURCHASE',
        app_user_id: TEST_USER_ID,
        expiration_at_ms: Date.now() + 30 * 24 * 3600 * 1000,
      },
    },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(queryCalls.length, 1);
  assert.match(queryCalls[0].text, /SET is_premium = true/);
  assert.strictEqual(queryCalls[0].params[0], TEST_USER_ID);
  await app.close();
});

test('signed EXPIRATION revokes premium', async () => {
  const routes = loadPaymentRoutes({ withSecret: true });
  const app = await buildApp(routes, '/api/payments');
  setQueryHandler(async () => ({ rows: [], rowCount: 1 }));

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments/webhook',
    headers: { authorization: SECRET },
    payload: { event: { type: 'EXPIRATION', app_user_id: TEST_USER_ID } },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.match(queryCalls[0].text, /is_premium = false/);
  await app.close();
});
