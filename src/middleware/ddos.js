'use strict';

/**
 * In-process DDoS / abuse protection.
 *
 * Flow per request:
 *   1. IP banned?          → 429 immediately, Retry-After header
 *   2. Count in window     → if over MAX_PER_WINDOW, add a strike
 *   3. Strikes >= MAX      → temp ban for BAN_MS
 *
 * Also exported: strikeIp() — called by @fastify/rate-limit's onExceeded so
 * both layers share the same strike counter.
 */

const store = new Map(); // ip → { windowStart, count, strikes, bannedUntil }

const WINDOW_MS      = 10_000;       // 10-second sliding window
const MAX_PER_WINDOW = 55;           // requests tolerated per window per IP
const MAX_STRIKES    = 3;            // strikes before a temp ban
const BAN_MS         = 15 * 60_000; // 15-minute ban
const CLEANUP_MS     =  5 * 60_000; // store GC interval

// IPs that are never throttled (loopback + optional env whitelist)
const WHITELIST = new Set([
  '127.0.0.1', '::1', '::ffff:127.0.0.1',
  ...(process.env.DDOS_IP_WHITELIST ?? '').split(',').map(s => s.trim()).filter(Boolean),
]);

// Periodic cleanup — removes entries idle for more than 2 windows after ban expired
const _gc = setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of store) {
    if (s.bannedUntil < now && now - s.windowStart > WINDOW_MS * 2) store.delete(ip);
  }
}, CLEANUP_MS);
_gc.unref(); // don't prevent process exit

// ── Helpers ────────────────────────────────────────────────────────────────

function getIp(request) {
  // Render and most reverse proxies populate x-forwarded-for
  const fwd = request.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return request.socket?.remoteAddress ?? 'unknown';
}

function sendBanned(reply, remainingMs) {
  const sec = Math.ceil(remainingMs / 1000);
  reply.header('Retry-After', String(sec));
  return reply.status(429).send({
    error: 'Trop de requêtes. Réessaie dans quelques minutes.',
    retry_after_seconds: sec,
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a strike against an IP (e.g. from @fastify/rate-limit onExceeded).
 * Returns true if the IP is now banned.
 */
function strikeIp(ip) {
  if (WHITELIST.has(ip)) return false;
  const now = Date.now();
  const s = store.get(ip) ?? { windowStart: now, count: 0, strikes: 0, bannedUntil: 0 };
  s.strikes++;
  store.set(ip, s);
  if (s.strikes >= MAX_STRIKES) {
    s.bannedUntil = now + BAN_MS;
    console.warn(`[DDoS] IP banned for ${BAN_MS / 60000} min: ${ip} (${s.strikes} strikes)`);
    return true;
  }
  console.warn(`[DDoS] Strike ${s.strikes}/${MAX_STRIKES} — IP: ${ip}`);
  return false;
}

/**
 * Fastify onRequest hook — register as the very first hook so banned IPs
 * are rejected before any business logic runs.
 *
 * app.addHook('onRequest', ddosHook)
 */
async function ddosHook(request, reply) {
  const ip = getIp(request);
  if (WHITELIST.has(ip)) return;

  const now = Date.now();
  let s = store.get(ip);

  // ── Active ban ────────────────────────────────────────────────────────────
  if (s?.bannedUntil > now) return sendBanned(reply, s.bannedUntil - now);

  // ── Init or reset expired window ──────────────────────────────────────────
  if (!s || now - s.windowStart > WINDOW_MS) {
    s = { windowStart: now, count: 0, strikes: s?.strikes ?? 0, bannedUntil: 0 };
    store.set(ip, s);
  }

  s.count++;

  // ── Window overflow → strike ──────────────────────────────────────────────
  if (s.count > MAX_PER_WINDOW) {
    const banned = strikeIp(ip);
    // Reset counter for next window regardless of ban
    s.count = 0;
    s.windowStart = now;
    store.set(ip, s);
    if (banned) return sendBanned(reply, BAN_MS);
  }
}

module.exports = { ddosHook, strikeIp, getIp, store };
