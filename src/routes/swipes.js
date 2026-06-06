const { z } = require('zod');
const { query, withTransaction } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');

const swipeSchema = z.object({
  target_id: z.string().uuid(),
  direction: z.enum(['left', 'right']),
});

const uuidSchema = z.string().uuid();

async function swipeRoutes(app) {
  // ── Rate limiting renforcé sur les swipes ──
  const swipeRateLimit = {
    config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
  };

  app.post('/', { preHandler: [app.authenticate], ...swipeRateLimit }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const body = swipeSchema.parse(request.body);

      if (body.target_id === userId) {
        return reply.status(400).send({ error: 'Cannot swipe on yourself' });
      }

      // Vérifier que l\'utilisateur cible existe
      const targetExists = await query('SELECT 1 FROM users WHERE id = $1', [body.target_id]);
      if (targetExists.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      // Enregistrer la vue
      await query(
        `INSERT INTO viewed_users (viewer_id, viewed_id)
         VALUES ($1, $2) ON CONFLICT (viewer_id, viewed_id) DO NOTHING`,
        [userId, body.target_id]
      );

      if (body.direction !== 'right') {
        return reply.send({ liked: false, matched: false });
      }

      // Like + vérification de match dans une transaction atomique
      const result = await withTransaction(async (client) => {
        // Enregistrer le like
        await client.query(
          `INSERT INTO user_likes (liker_id, liked_id)
           VALUES ($1, $2) ON CONFLICT (liker_id, liked_id) DO NOTHING`,
          [userId, body.target_id]
        );

        // Vérifier le match mutuel
        const matchCheck = await client.query(
          `SELECT id FROM user_likes WHERE liker_id = $1 AND liked_id = $2`,
          [body.target_id, userId]
        );

        if (matchCheck.rows.length === 0) {
          return { liked: true, matched: false, conversation_id: null };
        }

        // Créer la conversation de manière idempotente
        const convResult = await client.query(
          `INSERT INTO personal_conversations (user_initiator, user_receiver)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [userId, body.target_id]
        );

        let conversationId = convResult.rows[0]?.id ?? null;

        if (!conversationId) {
          const existing = await client.query(
            `SELECT id FROM personal_conversations
             WHERE (user_initiator = $1 AND user_receiver = $2)
                OR (user_initiator = $2 AND user_receiver = $1)`,
            [userId, body.target_id]
          );
          conversationId = existing.rows[0]?.id ?? null;
        }

        return { liked: true, matched: true, conversation_id: conversationId };
      });

      return reply.send(result);
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
      const limit = Math.min(parseInt(request.query.limit, 10) || 50, 200);
      const offset = Math.max(parseInt(request.query.offset, 10) || 0, 0);

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
         ORDER BY ul.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return reply.send({ matches: result.rows, has_more: result.rows.length === limit });
    } catch (err) {
      console.error('Matches error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/likes', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const limit = Math.min(parseInt(request.query.limit, 10) || 50, 200);
      const offset = Math.max(parseInt(request.query.offset, 10) || 0, 0);

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
         ORDER BY ul.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return reply.send({ likes: result.rows, has_more: result.rows.length === limit });
    } catch (err) {
      console.error('Likes error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── Block — avec validation UUID de la cible ──
  app.post('/block/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const parseResult = uuidSchema.safeParse(request.params.id);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid user id' });
      }
      const blockedId = parseResult.data;

      if (blockedId === userId) {
        return reply.status(400).send({ error: 'Cannot block yourself' });
      }

      await query(
        `DELETE FROM user_likes
         WHERE (liker_id = $1 AND liked_id = $2) OR (liker_id = $2 AND liked_id = $1)`,
        [userId, blockedId]
      );

      await query(
        `INSERT INTO blocked_users (blocker_id, blocked_id)
         VALUES ($1, $2) ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
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
