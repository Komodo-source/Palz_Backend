const { query } = require('../db');
const { exposeErrorDetails } = require('../debug');

async function constantDataRoutes(app) {
  app.get('/get_zodiac_sign', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {

      const result = await query(
        `SELECT id, name FROM astrology_signs;`
      );

      return reply.send({ astrology: result.rows });
    } catch (err) {
      console.error('Astrology error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/get_sports', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {

      const result = await query(
        `SELECT title FROM sports;`
      );

      return reply.send({ sports: result.rows });
    } catch (err) {
      console.error('Sport error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/get_type_search', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {

      const result = await query(
        `SELECT id, title, description FROM search_friendship;`
      );

      return reply.send({ search_types: result.rows });
    } catch (err) {
      console.error('type error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

  app.get('/get_hobbies', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {

      const result = await query(
        `SELECT title FROM hobbies;`
      );

      return reply.send({ hobbies: result.rows });
    } catch (err) {
      console.error('Hobbies error:', err);
      return reply.status(500).send({ error: 'Internal server error', details: exposeErrorDetails(request) ? err.message : undefined });
    }
  });

}

module.exports = { constantDataRoutes };
