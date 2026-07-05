const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');
const { checkTextContent } = require('../content_filtering');

const FREE_USER_MESSAGE_LIMIT = 3;

// Only allow media hosted on our own Supabase instance — same rule as chat
// messages (routes/messages.js). Prevents arbitrary external URLs (tracking
// pixels, shock images, phishing) from being injected into the shared feed.
const ALLOWED_MEDIA_DOMAIN = process.env.SUPABASE_URL || null;

function isOwnStorageUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (!ALLOWED_MEDIA_DOMAIN) return true; // dev without Supabase configured
  return url.startsWith(ALLOWED_MEDIA_DOMAIN);
}

const WALL_THEMES = [
'Ton endroit préféré 📍',
'Ta passion cachée 🎨',
'Ton coin lecture 📚',
'POV : ton bureau de survie',
'Ta vue là, tout de suite',
'Le dernier truc que tu as acheté',
'Ta boisson du moment',
'Ton setup pour chiller',
'Lunch box ou resto',
'Ton péché mignon à moins de 5€.',
'Le meilleur spot de street-food du quartier.',
'Le contenu de ton frigo à J-1 des courses.',
'Ta cover Spotify du moment.',
'Le livre que tu as sur ta table de nuit depuis 2 mois.',
'Une capture d\'écran du dernier même qui t\'a fait rire.',
'Un bout de ton quartier qui ressemble à un film.',
'L\'endroit où tu te vides la tête.',
'Le trajet que tu fais tous les jours.',
'Un indice sur ce que tu vas faire ce soir.',
'Ton écran d\'accueil (wall paper).',
'Le dernier message marrant que tu as reçu',
'Un objet que tu possèdes que tout le monde trouve bizarre.',
'Ton outfit du jour',
'Ta plante verte : vivante ou en train de mourir ?',
'Tes chaussettes du jour.',
'Ton workspace',
'Poste ton animal de compagnie 🐾'
];

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;


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

  app.get('/posts', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const theme = await getActiveTheme();

      const cutoff = new Date(Date.now() - THREE_DAYS_MS).toISOString();

      // NOTE: expired-post deletion + storage cleanup moved to the hourly
      // scheduler job (see scheduler.js runWallCleanup). The read path only
      // filters — no destructive work, no race between concurrent readers.

      let result;
      try {
        result = await query(
          `SELECT w.id, w.user_initiator, w.wall_photo, w.created_at,
                  u.full_name AS user_full_name,
                  u.user_name, u.profile_image,
                  COUNT(DISTINCT wr.user_id)::int AS reaction_count,
                  COALESCE(BOOL_OR(wr.user_id = $3), false) AS has_reacted
           FROM wall w
           JOIN users u ON u.id = w.user_initiator
           LEFT JOIN wall_reactions wr ON wr.post_id = w.id
           WHERE w.theme_id = $1
             AND w.created_at >= $2
             AND w.deleted_at IS NULL
           GROUP BY w.id, u.full_name, u.user_name, u.profile_image
           ORDER BY w.created_at DESC
           LIMIT 50`,
          [theme.id, cutoff, userId]
        );
      } catch (_reactErr) {
        // wall_reactions table not yet migrated — fall back without reactions
        result = await query(
          `SELECT w.id, w.user_initiator, w.wall_photo, w.created_at,
                  u.full_name AS user_full_name,
                  u.user_name, u.profile_image,
                  0 AS reaction_count, false AS has_reacted
           FROM wall w
           JOIN users u ON u.id = w.user_initiator
           WHERE w.theme_id = $1
             AND w.created_at >= $2
             AND w.deleted_at IS NULL
           ORDER BY w.created_at DESC
           LIMIT 50`,
          [theme.id, cutoff]
        );
      }

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
      if (wallPhoto.length > 5) {
        return reply.status(400).send({ error: 'wall_photo: maximum 5 photos per post' });
      }
      if (!wallPhoto.every(isOwnStorageUrl)) {
        return reply.status(400).send({ error: 'wall_photo must point to app storage only' });
      }
      const theme = await getActiveTheme();

      const result = await query(
        `INSERT INTO wall (user_initiator, wall_photo, theme_id)
         VALUES ($1, $2, $3)
         RETURNING id, user_initiator, wall_photo, theme_id, created_at`,
        [userId, JSON.stringify(wallPhoto), theme.id]
      );

      const update_nb_photos = await query(
        `UPDATE users SET number_photo_posted = number_photo_posted + 1 WHERE id=$1`,
        [userId]
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

      // Soft-delete: mark deleted_at so the post disappears from feeds immediately
      // but the row (and its storage files) are kept for 24 hours before permanent deletion.
      await query('UPDATE wall SET deleted_at = NOW() WHERE id = $1', [id]);

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

      const limit = Math.min(parseInt(request.query.limit, 10) || 100, 200);
      const offset = Math.max(parseInt(request.query.offset, 10) || 0, 0);

      const result = await query(
        `SELECT wm.id, wm.sender_id, wm.content, wm.created_at,
                u.full_name AS sender_name, u.user_name AS sender_username,
                u.profile_image AS sender_image
         FROM wall_messages wm
         JOIN users u ON u.id = wm.sender_id
         WHERE wm.wall_post_id = $1
         ORDER BY wm.created_at ASC
         LIMIT $2 OFFSET $3`,
        [postId, limit, offset]
      );

      return reply.send({ messages: result.rows, has_more: result.rows.length === limit });
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
      if (checkTextContent(content)) {
        return reply.status(400).send({ error: 'Ce message contient du contenu interdit.', flagged: true });
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
  // ── GET wall posts by a specific user (for profile page) ──
  app.get('/user/:userId/posts', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { userId: targetUserId } = request.params;
      const result = await query(
        `SELECT w.id, w.wall_photo, w.created_at, wt.title AS theme_title
         FROM wall w
         LEFT JOIN wall_themes wt ON wt.id = w.theme_id
         WHERE w.user_initiator = $1
         ORDER BY w.created_at DESC
         LIMIT 9`,
        [targetUserId]
      );
      return reply.send({ posts: result.rows });
    } catch (err) {
      console.error('Wall user posts error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST toggle flower reaction on a wall post ──
  app.post('/post/:id/react', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id } = request.params;

      const post = await query('SELECT id FROM wall WHERE id = $1', [id]);
      if (!post.rows.length) return reply.status(404).send({ error: 'Post not found' });

      try {
        const existing = await query(
          'SELECT 1 FROM wall_reactions WHERE post_id = $1 AND user_id = $2',
          [id, userId]
        );

        if (existing.rows.length) {
          await query('DELETE FROM wall_reactions WHERE post_id = $1 AND user_id = $2', [id, userId]);
          return reply.send({ reacted: false });
        }

        await query('INSERT INTO wall_reactions (post_id, user_id) VALUES ($1, $2)', [id, userId]);
        return reply.send({ reacted: true });
      } catch (_reactErr) {
        // wall_reactions table not yet migrated
        return reply.status(503).send({ error: 'Reactions not available yet — run the wall_reactions migration.' });
      }
    } catch (err) {
      console.error('Wall react error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { wallRoutes };
