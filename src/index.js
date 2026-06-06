const Fastify = require('fastify');
const cors = require('@fastify/cors');
const jwt = require('@fastify/jwt');
const rateLimit = require('@fastify/rate-limit');
const multipart = require('@fastify/multipart');
const fastifyStatic = require('@fastify/static');
const dotenv = require('dotenv');
const path = require('path');
const { query } = require('./db');
const { exposeErrorDetails } = require('./debug');
const { authRoutes } = require('./routes/auth');
const { userRoutes } = require('./routes/users');
const { swipeRoutes } = require('./routes/swipes');
const { messageRoutes } = require('./routes/messages');
const { constantDataRoutes } = require('./routes/constant_data');
const { uploadRoutes } = require('./routes/uploads');
const { wallRoutes } = require('./routes/wall');
const { groupRoutes } = require('./routes/groups');
const { eventRoutes } = require('./routes/events');
const { paymentRoutes } = require('./routes/payments');
const { startScheduler } = require('./scheduler');

dotenv.config();

// ── Validation des secrets au démarrage (fail-fast) ──
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET manquant ou trop court (min 32 caractères).');
  process.exit(1);
}

const API_SECRET_KEY = process.env.SECRET_ACCESS_KEY || process.env.API_SECRET_KEY;
if (!API_SECRET_KEY) {
  console.error('[FATAL] SECRET_ACCESS_KEY manquant.');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : [];

const app = Fastify({ logger: true });

// ── Table de révocation JWT (créée au démarrage si absente) ──
async function ensureRevokedTokensTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti        TEXT        PRIMARY KEY,
      user_id    UUID,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires
    ON revoked_tokens (expires_at)
  `);
}

async function ensureExtraTables() {
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS expo_push_token TEXT`);
  await query(`
    CREATE TABLE IF NOT EXISTS event_reminder_log (
      event_id      UUID        NOT NULL,
      user_id       UUID        NOT NULL,
      reminder_type VARCHAR(4)  NOT NULL,
      sent_at       TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (event_id, user_id, reminder_type)
    )
  `);
}

async function start() {
  await ensureRevokedTokensTable();
  await ensureExtraTables();

  // ── CORS — whitelist explicite ──
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // mobile natif / curl
      if (process.env.NODE_ENV !== 'production') {
        if (
          origin.startsWith('http://localhost') ||
          origin.startsWith('http://10.0.2.2')
        ) return cb(null, true);
      }
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    allowedHeaders: ['Authorization', 'x-api-key', 'Content-Type'],
  });

  // ── Rate limiting global ──
  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: 'Trop de requêtes — réessaie dans un moment.' }),
  });

  await app.register(jwt, { secret: JWT_SECRET });

  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  const uploadsDir = path.join(__dirname, '..', 'uploads');
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  // ── Vérification x-api-key sur toutes les routes /api/* ──
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/health') return;
    if (!request.url.startsWith('/api/')) return;
    const key = request.headers['x-api-key'];
    if (!key || key !== API_SECRET_KEY) {
      return reply.status(401).send({ error: 'Invalid API key' });
    }
  });

  // ── Authentification JWT + vérification de révocation ──
  app.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();
      const jti = request.user?.jti;
      if (jti) {
        const revoked = await query(
          'SELECT 1 FROM revoked_tokens WHERE jti = $1 AND expires_at > NOW()',
          [jti]
        );
        if (revoked.rows.length > 0) {
          return reply.status(401).send({ error: 'Token révoqué — reconnecte-toi' });
        }
      }
    } catch (err) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // ── Routes ──
  await app.register(authRoutes,         { prefix: '/api/auth' });
  await app.register(userRoutes,         { prefix: '/api/users' });
  await app.register(swipeRoutes,        { prefix: '/api/swipes' });
  await app.register(messageRoutes,      { prefix: '/api/messages' });
  await app.register(constantDataRoutes, { prefix: '/api/constant_data' });
  await app.register(uploadRoutes,       { prefix: '/api/upload' });
  await app.register(wallRoutes,         { prefix: '/api/wall' });
  await app.register(groupRoutes,        { prefix: '/api/groups' });
  await app.register(eventRoutes,        { prefix: '/api/events' });
  await app.register(paymentRoutes,      { prefix: '/api/payments' });

  // ── Health check (authentifié) ──
  app.get('/api/health', { preHandler: [app.authenticate] }, async (request, reply) => {
    const t = Date.now();
    let dbStatus = 'unknown';
    let dbError = null;
    try {
      const res = await query('SELECT 1 AS ok');
      dbStatus = res.rows[0]?.ok === 1 ? 'connected' : 'unexpected';
    } catch (err) {
      dbStatus = 'disconnected';
      dbError = err.message;
    }
    const health = {
      status: dbStatus === 'connected' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      db: {
        status: dbStatus,
        latency_ms: dbStatus === 'connected' ? Date.now() - t : null,
        ...(dbError && exposeErrorDetails(request) ? { error: dbError } : {}),
      },
    };
    return reply.status(dbStatus === 'connected' ? 200 : 503).send(health);
  });

  // ── Nettoyage périodique des tokens révoqués expirés ──
  setInterval(async () => {
    try { await query('DELETE FROM revoked_tokens WHERE expires_at < NOW()'); } catch { /* silence */ }
  }, 60 * 60 * 1000);

  startScheduler();

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`🚀 Palz Backend running on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

module.exports = app;
