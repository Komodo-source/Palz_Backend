const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');

const updateProfileSchema = z.object({
  nick_name: z.string().max(255).optional(),
  bio: z.string().optional(),
  work: z.string().optional(),
  situation: z.string().optional(),
  location: z.string().optional(),
  home_location: z.string().optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  phone: z.string().optional(),
  date_of_birth: z.string().optional(),
  profile_image: z.any().optional(),
  interests: z.any().optional(),
  search_radius: z.number().int().min(1).max(500).optional(),
  age_min_filter: z.number().int().min(13).max(100).optional(),
  age_max_filter: z.number().int().min(13).max(100).optional(),
  girls_filter: z.number().int().optional(),
  events_filter: z.number().int().optional(),
  ready_to_go: z.boolean().optional(),
  privacy: z.string().optional(),
});

async function userRoutes(app) {
  app.get('/discover', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      const result = await query(
        `SELECT u.id, CONCAT(u.firstname, ' ', u.surname) AS full_name, u.user_name, u.date_of_birth, u.profile_image,
                u.bio, u.work, u.situation, u.location, u.interests, u.astrology_sign_id,
                u.is_premium, u.created_at
         FROM users u
         WHERE u.id != $1
           AND u.id NOT IN (
             SELECT liked_id FROM user_likes WHERE liker_id = $1
           )
           AND u.id NOT IN (
             SELECT viewed_id FROM viewed_users WHERE viewer_id = $1
           )
           AND u.id NOT IN (
             SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
           )
           AND u.id NOT IN (
             SELECT blocker_id FROM blocked_users WHERE blocked_id = $1
           )
         ORDER BY RANDOM()
         LIMIT 20`,
        [userId]
      );

      return reply.send({ users: result.rows });
    } catch (err) {
      console.error('Discover error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params;

      const result = await query(
        `SELECT id, CONCAT(firstname, ' ', surname) AS full_name, user_name, date_of_birth, profile_image, bio,
                work, situation, location, home_location, astrology_sign_id,
                interests, is_premium, is_verified, created_at
         FROM users WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      return reply.send({ user: result.rows[0] });
    } catch (err) {
      console.error('Get user error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.put('/profile', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const body = updateProfileSchema.parse(request.body);

      const fields = [];
      const values = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) {
          const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
          fields.push(`${snakeKey} = $${paramIndex}`);
          values.push(
            key === 'profile_image' || key === 'interests'
              ? JSON.stringify(value)
              : value
          );
          paramIndex++;
        }
      }

      if (fields.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' });
      }

      values.push(userId);

      const result = await query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex}
         RETURNING id, CONCAT(firstname, ' ', surname) AS full_name, user_name, email, date_of_birth, phone, profile_image,
                   bio, work, situation, astrology_sign_id, interests, is_verified,
                   is_premium, location, home_location, latitude, longitude,
                   search_radius, age_min_filter, age_max_filter, ready_to_go, updated_at`,
        values
      );

      return reply.send({ user: result.rows[0] });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('Update profile error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = { userRoutes };
