// Offline tests for the API layer: feed parsing, sessions, PIN hashing, and the pick endpoint
// against an in-memory stand-in for Postgres. Run: node tools/test_api.mjs
import assert from 'node:assert/strict';
import { parseNbaSchedule, parseEspnEvent, gameKey } from '../lib/feeds.js';

process.env.SESSION_SECRET = 'test-secret';   // env wins over the settings-table secret
const { currentPlayer, setSession, hashPin } = await import('../lib/auth.js');
const { _setSql } = await import('../lib/db.js');

/* ---- feeds ---- */
const nba = parseNbaSchedule({ leagueSchedule: { seasonYear: '2026-27', gameDates: [{ gameDate: '10/20/2026 00:00:00', games: [
  { gameId: '0022600001', gameStatus: 1, gameDateTimeUTC: '2026-10-20T23:30:00Z', homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'NYK' }, arenaName: 'TD Garden', gameLabel: '', gameSubLabel: '' },
  { gameId: '0012600001', gameStatus: 1, gameDateTimeUTC: '2026-10-10T23:30:00Z', homeTeam: { teamTricode: 'LAL' }, awayTeam: { teamTricode: 'GSW' } },   // preseason: skipped
  { gameId: '0022600050', gameStatus: 3, gameDateTimeUTC: '2026-10-31T23:00:00Z', homeTeam: { teamTricode: 'NOP', score: 110 }, awayTeam: { teamTricode: 'UTA', score: 99 }, gameLabel: 'Emirates NBA Cup', gameSubLabel: 'West Group A' },
] }] } });
assert.equal(nba.length, 2);
assert.equal(nba[0].id, 'g:20261020-NYK-BOS'); assert.equal(nba[0].date, '2026-10-20'); assert.equal(nba[0].status, 'scheduled');
assert.equal(nba[1].cup, true); assert.equal(nba[1].status, 'final'); assert.equal(nba[1].homeScore, 110);
const espn = parseEspnEvent({ id: '401', date: '2026-10-21T02:00Z', season: { type: 2 }, competitions: [{ venue: { fullName: 'Crypto.com Arena' }, status: { type: { state: 'in', completed: false }, period: 3, displayClock: '4:12' },
  competitors: [{ homeAway: 'home', team: { abbreviation: 'LAL' }, score: '80' }, { homeAway: 'away', team: { abbreviation: 'GS' }, score: '77' }] }] });
assert.equal(espn.id, 'g:20261020-GSW-LAL');            // 02:00Z = 10 PM ET on Oct 20
assert.equal(espn.status, 'live'); assert.equal(espn.clock, 'Q3 4:12'); assert.equal(espn.away, 'GSW');
assert.equal(parseEspnEvent({ id: '1', date: '2026-10-21T02:00Z', season: { type: 1 }, competitions: [{ competitors: [] }] }), null);
assert.equal(gameKey('2026-12-25', 'DEN', 'MIN'), 'g:20261225-DEN-MIN');

/* ---- sessions & pins ---- */
const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
await setSession(res, 'KP');
const cookie = res.headers['Set-Cookie'].split(';')[0];
assert.equal(await currentPlayer({ headers: { cookie } }), 'KP');
assert.equal(await currentPlayer({ headers: { cookie: cookie.slice(0, -2) + 'xx' } }), null);
const { salt, hash } = hashPin('123456'); assert.equal(hashPin('123456', salt).hash, hash); assert.notEqual(hashPin('123457', salt).hash, hash);

