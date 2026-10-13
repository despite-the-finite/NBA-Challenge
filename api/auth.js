// GET  /api/auth                     -> { me, players }
// POST /api/auth {action:'login', player, pin} | {action:'setupPin', player, pin} | {action:'logout'} | {action:'changePin', currentPin, newPin}
import { sql } from '../lib/db.js';
import { currentPlayer, verifyPin, setPin, setupPin, playersNeedingPin, setSession, clearSession } from '../lib/auth.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const players = await sql()`select code, name, color from players order by code`;
      return res.status(200).json({ me: await currentPlayer(req), players, needsPin: await playersNeedingPin() });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    if (body.action === 'login') {
      const player = String(body.player || '').toUpperCase();
      if (player !== 'UP' && player !== 'KP') return res.status(400).json({ error: 'Pick a player.' });
      const v = await verifyPin(player, String(body.pin || ''));
      if (!v.ok) return res.status(401).json({ error: v.error });
      await setSession(res, player);
      return res.status(200).json({ me: player });
    }
    if (body.action === 'setupPin') {
      const player = String(body.player || '').toUpperCase();
      if (player !== 'UP' && player !== 'KP') return res.status(400).json({ error: 'Pick a player.' });
      await setupPin(player, String(body.pin || ''));
      await setSession(res, player);
      return res.status(200).json({ me: player });
    }
    if (body.action === 'logout') { clearSession(res); return res.status(200).json({ ok: true }); }
    if (body.action === 'changePin') {
      const me = await currentPlayer(req); if (!me) return res.status(401).json({ error: 'Not signed in.' });
      const v = await verifyPin(me, String(body.currentPin || ''));
      if (!v.ok) return res.status(401).json({ error: v.error });
      await setPin(me, String(body.newPin || ''));
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
}
