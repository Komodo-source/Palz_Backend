const { z } = require('zod');
const { query, withTransaction } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');
const { scoreCandidate, haversineKm, parseInterests, get_weather } = require('../matching');
const {ACTIVITY_BASED_LABELS} = require("../activities");
const { sendPush, getTokensForUsers } = require('../services/push');

const createGroupMessageSchema = z.object({
  weekly_group_id: z.string().uuid(),
  content: z.string().max(5000).optional().default(''),
  message_type: z.string().default('text').optional(),
  media_url: z.string().optional(),
});

const GROUP_SIZE = 5;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_TRIGGER_HOURS = 4;

const SPORT_ACTIVITIES = {
  yoga:        { title: 'Cours de yoga ensemble',    icon: 'body-outline',          color: '#10B981', humidity: [0, 80],  temperature: [15, 35] },
  running:     { title: 'Footing en groupe',         icon: 'walk-outline',          color: '#EF4444', humidity: [0, 70],  temperature: [-5, 25] },
  natation:    { title: 'Session piscine',           icon: 'water-outline',         color: '#3B82F6', humidity: [0, 100], temperature: [20, 40] },
  tennis:      { title: 'Match de tennis',           icon: 'tennisball-outline',    color: '#F59E0B', humidity: [0, 70],  temperature: [10, 30] },
  danse:       { title: 'Cours de danse',            icon: 'musical-notes-outline', color: '#8B5CF6', humidity: [0, 80],  temperature: [15, 30] },
  randonnée:   { title: 'Randonnée ensemble',        icon: 'leaf-outline',          color: '#22C55E', humidity: [0, 70],  temperature: [5, 25]  },
  pilates:     { title: 'Pilates en groupe',         icon: 'body-outline',          color: '#10B981', humidity: [0, 80],  temperature: [15, 30] },
  vélo:        { title: 'Balade à vélo',             icon: 'bicycle-outline',       color: '#F97316', humidity: [0, 70],  temperature: [10, 30] },
  escalade:    { title: 'Escalade en salle',         icon: 'trending-up-outline',   color: '#92400E', humidity: [0, 80],  temperature: [15, 30] },
  volleyball:  { title: 'Match de volley',           icon: 'football-outline',      color: '#F59E0B', humidity: [0, 70],  temperature: [15, 35] },
  basketball:  { title: 'Match de basket',           icon: 'basketball-outline',    color: '#EF4444', humidity: [0, 80],  temperature: [10, 35] },
  padel:       { title: 'Partie de padel',           icon: 'tennisball-outline',    color: '#10B981', humidity: [0, 70],  temperature: [10, 35] },
};

const HOBBY_ACTIVITIES = {
  cuisine:      { title: 'Atelier cuisine maison',   icon: 'restaurant-outline',    color: '#10B981', humidity: [0, 80],  temperature: [10, 35] },
  cinéma:       { title: 'Soirée ciné',              icon: 'film-outline',          color: '#F59E0B', humidity: [0, 100], temperature: [-10, 40] },
  musique:      { title: 'Concert ou live music',    icon: 'musical-notes-outline', color: '#8B5CF6', humidity: [0, 80],  temperature: [10, 35] },
  art:          { title: 'Atelier créatif',          icon: 'color-palette-outline', color: '#EC4899', humidity: [0, 80],  temperature: [15, 35] },
  peinture:     { title: 'Atelier peinture',         icon: 'color-palette-outline', color: '#EC4899', humidity: [0, 80],  temperature: [15, 35] },
  lecture:      { title: 'Book club & café',         icon: 'book-outline',          color: '#92400E', humidity: [0, 100], temperature: [-10, 40] },
  photographie: { title: 'Balade photo en ville',    icon: 'camera-outline',        color: '#6B7280', humidity: [0, 60],  temperature: [5, 30]  },
  voyage:       { title: "Excursion d'une journée",  icon: 'airplane-outline',      color: '#3B82F6', humidity: [0, 70],  temperature: [10, 30] },
  gaming:       { title: 'Soirée gaming',            icon: 'game-controller-outline',color: '#7C3AED', humidity: [0, 100], temperature: [-10, 40] },
  méditation:   { title: 'Séance méditation',        icon: 'leaf-outline',          color: '#10B981', humidity: [0, 80],  temperature: [15, 35] },
  théâtre:      { title: 'Pièce de théâtre',         icon: 'mic-outline',           color: '#F59E0B', humidity: [0, 100], temperature: [-10, 40] },
  shopping:     { title: 'Shopping en groupe',       icon: 'bag-outline',           color: '#EC4899', humidity: [0, 80],  temperature: [5, 35]  },
  jardinage:    { title: 'Jardin ou marché bio',     icon: 'flower-outline',        color: '#22C55E', humidity: [0, 70],  temperature: [10, 30] },
};

