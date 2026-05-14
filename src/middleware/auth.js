async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}

function getUserId(request) {
  const payload = request.user;
  return payload && payload.id ? payload.id : null;
}

module.exports = { authenticate, getUserId };
