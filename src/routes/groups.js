const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { scoreCandidate, haversineKm, parseInterests } = require('../matching');

const createGroupMessageSchema = z.object({
  weekly_group_id: z.string().uuid(),
  content: z.string().min(1).max(5000),
  message_type: z.string().default('text').optional(),
});

const GROUP_SIZE = 5;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

  if (labels.length === 0) return 'Centre d\'intérêt commun';

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
        `SELECT wg.*, dg.title, dg.description, dg.photo, dg.category
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
        `SELECT u.id, CONCAT(u.firstname, ' ', u.surname) AS full_name,
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

      return reply.send({
        group: {
          ...group,
          members: membersResult.rows,
          vote_summary: voteSummary,
        },
      });
    } catch (err) {
      console.error('Current group error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ── POST generate/join a weekly group (KNN-based matching) ──
  app.post('/generate', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Check if user already has ANY weekly group this week (active or not)
      // Also check if user created a group this week (owner) even if they left it
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

      // Score candidates against the current user
      const scored = candidates.map((c) => ({
        candidate: c,
        score: scoreCandidate(me, c),
      }));

      // Filter by proximity (must be within 15km)
      const nearby = scored.filter((s) => {
        if (!me.latitude || !me.longitude || !s.candidate.latitude || !s.candidate.longitude) return false;
        const dist = haversineKm(
          parseFloat(me.latitude), parseFloat(me.longitude),
          parseFloat(s.candidate.latitude), parseFloat(s.candidate.longitude)
        );
        return dist <= 15;
      });

      // Sort by score and take top GROUP_SIZE-1 (plus current user = GROUP_SIZE)
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

      const dgResult = await query(
        `INSERT INTO discussion_groups (owner_id, title, description, participant_limit, is_private, category)
         VALUES ($1, $2, $3, $4, false, 'weekly')
         RETURNING id`,
        [userId, groupTitle, `Groupe hebdomadaire: ${commonInterest}`, GROUP_SIZE]
      );

      const discussionGroupId = dgResult.rows[0].id;

      // Create weekly_group
      const wgResult = await query(
        `INSERT INTO weekly_groups (group_id, week_start, week_end, common_interest, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [discussionGroupId, weekStart.toISOString(), weekEnd.toISOString(), commonInterest]
      );

      const weeklyGroupId = wgResult.rows[0].id;

      // Add all members to group_participants
      for (const member of groupMembers) {
        await query(
          `INSERT INTO group_participants (group_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (group_id, user_id) DO NOTHING`,
          [discussionGroupId, member.id]
        );
      }

      // Get full member details
      const membersResult = await query(
        `SELECT u.id, CONCAT(u.firstname, ' ', u.surname) AS full_name,
                u.user_name, u.profile_image, u.location
         FROM group_participants gp
         JOIN users u ON u.id = gp.user_id
         WHERE gp.group_id = $1`,
        [discussionGroupId]
      );

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
      return reply.status(500).send({ error: 'Internal server error' });
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
      return reply.status(500).send({ error: 'Internal server error' });
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
      return reply.status(500).send({ error: 'Internal server error' });
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
                CONCAT(u.firstname, ' ', u.surname) AS sender_name,
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
      return reply.status(500).send({ error: 'Internal server error' });
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

      const result = await query(
        `INSERT INTO group_messages (group_id, sender_id, content, message_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id, group_id, sender_id, content, message_type, media_url, created_at`,
        [body.weekly_group_id, userId, body.content, body.message_type || 'text']
      );

      return reply.status(201).send({ message: result.rows[0] });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      console.error('Group message send error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
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

      return reply.send({ updated: true });
    } catch (err) {
      console.error('Rendezvous error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = { groupRoutes };
