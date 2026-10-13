// Load the official NBA schedule from a downloaded copy of
//   https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json
// Usage:
//   node tools/import_schedule.mjs path/to/scheduleLeagueV2_1.json          -> writes data/schedule-2026-27.json (demo mode uses it)
//   DATABASE_URL=... node tools/import_schedule.mjs path/to/file.json --db   -> also upserts the games into Neon
import { readFileSync, writeFileSync } from 'node:fs';
import { parseNbaSchedule } from '../lib/feeds.js';

const [file, flag] = process.argv.slice(2);
if (!file) { console.error('usage: node tools/import_schedule.mjs <scheduleLeagueV2_1.json> [--db]'); process.exit(1); }
const json = JSON.parse(readFileSync(file, 'utf8'));
const games = parseNbaSchedule(json).sort((a, b) => a.tipoff.localeCompare(b.tipoff));
if (!games.length) { console.error('no regular-season games found in that file'); process.exit(1); }
const seasonYear = json.leagueSchedule?.seasonYear || '';
writeFileSync(new URL('../data/schedule-2026-27.json', import.meta.url), JSON.stringify({ note: `Official NBA schedule ${seasonYear}, imported ${new Date().toISOString().slice(0, 10)}`, games: games.map(g => ({ id: g.id, date: g.date, tipoff: g.tipoff, away: g.away, home: g.home, arena: g.arena, cup: g.cup })) }));
console.log(`wrote data/schedule-2026-27.json: ${games.length} games, ${games[0].date} -> ${games[games.length - 1].date}`);
if (flag === '--db') {
  const { syncSchedule } = await import('../lib/league.js');
  const log = [];
  await syncSchedule(log, { source: 'file', games });
  console.log(log.join('\n'));
}
