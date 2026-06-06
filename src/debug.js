function exposeErrorDetails(request) {
  if (process.env.NODE_ENV !== 'production') return true;
  if (process.env.EXPOSE_ERROR_DETAILS === 'true') return true;
  return false;
}

module.exports = { exposeErrorDetails };
