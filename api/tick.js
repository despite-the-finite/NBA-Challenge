// GET /api/tick?job=daily|notify|schedule|scores   (Authorization: Bearer <CRON_SECRET>)
//   daily    the one batch per day: schedule refresh + yesterday's scores + due notifications.
//            Guarded to 5 AM Mountain (add &force=1 to run it now, e.g. the first time).
//   notify   database-only: morning reminders, pre-tip nudges, unanswered lines. No NBA feed calls.
//   schedule / scores   the two halves of the batch, for manual use.
import { dailyJob, syncSchedule, syncScores, notifyAll, batchClock } from '../lib/league.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'bad cron secret' });
  const log = [];
  try {
    const job = req.query.job || 'daily';
    const force = req.query.force === '1';
    if (job === 'daily') await dailyJob(log, force);
    else if (job === 'notify') await notifyAll(log);
    else if (job === 'schedule') await syncSchedule(log);
    else if (job === 'scores') await syncScores(log);
    else return res.status(400).json({ error: 'unknown job' });
    return res.status(200).json({ ok: true, mountainTime: batchClock().time, log });
  } catch (e) { console.error(e); return res.status(500).json({ ok: false, log, error: e.message }); }
}
