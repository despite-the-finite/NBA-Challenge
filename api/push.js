// POST /api/push {action:'subscribe', subscription} | {action:'unsubscribe', endpoint} | {action:'test'}
import { sql } from '../lib/db.js';
import { requirePlayer } from '../lib/auth.js';
import { sendTo } from '../lib/notify.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const me = requirePlayer(req, res); if (!me) return;
    const body = req.body || {};
    if (body.action === 'subscribe') {
      const s = body.subscription || {};
      if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth) return res.status(400).json({ error: 'Bad subscription.' });
      await sql()`insert into push_subscriptions (endpoint, player_code, p256dh, auth, user_agent) values (${s.endpoint}, ${me}, ${s.keys.p256dh}, ${s.keys.auth}, ${String(req.headers['user-agent'] || '').slice(0, 200)})
        on conflict (endpoint) do update set player_code = excluded.player_code, p256dh = excluded.p256dh, auth = excluded.auth`;
      return res.status(200).json({ ok: true });
    }
    if (body.action === 'unsubscribe') { await sql()`delete from push_subscriptions where endpoint = ${String(body.endpoint || '')} and player_code = ${me}`; return res.status(200).json({ ok: true }); }
    if (body.action === 'test') { const n = await sendTo(me, { title: 'NBA Challenge', body: 'Notifications are working on this device. 🏀', tag: 'test', url: '/#settings' }); return res.status(200).json({ sent: n }); }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
}
