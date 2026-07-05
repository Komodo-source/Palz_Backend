'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers'); // must be first: installs db mock
const { buildApp, setQueryHandler, resetQueries, queryCalls, TEST_USER_ID, OTHER_USER_ID } = helpers;

const { userRoutes } = require('../src/routes/users');

beforeEach(() => resetQueries());

test('report_user rejects self-reports', async () => {
  const app = await buildApp(userRoutes, '/api/users');
  const res = await app.inject({
    method: 'POST',
    url: '/api/users/report_user',
    payload: { reportedUserID: TEST_USER_ID, reason: 'spam' },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(queryCalls.length, 0);
  await app.close();
});

test('report_user 404s when target does not exist', async () => {
  const app = await buildApp(userRoutes, '/api/users');
  setQueryHandler(async (text) => {
    if (text.includes('SELECT 1 FROM users')) return { rows: [] };
    return { rows: [] };
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/users/report_user',
    payload: { reportedUserID: OTHER_USER_ID, reason: 'spam' },
  });
  assert.strictEqual(res.statusCode, 404);
  await app.close();
});

test('report_user inserts with dedup (ON CONFLICT DO NOTHING)', async () => {
  const app = await buildApp(userRoutes, '/api/users');
  setQueryHandler(async (text) => {
    if (text.includes('SELECT 1 FROM users')) return { rows: [{ '?column?': 1 }] };
    return { rows: [], rowCount: 1 };
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/users/report_user',
    payload: { reportedUserID: OTHER_USER_ID, reason: 'harassment' },
  });
  assert.strictEqual(res.statusCode, 200);
  const insert = queryCalls.find((c) => c.text.includes('INSERT INTO reported_users'));
  assert.ok(insert, 'insert must run');
  assert.match(insert.text, /ON CONFLICT \(reporter_id, reported_user_id\) DO NOTHING/);
  assert.deepStrictEqual(insert.params, [TEST_USER_ID, OTHER_USER_ID, 'harassment']);
  await app.close();
});

test('report_user validates reason length (max 255)', async () => {
  const app = await buildApp(userRoutes, '/api/users');
  const res = await app.inject({
    method: 'POST',
    url: '/api/users/report_user',
    payload: { reportedUserID: OTHER_USER_ID, reason: 'x'.repeat(300) },
  });
  assert.strictEqual(res.statusCode, 400);
  await app.close();
});
