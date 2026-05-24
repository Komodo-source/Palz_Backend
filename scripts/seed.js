/**
 * Test data seeder — inserts 5 users + reference data.
 * Run from Palz_Backend/: node scripts/seed.js
 * All test accounts share password: Test@1234
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const dns = require('dns').promises;

const TEST_PASSWORD = 'Test@1234';

// ── Reuse the same DNS-resolving pool logic as db.js ──────────────────────────
async function createPool() {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/palz';
  const url = new URL(connectionString);
  const isRemote = url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';

  const cfg = {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: parseInt(url.port || '5432', 10),
    database: url.pathname.slice(1) || 'postgres',
    max: 5,
    ...(isRemote ? { ssl: { rejectUnauthorized: false } } : {}),
  };

  if (isRemote) {
    let ip = null, family = 4;
    try { const a = await dns.resolve6(cfg.host); if (a.length) { ip = a[0]; family = 6; } } catch {}
    if (!ip) { try { const a = await dns.resolve4(cfg.host); if (a.length) { ip = a[0]; } } catch {} }
    if (ip) { cfg.host = ip; cfg.family = family; }
  }

  return new Pool(cfg);
}

// ── Reference data ─────────────────────────────────────────────────────────────
const ASTROLOGY_SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer',
  'Leo', 'Virgo', 'Libra', 'Scorpio',
  'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

const HOBBIES = [
  'Reading', 'Cooking', 'Traveling', 'Photography',
  'Painting', 'Yoga', 'Dancing', 'Gaming', 'Hiking', 'Music',
];

const SPORTS = [
  'Running', 'Swimming', 'Tennis', 'Basketball',
  'Volleyball', 'Cycling', 'Gym', 'Pilates',
];

const INTERESTS = [
  { title: 'Adventure', Value: 1 }, { title: 'Art',     Value: 2 },
  { title: 'Culture',   Value: 3 }, { title: 'Fashion', Value: 4 },
  { title: 'Food',      Value: 5 }, { title: 'Health',  Value: 6 },
  { title: 'Music',     Value: 7 }, { title: 'Nature',  Value: 8 },
  { title: 'Tech',      Value: 9 }, { title: 'Travel',  Value: 10 },
];

const SEARCH_TYPES = [
  { title: 'Best Friend',     description: 'Looking for a lifelong best friend' },
  { title: 'Activity Buddy',  description: 'Someone to do activities with' },
  { title: 'Study Partner',   description: 'Someone to study or work with' },
  { title: 'Casual Friend',   description: 'Casual hangouts and fun' },
];

// ── Test users ─────────────────────────────────────────────────────────────────
const TEST_USERS = [
  {
    full_name: 'Sarah Johnson', firstname: 'Sarah', surname: 'Johnson',
    user_name: 'sarah_j', email: 'sarah.test@palz.com',
    date_of_birth: '1998-03-15', location: 'Paris, France',
    latitude: '48.8566', longitude: '2.3522',
    bio: 'Coffee lover, bookworm, and weekend hiker. Looking for friends to explore the city!',
    work: 'Graphic Designer', astrology: 'Pisces', search: 'Best Friend',
    hobbies: ['Reading', 'Hiking', 'Photography'],
    sports: ['Running', 'Pilates'],
    interests: ['Art', 'Nature', 'Travel'],
  },
  {
    full_name: 'Léa Martin', firstname: 'Léa', surname: 'Martin',
    user_name: 'lea_martin', email: 'lea.test@palz.com',
    date_of_birth: '2000-07-22', location: 'Lyon, France',
    latitude: '45.7640', longitude: '4.8357',
    bio: 'Foodie and aspiring chef. Love cooking new recipes and finding hidden restaurant gems.',
    work: 'Student', astrology: 'Cancer', search: 'Activity Buddy',
    hobbies: ['Cooking', 'Music', 'Traveling'],
    sports: ['Swimming', 'Pilates'],
    interests: ['Food', 'Culture', 'Music'],
  },
  {
    full_name: 'Amara Diallo', firstname: 'Amara', surname: 'Diallo',
    user_name: 'amara_d', email: 'amara.test@palz.com',
    date_of_birth: '1996-11-05', location: 'Dakar, Senegal',
    latitude: '14.7167', longitude: '-17.4677',
    bio: 'Entrepreneur & tech enthusiast. Always looking for inspiring women to connect with.',
    work: 'Startup Founder', astrology: 'Scorpio', search: 'Study Partner',
    hobbies: ['Gaming', 'Reading', 'Traveling'],
    sports: ['Basketball', 'Running'],
    interests: ['Tech', 'Adventure', 'Culture'],
  },
  {
    full_name: 'Emma Wilson', firstname: 'Emma', surname: 'Wilson',
    user_name: 'emma_w', email: 'emma.test@palz.com',
    date_of_birth: '2001-01-30', location: 'London, UK',
    latitude: '51.5074', longitude: '-0.1278',
    bio: 'Yoga & wellness addict. Love art galleries, vintage markets, and spontaneous trips.',
    work: 'Yoga Instructor', astrology: 'Aquarius', search: 'Casual Friend',
    hobbies: ['Yoga', 'Painting', 'Traveling'],
    sports: ['Pilates', 'Cycling'],
    interests: ['Health', 'Art', 'Fashion'],
  },
  {
    full_name: 'Sofia Rossi', firstname: 'Sofia', surname: 'Rossi',
    user_name: 'sofia_r', email: 'sofia.test@palz.com',
    date_of_birth: '1999-09-12', location: 'Milan, Italy',
    latitude: '45.4654', longitude: '9.1859',
    bio: 'Fashion & photography enthusiast. Documenting life one shot at a time.',
    work: 'Fashion Photographer', astrology: 'Virgo', search: 'Activity Buddy',
    hobbies: ['Photography', 'Dancing', 'Cooking'],
    sports: ['Tennis', 'Gym'],
    interests: ['Fashion', 'Art', 'Travel'],
  },
];

// ── Seed logic ─────────────────────────────────────────────────────────────────
async function seed() {
  const pool = await createPool();
  const q = (text, params) => pool.query(text, params);

  try {
    console.log('Hashing password...');
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

    // Reference data
    console.log('Inserting reference data...');

    for (const name of ASTROLOGY_SIGNS) {
      await q(`INSERT INTO astrology_signs (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
    }
    for (const title of HOBBIES) {
      await q(`INSERT INTO hobbies (title) VALUES ($1) ON CONFLICT (title) DO NOTHING`, [title]);
    }
    for (const title of SPORTS) {
      await q(`INSERT INTO sports (title) VALUES ($1) ON CONFLICT DO NOTHING`, [title]);
    }
    for (const { title, Value } of INTERESTS) {
      await q(`INSERT INTO interests (title, "Value") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [title, Value]);
    }
    for (const { title, description } of SEARCH_TYPES) {
      await q(`INSERT INTO search_friendship (title, description) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [title, description]);
    }

    // Build lookup maps
    const signMap = Object.fromEntries((await q('SELECT id, name FROM astrology_signs')).rows.map(r => [r.name, r.id]));
    const hobbyMap = Object.fromEntries((await q('SELECT id, title FROM hobbies')).rows.map(r => [r.title, r.id]));
    const sportMap = Object.fromEntries((await q('SELECT id, title FROM sports')).rows.map(r => [r.title, r.id]));
    const interestMap = Object.fromEntries((await q('SELECT id, title FROM interests')).rows.map(r => [r.title, r.id]));
    const searchMap = Object.fromEntries((await q('SELECT id, title FROM search_friendship')).rows.map(r => [r.title, r.id]));

    // Insert users
    console.log('Inserting test users...');
    const inserted = [];

    for (const u of TEST_USERS) {
      // Remove existing test user if present (idempotent)
      await q(`DELETE FROM users WHERE email = $1`, [u.email]);

      const res = await q(
        `INSERT INTO users (
          full_name, firstname, surname, user_name, email, password,
          date_of_birth, location, latitude, longitude,
          bio, work, astrology_sign_id, id_type_searched,
          is_verified, ready_to_go, search_radius
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING id`,
        [
          u.full_name, u.firstname, u.surname, u.user_name, u.email, passwordHash,
          u.date_of_birth, u.location, u.latitude, u.longitude,
          u.bio, u.work,
          signMap[u.astrology] ?? null,
          searchMap[u.search] ?? null,
          true, true, 50,
        ]
      );

      inserted.push({ id: res.rows[0].id, ...u });
    }

    // Insert junction records
    console.log('Linking hobbies, sports and interests...');
    for (const u of inserted) {
      for (const h of u.hobbies)    if (hobbyMap[h])    await q(`INSERT INTO user_hobbies   (user_id, hobby_id)    VALUES ($1,$2)`, [u.id, hobbyMap[h]]);
      for (const s of u.sports)     if (sportMap[s])    await q(`INSERT INTO user_sports    (user_id, sport_id)    VALUES ($1,$2)`, [u.id, sportMap[s]]);
      for (const i of u.interests)  if (interestMap[i]) await q(`INSERT INTO user_interests (user_id, interest_id) VALUES ($1,$2)`, [u.id, interestMap[i]]);
    }

    console.log('\n✓ Seeded successfully!');
    console.log('─────────────────────────────────────────');
    console.log(`Password for all accounts : ${TEST_PASSWORD}`);
    console.log('─────────────────────────────────────────');
    inserted.forEach(u => console.log(`  ${u.full_name.padEnd(20)} ${u.email}`));
    console.log('─────────────────────────────────────────');
  } finally {
    await pool.end();
  }
}

seed().catch(err => { console.error('Seed failed:', err.message); process.exit(1); });
