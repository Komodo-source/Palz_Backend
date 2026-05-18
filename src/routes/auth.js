const bcrypt = require('bcrypt');
const { z } = require('zod');
const { OAuth2Client } = require('google-auth-library');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');

const signupSchema = z.object({
  surname: z.string().min(2).max(255),
  firstname: z.string().min(2).max(255),
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

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '639212474409-8q2g4e4hf7jqa88o7i70fq7m7c8rgpli.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Convert Google display name to surname + firstname
function parseGoogleName(displayName) {
  if (!displayName || !displayName.trim()) {
    return { surname: 'User', firstname: 'New' };
  }
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { surname: parts[0], firstname: parts[0] };
  }
  return {
    firstname: parts[0],
    surname: parts.slice(1).join(' '),
  };
}

// Generate a unique username from email
async function generateUserName(email) {
  const base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 20);
  let userName = base;
  let attempt = 0;
  while (true) {
    const existing = await query('SELECT id FROM users WHERE user_name = $1', [userName]);
    if (existing.rows.length === 0) return userName;
    attempt++;
    const suffix = Math.floor(Math.random() * 10000);
    userName = `${base.substring(0, 15)}_${suffix}`;
  }
}

async function authRoutes(app) {

  // ── Google OAuth ──
  app.post('/google', async (request, reply) => {
    try {
      const { idToken } = request.body;
      if (!idToken) {
        return reply.status(400).send({ error: 'Missing idToken' });
      }

      // Verify the Google ID token
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();
      const {
        email,
        name: displayName,
        given_name: givenName,
        family_name: familyName,
        picture,
      } = payload;

      if (!email) {
        return reply.status(400).send({ error: 'Google account has no email' });
      }

      // Check if user already exists
      let result = await query(
        `SELECT id, CONCAT(firstname, ' ', surname) AS full_name, user_name, email, date_of_birth, phone,
                profile_image, bio, is_verified, is_premium, created_at
         FROM users WHERE email = $1`,
        [email]
      );

      let user;
      let isNewUser = false;

      if (result.rows.length > 0) {
        // Existing user — log them in
        user = result.rows[0];

        // Optionally update profile image if they have none
        let parsedImage = [];
        try { parsedImage = typeof user.profile_image === 'string' ? JSON.parse(user.profile_image) : (user.profile_image || []); } catch {}
        if (picture && (!Array.isArray(parsedImage) || parsedImage.length === 0)) {
          await query(
            `UPDATE users SET profile_image = $1 WHERE id = $2`,
            [JSON.stringify([picture]), user.id]
          );
        }
      } else {
        // New user — create account
        isNewUser = true;
        const { surname, firstname } = familyName && givenName
          ? { surname: familyName, firstname: givenName }
          : parseGoogleName(displayName);

        const userName = await generateUserName(email);
        const randomPassword = require('crypto').randomBytes(32).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 12);

        const insertResult = await query(
          `INSERT INTO users (surname, firstname, user_name, email, password, profile_image, is_verified)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           RETURNING id, CONCAT(firstname, ' ', surname) AS full_name, user_name, email, date_of_birth, phone, profile_image, bio,
                     is_verified, is_premium, created_at`,
          [surname, firstname, userName, email, hashedPassword, JSON.stringify(picture ? [picture] : [])]
        );

        user = insertResult.rows[0];
      }

      const token = app.jwt.sign({ id: user.id, email: user.email }, { expiresIn: '30d' });

      return reply.send({ user, token, isNewUser });
    } catch (err) {
      console.error('Google auth error:', err);
      return reply.status(401).send({ error: 'Google authentication failed' });
    }
  });
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
        `INSERT INTO users (surname, firstname, user_name, email, password, date_of_birth, phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, CONCAT(firstname, ' ', surname) AS full_name, user_name, email, date_of_birth, phone, profile_image, bio,
                   is_verified, is_premium, created_at`,
        [
          body.surname,
          body.firstname,
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
      console.error('/auth/signup error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.post('/login', async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);

      const result = await query(
        `SELECT id, CONCAT(firstname, ' ', surname) AS full_name, user_name, email, password, date_of_birth, phone,
                profile_image, bio, is_verified, is_premium, created_at
         FROM users WHERE email = $1`,
        [body.email]
      );

      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];
      let valid = await bcrypt.compare(body.password, user.password);

      // Backward compatibility: pre-March 2025 clients sent SHA-256 hashed passwords
      if (!valid) {
        const crypto = require('crypto');
        const sha256Hash = crypto.createHash('sha256').update(body.password).digest('hex');
        valid = await bcrypt.compare(sha256Hash, user.password);
        // Auto-migrate: re-hash as bcrypt(plaintext) for future logins
        if (valid) {
          const newHash = await bcrypt.hash(body.password, 12);
          await query('UPDATE users SET password = $1 WHERE id = $2', [newHash, user.id]);
        }
      }

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
      console.error('/auth/login error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/me', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      const result = await query(
        `SELECT id, CONCAT(firstname, ' ', surname) AS full_name, user_name, email, date_of_birth, phone, profile_image, bio,
                work, situation, astrology_sign_id, interests, voice_fun_fact, is_verified, is_premium,
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
      console.error('/auth/me error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { authRoutes };
