const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function loadCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    let json = raw.trim();
    if (!json.startsWith('{')) json = Buffer.from(json, 'base64').toString('utf8');
    return JSON.parse(json);
  }
  const localPath = path.join(__dirname, '..', 'firebase-service-account.json');
  if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  throw new Error('FIREBASE_SERVICE_ACCOUNT env var or local firebase-service-account.json is missing');
}

const GOAL_API_KEY = (process.env.GOAL_API_KEY || '').trim();
if (!GOAL_API_KEY) throw new Error('GOAL_API_KEY env var is missing');

const BASE_URL = 'https://api.goal-api.com/v1';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

const LEAGUES = [
  { leagueId: 233, nanoid: 'cmr77dwd000irrx06go0ax033', arabicName: 'الدوري المصري الممتاز', country: 'Egypt' },
  { leagueId: 307, nanoid: 'cmr77dvw600b9rx06euixf818', arabicName: 'دوري روشن السعودي', country: 'Saudi Arabia' },
  { leagueId: 12,  nanoid: 'cmr77dvhg0016rx06xwyoefu1', arabicName: 'دوري أبطال أفريقيا', country: 'Africa' },
  { leagueId: 20,  nanoid: 'cmr77dvhg0017rx06rkze534u', arabicName: 'كأس الكونفدرالية الأفريقية', country: 'Africa' },
  { leagueId: 17,  nanoid: 'cmr77dvhf0014rx06p9obts02', arabicName: 'دوري أبطال آسيا للنخبة', country: 'Asia' },
  { leagueId: 2,   nanoid: 'cmr77dw3900f5rx06j05wgzv4', arabicName: 'دوري أبطال أوروبا', country: 'Europe' },
  { leagueId: 3,   nanoid: 'cmr77dw3900f6rx06tuqwft2d', arabicName: 'الدوري الأوروبي', country: 'Europe' },
  { leagueId: 6,   nanoid: 'cmr77dvhf0015rx069i57rsbo', arabicName: 'كأس الأمم الأفريقية', country: 'Africa' },
  { leagueId: 32,  nanoid: 'cmr77dvhg001srx060axumqos', arabicName: 'تصفيات كأس الأمم الأفريقية', country: 'Africa' },
  { leagueId: 403, nanoid: 'cmr77dw4800ferx06u57oohrh', arabicName: 'كأس الأمم الأوروبية', country: 'Europe' },
  { leagueId: 8,   nanoid: 'cmr77dvhg001drx06ru2azvov', arabicName: 'كأس آسيا', country: 'Asia' },
  { leagueId: 1,   nanoid: 'cmr77dw4s00fmrx069yvhf8ce', arabicName: 'كأس العالم', country: 'World' },
  { leagueId: 452, nanoid: 'cmr77dvhg0022rx06ee0umcpy', arabicName: 'كأس العرب', country: 'Arab' },
  { leagueId: 39,  nanoid: 'cmr77dvkr005nrx06lp7rvp49', arabicName: 'الدوري الإنجليزي الممتاز', country: 'England' },
  { leagueId: 140, nanoid: 'cmr77dvnt006nrx063v3w622e', arabicName: 'الدوري الإسباني', country: 'Spain' },
  { leagueId: 135, nanoid: 'cmr77dvpd006yrx06zig7907g', arabicName: 'الدوري الإيطالي', country: 'Italy' },
  { leagueId: 78,  nanoid: 'cmr77dvgm0002rx06rt2uqxii', arabicName: 'الدوري الألماني', country: 'Germany' },
  { leagueId: 61,  nanoid: 'cmr77dvqg007crx06q1kaceyo', arabicName: 'الدوري الفرنسي', country: 'France' },
];

function stableId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h & 0x7fffffff) || 1;
}

function isTruthy(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['true', '1', 'yes'].includes(v.trim().toLowerCase());
  return false;
}

function mapStatus(raw, liveFlag) {
  if (liveFlag) return 'LIVE';
  const s = String(raw || '').trim().toUpperCase();
  if (['LIVE', 'IN_PLAY', '1H', '2H', 'HT', 'ET', 'FIRST_HALF', 'SECOND_HALF', 'HALF_TIME'].includes(s)) return 'LIVE';
  if (['FINISHED', 'FT', 'AET', 'PEN', 'AFTER_PEN', 'AFTER_ET', 'AWARDED'].includes(s)) return 'FINISHED';
  if (['POSTPONED', 'PST', 'SUSP', 'SUSPENDED'].includes(s)) return 'POSTPONED';
  if (['CANCELLED', 'CANC', 'ABD', 'ABANDONED', 'WO'].includes(s)) return 'CANCELLED';
  return 'UPCOMING';
}

function extractArray(root, nestedKey) {
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== 'object') return [];
  const data = root.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data[nestedKey])) return data[nestedKey];
    if (Array.isArray(data.items)) return data.items;
  }
  return Array.isArray(root[nestedKey]) ? root[nestedKey] : [];
}

