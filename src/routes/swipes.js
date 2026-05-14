const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');

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

      await query(
        `INSERT INTO viewed_users (viewer_id, viewed_id)
         VALUES ($1, $2)
         ON CONFLICT (viewer_id, viewed_id) DO NOTHING`,
        [userId, body.target_id]
      );

      if (body.direction === 'right') {
        await query(
          `INSERT INTO user_likes (liker_id, liked_id)
           VALUES ($1, $2)
           ON CONFLICT (liker_id, liked_id) DO NOTHING`,
          [userId, body.target_id]
        );

        const matchResult = await query(
          `SELECT id FROM user_likes
           WHERE liker_id = $1 AND liked_id = $2`,
          [body.target_id, userId]
        );

        const isMatch = matchResult.rows.length > 0;

        if (isMatch) {
          const convResult = await query(
            `INSERT INTO personal_conversations (user_initiator, user_receiver)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [userId, body.target_id]
          );

          return reply.send({
            liked: true,
            matched: true,
            conversation_id: convResult.rows[0] ? convResult.rows[0].id : null,
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
      return reply.status(500).send({ error: 'Internal server error' });
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
      return reply.status(500).send({ error: 'Internal server error' });
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
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/block/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id: blockedId } = request.params;

      await query(
        `INSERT INTO blocked_users (blocker_id, blocked_id)
         VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [userId, blockedId]
      );

      return reply.send({ blocked: true });
    } catch (err) {
      console.error('Block error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = { swipeRoutes };
