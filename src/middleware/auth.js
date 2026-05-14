function getUserId(request) {
  const payload = request.user;
  return payload ? payload.id : null;
}

module.exports = { getUserId };