async function fetchJson(url) {
  const res = await axios.get(url, {
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${GOAL_API_KEY}`,
      Accept: 'application/json',
    },
  });
  if (res.data && res.data.success === false) {
    throw new Error(res.data.error?.message || 'Goal API error');
  }
  return res.data;
}

function parseFixture(obj, league, nowMs) {
  const rawId = String(obj.id || '').trim();
  if (!rawId) return null;
  const homeObj = obj.homeTeam || {};
  const awayObj = obj.awayTeam || {};
  const homeName = String(obj.homeTeamName || homeObj.name || '').trim();
  const awayName = String(obj.awayTeamName || awayObj.name || '').trim();
  if (!homeName || !awayName) return null;

  const kickoff = String(obj.kickoffUtc || obj.kickoff_utc || obj.date || '');
  const tIdx = kickoff.indexOf('T');
  const datePart = tIdx >= 0 ? kickoff.slice(0, tIdx) : kickoff;
  const date = datePart.length >= 10 ? datePart.slice(0, 10) : '';
  const time = tIdx >= 0 ? (kickoff.slice(tIdx + 1, tIdx + 6) || '17:00') : '17:00';

  const status = mapStatus(obj.matchStatus || obj.status, isTruthy(obj.matchLive));
  const homeScore = obj.homeTeamScore ?? obj.homeScore ?? null;
  const awayScore = obj.awayTeamScore ?? obj.awayScore ?? null;
  const minute = String(obj.matchElapsed || obj.minute || '').trim() || null;
  const stadium = String(obj.matchStadium || obj.stadium || obj.venue || '').trim() || 'غير محدد';
  const homeLogo = String(obj.teamHomeBadge || obj.homeTeamLogo || homeObj.badge || homeObj.logo || '');
  const awayLogo = String(obj.teamAwayBadge || obj.awayTeamLogo || awayObj.badge || awayObj.logo || '');

  return {
    id: stableId(`${league.leagueId}_${rawId}`),
    leagueId: league.leagueId,
    leagueName: league.arabicName,
    leagueCountry: league.country,
    homeTeamId: stableId(homeName),
    homeTeamName: homeName,
    homeTeamLogo: homeLogo,
    awayTeamId: stableId(awayName),
    awayTeamName: awayName,
    awayTeamLogo: awayLogo,
    homeScore: homeScore !== null ? Number(homeScore) : null,
    awayScore: awayScore !== null ? Number(awayScore) : null,
    status,
    minute,
    date,
    time,
    stadium,
    channel: 'غير محدد',
    commentator: 'غير محدد',
    savedAt: nowMs,
  };
}

function parseStanding(obj, leagueId, fallbackRank) {
  const teamObj = obj.team || {};
  const teamName = String(obj.teamName || teamObj.name || '').trim();
  if (!teamName) return null;
  const played = Number(obj.overallLeaguePlayed ?? obj.played ?? 0);
  const win = Number(obj.overallLeagueW ?? obj.won ?? obj.win ?? 0);
  const draw = Number(obj.overallLeagueD ?? obj.drawn ?? obj.draw ?? 0);
  const loss = Number(obj.overallLeagueL ?? obj.lost ?? obj.loss ?? 0);
  const gf = Number(obj.overallLeagueGF ?? obj.goalsFor ?? 0);
  const ga = Number(obj.overallLeagueGA ?? obj.goalsAgainst ?? 0);
  const gd = obj.goalDifference !== undefined && obj.goalDifference !== null ? Number(obj.goalDifference) : (gf - ga);
  const rank = Number(obj.overallLeaguePosition ?? obj.position ?? obj.rank ?? fallbackRank);
  const points = Number(obj.overallLeaguePTS ?? obj.points ?? 0);
  return {
    leagueId,
    rank,
    teamName,
    played,
    win,
    draw,
    loss,
    goalsFor: gf,
    goalsAgainst: ga,
    goalDifference: gd,
    points,
  };
}

(async () => {
  const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(loadCredential()) });
  const db = getFirestore(app);
  const now = Date.now();

  let totalMatches = 0;
  let totalStandings = 0;
  let failedLeagues = 0;

  const minDate = new Date(now - 30 * 86400_000).toISOString().slice(0, 10);
  const maxDate = new Date(now + 60 * 86400_000).toISOString().slice(0, 10);

  for (const league of LEAGUES) {
    try {
      const byId = new Map();
      for (let page = 1; page <= 15; page++) {
        const url = `${BASE_URL}/leagues/${league.nanoid}/fixtures?page=${page}&limit=${PAGE_SIZE}`;
        const root = await fetchJson(url);
        const arr = extractArray(root, 'fixtures');
        if (arr.length === 0) break;
        for (const item of arr) {
          const parsed = parseFixture(item, league, now);
          if (parsed) byId.set(parsed.id, parsed);
        }
        if (arr.length < PAGE_SIZE) break;
      }

      const allMatches = Array.from(byId.values());
      const windowMatches = allMatches.filter(m => m.status === 'LIVE' || (m.date >= minDate && m.date <= maxDate));
      const matches = (windowMatches.length > 0 ? windowMatches : allMatches.slice(0, 200))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

      const standingsRoot = await fetchJson(`${BASE_URL}/leagues/${league.nanoid}/standings`);
      const standingsArr = extractArray(standingsRoot, 'standings');
      const standings = standingsArr
        .map((item, idx) => parseStanding(item, league.leagueId, idx + 1))
        .filter(Boolean);

      await db.collection('global_sports').doc(String(league.leagueId)).set({
        leagueId: league.leagueId,
        leagueName: league.arabicName,
        leagueCountry: league.country,
        matchCount: matches.length,
        standingCount: standings.length,
        matches,
        standings,
        updatedAt: now,
      });

      totalMatches += matches.length;
      totalStandings += standings.length;
      console.log(`[OK] ${league.arabicName}: ${matches.length} matches, ${standings.length} standings`);
    } catch (e) {
      failedLeagues++;
      console.error(`[FAIL] ${league.arabicName}:`, e.message);
    }
  }

  await db.collection('config').doc('sports_sync').set({
    lastRunAt: now,
    totalLeagues: LEAGUES.length,
    failedLeagues,
    totalMatches,
    totalStandings,
  }, { merge: true });

  console.log(`\nDone: ${totalMatches} matches, ${totalStandings} standings, failed=${failedLeagues}`);
  process.exit(failedLeagues === LEAGUES.length ? 1 : 0);
})();
