// POST /api/schedule { games: [...] }  (signed-in player)
// The browser fetched the schedule itself (ESPN allows that; some feeds block cloud servers) and
// hands the normalized games to the server, which merges them exactly like the daily batch does.
import { requirePlayer } from '../lib/auth.js';
import { syncSchedule } from '../lib/league.js';
import { gameKey } from '../lib/feeds.js';
import { TEAMS } from '../js/teams.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const me = await requirePlayer(req, res); if (!me) return;
    const raw = Array.isArray(req.body?.games) ? req.body.games : [];
    if (raw.length < 100 || raw.length > 2000) return res.status(400).json({ error: `Expected a full season of games, got ${raw.length}.` });
    const games = [];
    for (const g of raw) {
      if (!TEAMS[g.home] || !TEAMS[g.away] || !/^\d{4}-\d{2}-\d{2}$/.test(g.date || '') || isNaN(new Date(g.tipoff))) continue;
      games.push({ id: gameKey(g.date, g.away, g.home), date: g.date, tipoff: new Date(g.tipoff).toISOString(), home: g.home, away: g.away,
        arena: typeof g.arena === 'string' ? g.arena.slice(0, 80) : null, cup: !!g.cup, status: 'scheduled', sourceIds: g.sourceIds && typeof g.sourceIds === 'object' ? g.sourceIds : {} });
    }
    if (games.length < 100) return res.status(400).json({ error: `Only ${games.length} valid games in the upload.` });
    const log = [];
    const result = await syncSchedule(log, { source: `browser:${me}`, games });
    return res.status(200).json({ ok: true, ...result, log });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
}
