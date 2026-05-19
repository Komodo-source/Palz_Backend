const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');
const { supabase } = require('../supabase');

const FREE_USER_MESSAGE_LIMIT = 3;

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
                u.full_name AS user_full_name,
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

      const post = await query('SELECT id, user_initiator, wall_photo FROM wall WHERE id = $1', [id]);

      if (post.rows.length === 0) {
        return reply.status(404).send({ error: 'Post not found' });
      }

      if (post.rows[0].user_initiator !== userId) {
        return reply.status(403).send({ error: 'Not authorized to delete this post' });
      }

      // Delete from DB first
      await query('DELETE FROM wall WHERE id = $1', [id]);

      // Clean up Supabase Storage files (fire-and-forget — don't block the response)
      try {
        const photos = Array.isArray(post.rows[0].wall_photo) ? post.rows[0].wall_photo : JSON.parse(post.rows[0].wall_photo || '[]');
        const filenames = photos
          .map((url) => {
            const match = String(url).match(/user_photos\/(.+)$/);
            return match ? match[1] : null;
          })
          .filter(Boolean);

        if (filenames.length > 0) {
          await supabase.storage.from('user_photos').remove(filenames);
        }
      } catch (storageErr) {
        console.error('Wall storage cleanup error (non-fatal):', storageErr);
      }

      return reply.send({ deleted: true });
    } catch (err) {
      console.error('Wall delete error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── GET messages on a wall post ──
  app.get('/post/:postId/messages', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { postId } = request.params;

      const result = await query(
        `SELECT wm.id, wm.sender_id, wm.content, wm.created_at,
                u.full_name AS sender_name, u.user_name AS sender_username,
                u.profile_image AS sender_image
         FROM wall_messages wm
         JOIN users u ON u.id = wm.sender_id
         WHERE wm.wall_post_id = $1
         ORDER BY wm.created_at ASC`,
        [postId]
      );

      return reply.send({ messages: result.rows });
    } catch (err) {
      console.error('Wall post messages error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST message on a wall post ──
  // Free users: max 3 messages per post. Premium users: unlimited.
  app.post('/post/:postId/message', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { postId } = request.params;
      const { content } = request.body || {};

      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return reply.status(400).send({ error: 'content is required' });
      }
      if (content.length > 500) {
        return reply.status(400).send({ error: 'Message too long (max 500 chars)' });
      }

      // Verify the post exists
      const postCheck = await query('SELECT id, user_initiator FROM wall WHERE id = $1', [postId]);
      if (postCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'Post not found' });
      }

      // Check premium status
      const userResult = await query('SELECT is_premium FROM users WHERE id = $1', [userId]);
      const isPremium = userResult.rows[0]?.is_premium === true;

      if (!isPremium) {
        const countResult = await query(
          'SELECT COUNT(*)::int AS count FROM wall_messages WHERE wall_post_id = $1 AND sender_id = $2',
          [postId, userId]
        );
        if (countResult.rows[0].count >= FREE_USER_MESSAGE_LIMIT) {
          return reply.status(403).send({
            error: `Free users can only send ${FREE_USER_MESSAGE_LIMIT} messages per wall post. Upgrade to premium for unlimited messages.`,
            limit_reached: true,
          });
        }
      }

      const result = await query(
        `INSERT INTO wall_messages (wall_post_id, sender_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, wall_post_id, sender_id, content, created_at`,
        [postId, userId, content.trim()]
      );

      return reply.status(201).send({ message: result.rows[0] });
    } catch (err) {
      console.error('Wall post message error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { wallRoutes };
