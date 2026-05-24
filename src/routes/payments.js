const Stripe = require('stripe');
const { query } = require('../db');
const { getUserId } = require('../middleware/auth');
const { exposeErrorDetails } = require('../debug');

let _stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) {
    _stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

async function paymentRoutes(fastify) {

  // ── POST /create-payment-sheet ─────────────────────────────────────────────
  // Creates a Stripe Customer + monthly Subscription and returns the three
  // values needed by @stripe/stripe-react-native's initPaymentSheet.
  fastify.post('/create-payment-sheet', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);

      const userRes = await query(
        'SELECT email, full_name, stripe_customer_id, is_premium FROM users WHERE id = $1',
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) return reply.status(404).send({ error: 'User not found' });
      if (user.is_premium) return reply.status(400).send({ error: 'Already premium', already_premium: true });

      const stripe = getStripe();
      if (!stripe) {
        return reply.status(503).send({ error: 'Stripe not configured on this server' });
      }
      if (!process.env.STRIPE_PRICE_ID) {
        return reply.status(503).send({ error: 'STRIPE_PRICE_ID not set' });
      }

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

      // Ephemeral key for the Payment Sheet
      const ephemeralKey = await stripe.ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: '2024-06-20' }
      );

      // Create subscription (incomplete until payment succeeds)
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: process.env.STRIPE_PRICE_ID }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
        metadata: { palz_user_id: userId },
      });

      const paymentIntent = subscription.latest_invoice.payment_intent;

      // Persist subscription ID so we can cancel later
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
  // Called by the frontend immediately after presentPaymentSheet() succeeds.
  // Verifies the PaymentIntent with Stripe and activates premium.
  fastify.post('/confirm', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { payment_intent_id } = request.body || {};

      if (!payment_intent_id) {
        return reply.status(400).send({ error: 'payment_intent_id is required' });
      }

      const stripe = getStripe();
      if (!stripe) {
        return reply.status(503).send({ error: 'Stripe not configured on this server' });
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

      return reply.send({ activated: true });
    } catch (err) {
      console.error('confirm error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
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
      if (!stripe) {
        return reply.status(503).send({ error: 'Stripe not configured on this server' });
      }

      await stripe.subscriptions.cancel(subId);
      await query(
        'UPDATE users SET is_premium = false, stripe_subscription_id = NULL, premium_expires_at = NOW() WHERE id = $1',
        [userId]
      );

      return reply.send({ cancelled: true });
    } catch (err) {
      console.error('cancel error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  // ── POST /webhook ──────────────────────────────────────────────────────────
  // Stripe sends events here. Requires raw body for signature verification.
  // Register as a nested plugin so it gets its own content-type parser scope.
  fastify.register(async function webhookPlugin(app) {
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      done(null, body); // raw Buffer — needed for stripe.webhooks.constructEvent
    });

    app.post('/webhook', async (request, reply) => {
      const sig = request.headers['stripe-signature'];
      let event;

      if (process.env.STRIPE_WEBHOOK_SECRET && sig) {
        const stripe = getStripe();
        if (!stripe) {
          return reply.status(503).send({ error: 'Stripe not configured on this server' });
        }
        try {
          event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
          console.error('Webhook signature error:', err.message);
          return reply.status(400).send(`Webhook Error: ${err.message}`);
        }
      } else {
        // Dev mode — no signature verification
        try { event = JSON.parse(request.body.toString()); }
        catch { return reply.status(400).send('Invalid JSON'); }
      }

      try {
        switch (event.type) {
          case 'invoice.payment_succeeded': {
            const invoice = event.data.object;
            if (['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason)) {
              await query(
                `UPDATE users
                 SET is_premium = true,
                     premium_since = COALESCE(premium_since, NOW()),
                     premium_expires_at = NOW() + INTERVAL '1 month'
                 WHERE stripe_customer_id = $1`,
                [invoice.customer]
              );
            }
            break;
          }
          case 'invoice.payment_failed': {
            const invoice = event.data.object;
            // Let the user keep premium until the period ends — Stripe will retry
            console.warn('Payment failed for customer:', invoice.customer);
            break;
          }
          case 'customer.subscription.deleted': {
            const sub = event.data.object;
            await query(
              'UPDATE users SET is_premium = false, stripe_subscription_id = NULL WHERE stripe_customer_id = $1',
              [sub.customer]
            );
            break;
          }
          case 'customer.subscription.updated': {
            const sub = event.data.object;
            if (sub.status === 'active') {
              await query('UPDATE users SET is_premium = true WHERE stripe_customer_id = $1', [sub.customer]);
            } else if (['canceled', 'unpaid'].includes(sub.status)) {
              await query('UPDATE users SET is_premium = false WHERE stripe_customer_id = $1', [sub.customer]);
            }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        console.error('Webhook handler error:', err);
      }

      return reply.send({ received: true });
    });
  });
}

module.exports = { paymentRoutes };
