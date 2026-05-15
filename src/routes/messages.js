const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');

const sendMessageSchema = z.object({
  conversation_id: z.string().uuid(),
  content: z.string().min(1).max(5000),
  message_type: z.string().default('text').optional(),
  reply_to_message: z.string().uuid().nullable().optional(),
});

async function messageRoutes(app) {
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
             WHEN pc.user_initiator = $1 THEN CONCAT(u2.first_name, ' ', u2.surname)
             ELSE CONCAT(u1.first_name, ' ', u1.surname)
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
      return reply.status(500).send({ error: 'Internal server error' });
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
                CONCAT(u.first_name, ' ', u.surname) AS sender_name, u.user_name AS sender_username,
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
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/send', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const body = sendMessageSchema.parse(request.body);

      const convCheck = await query(
        'SELECT id FROM personal_conversations WHERE id = $1 AND (user_initiator = $2 OR user_receiver = $2)',
        [body.conversation_id, userId]
      );

      if (convCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not authorized for this conversation' });
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
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = { messageRoutes };
