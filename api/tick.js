// GET /api/tick?job=daily|morning|schedule|scores   (Authorization: Bearer <CRON_SECRET>)
// Vercel cron (vercel.json) calls:
//   daily    at 12:00 UTC (5 AM Mountain, 6 AM during daylight saving): schedule refresh + yesterday's scores.
//   morning  at 16:00 UTC (9 AM Mountain / 11 AM Eastern): yesterday's result + tonight's to-do, by push.
// Both run once per Mountain day; add &force=1 to run again now (first-time schedule load, catch-up, testing).
import { dailyJob, morningJob, syncSchedule, syncScores, batchClock } from '../lib/league.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'bad cron secret' });
  const log = [];
  try {
    const job = req.query.job || 'daily';
    const force = req.query.force === '1';
    if (job === 'daily') await dailyJob(log, force);
    else if (job === 'morning') await morningJob(log, force);
    else if (job === 'schedule') await syncSchedule(log);
    else if (job === 'scores') await syncScores(log);
    else return res.status(400).json({ error: 'unknown job' });
    return res.status(200).json({ ok: true, mountainTime: batchClock().time, log });
  } catch (e) { console.error(e); return res.status(500).json({ ok: false, log, error: e.message }); }
}
