const { Pool } = require('pg');
const dns = require('dns').promises;
const dotenv = require('dotenv');

dotenv.config();

// Pre-resolve DB hostname because Node's dns.lookup (getaddrinfo) fails
// for IPv6-only hostnames, but dns.resolve6 (c-ares) works fine.
async function createPool() {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/palz';
  const url = new URL(connectionString);

  const isRemote = url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';

  const poolConfig = {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: parseInt(url.port || '5432', 10),
    database: url.pathname.slice(1) || 'postgres',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Supabase requires SSL for remote connections
    ...(isRemote ? { ssl: { rejectUnauthorized: false } } : {}),
  };

  // Resolve remote hostnames via c-ares (dns.resolve*) instead of getaddrinfo (dns.lookup)
  if (isRemote) {
    let ip = null;
    let family = 4;
    try {
      const addrs = await dns.resolve6(poolConfig.host);
      if (addrs.length > 0) { ip = addrs[0]; family = 6; }
    } catch { /* no IPv6 */ }
    if (!ip) {
      try {
        const addrs = await dns.resolve4(poolConfig.host);
        if (addrs.length > 0) { ip = addrs[0]; family = 4; }
      } catch { /* no IPv4 */ }
    }
    if (ip) {
      console.log(`DB host resolved: ${poolConfig.host} -> ${ip} (IPv${family})`);
      poolConfig.host = ip;
      poolConfig.family = family;
    }
  }

  return new Pool(poolConfig);
}

// Async pool init — wraps everything so query() always has a valid pool
let _poolReady = null;
let _pool = null;

function getPool() {
  if (!_poolReady) {
    _poolReady = createPool().then((p) => {
      _pool = p;
      _pool.on('error', (err) => {
        console.error('Unexpected error on idle client', err);
      });
      return _pool;
    });
  }
  return _poolReady;
}

async function query(text, params) {
  const pool = await getPool();
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;

  if (process.env.NODE_ENV !== 'production') {
    console.log('Executed query', { text: text.substring(0, 80), duration, rows: res.rowCount });
  }

  return res;
}

async function getClient() {
  const pool = await getPool();
  const client = await pool.connect();
  return client;
}

async function withTransaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, getClient, withTransaction, get pool() { return _pool; } };