/* ---- pick endpoint against a stub database ---- */
const db = {
  games: [{ id: 'g:20261120-NYK-BOS', date: '2026-11-20', tipoff: new Date(Date.now() + 3 * 3600e3).toISOString(), home: 'BOS', away: 'NYK', arena: 'TD Garden', cup: false, selector: 'UP', status: 'scheduled', home_score: null, away_score: null, clock: null, updated_at: new Date().toISOString() },
          { id: 'g:20261120-LAL-DEN', date: '2026-11-20', tipoff: new Date(Date.now() - 3600e3).toISOString(), home: 'DEN', away: 'LAL', selector: 'KP', status: 'live', updated_at: new Date().toISOString() }],
  picks: [], players: [{ code: 'UP', name: 'UP', notify_lines: true }, { code: 'KP', name: 'KP', notify_lines: true }], log: new Set(), pushes: [],
};
_setSql(async (strings, ...vals) => {
  const q = strings.join('?').replace(/\s+/g, ' ').trim();
  if (q.startsWith('select * from games where id =')) return db.games.filter(g => g.id === vals[0]);
  if (q.startsWith('select rules from settings')) return [{ rules: {} }];
  if (q.startsWith('select * from picks where game_id =')) return db.picks.filter(p => p.game_id === vals[0]);
  if (q.startsWith('insert into picks')) {
    const [game_id, player_code, winner, line, ou] = vals; const row = { game_id, player_code, winner, line, ou, updated_at: new Date().toISOString() };
    const i = db.picks.findIndex(p => p.game_id === game_id && p.player_code === player_code); if (i >= 0) db.picks[i] = row; else db.picks.push(row); return [row];
  }
  if (q.startsWith('select name, notify_lines from players')) return db.players.filter(p => p.code === vals[0]);
  if (q.startsWith('select name from players')) return db.players.filter(p => p.code === vals[0]);
  if (q.startsWith('insert into notifications_log')) { if (db.log.has(vals[0])) return []; db.log.add(vals[0]); return [{ key: vals[0] }]; }
  if (q.startsWith('select endpoint, p256dh, auth from push_subscriptions')) return [];
  if (q.startsWith('select vapid_public, vapid_private from settings')) return [{ vapid_public: null, vapid_private: null }];
  if (q.startsWith('update settings set vapid_public')) return [{ vapid_public: vals[0], vapid_private: vals[1] }];
  throw new Error('unexpected query in test: ' + q);
});
const pick = (await import('../api/pick.js')).default;
async function post(player, body) {
  const r = { headers: {}, setHeader(k, v) { this.headers[k] = v; } }; await setSession(r, player);
  const req = { method: 'POST', headers: { cookie: r.headers['Set-Cookie'].split(';')[0] }, body, query: {} };
  const out = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await pick(req, out); return out;
}
let r = await post('UP', { gameId: 'g:20261120-NYK-BOS', winner: 'BOS' }); assert.equal(r.code, 200); assert.equal(r.body.pick.winner, 'BOS');
r = await post('UP', { gameId: 'g:20261120-NYK-BOS', winner: 'MIA' }); assert.equal(r.code, 400);
r = await post('KP', { gameId: 'g:20261120-NYK-BOS', ou: 'O' }); assert.equal(r.code, 409, 'no line yet');
r = await post('KP', { gameId: 'g:20261120-NYK-BOS', line: 8 }); assert.equal(r.code, 403, 'KP is not the selector');
r = await post('UP', { gameId: 'g:20261120-NYK-BOS', line: 7.5 }); assert.equal(r.code, 400, 'half points off by default');
r = await post('UP', { gameId: 'g:20261120-NYK-BOS', line: 8 }); assert.equal(r.code, 200); assert.equal(r.body.pick.line, 8); assert.equal(r.body.pick.winner, 'BOS', 'line keeps the winner');
await new Promise(r => setTimeout(r, 20)); assert.ok(db.log.has('line:g:20261120-NYK-BOS:KP'), 'responder is notified once when a line lands');
r = await post('KP', { gameId: 'g:20261120-NYK-BOS', ou: 'U' }); assert.equal(r.code, 200); assert.equal(r.body.pick.ou, 'U');
r = await post('UP', { gameId: 'g:20261120-NYK-BOS', line: 12 }); assert.equal(r.code, 409, 'line frozen after the call');
r = await post('UP', { gameId: 'g:20261120-LAL-DEN', winner: 'DEN' }); assert.equal(r.code, 409, 'locked after tip-off');
r = await post('UP', { gameId: 'nope', winner: 'DEN' }); assert.equal(r.code, 404);
const noAuth = { code: 0, status(c) { this.code = c; return this; }, json() { return this; } };
await pick({ method: 'POST', headers: {}, body: {}, query: {} }, noAuth); assert.equal(noAuth.code, 401);
console.log('api tests passed: feeds, sessions, pins, pick rules');

/* ---- Mountain-time clock used to dedupe the daily jobs ---- */
const { batchClock } = await import('../lib/league.js');
assert.deepEqual(batchClock(new Date('2026-12-01T12:30:00Z')), { date: '2026-12-01', time: '05:30' }, 'MST');
assert.deepEqual(batchClock(new Date('2026-10-20T12:30:00Z')), { date: '2026-10-20', time: '06:30' }, 'MDT');
assert.deepEqual(batchClock(new Date('2026-12-02T04:30:00Z')), { date: '2026-12-01', time: '21:30' }, 'late evening is still the same Mountain day');
console.log('batch clock passed');
