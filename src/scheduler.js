const cron = require('node-cron');
const { query, withTransaction } = require('./db');
const { scoreCandidate, haversineKm } = require('./matching');
const { findGroupCommonInterest } = require('./routes/groups');
const { sendPush, getTokensForUsers } = require('./services/push');

const GROUP_SIZE = 5;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DISTANCE_KM = 30;

const WALL_THEMES = [
  'Ton endroit préféré 📍', 'Ta passion cachée 🎨', 'Ton coin lecture 📚',
  'POV : ton bureau de survie', 'Ta vue là, tout de suite',
  'Le dernier truc que tu as acheté', 'Ta boisson du moment',
  'Ton setup pour chiller', 'Lunch box ou resto', 'Ton péché mignon à moins de 5€.',
  'Le meilleur spot de street-food du quartier.',
  'Le contenu de ton frigo à J-1 des courses.', 'Ta cover Spotify du moment.',
  'Le livre que tu as sur ta table de nuit depuis 2 mois.',
  'Une capture d\'écran du dernier même qui t\'a fait rire.',
  'Un bout de ton quartier qui ressemble à un film.',
  'L\'endroit où tu te vides la tête.',
  'Le trajet que tu fais tous les jours.',
  'Un indice sur ce que tu vas faire ce soir.', 'Ton écran d\'accueil (wall paper).',
  'Le dernier message marrant que tu as reçu',
  'Un objet que tu possèdes que tout le monde trouve bizarre.',
  'Ton outfit du jour', 'Ta plante verte : vivante ou en train de mourir ?',
  'Tes chaussettes du jour.', 'Ton workspace',
  'Poste ton animal de compagnie 🐾',
];
const WALL_EPOCH = new Date('2025-05-18T00:00:00.000Z').getTime();
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function currentWallThemeIndex() {
  return Math.floor((Date.now() - WALL_EPOCH) / THREE_DAYS_MS) % WALL_THEMES.length;
}

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

        // Notify all members that their new group is ready
        const memberIds = members.map((m) => m.id);
        getTokensForUsers(memberIds, query).then((tokens) => {
          sendPush(tokens, '🎉 Ton groupe de la semaine est prêt !', `Tu as été mise en groupe autour de "${commonInterest}". Va dire bonjour !`, { type: 'group_formed' });
        }).catch(() => {});

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

async function runEventReminderCheck() {
  try {
    for (const type of ['2h', '1h']) {
      const minutes = type === '2h' ? 120 : 60;
      const { rows } = await query(
        `SELECT e.id, e.title, e.starts_at, em.user_id, u.expo_push_token
         FROM events e
         JOIN event_members em ON em.event_id = e.id
         JOIN users u ON u.id = em.user_id
         WHERE u.expo_push_token IS NOT NULL
           AND e.starts_at BETWEEN NOW() + INTERVAL '${minutes - 5} minutes'
                                AND NOW() + INTERVAL '${minutes + 5} minutes'
           AND NOT EXISTS (
             SELECT 1 FROM event_reminder_log erl
             WHERE erl.event_id = e.id AND erl.user_id = em.user_id AND erl.reminder_type = $1
           )`,
        [type]
      );

      if (rows.length === 0) continue;

      const label = type === '2h' ? 'dans 2 heures' : 'dans 1 heure';

      for (const row of rows) {
        sendPush([row.expo_push_token], `⏰ Rappel : ${row.title}`, `L'événement commence ${label} !`, { type: 'event_reminder', event_id: row.id });
        query(
          `INSERT INTO event_reminder_log (event_id, user_id, reminder_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [row.id, row.user_id, type]
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[scheduler] Event reminder error:', err);
  }
}

async function runWallThemeCheck(lastIndexRef) {
  try {
    const idx = currentWallThemeIndex();
    if (idx !== lastIndexRef.value) {
      lastIndexRef.value = idx;
      const theme = WALL_THEMES[idx];
      const { rows } = await query('SELECT expo_push_token FROM users WHERE expo_push_token IS NOT NULL');
      const tokens = rows.map((r) => r.expo_push_token);
      sendPush(tokens, '📸 Nouveau thème sur le Wall !', theme, { type: 'wall_theme' });
    }
  } catch (err) {
    console.error('[scheduler] Wall theme check error:', err);
  }
}

function startScheduler() {
  // Every Monday at 08:00, Europe/Paris timezone
  cron.schedule('0 8 * * 1', () => {
    runWeeklyGroupGeneration().catch((err) =>
      console.error('[scheduler] Unhandled error:', err)
    );
  }, { timezone: 'Europe/Paris' });

  // Every 5 minutes: check for events starting in ~1h or ~2h
  cron.schedule('*/5 * * * *', () => {
    runEventReminderCheck();
  });

  // Every hour: check if wall theme changed
  const lastWallThemeIndex = { value: currentWallThemeIndex() };
  cron.schedule('0 * * * *', () => {
    runWallThemeCheck(lastWallThemeIndex);
  });

  console.log('[scheduler] Weekly group scheduler active — runs every Monday 08:00 Europe/Paris');
  console.log('[scheduler] Event reminder cron active — runs every 5 minutes');
  console.log('[scheduler] Wall theme cron active — runs every hour');
}

module.exports = { startScheduler, runWeeklyGroupGeneration };
