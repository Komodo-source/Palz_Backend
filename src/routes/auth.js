const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { z } = require('zod');
const { OAuth2Client } = require('google-auth-library');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');

const signupSchema = z.object({
  full_name: z.string().min(2).max(255),
  user_name: z.string().min(3).max(255).regex(/^[a-zA-Z0-9_]+$/, 'Username must be alphanumeric'),
  email: z.string().email().transform((v) => v.trim().toLowerCase()),
  password: z.string().min(6).max(255),
  date_of_birth: z.string().optional(),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email().transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1),
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
  console.warn('[WARN] GOOGLE_CLIENT_ID manquant — Google OAuth désactivé');
}
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function parseGoogleName(displayName) {
  if (!displayName || !displayName.trim()) return 'New User';
  return displayName.trim();
}

async function generateUserName(email) {
  const base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 20);
  let userName = base;
  const MAX_ATTEMPTS = 15;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const existing = await query('SELECT id FROM users WHERE user_name = $1', [userName]);
    if (existing.rows.length === 0) return userName;
    const suffix = Math.floor(Math.random() * 10000);
    userName = `${base.substring(0, 15)}_${suffix}`;
  }
  throw new Error('Could not generate a unique username — réessaie');
}

const JWT_EXPIRY = '24h';
const JWT_EXPIRY_SECONDS = 24 * 60 * 60;

function signToken(app, userId, email) {
  const jti = crypto.randomUUID();
  const token = app.jwt.sign(
    { id: userId, email, jti },
    { expiresIn: JWT_EXPIRY }
  );
  return { token, jti };
}

async function authRoutes(app) {

  // ── Rate limiting renforcé sur les routes d\'authentification ──
  const authRateLimit = {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  };
  const signupRateLimit = {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  };

  // ── Google OAuth ──
  app.post('/google', authRateLimit, async (request, reply) => {
    if (!googleClient) {
      return reply.status(503).send({ error: 'Google OAuth non configuré' });
    }
    try {
      const { idToken } = request.body;
      if (!idToken) return reply.status(400).send({ error: 'Missing idToken' });

      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();
      const { email, name: displayName, given_name: givenName, family_name: familyName, picture } = payload;

      if (!email) return reply.status(400).send({ error: 'Google account has no email' });

      const normalizedEmail = email.trim().toLowerCase();

      let result = await query(
        `SELECT id, full_name, user_name, email, date_of_birth, phone,
                profile_image, bio, is_verified, is_premium, created_at
         FROM users WHERE email = $1`,
        [normalizedEmail]
      );

      let user;
      let isNewUser = false;

      if (result.rows.length > 0) {
        user = result.rows[0];
        let parsedImage = [];
        try { parsedImage = typeof user.profile_image === 'string' ? JSON.parse(user.profile_image) : (user.profile_image || []); } catch {}
        if (picture && (!Array.isArray(parsedImage) || parsedImage.length === 0)) {
          await query(`UPDATE users SET profile_image = $1 WHERE id = $2`, [JSON.stringify([picture]), user.id]);
        }
      } else {
        isNewUser = true;
        const googleFullName = familyName && givenName
          ? `${givenName} ${familyName}`
          : parseGoogleName(displayName);

        const userName = await generateUserName(normalizedEmail);
        const randomPassword = crypto.randomBytes(32).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 12);

        const insertResult = await query(
          `INSERT INTO users (full_name, user_name, email, password, profile_image, is_verified)
           VALUES ($1, $2, $3, $4, $5, true)
           RETURNING id, full_name, user_name, email, date_of_birth, phone, profile_image, bio,
                     is_verified, is_premium, created_at`,
          [googleFullName, userName, normalizedEmail, hashedPassword, JSON.stringify(picture ? [picture] : [])]
        );
        user = insertResult.rows[0];
      }

      const { token, jti } = signToken(app, user.id, user.email);
      query('INSERT INTO login_events (user_id) VALUES ($1)', [user.id]).catch((err) => console.error('[auth] login_events insert error:', err.message));

      return reply.send({ user, token, isNewUser });
    } catch (err) {
      console.error('Google auth error:', err);
      return reply.status(401).send({ error: 'Google authentication failed' });
    }
  });

  // ── Signup ──
  app.post('/signup', signupRateLimit, async (request, reply) => {
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
        [body.full_name, body.user_name, body.email, hashedPassword, body.date_of_birth || null, body.phone || null]
      );

      const user = result.rows[0];
      const { token } = signToken(app, user.id, user.email);

      return reply.status(201).send({ user, token });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('/auth/signup error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── Login ──
  app.post('/login', authRateLimit, async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);

      const result = await query(
        `SELECT id, full_name, user_name, email, password, date_of_birth, phone,
                profile_image, bio, is_verified, is_premium, created_at
         FROM users WHERE email = $1`,
        [body.email]
      );

      // Réponse identique pour email inexistant et mauvais mot de passe (anti-énumération)
      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];
      let valid = await bcrypt.compare(body.password, user.password);

      // Rétrocompatibilité SHA-256 (clients pré-mars 2025) — migration automatique
      if (!valid) {
        const sha256Hash = crypto.createHash('sha256').update(body.password).digest('hex');
        valid = await bcrypt.compare(sha256Hash, user.password);
        if (valid) {
          const newHash = await bcrypt.hash(body.password, 12);
          await query('UPDATE users SET password = $1 WHERE id = $2', [newHash, user.id]);
        }
      }

      if (!valid) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      delete user.password;
      const { token } = signToken(app, user.id, user.email);

      query('INSERT INTO login_events (user_id) VALUES ($1)', [user.id]).catch((err) => console.error('[auth] login_events insert error:', err.message));

      return reply.send({ user, token });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('/auth/login error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── Logout — révocation serveur du token ──
  app.post('/logout', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const jti = request.user?.jti;
      const exp = request.user?.exp;

      if (jti && exp) {
        const expiresAt = new Date(exp * 1000).toISOString();
        await query(
          `INSERT INTO revoked_tokens (jti, user_id, expires_at)
           VALUES ($1, $2, $3) ON CONFLICT (jti) DO NOTHING`,
          [jti, request.user.id, expiresAt]
        );
      }

      return reply.send({ success: true });
    } catch (err) {
      console.error('/auth/logout error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ── Me ──
  app.get('/me', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      const result = await query(
        `SELECT id, full_name, user_name, email, date_of_birth, phone, profile_image, bio,
                work, situation, astrology_sign_id, interests, voice_fun_fact, is_verified, is_premium,
                location, home_location, latitude, longitude, search_radius,
                girls_filter, events_filter, age_min_filter, age_max_filter, labels,
                ready_to_go, created_at, updated_at
         FROM users WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) return reply.status(404).send({ error: 'User not found' });

      return reply.send({ user: result.rows[0] });
    } catch (err) {
      console.error('/auth/me error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { authRoutes };
