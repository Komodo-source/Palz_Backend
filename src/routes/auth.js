const bcrypt = require('bcrypt');
const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');

const signupSchema = z.object({
  full_name: z.string().min(2).max(255),
  user_name: z.string().min(3).max(255).regex(/^[a-zA-Z0-9_]+$/, 'Username must be alphanumeric'),
  email: z.string().email(),
  password: z.string().min(6).max(255),
  date_of_birth: z.string().optional(),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function authRoutes(app) {
  app.post('/signup', async (request, reply) => {
    try {
      const body = signupSchema.parse(request.body);

      const existing = await query(
        'SELECT id FROM users WHERE email = $1 OR user_name = $2',
        [body.email, body.user_name]
      );

      if (existing.rows.length > 0) {
        return reply.status(409).send({ error: 'Email or username already taken' });
      }

      const hashedPassword = await bcrypt.hash(body.password, 12);

      const result = await query(
        `INSERT INTO users (full_name, user_name, email, password, date_of_birth, phone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, full_name, user_name, email, date_of_birth, phone, profile_image, bio,
                   is_verified, is_premium, created_at`,
        [
          body.full_name,
          body.user_name,
          body.email,
          hashedPassword,
          body.date_of_birth || null,
          body.phone || null,
        ]
      );

      const user = result.rows[0];
      const token = app.jwt.sign({ id: user.id, email: user.email }, { expiresIn: '30d' });

      return reply.status(201).send({ user, token });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('Signup error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/login', async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);

      const result = await query(
        `SELECT id, full_name, user_name, email, password, date_of_birth, phone,
                profile_image, bio, is_verified, is_premium, created_at
         FROM users WHERE email = $1`,
        [body.email]
      );

      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];
      const valid = await bcrypt.compare(body.password, user.password);

      if (!valid) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      delete user.password;
      const token = app.jwt.sign({ id: user.id, email: user.email }, { expiresIn: '30d' });

      return reply.send({ user, token });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('Login error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.get('/me', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      const result = await query(
        `SELECT id, full_name, user_name, email, date_of_birth, phone, profile_image, bio,
                work, situation, astrology_sign_id, interests, is_verified, is_premium,
                location, home_location, latitude, longitude, search_radius,
                girls_filter, events_filter, age_min_filter, age_max_filter,
                ready_to_go, created_at, updated_at
         FROM users WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      return reply.send({ user: result.rows[0] });
    } catch (err) {
      console.error('Me error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = { authRoutes };
