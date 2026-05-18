const Fastify = require('fastify');
const cors = require('@fastify/cors');
const jwt = require('@fastify/jwt');
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

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const app = Fastify({ logger: true });



async function start() {
await app.register(cors, {
  origin: true,
  credentials: true,
  allowedHeaders: ['Authorization', 'x-api-key', 'Content-Type']
});



  await app.register(jwt, { secret: JWT_SECRET });

  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, 
    },
  });

  // Serve uploaded files statically
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  app.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(swipeRoutes, { prefix: '/api/swipes' });
  await app.register(messageRoutes, { prefix: '/api/messages' });
  await app.register(constantDataRoutes, { prefix: '/api/constant_data' });
  await app.register(uploadRoutes, { prefix: '/api/upload' });
  await app.register(wallRoutes, { prefix: '/api/wall' });
  await app.register(groupRoutes, { prefix: '/api/groups' });

  // Health check with DB connectivity verification
  app.get('/api/health', async (request, reply) => {
    const start = Date.now();
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
        latency_ms: dbStatus === 'connected' ? Date.now() - start : null,
        ...(dbError && exposeErrorDetails(request) ? { error: dbError } : {}),
      },
    };

    const statusCode = dbStatus === 'connected' ? 200 : 503;
    return reply.status(statusCode).send(health);
  });

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
