const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');
const { sendPush, getTokensForUsers } = require('../services/push');

const sendMessageSchema = z.object({
  conversation_id: z.string().uuid(),
  content: z.string().max(5000).default(''),
  message_type: z.string().default('text').optional(),
  media_url: z.string().url().nullable().optional(),
  reply_to_message: z.string().uuid().nullable().optional(),
}).refine(
  (data) => data.content.trim().length > 0 || (data.media_url && data.media_url.length > 0),
  { message: 'Message must have content or media_url' }
);

const IceBreakerSchema = z.object({
  UserId: z.string().uuid(),
  targetUserId: z.string().uuid(),
});


const streakSchema = z.object({
  conversationId: z.string().uuid(),
});


const ICE_BREAKER = {
    "Yoga": [
      "Tu pratiques plutôt le Hatha, le Vinyasa ou l'Ashtanga ?",
      "Fais-tu du yoga principalement pour la souplesse ou pour la méditation ?",
      "As-tu déjà fait une retraite de yoga ?"
    ],
    "Pilates": [
      "Tu pratiques sur tapis ou sur machine comme le Reformer ?",
      "As-tu remarqué une vraie différence sur ta posture depuis que tu as commencé ?",
      "Qu'est-ce qui t'a poussé à essayer le Pilates au départ ?"
    ],
    "Escalade": [
      "Tu fais plutôt du bloc en salle ou de la voie en extérieur ?",
      "Quel est le niveau ou la cotation que tu essaies de passer en ce moment ?",
      "Quel est ton spot de grimpe rêvé dans le monde ?"
    ],
    "Randonnée": [
      "Quel est le plus beau chemin ou GR que tu aies fait ?",
      "Tu pars plutôt pour la journée ou sur plusieurs jours avec bivouac ?",
      "Préfères-tu la moyenne montagne ou les sentiers côtiers ?"
    ],
    "Danse": [
      "Quel style de danse pratiques-tu ?",
      "Tu as commencé la danse quand tu étais enfant ou sur le tard ?",
      "Quelle est la chorégraphie ou le spectacle qui t'a le plus impressionné(e) ?"
    ],
    "Fitness": [
      "Tu as une routine plutôt axée cardio ou renforcement musculaire ?",
      "Tu t'entraînes en salle ou à la maison ?",
      "Quels sont tes objectifs sportifs du moment ?"
    ],
    "Photographie": [
      "Tu shootes plutôt au smartphone, au réflex numérique ou à l'argentique ?",
      "Quel est ton sujet préféré : paysages, portraits ou street photo ?",
      "As-tu une photo dont tu es particulièrement fier/fière ?"
    ],
    "Cuisine": [
      "Quel est le plat 'signature' que tu cuisines pour tes invités ?",
      "Tu es plutôt bec sucré ou bec salé quand tu cuisines ?",
      "Quelle cuisine du monde aimes-tu le plus préparer ?"
    ],
    "Lecture": [
      "Quel est le dernier livre que tu as dévoré ?",
      "Tu préfères les romans de fiction, les essais ou les biographies ?",
      "Tu es plutôt livre papier ou liseuse électronique ?"
    ],
    "Tennis": [
      "As-tu suivi le dernier Roland-Garros ?",
      "Tu préfères jouer sur terre battue, sur gazon ou sur dur ?",
      "Quel est ton joueur ou ta joueuse de légende préféré ?"
    ],
    "Course à pied": [
      "Tu prépares un marathon ou un semi en ce moment ?",
      "Tu es plutôt course en nature (trail) ou sur route ?",
      "Quel est ton record personnel ou ta distance de prédilection ?"
    ],
    "Natation": [
      "Tu nages plutôt en piscine ou tu aimes l'eau libre ?",
      "Quelle est ta nage de spécialité ?",
      "Combien de longueurs fais-tu en moyenne par séance ?"
    ],
    "Cyclisme": [
      "Tu es plutôt vélo de route, VTT ou gravel ?",
      "As-tu suivi les étapes du Tour de France cette année ?",
      "Quel est le col ou le parcours le plus difficile que tu aies grimpé ?"
    ],
    "Football": [
      "Quelle est ton équipe de cœur ?",
      "Tu joues plutôt en club ou juste entre amis le dimanche ?",
      "Quel est le plus beau but que tu aies vu en direct à la télé ou au stade ?"
    ],
    "Basketball": [
      "Tu suis plutôt la NBA ou le championnat européen ?",
      "Tu joues à quel poste sur le terrain ?",
      "Qui est le meilleur joueur de tous les temps selon toi, Jordan ou LeBron ?"
    ],
    "Volleyball": [
      "Tu joues en salle ou tu préfères le beach-volley l'été ?",
      "Quel est ton poste de prédilection : passeur, attaquant ou libéro ?",
      "As-tu déjà assisté à un match de volley professionnel ?"
    ],
    "Arts martiaux": [
      "Quelle discipline pratiques-tu exactement ?",
      "Depuis combien de temps es-tu sur les tatamis ?",
      "As-tu déjà fait de la compétition ?"
    ],
    "Ski": [
      "Tu es plutôt ski alpin, ski de fond ou snowboard ?",
      "Quelle est ta station de ski préférée ?",
      "Tu as déjà fait du hors-piste ou tu restes sagement sur les pistes rouges ?"
    ],
    "Surf": [
      "Quel est le meilleur spot où tu aies surfé ?",
      "Tu préfères les longboards ou les shortboards ?",
      "As-tu déjà fait un 'surf trip' à l'étranger ?"
    ]
};

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
      const limit = Math.min(parseInt(request.query.limit, 10) || 50, 100);
      const offset = Math.max(parseInt(request.query.offset, 10) || 0, 0);

      const result = await query(
        `SELECT
           pc.id, pc.streak,
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
         ORDER BY last_msg.created_at DESC NULLS LAST
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return reply.send({ conversations: result.rows, has_more: result.rows.length === limit });
    } catch (err) {
      console.error('Conversations error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });


  app.post('/update_streak', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = streakSchema.parse(request.body);
      const conversation_id = body.conversationId;

      const result = await query(
        `SELECT streak, streak_last_date FROM personal_conversations WHERE id = $1`,
        [conversation_id]
      );
      const row = result.rows[0];
      if (!row) return reply.status(404).send({ error: 'Conversation not found' });

      // Compare dates at day granularity using Postgres DATE type
      const todayResult = await query(`SELECT CURRENT_DATE AS today`);
      const today = todayResult.rows[0].today; // 'YYYY-MM-DD' string

      const lastDate = row.streak_last_date
        ? new Date(row.streak_last_date).toISOString().split('T')[0]
        : null;

      if (lastDate === today) {
        return reply.send({ streak: row.streak });
      }

      let newStreak;
      if (!lastDate) {
        newStreak = 1;
      } else {
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        newStreak = lastDate === yesterday ? row.streak + 1 : 1;
      }

      await query(
        `UPDATE personal_conversations
         SET streak = $1, streak_last_date = CURRENT_DATE, updated_at = NOW()
         WHERE id = $2`,
        [newStreak, conversation_id]
      );

      return reply.send({ streak: newStreak });
    } catch (err) {
      console.error('Update streak error:', err);
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


  app.post('/generate_personnal_iceBreaker', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { other_user_id } = request.body || {};
      if (!other_user_id) {
        return reply.status(400).send({ error: 'other_user_id is required' });
      }

      const FALLBACK = [
        "Qu'est-ce qui t'a donné le sourire cette semaine ?",
        "Si tu pouvais voyager quelque part ce week-end, où irais-tu ?",
        "Quel est ton restaurant ou café préféré du moment ?",
        "Qu'est-ce que tu fais pour décompresser après une longue journée ?",
        "Tu as découvert quelque chose de cool dernièrement ?",
        "Ta série ou film du moment ?",
        "Un truc que tu as appris récemment qui t'a surprise ?",
      ];

      const [sportsRes, hobbiesRes] = await Promise.all([
        query(
          `SELECT s.title FROM user_sports us JOIN sports s ON s.id = us.sport_id WHERE us.user_id = $1`,
          [other_user_id]
        ),
        query(
          `SELECT h.title FROM user_hobbies uh JOIN hobbies h ON h.id = uh.hobby_id WHERE uh.user_id = $1`,
          [other_user_id]
        ),
      ]);

      const topics = [
        ...sportsRes.rows.map(r => r.title),
        ...hobbiesRes.rows.map(r => r.title),
      ].filter(t => ICE_BREAKER[t]);

      let message;
      if (topics.length > 0) {
        const topic = topics[Math.floor(Math.random() * topics.length)];
        const questions = ICE_BREAKER[topic];
        message = questions[Math.floor(Math.random() * questions.length)];
      } else {
        message = FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
      }

      return reply.status(201).send({ message });
    } catch (err) {
      console.error('Ice breaker error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  })


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

      const msgType = body.message_type || 'text';
      const mediaUrlJson = body.media_url ? JSON.stringify(body.media_url) : null;
      const result = await query(
        `INSERT INTO messages (sender_id, conversation_id, content, message_type, media_url, reply_to_message)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, sender_id, conversation_id, content, message_type,
                   media_url, is_seen, reply_to_message, created_at`,
        [
          userId,
          body.conversation_id,
          body.content || '',
          msgType,
          mediaUrlJson,
          body.reply_to_message || null,
        ]
      );

      await query(
        'UPDATE personal_conversations SET updated_at = NOW() WHERE id = $1',
        [body.conversation_id]
      );

      // Notify recipient (fire-and-forget)
      const conv = convCheck.rows[0];
      const recipientId = conv.user_initiator === userId ? conv.user_receiver : conv.user_initiator;
      query('SELECT full_name FROM users WHERE id = $1', [userId]).then(async (r) => {
        const name = r.rows[0]?.full_name || 'Quelqu\'un';
        const tokens = await getTokensForUsers([recipientId], query);
        const preview = body.content?.trim() || '📷';
        sendPush(tokens, name, preview, { type: 'message', conversation_id: body.conversation_id });
      }).catch(() => {});

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
