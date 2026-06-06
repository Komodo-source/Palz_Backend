const cron = require('node-cron');
const { query, withTransaction } = require('./db');
const { scoreCandidate, haversineKm } = require('./matching');
const { findGroupCommonInterest } = require('./routes/groups');

const GROUP_SIZE = 5;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DISTANCE_KM = 30;

async function runWeeklyGroupGeneration() {
  console.log('[scheduler] Weekly group generation started');

  try {
    // Close any groups whose week ended without a vote resolution
    await query(
      `UPDATE weekly_groups SET is_active = false
       WHERE week_end < NOW() AND is_active = true`
    );

    // Fetch all users with coordinates who don't already have an active group
    const { rows: pool } = await query(
      `SELECT u.id, u.interests, u.astrology_sign_id, u.latitude, u.longitude,
              a.name AS astrology_title, u.location
       FROM users u
       LEFT JOIN astrology_signs a ON a.id = u.astrology_sign_id
       WHERE u.latitude IS NOT NULL
         AND u.longitude IS NOT NULL
         AND u.id NOT IN (
           SELECT gp.user_id FROM group_participants gp
           JOIN weekly_groups wg ON wg.group_id = gp.group_id
           WHERE wg.is_active = true AND wg.week_end >= NOW()
         )`
    );

    if (pool.length < 3) {
      console.log(`[scheduler] Only ${pool.length} unmatched users — skipping`);
      return;
    }

    // Shuffle so no user systematically gets left out week after week
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const matchedIds = new Set();
    let groupsCreated = 0;

    for (const anchor of pool) {
      if (matchedIds.has(anchor.id)) continue;

      // Candidates: unmatched, within 30 km
      const nearby = pool.filter((u) => {
        if (u.id === anchor.id || matchedIds.has(u.id)) return false;
        const dist = haversineKm(
          parseFloat(anchor.latitude), parseFloat(anchor.longitude),
          parseFloat(u.latitude), parseFloat(u.longitude)
        );
        return dist <= MAX_DISTANCE_KM;
      });

      if (nearby.length < 2) continue; // Need at least 3 people total

      const companions = nearby
        .map((c) => ({ candidate: c, score: scoreCandidate(anchor, c, 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, GROUP_SIZE - 1)
        .map((s) => s.candidate);

      const members = [anchor, ...companions];
      const commonInterest = findGroupCommonInterest(members);
      const groupTitle = `Groupe ${commonInterest}`;
      const weekStart = new Date();
      const weekEnd = new Date(Date.now() + ONE_WEEK_MS);

      try {
        await withTransaction(async (client) => {
          const dgResult = await client.query(
            `INSERT INTO discussion_groups (owner_id, title, description, participant_limit, is_private, category)
             VALUES ($1, $2, $3, $4, false, 'weekly')
             RETURNING id`,
            [anchor.id, groupTitle, `Groupe hebdomadaire: ${commonInterest}`, GROUP_SIZE]
          );
          const dgId = dgResult.rows[0].id;

          await client.query(
            `INSERT INTO weekly_groups (group_id, week_start, week_end, common_interest, is_active)
             VALUES ($1, $2, $3, $4, true)`,
            [dgId, weekStart.toISOString(), weekEnd.toISOString(), commonInterest]
          );

          await client.query(
            `INSERT INTO group_participants (group_id, user_id)
             SELECT $1, unnest($2::uuid[])
             ON CONFLICT (group_id, user_id) DO NOTHING`,
            [dgId, members.map((m) => m.id)]
          );
        });

        for (const m of members) matchedIds.add(m.id);
        groupsCreated++;
      } catch (err) {
        console.error(`[scheduler] Failed to create group anchored on ${anchor.id}:`, err.message);
      }
    }

    const skipped = pool.filter((u) => !matchedIds.has(u.id)).length;
    console.log(`[scheduler] Done — ${groupsCreated} groups created, ${skipped} users unmatched`);
  } catch (err) {
    console.error('[scheduler] Generation error:', err);
  }
}

function startScheduler() {
  // Every Monday at 08:00, Europe/Paris timezone
  cron.schedule('0 8 * * 1', () => {
    runWeeklyGroupGeneration().catch((err) =>
      console.error('[scheduler] Unhandled error:', err)
    );
  }, { timezone: 'Europe/Paris' });

  console.log('[scheduler] Weekly group scheduler active — runs every Monday 08:00 Europe/Paris');
}

module.exports = { startScheduler, runWeeklyGroupGeneration };
