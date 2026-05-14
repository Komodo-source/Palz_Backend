const Fastify = require('fastify');
const cors = require('@fastify/cors');
const jwt = require('@fastify/jwt');
const dotenv = require('dotenv');
const { authRoutes } = require('./routes/auth');
const { userRoutes } = require('./routes/users');
const { swipeRoutes } = require('./routes/swipes');
const { messageRoutes } = require('./routes/messages');

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const app = Fastify({ logger: true });

async function start() {
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(jwt, { secret: JWT_SECRET });

  app.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(swipeRoutes, { prefix: '/api/swipes' });
  await app.register(messageRoutes, { prefix: '/api/messages' });

  app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

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
