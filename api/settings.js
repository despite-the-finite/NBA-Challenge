// POST /api/settings { rules } | { names: {UP, KP} } | { prefs: {tz, reminder_time, notify_*} }
import { sql } from '../lib/db.js';
import { requirePlayer } from '../lib/auth.js';
import { loadRules } from '../lib/league.js';
import { DEFAULT_RULES } from '../js/scoring.js';

const RULE_CHECKS = {
  push: v => ['nobody', 'selector'].includes(v), unansweredLine: v => ['selector', 'nobody'].includes(v), noLine: v => ['responder', 'nobody'].includes(v),
  showUpBonus: v => Number.isInteger(v) && v >= 0 && v <= 10, pickWindowDays: v => Number.isInteger(v) && v >= 1 && v <= 30,
  halfPointLines: v => typeof v === 'boolean', winnerPoint: v => Number.isInteger(v) && v >= 0 && v <= 5, spreadPoint: v => Number.isInteger(v) && v >= 0 && v <= 5,
  lineMin: v => Number.isInteger(v) && v >= 0 && v <= 10, lineMax: v => Number.isInteger(v) && v >= 10 && v <= 60,
};

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const me = await requirePlayer(req, res); if (!me) return;
    const body = req.body || {};
    if (body.rules) {
      const cur = await loadRules(); const next = { ...cur };
      for (const [k, v] of Object.entries(body.rules)) {
        if (!(k in DEFAULT_RULES) || !RULE_CHECKS[k]?.(v)) return res.status(400).json({ error: `Bad value for rule ${k}.` });
        next[k] = v;
      }
      await sql()`update settings set rules = ${JSON.stringify(next)}::jsonb where id = 1`;
      return res.status(200).json({ rules: next });
    }
    if (body.names) {
      for (const code of ['UP', 'KP']) if (body.names[code]) await sql()`update players set name = ${String(body.names[code]).slice(0, 16)} where code = ${code}`;
      return res.status(200).json({ ok: true });
    }
    if (body.prefs) {
      const p = body.prefs;
      const tz = typeof p.tz === 'string' && p.tz.length < 64 ? p.tz : null;
      const time = /^\d{2}:\d{2}$/.test(p.reminder_time || '') ? p.reminder_time : null;
      await sql()`update players set tz = coalesce(${tz}, tz), reminder_time = coalesce(${time}, reminder_time),
        notify_pretip = coalesce(${typeof p.notify_pretip === 'boolean' ? p.notify_pretip : null}, notify_pretip),
        notify_lines = coalesce(${typeof p.notify_lines === 'boolean' ? p.notify_lines : null}, notify_lines),
        notify_results = coalesce(${typeof p.notify_results === 'boolean' ? p.notify_results : null}, notify_results) where code = ${me}`;
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Nothing to save.' });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
}
