const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');
const { scoreCandidate, haversineKm } = require('../matching');

const updateProfileSchema = z.object({
  astrology_sign_id: z.any().optional(),
  bio: z.string().optional(),
  work: z.string().optional(),
  situation: z.string().optional(),
  location: z.string().optional(),
  home_location: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  phone: z.string().optional(),
  date_of_birth: z.string().optional(),
  profile_image: z.any().optional(),
  interests: z.any().optional(),
  voice_fun_fact: z.string().nullable().optional(),
  search_radius: z.number().int().min(1).max(500).optional(),
  age_min_filter: z.number().int().min(13).max(100).optional(),
  age_max_filter: z.number().int().min(13).max(100).optional(),
  girls_filter: z.number().int().optional(),
  events_filter: z.number().int().optional(),
  id_type_searched: z.string().optional(),
  ready_to_go: z.boolean().optional(),
  privacy: z.string().optional(),
});


// ── KNN Matching Algorithm ──
// Shared matching functions imported from ../matching.js
//
// Recommendations use a 70/30 split:
//   • 70 % highest-scoring (compatible) candidates
//   • 30 % exploratory picks from the mid-tier

/** Compute how different two candidates are (inverse of their similarity) */
function candidateDifference(candA, candB) {
  return 1 - scoreCandidate(candA, candB);
}

/**
 * Build the final recommendation list with a 70/30 split.
 *   70 % — highest-scoring compatible candidates
 *   30 % — exploratory picks from the mid-tier (prevents echo-chamber)
 */
function buildRecommendations(scoredCandidates, limit) {
  const compatibleCount = Math.floor(limit * 0.7);
  const exploratoryCount = limit - compatibleCount;

  scoredCandidates.sort((a, b) => b.score - a.score);

  const compatible = scoredCandidates.slice(0, Math.min(compatibleCount, scoredCandidates.length));

  // Exploratory picks: skip the top tier, pick from the middle with randomness
  const midStart = compatible.length;
  const midEnd = Math.min(scoredCandidates.length, midStart + exploratoryCount * 3);
  let exploratory = [];

  if (midEnd > midStart) {
    const midPool = scoredCandidates.slice(midStart, midEnd);
    for (let i = midPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [midPool[i], midPool[j]] = [midPool[j], midPool[i]];
    }
    exploratory = midPool.slice(0, exploratoryCount);
  }

  // Fallback: if not enough exploratory candidates, pad from compatible pool
  const total = [...compatible, ...exploratory];
  while (total.length < limit && scoredCandidates.length > total.length) {
    total.push(scoredCandidates[total.length]);
  }

  return total.slice(0, limit);
}



async function userRoutes(app) {

  app.get('/discover', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Fetch current user profile (for scoring)
      const meResult = await query(
        `SELECT u.id, u.interests, u.astrology_sign_id, u.latitude, u.longitude,
                a.name AS astrology_title
         FROM users u
         LEFT JOIN astrology_signs a ON a.id = u.astrology_sign_id
         WHERE u.id = $1`,
        [userId]
      );
      const me = meResult.rows[0];

      // Fetch candidate pool (unviewed, unliked, not blocked)s.
      const candidatesResult = await query(
        `SELECT u.id, u.full_name, u.user_name, u.date_of_birth, u.profile_image,
                u.bio, u.work, u.situation, u.location, u.interests,
                u.latitude, u.longitude,
                a.name AS astrology_title,
                u.is_premium, u.created_at,
                jsonb_agg(DISTINCT s.title) FILTER (WHERE s.title IS NOT NULL) AS sports,
                jsonb_agg(DISTINCT h.title) FILTER (WHERE h.title IS NOT NULL) AS hobbies
              FROM users u
              LEFT JOIN astrology_signs a ON a.id = u.astrology_sign_id
              LEFT JOIN user_hobbies hb ON hb.user_id = u.id
              LEFT JOIN hobbies h ON hb.hobby_id = h.id

              LEFT JOIN user_sports us ON us.user_id = u.id
              LEFT JOIN sports s ON us.sport_id = s.id

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
              GROUP BY u.id, u.user_name, u.date_of_birth, u.profile_image,
                      u.bio, u.work, u.situation, u.location, u.interests,
                      u.latitude, u.longitude,
                      a.name,
                      u.is_premium, u.created_at
              LIMIT 50`,
        [userId]
      );

      const candidates = candidatesResult.rows;

      // Score every candidate against the current user
      const scored = candidates.map((c) => ({
        candidate: c,
        score: scoreCandidate(me, c),
      }));

      // Build recommendation list (70 % compatible + 30 % exploratory)
      const limit = Math.min(20, scored.length);
      const recommendations = buildRecommendations(scored, limit);

      return reply.send({
        users: recommendations.map((r) => r.candidate),
      });
    } catch (err) {
      console.error('Discover error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params;

      const result = await query(
        `SELECT u.id, u.full_name, u.user_name, u.date_of_birth, u.profile_image, u.bio,
                u.work, u.situation, u.location, u.home_location, u.astrology_sign_id,
                a.name AS astrology_title,
                u.interests, u.is_premium, u.is_verified, u.created_at
         FROM users u
         LEFT JOIN astrology_signs a ON a.id = u.astrology_sign_id
         WHERE u.id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      return reply.send({ user: result.rows[0] });
    } catch (err) {
      console.error('Get user error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
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
         RETURNING id, full_name, user_name, email, date_of_birth, phone, profile_image,
                   bio, work, situation, astrology_sign_id, interests, voice_fun_fact, is_verified,
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
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { userRoutes };
