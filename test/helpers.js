'use strict';

/**
 * Test helpers — no external test dependencies (uses node:test).
 *
 * The route modules capture `query` from ../src/db at require time, so the
 * mock db module is installed into the require cache BEFORE any route module
 * is loaded. Always `require('./helpers')` first in a test file.
 */

const Fastify = require('fastify');

// Env the route modules read at load time
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test-project.supabase.co';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-characters!!';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

// ── Mock db module ──────────────────────────────────────────────────────────
const queryCalls = [];
let queryHandler = async () => ({ rows: [], rowCount: 0 });

const mockDb = {
  query: async (text, params) => {
    queryCalls.push({ text, params });
    return queryHandler(text, params);
  },
  getClient: async () => {
    throw new Error('getClient is not supported in tests');
  },
  withTransaction: async (fn) => fn({ query: mockDb.query }),
  get pool() { return null; },
};

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// Mock the supabase client too, so route modules that import it don't need creds
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    supabase: {
      storage: {
        from: () => ({
          upload: async () => ({ error: null }),
          remove: async () => ({ error: null }),
          getPublicUrl: () => ({ data: { publicUrl: 'https://test-project.supabase.co/storage/v1/object/public/x' } }),
          createSignedUrl: async () => ({ data: { signedUrl: 'https://test-project.supabase.co/signed/x' } }),
        }),
        createBucket: async () => ({}),
        updateBucket: async () => ({}),
      },
    },
  },
};

function setQueryHandler(fn) { queryHandler = fn; }
function resetQueries() {
  queryCalls.length = 0;
  queryHandler = async () => ({ rows: [], rowCount: 0 });
}

// ── App factory ─────────────────────────────────────────────────────────────
async function buildApp(routePlugin, prefix, { userId = TEST_USER_ID } = {}) {
  const app = Fastify({ logger: false });
  await app.register(require('@fastify/jwt'), { secret: process.env.JWT_SECRET });
  app.decorate('authenticate', async (request) => {
    request.user = {
      id: userId,
      email: 'test@example.com',
      jti: 'test-jti',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await app.register(routePlugin, { prefix });
  await app.ready();
  return app;
}

module.exports = {
  buildApp,
  setQueryHandler,
  resetQueries,
  queryCalls,
  mockDb,
  TEST_USER_ID,
  OTHER_USER_ID,
};
