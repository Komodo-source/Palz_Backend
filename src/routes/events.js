const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');

const VALID_CATEGORIES = ['bar', 'bowling', 'cinema', 'restaurant', 'sport', 'cafe', 'plage', 'parc', 'autre'];

const createEventSchema = z.object({
  title: z.string().min(3).max(100),
  description: z.string().max(500).optional().nullable(),
  category: z.enum(VALID_CATEGORIES),
  location_name: z.string().min(2).max(255),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  max_members: z.number().int().min(2).max(20).default(10),
  starts_at: z.string().datetime(),
});

// An event is "active" while starts_at + 72h > NOW()
const ACTIVE_FILTER = `e.starts_at + INTERVAL '72 hours' > NOW()`;

async function eventRoutes(app) {

  // GET /events — list all active events with member count and join status
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { filter, category } = request.query; 

      const params = [userId];
      let extraWhere = '';

      if (filter === 'tonight') {
        extraWhere += ` AND e.starts_at >= date_trunc('day', now() AT TIME ZONE 'UTC') + INTERVAL '18 hours' AND e.starts_at <  date_trunc('day', now() AT TIME ZONE 'UTC') + INTERVAL '1 day'`;
      } else if (filter === 'joined') {
        extraWhere += ` AND EXISTS (SELECT 1 FROM event_members em2 WHERE em2.event_id = e.id AND em2.user_id = $1)`;
      }

      if (category && VALID_CATEGORIES.includes(category)) {
        params.push(category);
        extraWhere += ` AND e.category = $${params.length}`;
      }

      const result = await query(
        `SELECT
           e.id, e.title, e.description, e.category,
           e.location_name, e.latitude, e.longitude,
           e.max_members, e.starts_at, e.created_at,
           e.creator_id,
           u.full_name AS creator_name,
           u.profile_image AS creator_image,
           COUNT(DISTINCT em.user_id)::int AS member_count,
           COALESCE(BOOL_OR(em.user_id = $1), false) AS is_joined
         FROM events e
         JOIN users u ON u.id = e.creator_id
         LEFT JOIN event_members em ON em.event_id = e.id
         WHERE ${ACTIVE_FILTER} ${extraWhere}
         GROUP BY e.id, u.full_name, u.profile_image
         ORDER BY e.starts_at ASC`,
        params
      );

      return reply.send({ events: result.rows });
    } catch (err) {
      console.error('List events error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // POST /events — create a new event (creator auto-joins)
  app.post('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const body = createEventSchema.parse(request.body);

      const startsAt = new Date(body.starts_at);
      const now = new Date();
      const maxFuture = new Date(now.getTime() + 72 * 60 * 60 * 1000);

      if (startsAt <= now) {
        return reply.status(400).send({ error: "L'événement doit démarrer dans le futur." });
      }
      if (startsAt > maxFuture) {
        return reply.status(400).send({ error: "L'événement doit démarrer dans les 72 prochaines heures." });
      }

      const result = await query(
        `INSERT INTO events (creator_id, title, description, category, location_name, latitude, longitude, max_members, starts_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          userId,
          body.title,
          body.description || null,
          body.category,
          body.location_name,
          body.latitude ?? null,
          body.longitude ?? null,
          body.max_members,
          body.starts_at,
        ]
      );

      const event = result.rows[0];

      // Auto-join the creator
      await query(
        'INSERT INTO event_members (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [event.id, userId]
      );

      // Send a welcome message in the event chat
      await query(
        `INSERT INTO event_messages (event_id, sender_id, content) VALUES ($1, $2, $3)`,
        [event.id, userId, `🎉 L'événement "${event.title}" a été créé ! Rejoignez-nous.`]
      );

      return reply.status(201).send({ event });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('Create event error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // GET /events/:id — event details + members list
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id } = request.params;

      const eventRes = await query(
        `SELECT
           e.id, e.title, e.description, e.category,
           e.location_name, e.latitude, e.longitude,
           e.max_members, e.starts_at, e.created_at,
           e.creator_id,
           u.full_name AS creator_name,
           u.profile_image AS creator_image,
           COUNT(DISTINCT em.user_id)::int AS member_count,
           BOOL_OR(em.user_id = $2) AS is_joined
         FROM events e
         JOIN users u ON u.id = e.creator_id
         LEFT JOIN event_members em ON em.event_id = e.id
         WHERE e.id = $1
         GROUP BY e.id, u.full_name, u.profile_image`,
        [id, userId]
      );

      if (!eventRes.rows.length) {
        return reply.status(404).send({ error: 'Event not found' });
      }

      const membersRes = await query(
        `SELECT u.id, u.full_name, u.user_name, u.profile_image, em.joined_at
         FROM event_members em
         JOIN users u ON u.id = em.user_id
         WHERE em.event_id = $1
         ORDER BY em.joined_at ASC`,
        [id]
      );

      return reply.send({ event: eventRes.rows[0], members: membersRes.rows });
    } catch (err) {
      console.error('Get event error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // POST /events/:id/join — join an event
  app.post('/:id/join', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id } = request.params;

      const eventRes = await query(
        `SELECT e.id, e.max_members, e.title FROM events e WHERE e.id = $1 AND ${ACTIVE_FILTER}`,
        [id]
      );

      if (!eventRes.rows.length) {
        return reply.status(404).send({ error: 'Événement introuvable ou expiré.' });
      }

      const event = eventRes.rows[0];

      const countRes = await query(
        'SELECT COUNT(*)::int AS count FROM event_members WHERE event_id = $1',
        [id]
      );

      if (countRes.rows[0].count >= event.max_members) {
        return reply.status(400).send({ error: "L'événement est complet." });
      }

      await query(
        'INSERT INTO event_members (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, userId]
      );

      // Announce new member in chat
      const userRes = await query('SELECT full_name FROM users WHERE id = $1', [userId]);
      const name = userRes.rows[0]?.full_name || 'Quelqu\'un';
      await query(
        'INSERT INTO event_messages (event_id, sender_id, content) VALUES ($1, $2, $3)',
        [id, userId, `👋 ${name} vient de rejoindre l'événement !`]
      );

      return reply.send({ joined: true });
    } catch (err) {
      console.error('Join event error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // POST /events/:id/leave — leave an event
  app.post('/:id/leave', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id } = request.params;

      // Creator cannot leave their own event
      const creatorCheck = await query('SELECT 1 FROM events WHERE id = $1 AND creator_id = $2', [id, userId]);
      if (creatorCheck.rows.length > 0) {
        return reply.status(400).send({ error: "Le créateur ne peut pas quitter son propre événement." });
      }

      await query('DELETE FROM event_members WHERE event_id = $1 AND user_id = $2', [id, userId]);

      return reply.send({ left: true });
    } catch (err) {
      console.error('Leave event error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // GET /events/:id/messages — event group chat
  app.get('/:id/messages', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id } = request.params;

      const memberCheck = await query(
        'SELECT 1 FROM event_members WHERE event_id = $1 AND user_id = $2',
        [id, userId]
      );
      if (!memberCheck.rows.length) {
        return reply.status(403).send({ error: 'Rejoins l\'événement pour voir le chat.' });
      }

      const result = await query(
        `SELECT em.id, em.event_id, em.sender_id, em.content, em.created_at,
                u.full_name AS sender_name, u.user_name AS sender_username,
                u.profile_image AS sender_image
         FROM event_messages em
         JOIN users u ON u.id = em.sender_id
         WHERE em.event_id = $1
         ORDER BY em.created_at ASC
         LIMIT 100`,
        [id]
      );

      return reply.send({ messages: result.rows });
    } catch (err) {
      console.error('Event messages error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // POST /events/:id/messages — send a message in event chat
  app.post('/:id/messages', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id } = request.params;
      const { content } = request.body || {};

      if (!content || !String(content).trim()) {
        return reply.status(400).send({ error: 'content is required' });
      }

      const memberCheck = await query(
        'SELECT 1 FROM event_members WHERE event_id = $1 AND user_id = $2',
        [id, userId]
      );
      if (!memberCheck.rows.length) {
        return reply.status(403).send({ error: 'Rejoins l\'événement pour envoyer un message.' });
      }

      const result = await query(
        `INSERT INTO event_messages (event_id, sender_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, event_id, sender_id, content, created_at`,
        [id, userId, String(content).trim()]
      );

      return reply.status(201).send({ message: result.rows[0] });
    } catch (err) {
      console.error('Send event message error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { eventRoutes };
