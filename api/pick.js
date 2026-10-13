// POST /api/pick { gameId, winner } | { gameId, line } | { gameId, ou }   (null clears)
// Every rule is checked here, server-side: lock at tip-off, pick window, who sets the line,
// who calls it, a line freezes once answered, a call needs a line.
import { sql } from '../lib/db.js';
import { requirePlayer } from '../lib/auth.js';
import { rowToGame, loadRules, notifyLinePosted } from '../lib/league.js';
import { otherPlayer, isPickable, isValidLine } from '../js/scoring.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const me = await requirePlayer(req, res); if (!me) return;
    const body = req.body || {};
    const gameId = String(body.gameId || '');
    const [row] = await sql()`select * from games where id = ${gameId}`;
    if (!row) return res.status(404).json({ error: 'Unknown game.' });
    const game = rowToGame(row);
    const rules = await loadRules();
    const now = new Date();
    if (game.status === 'postponed') return res.status(409).json({ error: 'This game was postponed.' });
    if (!isPickable(game, rules, now)) return res.status(409).json({ error: new Date(game.tipoff) <= now ? 'This game is locked.' : `Picks for this game open ${rules.pickWindowDays} days before tip-off.` });
    const existing = await sql()`select * from picks where game_id = ${gameId}`;
    const mine = existing.find(p => p.player_code === me) || {};
    const theirs = existing.find(p => p.player_code === otherPlayer(me)) || {};
    let patch = {};
    if ('winner' in body) {
      if (body.winner != null && body.winner !== game.home && body.winner !== game.away) return res.status(400).json({ error: 'Winner must be one of the two teams.' });
      patch = { winner: body.winner ?? null };
    } else if ('line' in body) {
      if (game.selector !== me) return res.status(403).json({ error: 'The other player sets the line for this game.' });
      if (theirs.ou) return res.status(409).json({ error: 'The line is frozen once it has been answered.' });
      if (body.line != null && !isValidLine(Number(body.line), rules)) return res.status(400).json({ error: `Line must be a whole number${rules.halfPointLines ? ' or half point' : ''} between ${rules.lineMin} and ${rules.lineMax}.` });
      patch = { line: body.line == null ? null : Number(body.line) };
    } else if ('ou' in body) {
      if (game.selector === me) return res.status(403).json({ error: 'You set the line; the other player makes the call.' });
      if (theirs.line == null) return res.status(409).json({ error: 'No line has been posted yet.' });
      if (body.ou != null && body.ou !== 'O' && body.ou !== 'U') return res.status(400).json({ error: 'Call must be O or U.' });
      patch = { ou: body.ou ?? null };
    } else return res.status(400).json({ error: 'Nothing to save.' });

    const next = { winner: mine.winner ?? null, line: mine.line == null ? null : Number(mine.line), ou: mine.ou ?? null, ...patch };
    const [saved] = await sql()`insert into picks (game_id, player_code, winner, line, ou, updated_at) values (${gameId}, ${me}, ${next.winner}, ${next.line}, ${next.ou}, now())
      on conflict (game_id, player_code) do update set winner = excluded.winner, line = excluded.line, ou = excluded.ou, updated_at = now() returning *`;
    if ('line' in patch && patch.line != null && (mine.line == null)) notifyLinePosted(game, me, patch.line).catch(e => console.error('line push failed', e));
    return res.status(200).json({ pick: { game_id: saved.game_id, player_code: saved.player_code, winner: saved.winner, line: saved.line == null ? null : Number(saved.line), ou: saved.ou } });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
}
