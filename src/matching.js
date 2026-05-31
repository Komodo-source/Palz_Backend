/**
 * Shared matching/scoring functions used by both user discovery (users.js)
 * and group formation (groups.js).
 *
 * All features are normalized to 0..1 before weighting:
 *   Personality (interest distance) : 50% — strongest signal
 *   Common hobbies                  : 20%
 *   Common sports                   : 20%
 *   Geographic proximity            : 10%
 *   Zodiac compatibility            :  5% — soft tie-breaker only
 */

const MAX_DISTANCE_KM = 15;
const MAX_INTEREST_DISTANCE = Math.sqrt(9 * 9 * 3); // max euclidean for 1-10 scales

/** Safely parse a user's interests JSON into { sports: [], hobbies: [], ... } */
function parseInterests(interests) {
  if (!interests) return {};
  if (typeof interests === 'string') {
    try { return JSON.parse(interests); } catch { return {}; }
  }
  return interests;
}

/** Count shared items between two arrays, normalized to 0..1 */
function getCommonItems(arr1, arr2) {
  if (!Array.isArray(arr1) || !Array.isArray(arr2)) return 0;
  if (arr1.length === 0 || arr2.length === 0) return 0;
  const set2 = new Set(arr2);
  const commonCount = arr1.filter((item) => set2.has(item)).length;
  return commonCount / Math.max(arr1.length, arr2.length);
}

/** Euclidean distance of the 3 interest dimensions, normalized 0..1 (1 = identical) */
function calculateInterestDistance(central, excentrated) {
  const c = central || {};
  const e = excentrated || {};
  const se = (Number(c.social_energy) || 5) - (Number(e.social_energy) || 5);
  const ps = (Number(c.planning_style) || 5) - (Number(e.planning_style) || 5);
  const cd = (Number(c.conversation_depth) || 5) - (Number(e.conversation_depth) || 5);
  const raw = Math.sqrt(se * se + ps * ps + cd * cd);
  return 1 - raw / MAX_INTEREST_DISTANCE; // 1 = perfect match
}

/** Check zodiac-pair compatibility (returns true/false) */
function checkZodiacCompatibility(zodiacA, zodiacB) {
  if (!zodiacA || !zodiacB) return false;
  const compatiblePairs = [
    ['Bélier', 'Lion'], ['Bélier', 'Sagittaire'], ['Lion', 'Sagittaire'],
    ['Taureau', 'Vierge'], ['Taureau', 'Capricorne'], ['Vierge', 'Capricorne'],
    ['Gémeaux', 'Balance'], ['Gémeaux', 'Verseau'], ['Balance', 'Verseau'],
    ['Cancer', 'Scorpion'], ['Cancer', 'Poissons'], ['Scorpion', 'Poissons'],
    ['Bélier', 'Gémeaux'], ['Lion', 'Balance'],
    ['Vierge', 'Scorpion'], ['Taureau', 'Cancer'],
    ['Sagittaire', 'Verseau'], ['Capricorne', 'Poissons'],
  ];
  return compatiblePairs.some(
    ([a, b]) => (zodiacA === a && zodiacB === b) || (zodiacA === b && zodiacB === a)
  );
}

/** Haversine distance in km */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.07103;
  const toRad = (deg) => deg * (Math.PI / 180);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}


  async function get_weather(city){
    try{

      const apiKey = '0c27d67d5ad3c0a1e608f12a8b5180d7';
      let query = city || "Paris,FR";
      const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(query)}&units=metric&lang=fr&appid=${apiKey}`);
      if (!res.ok) throw new Error('Weather fetch failed');
      const data = await res.json();
      const humidity = data.main.humidity;
      const temperature = data.main.temp;
      return {humidity, temperature};
    }catch(err){
      return null;
    }
  }

/**
 * Score a candidate against the current user.
 * Returns a number 0..1 where higher = better match.
 */
function scoreCandidate(user, candidate, affinityBonus = 0) {
  const userInterests = parseInterests(user.interests);
  const candInterests = parseInterests(candidate.interests);

  const userSports = userInterests.sports || [];
  const userHobbies = userInterests.hobbies || [];
  const candSports = candInterests.sports || [];
  const candHobbies = candInterests.hobbies || [];

  //Personnalité avec le test fait en inscription
  const personalityScore = calculateInterestDistance(userInterests, candInterests);

  // 2. hobbies partagé
  const hobbiesScore = getCommonItems(userHobbies, candHobbies);

  // 3. sports partagé
  const sportsScore = getCommonItems(userSports, candSports);

  // 4. proximité géographique
  let distanceScore = 0;
  if (user.latitude && user.longitude && candidate.latitude && candidate.longitude) {
    const dist = haversineKm(
      parseFloat(user.latitude), parseFloat(user.longitude),
      parseFloat(candidate.latitude), parseFloat(candidate.longitude)
    );
    distanceScore = Math.max(0, 1 - dist / MAX_DISTANCE_KM);
  }

  // 5. astrology sign
  const zodiacScore = checkZodiacCompatibility(user.astrology_title, candidate.astrology_title) ? 1 : 0;

  const base = (
    personalityScore * 0.50 +
    hobbiesScore * 0.20 +
    sportsScore * 0.20 +
    distanceScore * 0.10 +
    zodiacScore * 0.05
  );
  return Math.min(1, Math.max(0, base + affinityBonus));
}

module.exports = {
  parseInterests,
  getCommonItems,
  calculateInterestDistance,
  checkZodiacCompatibility,
  haversineKm,
  scoreCandidate,
  MAX_DISTANCE_KM,
  MAX_INTEREST_DISTANCE,
  get_weather
};
