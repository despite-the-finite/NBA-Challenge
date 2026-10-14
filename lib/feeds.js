// Schedule and score feeds. Two public, key-free sources, normalized to one shape:
//   { id: 'g:YYYYMMDD-AWAY-HOME', date, tipoff, home, away, arena, cup, status, homeScore, awayScore, clock, sourceIds }
// NBA.com publishes the official season schedule as one JSON file; ESPN's scoreboard is addressable
// by date, which makes it the better score feed. Either can stand in for the other.
import { ESPN_TO_CODE } from '../js/teams.js';

const ET = 'America/New_York';
export function etDate(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(d));
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
export const gameKey = (date, away, home) => `g:${date.replace(/-/g, '')}-${away}-${home}`;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
};
async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { ...BROWSER_HEADERS, ...headers }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`non-JSON response from ${new URL(url).host} (${text.slice(0, 60).replace(/\s+/g, ' ')}…)`); }
}
const NBA_HEADERS = { Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com' };

/* ---------------- NBA.com ---------------- */
const NBA_SCHEDULE = 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json';
const NBA_TODAY = 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json';
const NBA_CODE = { GSW: 'GSW', NOP: 'NOP', NYK: 'NYK', SAS: 'SAS', UTA: 'UTA', WAS: 'WAS', PHX: 'PHX', BKN: 'BKN' };
const nbaCode = t => NBA_CODE[t] || (ESPN_TO_CODE[t] ? ESPN_TO_CODE[t] : t);

/** Parse the NBA.com league schedule file (also usable offline via tools/import_schedule.mjs). */
export function parseNbaSchedule(json) {
  const out = [];
  for (const day of json.leagueSchedule?.gameDates || []) {
    for (const g of day.games || []) try {
      // 001 preseason, 002 regular season, 003 all-star, 004 playoffs, 005 play-in, 006 NBA Cup final
      if (!String(g.gameId).startsWith('002')) continue;
      const home = nbaCode(g.homeTeam?.teamTricode), away = nbaCode(g.awayTeam?.teamTricode);
      if (!home || !away || home.length !== 3) continue;
      if (!g.gameDateTimeUTC) continue;
      const tip = new Date(g.gameDateTimeUTC);
      const date = etDate(tip);
      const label = `${g.gameLabel || ''} ${g.gameSubLabel || ''}`;
      out.push(normalize({ date, tipoff: tip.toISOString(), home, away, arena: g.arenaName || null, cup: /cup/i.test(label),
        status: nbaStatus(g.gameStatus), homeScore: g.gameStatus > 1 ? g.homeTeam?.score ?? null : null, awayScore: g.gameStatus > 1 ? g.awayTeam?.score ?? null : null,
        clock: g.gameStatus === 2 ? g.gameStatusText : null, sourceIds: { nba: g.gameId } }));
    } catch (e) { console.warn('skipping NBA.com game', g?.gameId, e.message); }
  }
  return out;
}
const nbaStatus = s => (s === 3 ? 'final' : s === 2 ? 'live' : 'scheduled');

export async function fetchNbaSchedule() { return parseNbaSchedule(await getJson(NBA_SCHEDULE, NBA_HEADERS)); }
export async function fetchNbaToday() {
  const j = await getJson(NBA_TODAY, NBA_HEADERS);
  return (j.scoreboard?.games || []).map(g => normalize({
    date: etDate(g.gameTimeUTC), tipoff: new Date(g.gameTimeUTC).toISOString(), home: nbaCode(g.homeTeam.teamTricode), away: nbaCode(g.awayTeam.teamTricode),
    status: nbaStatus(g.gameStatus), homeScore: g.gameStatus > 1 ? g.homeTeam.score : null, awayScore: g.gameStatus > 1 ? g.awayTeam.score : null,
    clock: g.gameStatus === 2 ? g.gameStatusText : null, sourceIds: { nba: g.gameId },
  })).filter(g => String(g.sourceIds.nba).startsWith('002'));
}

/* ---------------- ESPN ---------------- */
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
export function parseEspnEvent(ev) {
  const comp = ev.competitions?.[0]; if (!comp) return null;
  if (ev.season?.type !== 2) return null;                       // 2 = regular season
  const h = comp.competitors.find(c => c.homeAway === 'home'), a = comp.competitors.find(c => c.homeAway === 'away');
  const home = ESPN_TO_CODE[(h?.team?.abbreviation || '').toUpperCase()], away = ESPN_TO_CODE[(a?.team?.abbreviation || '').toUpperCase()];
  if (!home || !away) return null;
  const headline = (comp.notes || []).map(n => n.headline || '').join(' ');
  if (/cup/i.test(headline) && /(final|championship)/i.test(headline)) return null;   // Cup final does not count
  const state = comp.status?.type?.state;                        // pre | in | post
  const status = state === 'post' ? (comp.status?.type?.completed ? 'final' : 'postponed') : state === 'in' ? 'live' : 'scheduled';
  const tip = new Date(ev.date);
  return normalize({ date: etDate(tip), tipoff: tip.toISOString(), home, away, arena: comp.venue?.fullName || null, cup: /cup/i.test(headline), status,
    homeScore: state === 'pre' ? null : Number(h.score ?? 0), awayScore: state === 'pre' ? null : Number(a.score ?? 0),
    clock: state === 'in' ? `Q${comp.status.period} ${comp.status.displayClock}` : null, sourceIds: { espn: ev.id } });
}
export async function fetchEspn(dates) {
  const j = await getJson(`${ESPN}?dates=${dates}&limit=1000`);
  const out = [];
  for (const ev of j.events || []) {
    try { const g = parseEspnEvent(ev); if (g) out.push(g); }
    catch (e) { console.warn('skipping ESPN event', ev?.id, e.message); }
  }
  return out;
}
export async function fetchEspnSchedule(start, end) {
  const out = [];
  let cur = new Date(start + 'T00:00:00Z'); const stop = new Date(end + 'T00:00:00Z');
  while (cur < stop) {
    const next = new Date(cur); next.setUTCMonth(next.getUTCMonth() + 1);
    const to = next < stop ? next : stop;
    out.push(...await fetchEspn(`${cur.toISOString().slice(0, 10).replace(/-/g, '')}-${to.toISOString().slice(0, 10).replace(/-/g, '')}`));
    cur = next;
  }
  return out;
}

/* ESPN per-team schedule: 30 small requests, no date-range parameter, works where the scoreboard range 400s. */
const ESPN_TEAM_IDS = { ATL: 1, BOS: 2, NOP: 3, CHI: 4, CLE: 5, DAL: 6, DEN: 7, DET: 8, GSW: 9, HOU: 10, IND: 11, LAC: 12, LAL: 13, MIA: 14, MIL: 15, MIN: 16, BKN: 17, NYK: 18, ORL: 19, PHI: 20, PHX: 21, POR: 22, SAC: 23, SAS: 24, OKC: 25, UTA: 26, WAS: 27, TOR: 28, MEM: 29, CHA: 30 };
export function parseEspnTeamEvent(ev) {
  const comp = ev.competitions?.[0]; if (!comp) return null;
  const seasonType = ev.seasonType?.type ?? ev.season?.type ?? comp.type?.id;
  if (Number(seasonType) !== 2) return null;
  const h = comp.competitors.find(c => c.homeAway === 'home'), a = comp.competitors.find(c => c.homeAway === 'away');
  const home = ESPN_TO_CODE[(h?.team?.abbreviation || '').toUpperCase()], away = ESPN_TO_CODE[(a?.team?.abbreviation || '').toUpperCase()];
  if (!home || !away) return null;
  const headline = (comp.notes || []).map(n => n.headline || '').join(' ');
  if (/cup/i.test(headline) && /(final|championship)/i.test(headline)) return null;
  const state = comp.status?.type?.state;
  const status = state === 'post' ? (comp.status?.type?.completed ? 'final' : 'postponed') : state === 'in' ? 'live' : 'scheduled';
  const score = c => (c?.score == null ? null : Number(typeof c.score === 'object' ? c.score.value ?? c.score.displayValue : c.score));
  const tip = new Date(ev.date);
  return normalize({ date: etDate(tip), tipoff: tip.toISOString(), home, away, arena: comp.venue?.fullName || null, cup: /cup/i.test(headline), status,
    homeScore: state === 'pre' ? null : score(h), awayScore: state === 'pre' ? null : score(a), clock: null, sourceIds: { espn: ev.id } });
}
export async function fetchEspnTeamSchedules(seasonEndYear) {
  const byId = new Map();
  const failures = [];
  const entries = Object.entries(ESPN_TEAM_IDS);
  const worker = async () => {
    while (entries.length) {
      const [code, id] = entries.shift();
      try {
        const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${id}/schedule?season=${seasonEndYear}`);
        for (const ev of j.events || []) { try { const g = parseEspnTeamEvent(ev); if (g) byId.set(g.id, g); } catch (e) { console.warn('skipping team event', ev?.id, e.message); } }
      } catch (e) { failures.push(`${code}: ${e.message}`); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);   // 6 at a time
  if (failures.length > 5) throw new Error(`${failures.length} team schedules failed (${failures[0]})`);
  return [...byId.values()];
}

function normalize(g) { return { ...g, id: gameKey(g.date, g.away, g.home) }; }

/** Season schedule: NBA.com first (official), ESPN as fallback. */
export async function fetchSchedule({ start, end }) {
  const errors = [];
  try {
    const s = await fetchNbaSchedule();
    const inSeason = s.filter(g => g.date >= start && g.date <= end);
    if (inSeason.length > 100) return { source: 'nba', games: inSeason };
    errors.push(`NBA.com: only ${inSeason.length} regular-season games between ${start} and ${end}`);
  } catch (e) { errors.push(`NBA.com: ${e.message}`); }
  try {
    const s = await fetchEspnSchedule(start, end);
    if (s.length > 100) return { source: 'espn', games: s };
    errors.push(`ESPN scoreboard: only ${s.length} regular-season games between ${start} and ${end}`);
  } catch (e) { errors.push(`ESPN scoreboard: ${e.message}`); }
  try {
    const s = (await fetchEspnTeamSchedules(Number(end.slice(0, 4)))).filter(g => g.date >= start && g.date <= end);
    if (s.length > 100) return { source: 'espn-teams', games: s };
    errors.push(`ESPN team schedules: only ${s.length} regular-season games between ${start} and ${end}`);
  } catch (e) { errors.push(`ESPN team schedules: ${e.message}`); }
  throw new Error('schedule feeds failed. ' + errors.join(' | '));
}
/** Final scores for specific ET dates (one request per date). ESPN first; NBA.com can only
 *  cover today, so it is the fallback for today's date alone. */
export async function fetchScoresForDates(dates) {
  const out = new Map();   // date -> { source, games }
  const today = etDate(new Date());
  for (const date of dates) {
    try { out.set(date, { source: 'espn', games: await fetchEspn(date.replace(/-/g, '')) }); continue; }
    catch (e) { console.warn('ESPN scores failed for', date, e.message); }
    if (date === today) { try { out.set(date, { source: 'nba', games: await fetchNbaToday() }); } catch (e) { console.warn('NBA.com scores failed', e.message); } }
  }
  return out;
}
