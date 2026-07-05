const crypto = require('crypto');
const { z } = require('zod');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');

// RevenueCat event types that grant premium access
const RC_ACTIVATE = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION']);
// Event types that end premium access immediately
const RC_DEACTIVATE = new Set(['EXPIRATION', 'BILLING_ISSUE_DETECTED_WITHOUT_GRACE_PERIOD']);

const uuidSchema = z.string().uuid();

// ── Webhook secret is MANDATORY in production ──
// Without it, anyone reaching the endpoint could grant themselves premium by
// posting a forged event with their own app_user_id.
const WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || null;
if (!WEBHOOK_SECRET && process.env.NODE_ENV === 'production') {
  console.error('[FATAL] REVENUECAT_WEBHOOK_SECRET manquant — le webhook paiements serait forgeable.');
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.warn('[WARN] REVENUECAT_WEBHOOK_SECRET manquant — webhook paiements désactivé (503).');
}

// Constant-time comparison — same pattern as the x-api-key check in index.js
function timingSafeCompare(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

async function paymentRoutes(fastify) {

  // ── GET /status ────────────────────────────────────────────────────────────
  fastify.get('/status', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const res = await query(
        'SELECT is_premium, premium_since, premium_expires_at FROM users WHERE id = $1',
        [userId]
      );
      const u = res.rows[0] || {};
      return reply.send({
        is_premium: u.is_premium || false,
        premium_since: u.premium_since || null,
        premium_expires_at: u.premium_expires_at || null,
      });
    } catch {
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ── POST /webhook ──────────────────────────────────────────────────────────
  // RevenueCat server-to-server webhook.
  // Set the shared secret in the RevenueCat dashboard → Integrations → Webhooks.
  // RevenueCat sends it as the raw Authorization header value.
  // Docs: https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
  fastify.post('/webhook', async (request, reply) => {
    // No secret configured → the webhook cannot be authenticated, so it is disabled.
    if (!WEBHOOK_SECRET) {
      return reply.status(503).send({ error: 'Webhook not configured' });
    }
    if (!request.headers.authorization || !timingSafeCompare(request.headers.authorization, WEBHOOK_SECRET)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const event = request.body?.event;
    if (!event?.type || !event?.app_user_id) {
      return reply.status(400).send({ error: 'Invalid webhook payload' });
    }

    // app_user_id must be one of our user UUIDs — reject anonymous RC ids ($RCAnonymousID:…)
    // and anything else that isn't a valid UUID before it reaches SQL.
    const parsedUserId = uuidSchema.safeParse(event.app_user_id);
    if (!parsedUserId.success) {
      // 200 so RevenueCat doesn't retry forever on events we'll never be able to process
      return reply.status(200).send({ received: true, skipped: 'app_user_id is not a known user id format' });
    }

    const userId = parsedUserId.data;
    const type = event.type;
    const expiresAt = event.expiration_at_ms
      ? new Date(event.expiration_at_ms).toISOString()
      : null;

    try {
      if (RC_ACTIVATE.has(type)) {
        // Purchase, renewal, or resubscription — grant premium until expiry
        await query(
          `UPDATE users
           SET is_premium = true,
               premium_since = COALESCE(premium_since, NOW()),
               premium_expires_at = $2
           WHERE id = $1`,
          [userId, expiresAt]
        );
      } else if (type === 'CANCELLATION') {
        // User cancelled but retains access until the billing period ends
        if (expiresAt) {
          await query(
            'UPDATE users SET premium_expires_at = $2 WHERE id = $1',
            [userId, expiresAt]
          );
        }
      } else if (RC_DEACTIVATE.has(type)) {
        await query(
          'UPDATE users SET is_premium = false, premium_expires_at = NOW() WHERE id = $1',
          [userId]
        );
      }
      // BILLING_ISSUE (grace period), SUBSCRIBER_ALIAS, TEST, TRANSFER → ignored
    } catch (err) {
      console.error('RevenueCat webhook error:', err);
      return reply.status(500).send({ error: 'Processing error' });
    }

    return reply.status(200).send({ received: true });
  });
}

module.exports = { paymentRoutes };
