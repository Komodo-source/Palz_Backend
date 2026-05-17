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
  voice_fun_fact: z.string().nullable().optional(),
  search_radius: z.number().int().min(1).max(500).optional(),
  age_min_filter: z.number().int().min(13).max(100).optional(),
  age_max_filter: z.number().int().min(13).max(100).optional(),
  girls_filter: z.number().int().optional(),
  events_filter: z.number().int().optional(),
  id_type_searched: z.number().int().optional(),
  ready_to_go: z.boolean().optional(),
  privacy: z.string().optional(),
});


// ── KNN Matching Algorithm ──
//
// All features are normalized to 0..1 before weighting:
//   Personality (interest distance) : 50% — strongest signal
//   Common hobbies                  : 20%
//   Common sports                   : 20%
//   Geographic proximity            : 10%
//   Zodiac compatibility            :  5% — soft tie-breaker only
//
// Recommendations use a 70/30 split:
//   • 70 % highest-scoring (compatible) candidates
//   • 30 % exploratory picks from the mid-tier

const MAX_DISTANCE_KM = 15;
const MAX_INTEREST_DISTANCE = Math.sqrt(9 * 9 * 3); // max euclidean for 1-10 scales

/** Count shared items between two arrays, normalized to 0..1 */
function getCommonItems(arr1, arr2) {
  if (!Array.isArray(arr1) || !Array.isArray(arr2)) return 0;
  if (arr1.length === 0 || arr2.length === 0) return 0;
  const set2 = new Set(arr2);
  const commonCount = arr1.filter((item) => set2.has(item)).length;
  return commonCount / Math.max(arr1.length, arr2.length);
}

/** Euclidean distance of the 3 interest dimensions, normalized 0..1 (1 = identical) */
function calculateInterestDistance(central, excentrated) {
  const c = central || {};
  const e = excentrated || {};
  const se = (Number(c.social_energy) || 5) - (Number(e.social_energy) || 5);
  const ps = (Number(c.planning_style) || 5) - (Number(e.planning_style) || 5);
  const cd = (Number(c.conversation_depth) || 5) - (Number(e.conversation_depth) || 5);
  const raw = Math.sqrt(se * se + ps * ps + cd * cd);
  return 1 - raw / MAX_INTEREST_DISTANCE; // 1 = perfect match
}

/** Check zodiac-pair compatibility (returns true/false) */
function checkZodiacCompatibility(zodiacA, zodiacB) {
  if (!zodiacA || !zodiacB) return false;
  const compatiblePairs = [
    ['Bélier', 'Lion'], ['Bélier', 'Sagittaire'], ['Lion', 'Sagittaire'],
    ['Taureau', 'Vierge'], ['Taureau', 'Capricorne'], ['Vierge', 'Capricorne'],
    ['Gémeaux', 'Balance'], ['Gémeaux', 'Verseau'], ['Balance', 'Verseau'],
    ['Cancer', 'Scorpion'], ['Cancer', 'Poissons'], ['Scorpion', 'Poissons'],
    ['Bélier', 'Gémeaux'], ['Lion', 'Balance'],
    ['Vierge', 'Scorpion'], ['Taureau', 'Cancer'],
    ['Sagittaire', 'Verseau'], ['Capricorne', 'Poissons'],
  ];
  return compatiblePairs.some(
    ([a, b]) => (zodiacA === a && zodiacB === b) || (zodiacA === b && zodiacB === a)
  );
}

/**
 * Score a candidate against the current user.
 * Returns a number 0..1 where higher = better match.
 */
function scoreCandidate(user, candidate) {
  let userInterests = {};
  let candInterests = {};
  let userSports = [];
  let userHobbies = [];
  let candSports = [];
  let candHobbies = [];

  try { userInterests = typeof user.interests === 'string' ? JSON.parse(user.interests) : (user.interests || {}); } catch {}
  try { candInterests = typeof candidate.interests === 'string' ? JSON.parse(candidate.interests) : (candidate.interests || {}); } catch {}

  userSports = userInterests.sports || [];
  userHobbies = userInterests.hobbies || [];
  candSports = candInterests.sports || [];
  candHobbies = candInterests.hobbies || [];

  // 1. Personality compatibility (strongest signal — 50 %)
  const personalityScore = calculateInterestDistance(userInterests, candInterests);

  // 2. Shared hobbies (20 %)
  const hobbiesScore = getCommonItems(userHobbies, candHobbies);

  // 3. Shared sports (20 %)
  const sportsScore = getCommonItems(userSports, candSports);

  // 4. Geographic proximity (10 %)
  let distanceScore = 0;
  if (user.latitude && user.longitude && candidate.latitude && candidate.longitude) {
    const dist = haversineKm(
      parseFloat(user.latitude), parseFloat(user.longitude),
      parseFloat(candidate.latitude), parseFloat(candidate.longitude)
    );
    distanceScore = Math.max(0, 1 - dist / MAX_DISTANCE_KM);
  }

  // 5. Zodiac (5 % — tie-breaker only)
  const zodiacScore = checkZodiacCompatibility(user.astrology_title, candidate.astrology_title) ? 1 : 0;

  return (
    personalityScore * 0.50 +
    hobbiesScore * 0.20 +
    sportsScore * 0.20 +
    distanceScore * 0.10 +
    zodiacScore * 0.05
  );
}

/** Haversine distance in km */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.07103;
  const toRad = (deg) => deg * (Math.PI / 180);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

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

      // Fetch candidate pool (unviewed, unliked, not blocked)
      const candidatesResult = await query(
        `SELECT u.id, CONCAT(u.firstname, ' ', u.surname) AS full_name, u.user_name, u.date_of_birth, u.profile_image,
                u.bio, u.work, u.situation, u.location, u.interests,
                u.latitude, u.longitude,
                a.name AS astrology_title,
                u.is_premium, u.created_at
         FROM users u
         LEFT JOIN astrology_signs a ON a.id = u.astrology_sign_id
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
      return reply.status(500).send({ error: 'Internal server error', details: process.env.NODE_ENV !== 'production' || process.env.EXPOSE_ERROR_DETAILS === 'true' ? err.message : undefined });
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
      return reply.status(500).send({ error: 'Internal server error', details: process.env.NODE_ENV !== 'production' || process.env.EXPOSE_ERROR_DETAILS === 'true' ? err.message : undefined });
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
      return reply.status(500).send({ error: 'Internal server error', details: process.env.NODE_ENV !== 'production' || process.env.EXPOSE_ERROR_DETAILS === 'true' ? err.message : undefined });
    }
  });
}

module.exports = { userRoutes };