const SOCIAL_DEFAULTS = [
  { title: 'Brunch ou café',       icon: 'cafe-outline',         color: '#92400E', description: 'Pour mieux se connaître',     humidity: [0, 100], temperature: [-10, 40] },
  { title: 'Pique-nique au parc',  icon: 'sunny-outline',        color: '#22C55E', description: 'Sortie nature détendue',      humidity: [0, 60],  temperature: [15, 30]  },
  { title: 'Escape game',          icon: 'lock-closed-outline',  color: '#8B5CF6', description: 'Défi et team building',       humidity: [0, 100], temperature: [-10, 40] },
  { title: 'Bowling',              icon: 'trophy-outline',       color: '#3B82F6', description: 'Compétition amicale garantie',humidity: [0, 100], temperature: [-10, 40] },
  { title: 'Soirée cocktails',     icon: 'wine-outline',         color: '#EF4444', description: 'Détente et bonne humeur',     humidity: [0, 100], temperature: [-10, 40] },
  { title: 'Marché local',         icon: 'storefront-outline',   color: '#F97316', description: 'Découverte et flânerie',      humidity: [0, 70],  temperature: [10, 30]  },
  { title: 'Karaoké',              icon: 'mic-outline',          color: '#8B5CF6', description: 'Bonne ambiance garantie',     humidity: [0, 100], temperature: [-10, 40] },
  { title: 'Mini-golf',            icon: 'golf-outline',         color: '#22C55E', description: 'Casual et fun',               humidity: [0, 60],  temperature: [15, 30]  },
];

async function generateActivitySuggestions(members) {
  const sportFreq = {};
  const hobbyFreq = {};
  const personalityTotals = { social_energy: 0, planning_style: 0, conversation_depth: 0 };
  let personalityCount = 0;

  const weatherData = await get_weather(""); // { humidity, temperature } or null

  // Range check helper: activity.humidity/temperature are [min, max] pairs
  const okForWeather = (activity) => {
    if (!weatherData) return true;
    const { humidity, temperature } = weatherData;
    const [humMin, humMax] = activity.humidity;
    const [tempMin, tempMax] = activity.temperature;
    return humidity >= humMin && humidity <= humMax && temperature >= tempMin && temperature <= tempMax;
  };

  for (const m of members) {
    const interests = parseInterests(m.interests);
    for (const s of (interests.sports || [])) {
      const k = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
      sportFreq[k] = (sportFreq[k] || 0) + 1;
    }
    for (const h of (interests.hobbies || [])) {
      const k = h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
      hobbyFreq[k] = (hobbyFreq[k] || 0) + 1;
    }
    if (interests.social_energy != null) {
      personalityTotals.social_energy += Number(interests.social_energy) || 5;
      personalityTotals.planning_style += Number(interests.planning_style) || 5;
      personalityTotals.conversation_depth += Number(interests.conversation_depth) || 5;
      personalityCount++;
    }
  }

  const avgPersonality = personalityCount > 0
    ? {
        social_energy: personalityTotals.social_energy / personalityCount,
        planning_style: personalityTotals.planning_style / personalityCount,
        conversation_depth: personalityTotals.conversation_depth / personalityCount,
      }
    : { social_energy: 5, planning_style: 5, conversation_depth: 5 };

  const suggestions = [];
  const usedTitles = new Set();

  // Sports shared by ≥2 members, filtered by weather
  const topSports = Object.entries(sportFreq).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
  for (const [sport, count] of topSports) {
    if (suggestions.length >= 2) break;
    const template = SPORT_ACTIVITIES[sport];
    if (!template) continue;
    if (!okForWeather(template)) continue;
    if (!usedTitles.has(template.title)) {
      suggestions.push({ ...template, description: `${count} membres aiment ça`, tag: 'sport' });
      usedTitles.add(template.title);
    }
  }

  // Hobbies shared by ≥2 members, filtered by weather
  const topHobbies = Object.entries(hobbyFreq).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
  for (const [hobby, count] of topHobbies) {
    if (suggestions.length >= 3) break;
    const template = HOBBY_ACTIVITIES[hobby];
    if (!template) continue;
    if (!okForWeather(template)) continue;
    if (!usedTitles.has(template.title)) {
      suggestions.push({ ...template, description: `${count} membres adorent ça`, tag: 'hobby' });
      usedTitles.add(template.title);
    }
  }

  // Fill remaining slots with personality-driven social defaults
  const shuffled = [...SOCIAL_DEFAULTS].sort(() => Math.random() - 0.5);
  const partyTerms = ['cocktails', 'karaoké', 'soirée'];
  const ordered = avgPersonality.social_energy >= 6
    ? shuffled.sort((a, b) => {
        const aParty = partyTerms.some((t) => a.title.toLowerCase().includes(t)) ? -1 : 1;
        const bParty = partyTerms.some((t) => b.title.toLowerCase().includes(t)) ? -1 : 1;
        return aParty - bParty;
      })
    : shuffled;

  for (const def of ordered) {
    if (suggestions.length >= 4) break;
    if (okForWeather(def) && !usedTitles.has(def.title)) {
      suggestions.push({ ...def, tag: 'social' });
      usedTitles.add(def.title);
    }
  }
  // If weather filtered too aggressively, fill without weather constraint
  for (const def of ordered) {
    if (suggestions.length >= 4) break;
    if (!usedTitles.has(def.title)) {
      suggestions.push({ ...def, tag: 'social' });
      usedTitles.add(def.title);
    }
  }

  return suggestions.slice(0, 4);
}

/**
 * Find the best common interest label between two users.
 */
