/**
 * Debug/Error detail exposure utility.
 *
 * Determines whether to expose internal error details to API responses.
 * Two mechanisms:
 *   1. Environment variable: EXPOSE_ERROR_DETAILS=true
 *   2. Request header: x-debug: true  (allows per-request debugging from frontend)
 *
 * Usage in route catch blocks:
 *   return reply.status(500).send({
 *     error: 'Internal server error',
 *     details: exposeErrorDetails(request) ? err.message : undefined,
 *   });
 */

function exposeErrorDetails(request) {
  if (process.env.NODE_ENV !== 'production') return true;
  if (process.env.EXPOSE_ERROR_DETAILS === 'true') return true;
  // Allow per-request debugging via x-debug header
  if (request?.headers?.['x-debug'] === 'true') return true;
  return false;
}

module.exports = { exposeErrorDetails };
