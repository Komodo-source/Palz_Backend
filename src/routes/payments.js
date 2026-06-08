const Stripe = require('stripe');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');

let _stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// PaymentIntent states where the user can still complete payment
const PI_RETRYABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

async function paymentRoutes(fastify) {

  // ── POST /create-payment-sheet ─────────────────────────────────────────────
  // Idempotent: if the user already has a pending payment intent (e.g. they
  // timed out mid-flow), the same client_secret is returned so they resume the
  // same charge rather than getting billed a second time.
  fastify.post('/create-payment-sheet', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { idempotency_key } = request.body || {};

      if (!idempotency_key || typeof idempotency_key !== 'string' || idempotency_key.length > 128) {
        return reply.status(400).send({ error: 'idempotency_key is required (max 128 chars)' });
      }

      const userRes = await query(
        'SELECT email, full_name, stripe_customer_id, is_premium FROM users WHERE id = $1',
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) return reply.status(404).send({ error: 'User not found' });
      if (user.is_premium) return reply.status(400).send({ error: 'Already premium', already_premium: true });

      const stripe = getStripe();
      if (!stripe) return reply.status(503).send({ error: 'Stripe not configured on this server' });
      if (!process.env.STRIPE_PRICE_ID) return reply.status(503).send({ error: 'STRIPE_PRICE_ID not set' });

      // ── Check for any active (non-terminal) payment event for this user ───
      // This is the core idempotency guard: if the user timed out mid-payment,
      // we reuse the existing PaymentIntent instead of creating a new charge.
      const activeRes = await query(
        `SELECT * FROM payment_events
         WHERE user_id = $1 AND status IN ('initiated', 'processing')
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );

      if (activeRes.rows.length > 0) {
        const evt = activeRes.rows[0];

        if (evt.stripe_payment_intent_id) {
          try {
            const pi = await stripe.paymentIntents.retrieve(evt.stripe_payment_intent_id);

            if (pi.status === 'succeeded') {
              // PI already succeeded (e.g. confirm endpoint was missed) — activate premium now
              await query(
                `UPDATE users
                 SET is_premium = true,
                     premium_since = COALESCE(premium_since, NOW()),
                     premium_expires_at = NOW() + INTERVAL '1 month'
                 WHERE id = $1`,
                [userId]
              );
              await query(
                `UPDATE payment_events SET status = 'succeeded', updated_at = NOW() WHERE id = $1`,
                [evt.id]
              );
              return reply.status(400).send({ error: 'Already premium', already_premium: true });
            }

            if (PI_RETRYABLE.has(pi.status)) {
              // Safe to resume: return the same PI so no second charge is created
              const ephemeralKey = await stripe.ephemeralKeys.create(
                { customer: evt.stripe_customer_id },
                { apiVersion: '2024-06-20' }
              );
              return reply.send({
                paymentIntent: pi.client_secret,
                ephemeralKey: ephemeralKey.secret,
                customer: evt.stripe_customer_id,
              });
            }

            // PI is in a terminal failure state — mark it and fall through to create new
            await query(
              `UPDATE payment_events SET status = 'failed', updated_at = NOW() WHERE id = $1`,
              [evt.id]
            );
          } catch (stripeErr) {
            console.warn('Could not retrieve existing PI from Stripe:', stripeErr.message);
            // Fall through and create a new attempt
          }
        }
      }

      // ── Create new payment attempt ─────────────────────────────────────────

      // Get or create Stripe Customer
      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.full_name || undefined,
          metadata: { palz_user_id: userId },
        });
        customerId = customer.id;
        await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, userId]);
      }

      // Insert payment_events row BEFORE calling Stripe so the record exists
      // even if the process crashes between the Stripe call and the UPDATE below.
      await query(
        `INSERT INTO payment_events (idempotency_key, user_id, stripe_customer_id, status)
         VALUES ($1, $2, $3, 'initiated')
         ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()`,
        [idempotency_key, userId, customerId]
      );

      const ephemeralKey = await stripe.ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: '2024-06-20' }
      );

      // Use the frontend-supplied idempotency key as Stripe's idempotency key
      // so repeated retries with the same key never create duplicate subscriptions.
      const subscription = await stripe.subscriptions.create(
        {
          customer: customerId,
          items: [{ price: process.env.STRIPE_PRICE_ID }],
          payment_behavior: 'default_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription' },
          metadata: { palz_user_id: userId },
        },
        { idempotencyKey: `sub_${idempotency_key}` }
      );

      // Fetch the invoice explicitly — nested expand on subscription create is unreliable
      const invoiceId = typeof subscription.latest_invoice === 'string'
        ? subscription.latest_invoice
        : subscription.latest_invoice?.id;

      if (!invoiceId) {
        return reply.status(500).send({ error: 'Stripe n\'a pas créé de facture pour cet abonnement.' });
      }

      const invoice = await stripe.invoices.retrieve(invoiceId, {
        expand: ['payment_intent'],
      });

      let paymentIntent = invoice.payment_intent;

      // payment_intent might still be a string if expand didn't work
      if (typeof paymentIntent === 'string') {
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent);
      }

      if (!paymentIntent) {
        // Subscription may already be active (trial, $0, or auto-charged card on file)
        if (subscription.status === 'active') {
          await query(
            `UPDATE users SET is_premium = true, premium_since = COALESCE(premium_since, NOW()), premium_expires_at = NOW() + INTERVAL '1 month' WHERE id = $1`,
            [userId]
          );
          await query(
            `UPDATE payment_events SET status = 'succeeded', updated_at = NOW() WHERE idempotency_key = $1`,
            [idempotency_key]
          );
          return reply.send({ activated: true });
        }
        return reply.status(500).send({ error: 'Paiement non initialisé par Stripe. Réessaie.' });
      }

      await query(
        `UPDATE payment_events
         SET stripe_subscription_id = $1,
             stripe_payment_intent_id = $2,
             status = 'processing',
             updated_at = NOW()
         WHERE idempotency_key = $3`,
        [subscription.id, paymentIntent.id, idempotency_key]
      );
      await query('UPDATE users SET stripe_subscription_id = $1 WHERE id = $2', [subscription.id, userId]);

      return reply.send({
        paymentIntent: paymentIntent.client_secret,
        ephemeralKey: ephemeralKey.secret,
        customer: customerId,
      });
    } catch (err) {
      console.error('create-payment-sheet error:', err);
      return reply.status(500).send({
        error: err.message || 'Internal server error',
        details: exposeErrorDetails(request) ? err.stack : undefined,
      });
    }
  });

  // ── POST /confirm ──────────────────────────────────────────────────────────
  // Fast-path called by the frontend right after presentPaymentSheet() succeeds.
  // Verifies the PI belongs to the requesting user before activating premium.
  fastify.post('/confirm', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { payment_intent_id } = request.body || {};

      if (!payment_intent_id) {
        return reply.status(400).send({ error: 'payment_intent_id is required' });
      }

      const stripe = getStripe();
      if (!stripe) return reply.status(503).send({ error: 'Stripe not configured on this server' });

      // Verify this PI was created for the authenticated user
      const evtRes = await query(
        'SELECT id FROM payment_events WHERE stripe_payment_intent_id = $1 AND user_id = $2',
        [payment_intent_id, userId]
      );
      if (evtRes.rows.length === 0) {
        return reply.status(403).send({ error: 'Payment intent not found for this user' });
      }

      const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
      if (pi.status !== 'succeeded') {
        return reply.status(402).send({ error: 'Payment not yet confirmed', status: pi.status });
      }

      await query(
        `UPDATE users
         SET is_premium = true,
             premium_since = COALESCE(premium_since, NOW()),
             premium_expires_at = NOW() + INTERVAL '1 month'
         WHERE id = $1`,
        [userId]
      );
      await query(
        `UPDATE payment_events
         SET status = 'succeeded', stripe_event_type = 'frontend_confirm', updated_at = NOW()
         WHERE stripe_payment_intent_id = $1`,
        [payment_intent_id]
      );

      return reply.send({ activated: true });
    } catch (err) {
      console.error('confirm error:', err);
      return reply.status(500).send({
        error: 'Internal server error',
        details: exposeErrorDetails(request) ? err.message : undefined,
      });
    }
  });

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
    } catch (err) {
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ── POST /cancel ───────────────────────────────────────────────────────────
  fastify.post('/cancel', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const res = await query('SELECT stripe_subscription_id FROM users WHERE id = $1', [userId]);
      const subId = res.rows[0]?.stripe_subscription_id;

      if (!subId) return reply.status(404).send({ error: 'No active subscription found' });

      const stripe = getStripe();
      if (!stripe) return reply.status(503).send({ error: 'Stripe not configured on this server' });

      await stripe.subscriptions.cancel(subId);
      await query(
        `UPDATE users
         SET is_premium = false, stripe_subscription_id = NULL, premium_expires_at = NOW()
         WHERE id = $1`,
        [userId]
      );
      await query(
        `UPDATE payment_events
         SET status = 'canceled', stripe_event_type = 'user_canceled', updated_at = NOW()
         WHERE stripe_subscription_id = $1 AND status NOT IN ('failed', 'canceled')`,
        [subId]
      );

      return reply.send({ cancelled: true });
    } catch (err) {
      console.error('cancel error:', err);
      return reply.status(500).send({
        error: 'Internal server error',
        details: exposeErrorDetails(request) ? err.message : undefined,
      });
    }
  });

}

module.exports = { paymentRoutes };
