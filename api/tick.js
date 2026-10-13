// GET /api/tick?job=schedule|scores|notify   (Authorization: Bearer <CRON_SECRET>)
// Vercel's daily cron calls job=schedule; the GitHub Actions workflow calls job=scores every 15 min.
import { syncSchedule, syncScores, notifyAll } from '../lib/league.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'bad cron secret' });
  const log = [];
  try {
    const job = req.query.job || 'scores';
    if (job === 'schedule') await syncSchedule(log);
    else if (job === 'scores') { await syncScores(log); await notifyAll(log); }
    else if (job === 'notify') await notifyAll(log);
    else return res.status(400).json({ error: 'unknown job' });
    return res.status(200).json({ ok: true, log });
  } catch (e) { console.error(e); return res.status(500).json({ ok: false, log, error: e.message }); }
}