function findCommonInterest(userA, userB) {
  const aInterests = parseInterests(userA.interests);
  const bInterests = parseInterests(userB.interests);

  const aSports = aInterests.sports || [];
  const bSports = bInterests.sports || [];
  const aHobbies = aInterests.hobbies || [];
  const bHobbies = bInterests.hobbies || [];

  const commonSports = aSports.filter((s) => bSports.includes(s));
  const commonHobbies = aHobbies.filter((h) => bHobbies.includes(h));

  if (commonSports.length > 0) return commonSports[0];
  if (commonHobbies.length > 0) return commonHobbies[0];
  if (userA.astrology_title && userB.astrology_title && userA.astrology_title === userB.astrology_title) {
    return `Même signe astro: ${userA.astrology_title}`;
  }
  return null;
}

/**
 * Find the most common shared interest label across a group.
 */
function findGroupCommonInterest(members) {
  const labels = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const ci = findCommonInterest(members[i], members[j]);
      if (ci) labels.push(ci);
    }
  }

  if (labels.length === 0) return 'Les pétillantes';

  // Return the most frequent label
  const freq = {};
  labels.forEach((l) => { freq[l] = (freq[l] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
}

async function groupRoutes(app) {

  // ── GET user's current weekly group ──
  app.get('/current', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Find active weekly group the user is part of
      const result = await query(
        `SELECT wg.id, wg.group_id, wg.week_start, wg.week_end,
                wg.common_interest, wg.rendezvous_location, wg.rendezvous_time,
                COALESCE(wg.rendezvous_suggestions, '[]'::jsonb) AS rendezvous_suggestions,
                wg.is_active, wg.created_at,
                dg.title, dg.description, dg.photo, dg.category
         FROM weekly_groups wg
         JOIN discussion_groups dg ON dg.id = wg.group_id
         JOIN group_participants gp ON gp.group_id = dg.id
         WHERE gp.user_id = $1
           AND wg.is_active = true
           AND wg.week_end >= NOW()
         ORDER BY wg.week_start DESC
         LIMIT 1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return reply.send({ group: null, message: 'No active weekly group' });
      }

      const group = result.rows[0];

      // Get members
      const membersResult = await query(
        `SELECT u.id, u.full_name,
                u.user_name, u.profile_image, u.location
         FROM group_participants gp
         JOIN users u ON u.id = gp.user_id
         WHERE gp.group_id = $1`,
        [group.group_id]
      );

      // Get vote results
      const votesResult = await query(
        `SELECT vote, COUNT(*)::int AS count
         FROM group_votes
         WHERE weekly_group_id = $1
         GROUP BY vote`,
        [group.id]
      );

      let voteSummary = { continue: 0, disband: 0, total: 0 };
      votesResult.rows.forEach((r) => {
        if (r.vote) voteSummary.continue = r.count;
        else voteSummary.disband = r.count;
        voteSummary.total += r.count;
      });

      // ── Activity suggestions (trigger after ACTIVITY_TRIGGER_HOURS) ──
      let activitySuggestions = null;
      let activityVotes = { counts: {}, my_votes: [] };

      const hoursSinceStart = (Date.now() - new Date(group.week_start).getTime()) / 3600000;
      if (hoursSinceStart >= ACTIVITY_TRIGGER_HOURS) {
        const existingSugg = await query(
          'SELECT suggestions, generated_at FROM group_activity_suggestions WHERE weekly_group_id = $1',
          [group.id]
        );

        const oneDayMs = 24 * 60 * 60 * 1000;
        const hasExisting = existingSugg.rows.length > 0;
        const generatedAt = hasExisting ? new Date(existingSugg.rows[0].generated_at) : null;
        const diffMs = generatedAt ? Date.now() - generatedAt.getTime() : Infinity;

        if (!hasExisting || diffMs > oneDayMs) {
          // Fetch member interests for generation
          const membersWithInterests = await query(
            `SELECT u.interests FROM group_participants gp
             JOIN users u ON u.id = gp.user_id
             WHERE gp.group_id = $1`,
            [group.group_id]
          );
          const generated = await generateActivitySuggestions(membersWithInterests.rows);
          await query(
            `INSERT INTO group_activity_suggestions (weekly_group_id, suggestions)
             VALUES ($1, $2)
             ON CONFLICT (weekly_group_id) DO UPDATE SET suggestions = $2, generated_at = NOW()`,
            [group.id, JSON.stringify(generated)]
          );
          activitySuggestions = generated;
        } else {
          activitySuggestions = existingSugg.rows[0].suggestions;
        }

        // Vote counts
        const voteCounts = await query(
          `SELECT suggestion_index, COUNT(*)::int AS count
           FROM group_activity_votes WHERE weekly_group_id = $1
           GROUP BY suggestion_index`,
          [group.id]
        );
        const myVotes = await query(
          'SELECT suggestion_index FROM group_activity_votes WHERE weekly_group_id = $1 AND user_id = $2',
          [group.id, userId]
        );
        activityVotes = {
          counts: voteCounts.rows.reduce((acc, r) => { acc[r.suggestion_index] = r.count; return acc; }, {}),
          my_votes: myVotes.rows.map((r) => r.suggestion_index),
        };
      }

      return reply.send({
        group: {
          ...group,
          members: membersResult.rows,
          vote_summary: voteSummary,
          activity_suggestions: activitySuggestions,
          activity_votes: activityVotes,
        },
      });
    } catch (err) {
      console.error('Current group error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST generate/join a weekly group ──
  //eh ouais des KNN
  app.post('/generate', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const now = new Date().toISOString();

      const existingAsParticipant = await query(
        `SELECT wg.id FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE gp.user_id = $1
           AND wg.week_start <= $2
           AND wg.week_end >= $2
         LIMIT 1`,
        [userId, now]
      );

      const existingAsOwner = await query(
        `SELECT wg.id FROM weekly_groups wg
         JOIN discussion_groups dg ON dg.id = wg.group_id
         WHERE dg.owner_id = $1
           AND wg.week_start <= $2
           AND wg.week_end >= $2
         LIMIT 1`,
        [userId, now]
      );

      if (existingAsParticipant.rows.length > 0 || existingAsOwner.rows.length > 0) {
        return reply.status(409).send({ error: 'You already have (or had) a group this week' });
      }

      // Fetch current user profile
      const meResult = await query(
        `SELECT u.id, u.interests, u.astrology_sign_id, u.latitude, u.longitude,
                a.name AS astrology_title
         FROM users u
         LEFT JOIN astrology_signs a ON a.id = u.astrology_sign_id
         WHERE u.id = $1`,
        [userId]
      );
      const me = meResult.rows[0];

      // Fetch candidate pool (users in same area, not blocked, not already in group)
      const candidatesResult = await query(
        `SELECT u.id, u.interests, u.astrology_sign_id, u.latitude, u.longitude,
                a.name AS astrology_title,
                u.location
         FROM users u
         LEFT JOIN astrology_signs a ON a.id = u.astrology_sign_id
         WHERE u.id != $1
           AND u.latitude IS NOT NULL
           AND u.longitude IS NOT NULL
           AND u.id NOT IN (
             SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
           )
           AND u.id NOT IN (
             SELECT blocker_id FROM blocked_users WHERE blocked_id = $1
           )
           AND u.id NOT IN (
             SELECT gp.user_id FROM group_participants gp
             JOIN weekly_groups wg ON wg.group_id = gp.group_id
             WHERE wg.is_active = true AND wg.week_end >= NOW()
           )
         LIMIT 100`,
        [userId]
      );

      const candidates = candidatesResult.rows;

      // Fetch affinity bonuses from past interaction ratings
      const affinityResult = await query(
        `SELECT rated_user_id,
                AVG((want_again + comfort + in_common)::float / 3) AS avg_score
         FROM member_interaction_ratings
         WHERE rater_id = $1
         GROUP BY rated_user_id`,
        [userId]
      );
      // avg_score 1–5, centred at 3 → bonus range –0.15 to +0.15
      const affinityMap = {};
      for (const row of affinityResult.rows) {
        affinityMap[row.rated_user_id] = ((parseFloat(row.avg_score) - 3) / 2) * 0.15;
      }

      const scored = candidates.map((c) => ({
        candidate: c,
        score: scoreCandidate(me, c, affinityMap[c.id] ?? 0),
      }));

      //filtre de proximité -- 30dm
      const nearby = scored.filter((s) => {
        if (!me.latitude || !me.longitude || !s.candidate.latitude || !s.candidate.longitude) return false;
        const dist = haversineKm(
          parseFloat(me.latitude), parseFloat(me.longitude),
          parseFloat(s.candidate.latitude), parseFloat(s.candidate.longitude)
        );
        return dist <= 30;
      });

      nearby.sort((a, b) => b.score - a.score);
      const selectedCandidates = nearby.slice(0, GROUP_SIZE - 1);

      if (selectedCandidates.length < 2) {
        return reply.status(400).send({
          error: 'Not enough compatible users nearby to form a group. Try again later.',
          found: selectedCandidates.length + 1,
        });
      }

      // Collect group members
      const groupMembers = [me, ...selectedCandidates.map((s) => s.candidate)];
      const commonInterest = findGroupCommonInterest(groupMembers);

      // Create discussion_group
      const weekStart = new Date();
      const weekEnd = new Date(Date.now() + ONE_WEEK_MS);

      const groupTitle = `Groupe ${commonInterest}`;

      const { discussionGroupId, weeklyGroupId, membersResult } = await withTransaction(async (client) => {
        const dgResult = await client.query(
          `INSERT INTO discussion_groups (owner_id, title, description, participant_limit, is_private, category)
           VALUES ($1, $2, $3, $4, false, 'weekly')
           RETURNING id`,
          [userId, groupTitle, `Groupe hebdomadaire: ${commonInterest}`, GROUP_SIZE]
        );
        const dgId = dgResult.rows[0].id;

        const wgResult = await client.query(
          `INSERT INTO weekly_groups (group_id, week_start, week_end, common_interest, is_active)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id`,
          [dgId, weekStart.toISOString(), weekEnd.toISOString(), commonInterest]
        );
        const wgId = wgResult.rows[0].id;

        await client.query(
          `INSERT INTO group_participants (group_id, user_id)
           SELECT $1, unnest($2::uuid[])
           ON CONFLICT (group_id, user_id) DO NOTHING`,
          [dgId, groupMembers.map((m) => m.id)]
        );

        const members = await client.query(
          `SELECT u.id, u.full_name, u.user_name, u.profile_image, u.location
           FROM group_participants gp
           JOIN users u ON u.id = gp.user_id
           WHERE gp.group_id = $1`,
          [dgId]
        );

        return { discussionGroupId: dgId, weeklyGroupId: wgId, membersResult: members };
      });

      // Notify the other members (not the initiator) that they've been added
      const otherMemberIds = membersResult.rows.map((m) => m.id).filter((id) => id !== userId);
      if (otherMemberIds.length > 0) {
        getTokensForUsers(otherMemberIds, query).then((tokens) => {
          sendPush(tokens, '🎉 Ton groupe de la semaine est prêt !', `Tu as été mise en groupe autour de "${commonInterest}". Va dire bonjour !`, { type: 'group_formed' });
        }).catch((err) => console.error('[push] group_formed notification error:', err.message));
      }

      return reply.status(201).send({
        group: {
          id: weeklyGroupId,
          group_id: discussionGroupId,
          week_start: weekStart.toISOString(),
          week_end: weekEnd.toISOString(),
          common_interest: commonInterest,
          is_active: true,
          title: groupTitle,
          members: membersResult.rows,
        },
      });
    } catch (err) {
      console.error('Generate group error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST leave a weekly group ──
  app.post('/leave', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Find the user's active weekly group
      const result = await query(
        `SELECT wg.id AS weekly_group_id, wg.group_id
         FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE gp.user_id = $1 AND wg.is_active = true AND wg.week_end >= NOW()`,
        [userId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'No active weekly group found' });
      }

      const { weekly_group_id, group_id } = result.rows[0];

      // Remove user from group participants
      await query('DELETE FROM group_participants WHERE group_id = $1 AND user_id = $2', [group_id, userId]);

      // Check if group is now empty
      const remaining = await query('SELECT COUNT(*)::int AS count FROM group_participants WHERE group_id = $1', [group_id]);

      if (remaining.rows[0].count === 0) {
        await query('UPDATE weekly_groups SET is_active = false WHERE id = $1', [weekly_group_id]);
      }

      return reply.send({ left: true });
    } catch (err) {
      console.error('Leave group error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST vote on whether to continue the group ──
  app.post('/vote', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weekly_group_id, vote } = request.body;

      if (typeof vote !== 'boolean') {
        return reply.status(400).send({ error: 'vote must be a boolean' });
      }

      // Verify user is in the group
      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [weekly_group_id, userId]
      );

      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'You are not a member of this group' });
      }

      // Upsert the vote
      await query(
        `INSERT INTO group_votes (weekly_group_id, voter_id, vote)
         VALUES ($1, $2, $3)
         ON CONFLICT (weekly_group_id, voter_id)
         DO UPDATE SET vote = $3, created_at = NOW()`,
        [weekly_group_id, userId, vote]
      );

      // Check if all members have voted (at end of week, we resolve)
      const voteResult = await query(
        `SELECT vote, COUNT(*)::int AS count
         FROM group_votes
         WHERE weekly_group_id = $1
         GROUP BY vote`,
        [weekly_group_id]
      );

      const memberCount = await query(
        `SELECT COUNT(*)::int AS count FROM group_participants gp
         JOIN weekly_groups wg ON wg.group_id = gp.group_id
         WHERE wg.id = $1`,
        [weekly_group_id]
      );

      let continueCount = 0;
      let disbandCount = 0;
      voteResult.rows.forEach((r) => {
        if (r.vote) continueCount = r.count;
        else disbandCount = r.count;
      });

      const totalMembers = memberCount.rows[0].count;
      const totalVotes = continueCount + disbandCount;

      let resolved = false;
      let groupContinues = null;

      // Check if week has ended (time-based auto-resolution)
      const weekCheck = await query(
        `SELECT week_end FROM weekly_groups WHERE id = $1`,
        [weekly_group_id]
      );
      const weekEnded = weekCheck.rows.length > 0 && new Date(weekCheck.rows[0].week_end) <= new Date();

      // Require majority of members to have voted, or auto-resolve at week end
      const quorumReached = totalVotes > totalMembers / 2;
      const shouldResolve = totalVotes >= totalMembers || (weekEnded && quorumReached);

      // If week ended without quorum, disband by default (no engagement = dead group)
      if (weekEnded && !quorumReached) {
        resolved = true;
        await query('UPDATE weekly_groups SET is_active = false WHERE id = $1', [weekly_group_id]);
        groupContinues = false;
      } else if (shouldResolve) {
        resolved = true;
        if (disbandCount >= continueCount) {
          // Disband the group
          await query('UPDATE weekly_groups SET is_active = false WHERE id = $1', [weekly_group_id]);
          groupContinues = false;
        } else {
          // Extend for another week — update both start and end
          await query(
            `UPDATE weekly_groups SET
               week_start = week_start + INTERVAL '7 days',
               week_end = week_end + INTERVAL '7 days',
               updated_at = NOW()
             WHERE id = $1`,
            [weekly_group_id]
          );
          groupContinues = true;

          // Clear votes for the new week
          await query('DELETE FROM group_votes WHERE weekly_group_id = $1', [weekly_group_id]);
        }
      }

      return reply.send({
        vote_recorded: true,
        resolved,
        group_continues: groupContinues,
        vote_summary: {
          continue: continueCount,
          disband: disbandCount,
          total_members: totalMembers,
        },
      });
    } catch (err) {
      console.error('Vote error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── GET group chat messages ──
  app.get('/:weeklyGroupId/messages', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weeklyGroupId } = request.params;

      // Verify membership
      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [weeklyGroupId, userId]
      );

      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this group' });
      }

      const result = await query(
        `SELECT gm.id, gm.sender_id, gm.content, gm.message_type,
                gm.media_url, gm.created_at,
                u.full_name AS sender_name,
                u.user_name AS sender_username,
                u.profile_image AS sender_image
         FROM group_messages gm
         JOIN users u ON u.id = gm.sender_id
         WHERE gm.group_id = $1
         ORDER BY gm.created_at ASC
         LIMIT 100`,
        [weeklyGroupId]
      );

      return reply.send({ messages: result.rows });
    } catch (err) {
      console.error('Group messages error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST send group message ──
  app.post('/message/send', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const body = createGroupMessageSchema.parse(request.body);

      // Verify membership
      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [body.weekly_group_id, userId]
      );

      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this group' });
      }

      // media_url is a jsonb column — the URL string must be JSON-encoded before
      // insert (same as 1-on-1 messages). Inserting a bare URL throws
      // "invalid input syntax for type json" and 500s the request.
      const mediaUrlJson = body.media_url ? JSON.stringify(body.media_url) : null;
      const result = await query(
        `INSERT INTO group_messages (group_id, sender_id, content, message_type, media_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, group_id, sender_id, content, message_type, media_url, created_at`,
        [body.weekly_group_id, userId, body.content || '', body.message_type || 'text', mediaUrlJson]
      );

      // Notify other group members (fire-and-forget)
      Promise.all([
        query('SELECT full_name FROM users WHERE id = $1', [userId]),
        query(`SELECT dg.title FROM weekly_groups wg JOIN discussion_groups dg ON dg.id = wg.group_id WHERE wg.id = $1`, [body.weekly_group_id]),
        query(`SELECT gp.user_id FROM weekly_groups wg JOIN group_participants gp ON gp.group_id = wg.group_id WHERE wg.id = $1 AND gp.user_id != $2`, [body.weekly_group_id, userId]),
      ]).then(async ([senderRes, groupRes, membersRes]) => {
        const senderName = senderRes.rows[0]?.full_name || 'Quelqu\'un';
        const groupTitle = groupRes.rows[0]?.title || 'Groupe';
        const memberIds = membersRes.rows.map((r) => r.user_id);
        const tokens = await getTokensForUsers(memberIds, query);
        const preview = body.content?.trim() || '📷';
        sendPush(tokens, groupTitle, `${senderName}: ${preview}`, { type: 'group_message', weekly_group_id: body.weekly_group_id });
      }).catch((err) => console.error('[push] group_message notification error:', err.message));

      return reply.status(201).send({ message: result.rows[0] });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('Group message send error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST vote on individual members ──
  app.post('/member-vote', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weekly_group_id, votes } = request.body;
      // votes: [{ member_id: uuid, keep: boolean }, ...]

      if (!weekly_group_id || !Array.isArray(votes) || votes.length === 0) {
        return reply.status(400).send({ error: 'weekly_group_id and votes[] are required' });
      }

      // Verify user is a member
      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [weekly_group_id, userId]
      );
      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'You are not a member of this group' });
      }

      const validVotes = votes.filter((v) => v.member_id !== userId && typeof v.keep === 'boolean');

      if (validVotes.length > 0) {
        const placeholders = validVotes.map((_, i) => {
          const b = 3 + i * 2;
          return `($1, $2, $${b}, $${b + 1})`;
        }).join(', ');
        const values = [weekly_group_id, userId];
        for (const v of validVotes) values.push(v.member_id, v.keep);

        await query(
          `INSERT INTO member_votes (weekly_group_id, voter_id, member_id, keep)
           VALUES ${placeholders}
           ON CONFLICT (weekly_group_id, voter_id, member_id)
           DO UPDATE SET keep = EXCLUDED.keep`,
          values
        );
      }

      return reply.send({ recorded: true });
    } catch (err) {
      console.error('Member vote error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── GET member vote results for the group ──
  app.get('/:weeklyGroupId/member-votes', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weeklyGroupId } = request.params;

      // Verify membership
      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [weeklyGroupId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this group' });
      }

      // Aggregate: for each member, how many keep vs remove votes
      const result = await query(
        `SELECT mv.member_id,
                u.full_name, u.user_name,
                COUNT(*) FILTER (WHERE mv.keep = true)::int AS keep_votes,
                COUNT(*) FILTER (WHERE mv.keep = false)::int AS remove_votes
         FROM member_votes mv
         JOIN users u ON u.id = mv.member_id
         WHERE mv.weekly_group_id = $1
         GROUP BY mv.member_id, u.full_name, u.user_name`,
        [weeklyGroupId]
      );

      // Did this user already vote?
      const myVotes = await query(
        'SELECT member_id, keep FROM member_votes WHERE weekly_group_id = $1 AND voter_id = $2',
        [weeklyGroupId, userId]
      );

      return reply.send({
        member_votes: result.rows,
        my_votes: myVotes.rows,
      });
    } catch (err) {
      console.error('Member votes error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── PUT set rendezvous location/time ──
  app.put('/rendezvous', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weekly_group_id, location, time } = request.body;

      if (!weekly_group_id || !location) {
        return reply.status(400).send({ error: 'weekly_group_id and location are required' });
      }

      // Verify membership
      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [weekly_group_id, userId]
      );

      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this group' });
      }

      await query(
        `UPDATE weekly_groups SET rendezvous_location = $2, rendezvous_time = $3, updated_at = NOW()
         WHERE id = $1`,
        [weekly_group_id, location, time || null]
      );

      // Notify all group members of the proposed rendezvous (fire-and-forget)
      Promise.all([
        query(`SELECT dg.title FROM weekly_groups wg JOIN discussion_groups dg ON dg.id = wg.group_id WHERE wg.id = $1`, [weekly_group_id]),
        query(`SELECT gp.user_id FROM weekly_groups wg JOIN group_participants gp ON gp.group_id = wg.group_id WHERE wg.id = $1`, [weekly_group_id]),
      ]).then(async ([groupRes, membersRes]) => {
        const groupTitle = groupRes.rows[0]?.title || 'Votre groupe';
        const memberIds = membersRes.rows.map((r) => r.user_id);
        const tokens = await getTokensForUsers(memberIds, query);
        const timeLabel = time
          ? new Date(time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
          : null;
        const bodyMsg = timeLabel ? `📍 ${location} à ${timeLabel}` : `📍 ${location}`;
        sendPush(tokens, `${groupTitle} — Rendez-vous proposé !`, bodyMsg, { type: 'rendezvous', weekly_group_id });
      }).catch((err) => console.error('[push] rendezvous notification error:', err.message));

      return reply.send({ updated: true });
    } catch (err) {
      console.error('Rendezvous error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
  // ── POST add a rendez-vous suggestion ──
  app.post('/rendezvous-suggest', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weekly_group_id, location, time } = request.body;

      if (!weekly_group_id || !location) {
        return reply.status(400).send({ error: 'weekly_group_id and location are required' });
      }

      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [weekly_group_id, userId]
      );
      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this group' });
      }

      const userRes = await query('SELECT full_name, user_name FROM users WHERE id = $1', [userId]);
      const user = userRes.rows[0] || {};
      const userName = user.full_name || user.user_name || 'Anonyme';

      const existing = await query(
        `SELECT COALESCE(rendezvous_suggestions, '[]'::jsonb) AS suggestions FROM weekly_groups WHERE id = $1`,
        [weekly_group_id]
      );
      const suggestions = existing.rows[0]?.suggestions || [];
      const newSuggestion = {
        id: Date.now(),
        user_id: userId,
        user_name: userName,
        location: location.trim(),
        time: time || null,
        likes: [],
      };
      suggestions.push(newSuggestion);

      await query(
        `UPDATE weekly_groups SET rendezvous_suggestions = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [weekly_group_id, JSON.stringify(suggestions)]
      );

      // Push notification (fire-and-forget)
      Promise.all([
        query(`SELECT dg.title FROM weekly_groups wg JOIN discussion_groups dg ON dg.id = wg.group_id WHERE wg.id = $1`, [weekly_group_id]),
        query(`SELECT gp.user_id FROM weekly_groups wg JOIN group_participants gp ON gp.group_id = wg.group_id WHERE wg.id = $1`, [weekly_group_id]),
      ]).then(async ([groupRes, membersRes]) => {
        const groupTitle = groupRes.rows[0]?.title || 'Votre groupe';
        const memberIds = membersRes.rows.map((r) => r.user_id).filter((id) => id !== userId);
        const tokens = await getTokensForUsers(memberIds, query);
        sendPush(tokens, `${groupTitle} — Nouvelle suggestion 📍`, `${userName} propose : ${location}`, { type: 'rendezvous', weekly_group_id });
      }).catch((err) => console.error('[push] rendezvous-suggest notification error:', err.message));

      return reply.status(201).send({ suggestion: newSuggestion });
    } catch (err) {
      console.error('Rendezvous suggest error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST toggle like on a rendez-vous suggestion ──
  app.post('/:weeklyGroupId/rendezvous-like/:suggestionId', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weeklyGroupId, suggestionId } = request.params;
      const sidNum = parseInt(suggestionId, 10);

      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [weeklyGroupId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this group' });
      }

      const existing = await query(
        `SELECT COALESCE(rendezvous_suggestions, '[]'::jsonb) AS suggestions FROM weekly_groups WHERE id = $1`,
        [weeklyGroupId]
      );
      const suggestions = existing.rows[0]?.suggestions || [];
      const idx = suggestions.findIndex((s) => s.id === sidNum);
      if (idx === -1) return reply.status(404).send({ error: 'Suggestion not found' });

      const likes = suggestions[idx].likes || [];
      const alreadyLiked = likes.includes(userId);
      suggestions[idx].likes = alreadyLiked ? likes.filter((id) => id !== userId) : [...likes, userId];

      await query(
        `UPDATE weekly_groups SET rendezvous_suggestions = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [weeklyGroupId, JSON.stringify(suggestions)]
      );

      return reply.send({ liked: !alreadyLiked, suggestion: suggestions[idx] });
    } catch (err) {
      console.error('Rendezvous like error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST report a group ──
  app.post('/:weeklyGroupId/report', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weeklyGroupId } = request.params;
      const { reason } = request.body || {};

      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return reply.status(400).send({ error: 'reason is required' });
      }

      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [weeklyGroupId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this group' });
      }

      await query(
        `INSERT INTO reported_groups (reporter_id, group_id, reason) VALUES ($1, $2, $3)`,
        [userId, weeklyGroupId, reason.trim()]
      );

      return reply.send({ reported: true });
    } catch (err) {
      console.error('Report group error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST toggle vote on an activity suggestion ──
  app.post('/:weeklyGroupId/activity-vote', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weeklyGroupId } = request.params;
      const { suggestion_index } = request.body;

      if (suggestion_index == null || typeof suggestion_index !== 'number') {
        return reply.status(400).send({ error: 'suggestion_index (number) is required' });
      }

      // Verify membership
      const memberCheck = await query(
        `SELECT 1 FROM weekly_groups wg
         JOIN group_participants gp ON gp.group_id = wg.group_id
         WHERE wg.id = $1 AND gp.user_id = $2`,
        [weeklyGroupId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this group' });
      }

      // Toggle: delete if exists, insert if not
      const existing = await query(
        'SELECT id FROM group_activity_votes WHERE weekly_group_id = $1 AND user_id = $2 AND suggestion_index = $3',
        [weeklyGroupId, userId, suggestion_index]
      );

      if (existing.rows.length > 0) {
        await query(
          'DELETE FROM group_activity_votes WHERE weekly_group_id = $1 AND user_id = $2 AND suggestion_index = $3',
          [weeklyGroupId, userId, suggestion_index]
        );
        return reply.send({ voted: false });
      } else {
        await query(
          'INSERT INTO group_activity_votes (weekly_group_id, user_id, suggestion_index) VALUES ($1, $2, $3)',
          [weeklyGroupId, userId, suggestion_index]
        );
        return reply.send({ voted: true });
      }
    } catch (err) {
      console.error('Activity vote error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST dissolution feedback (group rating + member personality ratings) ──
  app.post('/dissolution-feedback', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weekly_group_id, group_rating, member_ratings } = request.body;

      if (!weekly_group_id) {
        return reply.status(400).send({ error: 'weekly_group_id is required' });
      }

      if (group_rating != null) {
        await query(
          `INSERT INTO group_dissolution_feedback (weekly_group_id, reviewer_id, group_rating)
           VALUES ($1, $2, $3)
           ON CONFLICT (weekly_group_id, reviewer_id)
           DO UPDATE SET group_rating = $3`,
          [weekly_group_id, userId, group_rating]
        );
      }

      const validRatings = (Array.isArray(member_ratings) ? member_ratings : [])
        .filter((mr) => mr.member_id && mr.member_id !== userId);

      if (validRatings.length > 0) {
        const placeholders = validRatings.map((_, i) => {
          const b = 3 + i * 6;
          return `($1, $2, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
        }).join(', ');
        const values = [weekly_group_id, userId];
        for (const mr of validRatings) {
          values.push(
            mr.member_id,
            mr.spontaneous_vs_planner ?? null,
            mr.sporty_vs_chill ?? null,
            mr.party_vs_coffee ?? null,
            mr.deep_vs_casual ?? null,
            mr.group_role ?? null
          );
        }
        await query(
          `INSERT INTO member_personality_ratings
             (weekly_group_id, reviewer_id, member_id,
              spontaneous_vs_planner, sporty_vs_chill, party_vs_coffee, deep_vs_casual, group_role)
           VALUES ${placeholders}
           ON CONFLICT (weekly_group_id, reviewer_id, member_id)
           DO UPDATE SET
             spontaneous_vs_planner = EXCLUDED.spontaneous_vs_planner,
             sporty_vs_chill = EXCLUDED.sporty_vs_chill,
             party_vs_coffee = EXCLUDED.party_vs_coffee,
             deep_vs_casual = EXCLUDED.deep_vs_casual,
             group_role = EXCLUDED.group_role`,
          values
        );
      }

      return reply.send({ submitted: true });
    } catch (err) {
      console.error('Dissolution feedback error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST interaction ratings (3 questions × member, scale 1–5) ──
  app.post('/interaction-ratings', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { weekly_group_id, ratings } = request.body;
      if (!weekly_group_id || !Array.isArray(ratings)) {
        return reply.status(400).send({ error: 'weekly_group_id and ratings[] are required' });
      }
      const validRatings = ratings
        .map((r) => ({
          rated_user_id: r.rated_user_id,
          want_again: parseInt(r.want_again, 10),
          comfort: parseInt(r.comfort, 10),
          in_common: parseInt(r.in_common, 10),
        }))
        .filter((r) =>
          r.rated_user_id && r.rated_user_id !== userId &&
          r.want_again >= 1 && r.want_again <= 5 &&
          r.comfort >= 1 && r.comfort <= 5 &&
          r.in_common >= 1 && r.in_common <= 5
        );

      if (validRatings.length > 0) {
        const placeholders = validRatings.map((_, i) => {
          const b = 3 + i * 4;
          return `($1, $2, $${b}, $${b + 1}, $${b + 2}, $${b + 3})`;
        }).join(', ');
        const values = [weekly_group_id, userId];
        for (const r of validRatings) values.push(r.rated_user_id, r.want_again, r.comfort, r.in_common);

        await query(
          `INSERT INTO member_interaction_ratings
             (weekly_group_id, rater_id, rated_user_id, want_again, comfort, in_common)
           VALUES ${placeholders}
           ON CONFLICT (weekly_group_id, rater_id, rated_user_id)
           DO UPDATE SET want_again = EXCLUDED.want_again,
                         comfort = EXCLUDED.comfort,
                         in_common = EXCLUDED.in_common`,
          values
        );
      }
      return reply.send({ submitted: true });
    } catch (err) {
      console.error('Interaction ratings error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });
}

module.exports = { groupRoutes, findGroupCommonInterest };
