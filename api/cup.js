// POST /api/cup { picks }   (signed-in player)
// Save the player's NBA Cup bracket: { "<quarterfinal game id>": team, "SF-East": team, "SF-West": team, "F": team }.
// Picks are cleaned to a consistent bracket (a semifinal pick must be one of your own quarterfinal picks,
// the final one of your semifinal picks). The bracket opens once all four quarterfinals are on the
// schedule and locks at the first quarterfinal tip-off. Reading happens through /api/state (cupPicks).
import { sql, migrate } from '../lib/db.js';
import { requirePlayer } from '../lib/auth.js';
import { loadCup } from '../lib/league.js';
import { bracketLocked, cleanBracketPicks } from '../js/cup.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const me = await requirePlayer(req, res); if (!me) return;
    await migrate();
    const cup = await loadCup();
    const now = new Date();
    if (!cup.bracket.ready) return res.status(409).json({ error: 'The bracket opens once the quarterfinal matchups are on the schedule.' });
    if (bracketLocked(cup.bracket, now)) return res.status(409).json({ error: 'The bracket locked at the first quarterfinal tip-off.' });
    const picks = cleanBracketPicks(req.body?.picks, cup.bracket);
    const [saved] = await sql()`insert into cup_picks (player_code, picks, updated_at) values (${me}, ${JSON.stringify(picks)}::jsonb, now())
      on conflict (player_code) do update set picks = excluded.picks, updated_at = now() returning picks, updated_at`;
    return res.status(200).json({ picks: saved.picks, updated_at: saved.updated_at });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
}
