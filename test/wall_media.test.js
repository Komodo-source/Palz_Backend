'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers'); // must be first: installs db mock + SUPABASE_URL
const { buildApp, setQueryHandler, resetQueries, queryCalls } = helpers;

const { wallRoutes } = require('../src/routes/wall');

const OWN_URL = `${process.env.SUPABASE_URL}/storage/v1/object/public/user_photos/img_1.jpg`;

function themeAwareHandler(extra = () => null) {
  return async (text, params) => {
    const custom = extra(text, params);
    if (custom) return custom;
    if (text.includes('FROM wall_themes')) return { rows: [{ id: 'theme-1' }] };
    if (text.includes('INSERT INTO wall_themes')) return { rows: [{ id: 'theme-1' }] };
    if (text.includes('INSERT INTO wall')) {
      return { rows: [{ id: 'post-1', user_initiator: params[0], wall_photo: params[1], theme_id: 'theme-1', created_at: new Date().toISOString() }] };
    }
    return { rows: [], rowCount: 0 };
  };
}

beforeEach(() => resetQueries());

test('wall post rejects external media URLs', async () => {
  const app = await buildApp(wallRoutes, '/api/wall');
  setQueryHandler(themeAwareHandler());
  const res = await app.inject({
    method: 'POST',
    url: '/api/wall/post',
    payload: { wall_photo: ['https://evil.example.com/tracker.gif'] },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.ok(!queryCalls.some((c) => c.text.includes('INSERT INTO wall (')), 'no insert for rejected post');
  await app.close();
});

test('wall post rejects mixed own + external URLs', async () => {
  const app = await buildApp(wallRoutes, '/api/wall');
  setQueryHandler(themeAwareHandler());
  const res = await app.inject({
    method: 'POST',
    url: '/api/wall/post',
    payload: { wall_photo: [OWN_URL, 'http://phish.example/x.png'] },
  });
  assert.strictEqual(res.statusCode, 400);
  await app.close();
});

test('wall post accepts own-storage URLs', async () => {
  const app = await buildApp(wallRoutes, '/api/wall');
  setQueryHandler(themeAwareHandler());
  const res = await app.inject({
    method: 'POST',
    url: '/api/wall/post',
    payload: { wall_photo: [OWN_URL] },
  });
  assert.strictEqual(res.statusCode, 201);
  await app.close();
});

test('wall post caps photo count at 5', async () => {
  const app = await buildApp(wallRoutes, '/api/wall');
  const res = await app.inject({
    method: 'POST',
    url: '/api/wall/post',
    payload: { wall_photo: Array(6).fill(OWN_URL) },
  });
  assert.strictEqual(res.statusCode, 400);
  await app.close();
});

test('wall message with banned content is rejected', async () => {
  const app = await buildApp(wallRoutes, '/api/wall');
  setQueryHandler(async (text) => {
    if (text.includes('FROM wall WHERE id')) return { rows: [{ id: 'post-1', user_initiator: 'u' }] };
    return { rows: [] };
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/wall/post/00000000-0000-4000-8000-000000000000/message',
    payload: { content: 'viens sur onlyfans' },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().flagged, true);
  await app.close();
});
