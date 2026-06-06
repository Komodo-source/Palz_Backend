const EXPO_PUSH_URL = 'https://exp.host/api/v2/push/send';

async function sendPush(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;
  const valid = tokens.filter((t) => t && typeof t === 'string');
  if (valid.length === 0) return;

  const messages = valid.map((token) => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
  }));

  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!res.ok) console.error('[push] HTTP', res.status, await res.text());
    } catch (err) {
      console.error('[push] Network error:', err.message);
    }
  }
}

async function getTokensForUsers(userIds, queryFn) {
  if (!userIds || userIds.length === 0) return [];
  const result = await queryFn(
    `SELECT expo_push_token FROM users WHERE id = ANY($1::uuid[]) AND expo_push_token IS NOT NULL`,
    [userIds]
  );
  return result.rows.map((r) => r.expo_push_token);
}

module.exports = { sendPush, getTokensForUsers };
