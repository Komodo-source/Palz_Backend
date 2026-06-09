const { query } = require('../db');
const { getUserId } = require('../middleware/auth');

// RevenueCat event types that grant premium access
const RC_ACTIVATE = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION']);
// Event types that end premium access immediately
const RC_DEACTIVATE = new Set(['EXPIRATION', 'BILLING_ISSUE_DETECTED_WITHOUT_GRACE_PERIOD']);

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
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (secret && request.headers.authorization !== secret) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const event = request.body?.event;
    if (!event?.type || !event?.app_user_id) {
      return reply.status(400).send({ error: 'Invalid webhook payload' });
    }

    const userId = event.app_user_id;
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
