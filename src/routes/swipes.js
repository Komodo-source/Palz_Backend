const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');

const swipeSchema = z.object({
  target_id: z.string().uuid(),
  direction: z.enum(['left', 'right']),
});

async function swipeRoutes(app) {
  app.post('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const body = swipeSchema.parse(request.body);

      if (body.target_id === userId) {
        return reply.status(400).send({ error: 'Cannot swipe on yourself' });
      }

      // Record the view
      await query(
        `INSERT INTO viewed_users (viewer_id, viewed_id)
         VALUES ($1, $2)
         ON CONFLICT (viewer_id, viewed_id) DO NOTHING`,
        [userId, body.target_id]
      );

      if (body.direction === 'right') {
        // Record the like
        await query(
          `INSERT INTO user_likes (liker_id, liked_id)
           VALUES ($1, $2)
           ON CONFLICT (liker_id, liked_id) DO NOTHING`,
          [userId, body.target_id]
        );

        // Check if it's a match (mutual like)
        const matchResult = await query(
          `SELECT id FROM user_likes
           WHERE liker_id = $1 AND liked_id = $2`,
          [body.target_id, userId]
        );

        const isMatch = matchResult.rows.length > 0;

        if (isMatch) {
          // Check if conversation already exists (either direction)
          const existingConv = await query(
            `SELECT id FROM personal_conversations
             WHERE (user_initiator = $1 AND user_receiver = $2)
                OR (user_initiator = $2 AND user_receiver = $1)`,
            [userId, body.target_id]
          );

          let conversationId = null;
          if (existingConv.rows.length > 0) {
            conversationId = existingConv.rows[0].id;
          } else {
            const convResult = await query(
              `INSERT INTO personal_conversations (user_initiator, user_receiver)
               VALUES ($1, $2)
               RETURNING id`,
              [userId, body.target_id]
            );
            conversationId = convResult.rows[0] ? convResult.rows[0].id : null;
          }

          return reply.send({
            liked: true,
            matched: true,
            conversation_id: conversationId,
          });
        }

        return reply.send({ liked: true, matched: false });
      }

      return reply.send({ liked: false, matched: false });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('Swipe error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/matches', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      const result = await query(
        `SELECT
           u.id, u.full_name, u.user_name, u.profile_image, u.bio,
           pc.id AS conversation_id, ul.created_at AS matched_at
         FROM user_likes ul
         JOIN users u ON u.id = ul.liker_id
         JOIN personal_conversations pc
           ON (pc.user_initiator = $1 AND pc.user_receiver = ul.liker_id)
              OR (pc.user_receiver = $1 AND pc.user_initiator = ul.liker_id)
         WHERE ul.liked_id = $1
           AND EXISTS (
             SELECT 1 FROM user_likes ul2
             WHERE ul2.liker_id = $1 AND ul2.liked_id = ul.liker_id
           )
         ORDER BY ul.created_at DESC`,
        [userId]
      );

      return reply.send({ matches: result.rows });
    } catch (err) {
      console.error('Matches error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/likes', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      const result = await query(
        `SELECT u.id, u.full_name, u.user_name, u.profile_image, u.bio,
                ul.created_at AS liked_at
         FROM user_likes ul
         JOIN users u ON u.id = ul.liker_id
         WHERE ul.liked_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM user_likes ul2
             WHERE ul2.liker_id = $1 AND ul2.liked_id = ul.liker_id
           )
         ORDER BY ul.created_at DESC`,
        [userId]
      );

      return reply.send({ likes: result.rows });
    } catch (err) {
      console.error('Likes error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // Block a user (also removes any likes between them)
  app.post('/block/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id: blockedId } = request.params;

      // Remove any likes between these users (both directions)
      await query(
        `DELETE FROM user_likes WHERE (liker_id = $1 AND liked_id = $2) OR (liker_id = $2 AND liked_id = $1)`,
        [userId, blockedId]
      );

      // Insert block
      await query(
        `INSERT INTO blocked_users (blocker_id, blocked_id)
         VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [userId, blockedId]
      );

      return reply.send({ blocked: true });
    } catch (err) {
      console.error('Block error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { swipeRoutes };
