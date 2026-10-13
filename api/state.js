// GET /api/state            -> full league state for the signed-in player
// GET /api/state?since=ISO  -> only games/picks changed since then (plus picks that just unlocked)
// The other player's winner pick is hidden (winner:null, has_winner:true) until that game tips off.
import { sql } from '../lib/db.js';
import { requirePlayer } from '../lib/auth.js';
import { rowToGame, loadRules, maybeRefreshScores } from '../lib/league.js';

export default async function handler(req, res) {
  try {
    const me = requirePlayer(req, res); if (!me) return;
    const since = req.query.since ? new Date(req.query.since) : null;
    if (since && isNaN(since)) return res.status(400).json({ error: 'bad since' });
    const now = new Date();
    if (!since) await maybeRefreshScores();
    const [players, rules, games, picks] = await Promise.all([
      since ? [] : sql()`select code, name, color, tz, reminder_time, notify_pretip, notify_lines, notify_results from players order by code`,
      since ? null : loadRules(),
      since ? sql()`select * from games where updated_at > ${since.toISOString()} order by tipoff` : sql()`select * from games order by tipoff`,
      since
        ? sql()`select p.*, g.tipoff from picks p join games g on g.id = p.game_id where p.updated_at > ${since.toISOString()} or (g.tipoff > ${since.toISOString()} and g.tipoff <= ${now.toISOString()})`
        : sql()`select p.*, g.tipoff from picks p join games g on g.id = p.game_id`,
    ]);
    const visible = picks.map(p => {
      const hidden = p.player_code !== me && new Date(p.tipoff) > now;
      return { game_id: p.game_id, player_code: p.player_code, winner: hidden ? null : p.winner, has_winner: p.winner != null, line: p.line == null ? null : Number(p.line), ou: p.ou };
    });
    const out = { me, now: now.toISOString(), games: games.map(rowToGame), picks: visible };
    if (!since) {
      out.players = players.map(p => ({ code: p.code, name: p.name, color: p.color, ...(p.code === me ? { tz: p.tz, reminder_time: p.reminder_time, notify_pretip: p.notify_pretip, notify_lines: p.notify_lines, notify_results: p.notify_results } : {}) }));
      out.rules = rules;
      out.vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
      const [s] = await sql()`select season, last_schedule_sync, last_scores_sync from settings where id = 1`;
      out.season = s?.season; out.lastScheduleSync = s?.last_schedule_sync; out.lastScoresSync = s?.last_scores_sync;
    }
    return res.status(200).json(out);
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
}
