const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');

// ── Predefined wall themes (rotate every 3 days) ──
const WALL_THEMES = [
  'Poste ton animal de compagnie 🐾',
  'Ton plus beau sourire 😊',
  'Ta tenue du jour 👗',
  'Ton endroit préféré 📍',
  'Ton plat favori 🍕',
  'Ta passion cachée 🎨',
  'Ton moment détente 🌿',
  'Ta photo d\'enfance 👶',
  'Ce qui te fait rire 😂',
  'Ton sport favori ⚽',
  'Ta plus belle vue 🌅',
  'Ton rituel du matin ☕',
  'Ta collection préférée 🎵',
  'Ton coin lecture 📚',
  'Ta photo nature 🌸',
  'Ton look du weekend ✨',
];

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Get or create the active theme for now.
 * Rotates themes every 3 days starting from a reference epoch.
 */
async function getActiveTheme() {
  // Reference epoch: 2025-05-18 00:00:00 UTC
  const EPOCH = new Date('2025-05-18T00:00:00.000Z').getTime();
  const now = Date.now();
  const elapsedIntervals = Math.floor((now - EPOCH) / THREE_DAYS_MS);
  const themeIndex = elapsedIntervals % WALL_THEMES.length;
  const themeTitle = WALL_THEMES[themeIndex];

  const startsAt = new Date(EPOCH + elapsedIntervals * THREE_DAYS_MS);
  const endsAt = new Date(startsAt.getTime() + THREE_DAYS_MS);

  // Upsert the theme in DB
  const existing = await query(
    `SELECT id FROM wall_themes WHERE starts_at = $1`,
    [startsAt.toISOString()]
  );

  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, title: themeTitle, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() };
  }

  // Use ON CONFLICT to prevent race condition duplicates
  const result = await query(
    `INSERT INTO wall_themes (title, starts_at, ends_at) VALUES ($1, $2, $3)
     ON CONFLICT (starts_at) DO NOTHING
     RETURNING id`,
    [themeTitle, startsAt.toISOString(), endsAt.toISOString()]
  );

  // If racing, another request may have created it — refetch
  if (result.rows.length === 0) {
    const refetched = await query(
      `SELECT id FROM wall_themes WHERE starts_at = $1`,
      [startsAt.toISOString()]
    );
    return { id: refetched.rows[0].id, title: themeTitle, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() };
  }

  return { id: result.rows[0].id, title: themeTitle, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() };
}

async function wallRoutes(app) {

  // ── GET active theme ──
  app.get('/theme', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const theme = await getActiveTheme();
      return reply.send({ theme });
    } catch (err) {
      console.error('Wall theme error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── GET wall posts for active theme ──
  app.get('/posts', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const theme = await getActiveTheme();

      // Auto-delete posts older than 24 hours before fetching
      const cutoff = new Date(Date.now() - ONE_DAY_MS).toISOString();
      await query('DELETE FROM wall WHERE created_at < $1', [cutoff]);

      const result = await query(
        `SELECT w.id, w.user_initiator, w.wall_photo, w.created_at,
                CONCAT(u.firstname, ' ', u.surname) AS user_full_name,
                u.user_name, u.profile_image
         FROM wall w
         JOIN users u ON u.id = w.user_initiator
         WHERE w.theme_id = $1
           AND w.created_at >= $2
         ORDER BY w.created_at DESC
         LIMIT 50`,
        [theme.id, cutoff]
      );

      return reply.send({ posts: result.rows, theme });
    } catch (err) {
      console.error('Wall posts error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST a wall photo ──
  app.post('/post', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const body = request.body;

      // Validate that wall_photo is a non-empty array of URLs
      const wallPhoto = body.wall_photo;
      if (!wallPhoto || !Array.isArray(wallPhoto) || wallPhoto.length === 0) {
        return reply.status(400).send({ error: 'wall_photo must be a non-empty array of image URLs' });
      }

      const theme = await getActiveTheme();

      const result = await query(
        `INSERT INTO wall (user_initiator, wall_photo, theme_id)
         VALUES ($1, $2, $3)
         RETURNING id, user_initiator, wall_photo, theme_id, created_at`,
        [userId, JSON.stringify(wallPhoto), theme.id]
      );

      return reply.status(201).send({ post: result.rows[0] });
    } catch (err) {
      console.error('Wall post error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── DELETE own wall post ──
  app.delete('/post/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id } = request.params;

      const post = await query('SELECT id, user_initiator FROM wall WHERE id = $1', [id]);

      if (post.rows.length === 0) {
        return reply.status(404).send({ error: 'Post not found' });
      }

      if (post.rows[0].user_initiator !== userId) {
        return reply.status(403).send({ error: 'Not authorized to delete this post' });
      }

      await query('DELETE FROM wall WHERE id = $1', [id]);

      return reply.send({ deleted: true });
    } catch (err) {
      console.error('Wall delete error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { wallRoutes };
