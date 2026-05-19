const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');

const sendMessageSchema = z.object({
  conversation_id: z.string().uuid(),
  content: z.string().min(1).max(5000),
  message_type: z.string().default('text').optional(),
  reply_to_message: z.string().uuid().nullable().optional(),
});

const FREE_USER_MSG_LIMIT = 3;

async function messageRoutes(app) {

  // ── POST start or get a conversation with any user ──
  // Used by wall (tapping a poster) and any place a DM needs to be opened without a prior match.
  // Free users are limited to 3 outgoing messages in conversations where there is no mutual like.
  app.post('/start', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { other_user_id } = request.body || {};

      if (!other_user_id) {
        return reply.status(400).send({ error: 'other_user_id is required' });
      }
      if (other_user_id === userId) {
        return reply.status(400).send({ error: 'Cannot start a conversation with yourself' });
      }

      // Get or create conversation (either direction)
      const existing = await query(
        `SELECT id FROM personal_conversations
         WHERE (user_initiator = $1 AND user_receiver = $2)
            OR (user_initiator = $2 AND user_receiver = $1)`,
        [userId, other_user_id]
      );

      let conversationId;
      if (existing.rows.length > 0) {
        conversationId = existing.rows[0].id;
      } else {
        const created = await query(
          `INSERT INTO personal_conversations (user_initiator, user_receiver)
           VALUES ($1, $2) RETURNING id`,
          [userId, other_user_id]
        );
        conversationId = created.rows[0].id;
      }

      // Check free user message limit (only applies when users are not mutually matched)
      const userResult = await query('SELECT is_premium FROM users WHERE id = $1', [userId]);
      const isPremium = userResult.rows[0]?.is_premium === true;

      let messagesSent = null;
      let limitReached = false;

      if (!isPremium) {
        const isMatched = await query(
          `SELECT 1 FROM user_likes ul1
           JOIN user_likes ul2 ON ul2.liker_id = $2 AND ul2.liked_id = $1
           WHERE ul1.liker_id = $1 AND ul1.liked_id = $2`,
          [userId, other_user_id]
        );

        if (isMatched.rows.length === 0) {
          const countResult = await query(
            `SELECT COUNT(*)::int AS count FROM messages
             WHERE conversation_id = $1 AND sender_id = $2`,
            [conversationId, userId]
          );
          messagesSent = countResult.rows[0].count;
          limitReached = messagesSent >= FREE_USER_MSG_LIMIT;
        }
      }

      return reply.send({
        conversation_id: conversationId,
        is_premium: isPremium,
        messages_sent: messagesSent,
        limit_reached: limitReached,
        free_limit: FREE_USER_MSG_LIMIT,
      });
    } catch (err) {
      console.error('Start conversation error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/conversations', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      const result = await query(
        `SELECT
           pc.id,
           CASE
             WHEN pc.user_initiator = $1 THEN u2.id
             ELSE u1.id
           END AS other_user_id,
           CASE
             WHEN pc.user_initiator = $1 THEN u2.full_name
             ELSE u1.full_name
           END AS other_user_name,
           CASE
             WHEN pc.user_initiator = $1 THEN u2.user_name
             ELSE u1.user_name
           END AS other_user_username,
           CASE
             WHEN pc.user_initiator = $1 THEN u2.profile_image
             ELSE u1.profile_image
           END AS other_user_image,
           last_msg.content AS last_message,
           last_msg.created_at AS last_message_at,
           last_msg.sender_id AS last_message_sender_id,
           CASE WHEN last_msg.sender_id != $1 AND last_msg.is_seen = false
             THEN true ELSE false END AS has_unread
         FROM personal_conversations pc
         JOIN users u1 ON u1.id = pc.user_initiator
         JOIN users u2 ON u2.id = pc.user_receiver
         LEFT JOIN LATERAL (
           SELECT m.content, m.created_at, m.sender_id, m.is_seen
           FROM messages m
           WHERE m.conversation_id = pc.id
           ORDER BY m.created_at DESC
           LIMIT 1
         ) last_msg ON true
         WHERE pc.user_initiator = $1 OR pc.user_receiver = $1
         ORDER BY last_msg.created_at DESC NULLS LAST`,
        [userId]
      );

      return reply.send({ conversations: result.rows });
    } catch (err) {
      console.error('Conversations error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/:conversationId', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { conversationId } = request.params;

      const convCheck = await query(
        'SELECT id FROM personal_conversations WHERE id = $1 AND (user_initiator = $2 OR user_receiver = $2)',
        [conversationId, userId]
      );

      if (convCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not authorized for this conversation' });
      }

      await query(
        'UPDATE messages SET is_seen = true WHERE conversation_id = $1 AND sender_id != $2 AND is_seen = false',
        [conversationId, userId]
      );

      const result = await query(
        `SELECT m.id, m.sender_id, m.conversation_id, m.content, m.message_type,
                m.media_url, m.is_seen, m.reply_to_message, m.created_at,
                u.full_name AS sender_name, u.user_name AS sender_username,
                u.profile_image AS sender_image
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = $1
         ORDER BY m.created_at ASC
         LIMIT 50`,
        [conversationId]
      );

      return reply.send({ messages: result.rows });
    } catch (err) {
      console.error('Messages error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.post('/send', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const body = sendMessageSchema.parse(request.body);

      const convCheck = await query(
        'SELECT id, user_initiator, user_receiver FROM personal_conversations WHERE id = $1 AND (user_initiator = $2 OR user_receiver = $2)',
        [body.conversation_id, userId]
      );

      if (convCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not authorized for this conversation' });
      }

      // Free user message limit: max 3 messages in conversations with non-matched users
      const userResult = await query('SELECT is_premium FROM users WHERE id = $1', [userId]);
      const isPremium = userResult.rows[0]?.is_premium === true;

      if (!isPremium) {
        const conv = convCheck.rows[0];
        const otherId = conv.user_initiator === userId ? conv.user_receiver : conv.user_initiator;

        const isMatched = await query(
          `SELECT 1 FROM user_likes ul1
           JOIN user_likes ul2 ON ul2.liker_id = $2 AND ul2.liked_id = $1
           WHERE ul1.liker_id = $1 AND ul1.liked_id = $2`,
          [userId, otherId]
        );

        if (isMatched.rows.length === 0) {
          const countResult = await query(
            `SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id = $1 AND sender_id = $2`,
            [body.conversation_id, userId]
          );
          if (countResult.rows[0].count >= FREE_USER_MSG_LIMIT) {
            return reply.status(403).send({
              error: `Les utilisateurs gratuits peuvent envoyer ${FREE_USER_MSG_LIMIT} messages avant un match. Passe Premium pour envoyer plus.`,
              limit_reached: true,
            });
          }
        }
      }

      const result = await query(
        `INSERT INTO messages (sender_id, conversation_id, content, message_type, reply_to_message)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, sender_id, conversation_id, content, message_type,
                   media_url, is_seen, reply_to_message, created_at`,
        [
          userId,
          body.conversation_id,
          body.content,
          body.message_type || 'text',
          body.reply_to_message || null,
        ]
      );

      await query(
        'UPDATE personal_conversations SET updated_at = NOW() WHERE id = $1',
        [body.conversation_id]
      );

      return reply.status(201).send({ message: result.rows[0] });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('Send message error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { messageRoutes };
