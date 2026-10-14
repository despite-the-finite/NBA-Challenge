// League state loading, schedule/score syncing, and the notification rules.
import { sql } from './db.js';
import { sendTo, once } from './notify.js';
import { fetchSchedule, fetchScoresForDates, etDate } from './feeds.js';
import { TEAMS } from '../js/teams.js';
import { DEFAULT_RULES, otherPlayer, assignSelector, groupByDate, scoreDay, missingPicks, isPickable } from '../js/scoring.js';

export const SEASON = { start: process.env.SEASON_START || '2026-10-01', end: process.env.SEASON_END || '2027-04-30' };

export function rowToGame(r) {
  return { id: r.id, date: typeof r.date === 'string' ? r.date : toDateStr(r.date), tipoff: new Date(r.tipoff).toISOString(), home: r.home, away: r.away, arena: r.arena, cup: r.cup,
    selector: r.selector, status: r.status, homeScore: r.home_score, awayScore: r.away_score, clock: r.clock, updatedAt: new Date(r.updated_at).toISOString() };
}
const toDateStr = d => new Date(d).toISOString().slice(0, 10);

export async function loadRules() {
  const rows = await sql()`select rules from settings where id = 1`;
  return { ...DEFAULT_RULES, ...(rows[0]?.rules || {}) };
}

/** Everything the notification logic needs: a window of games, all picks on them, players, rules. */
export async function loadLeague(fromDate, toDate) {
  const [players, rules, games] = await Promise.all([
    sql()`select * from players order by code`, loadRules(),
    sql()`select * from games where date between ${fromDate} and ${toDate} order by tipoff`,
  ]);
  const list = games.map(rowToGame);
  const ids = list.map(g => g.id);
  const pickRows = ids.length ? await sql()`select * from picks where game_id = any(${ids})` : [];
  const picks = new Map();
  for (const p of pickRows) {
    const all = picks.get(p.game_id) || {};
    all[p.player_code] = { winner: p.winner, line: p.line == null ? null : Number(p.line), ou: p.ou };
    picks.set(p.game_id, all);
  }
  const names = {}; for (const p of players) names[p.code] = p.name;
  return { players, rules, games: list, picks, names };
}

/* ---------------- sync ---------------- */
/** Capture a query's template parts so it can be replayed inside a batched transaction. */
function tagged(strings, ...values) { return { strings, values }; }

export async function recordSyncError(where, e) {
  const msg = `${where}: ${e?.message || e}`.slice(0, 500);
  console.error(msg);
  try { await sql()`update settings set last_sync_error = ${msg}, last_sync_error_at = now() where id = 1`; } catch {}
}
export async function syncSchedule(log = [], prefetched = null) {
  let fetchedResult;
  try { fetchedResult = prefetched || await fetchSchedule(SEASON); }
  catch (e) { await recordSyncError('schedule', e); throw e; }
  const { source, games: fetched } = fetchedResult;
  const existing = await sql()`select id, date, tipoff, home, away, selector, status from games`;
  const known = new Map(existing.map(r => [r.id, { ...r, date: typeof r.date === 'string' ? r.date : toDateStr(r.date) }]));
  const seasonStart = [...fetched.map(g => g.date), ...known.values()].map(x => x.date || x).sort()[0];
  const all = [...fetched, ...[...known.values()].filter(k => !fetched.some(f => f.id === k.id))];
  const byDate = groupByDate(all);
  let inserted = 0, updated = 0;
  const pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending.splice(0);
    if (typeof sql().transaction === 'function') await sql().transaction(batch.map(q => sql()(q.strings, ...q.values)));
    else for (const q of batch) await sql()(q.strings, ...q.values);
  };
  for (const g of fetched) {
    const prev = known.get(g.id);
    if (!prev) {
      const selector = assignSelector(g, byDate.get(g.date) || [g], seasonStart);
      pending.push(tagged`insert into games (id, date, tipoff, home, away, arena, cup, selector, status, source_ids)
        values (${g.id}, ${g.date}, ${g.tipoff}, ${g.home}, ${g.away}, ${g.arena}, ${g.cup}, ${selector}, 'scheduled', ${JSON.stringify(g.sourceIds)})
        on conflict (id) do nothing`);
      if (pending.length >= 150) await flush();
      inserted++;
    } else if (new Date(prev.tipoff).toISOString() !== g.tipoff || prev.status === 'postponed') {
      await sql()`update games set tipoff = ${g.tipoff}, arena = coalesce(${g.arena}, arena), cup = ${g.cup}, status = case when status = 'postponed' then 'scheduled' else status end,
        source_ids = source_ids || ${JSON.stringify(g.sourceIds)}::jsonb, updated_at = now() where id = ${g.id}`;
      updated++;
    }
  }
  await flush();
  // Games that vanished from the schedule before tipping off were postponed (they come back under a new date/id).
  let postponed = 0;
  const fetchedIds = new Set(fetched.map(g => g.id));
  for (const k of known.values()) {
    if (!fetchedIds.has(k.id) && k.status === 'scheduled' && k.date >= SEASON.start) {
      await sql()`update games set status = 'postponed', updated_at = now() where id = ${k.id}`; postponed++;
    }
  }
  await sql()`update settings set last_schedule_sync = now(), last_sync_error = null where id = 1`;
  log.push(`schedule(${source}): ${fetched.length} games, ${inserted} new, ${updated} changed, ${postponed} postponed`);
  return { inserted, updated, postponed };
}

/** Batch-score every game that has tipped off and is not final yet (normally just yesterday's slate;
 *  more dates only when a previous run was missed). One feed request per date. */
export async function syncScores(log = []) {
  const due = await sql()`select distinct date from games where status in ('scheduled','live') and tipoff < now() - interval '3 hours' order by date desc limit 7`;
  const dates = due.map(r => (typeof r.date === 'string' ? r.date : toDateStr(r.date)));
  if (!dates.length) { log.push('scores: nothing due'); return { updates: 0, finals: 0, postponed: 0 }; }
  let results;
  try { results = await fetchScoresForDates(dates); } catch (e) { await recordSyncError('scores', e); throw e; }
  let updates = 0, finals = 0, postponed = 0;
  for (const date of dates) {
    const r = results.get(date);
    if (!r || !r.games.length) { log.push(`scores ${date}: feed unavailable, left locked`); continue; }
    const seen = new Set();
    for (const g of r.games) {
      seen.add(g.id);
      const [prev] = await sql()`select id, status from games where id = ${g.id}`;
      if (!prev || prev.status === 'final') continue;
      const newlyFinal = g.status === 'final';
      await sql()`update games set status = ${g.status}, home_score = ${g.homeScore}, away_score = ${g.awayScore}, clock = ${g.clock},
        final_at = case when ${newlyFinal} then now() else final_at end, source_ids = source_ids || ${JSON.stringify(g.sourceIds)}::jsonb, updated_at = now() where id = ${g.id}`;
      updates++; if (newlyFinal) finals++;
    }
    // A game we expected that day that the feed no longer lists was postponed; it returns under its new date.
    const expected = await sql()`select id from games where date = ${date} and status in ('scheduled','live') and tipoff < now() - interval '3 hours'`;
    for (const e of expected) if (!seen.has(e.id)) { await sql()`update games set status = 'postponed', updated_at = now() where id = ${e.id}`; postponed++; }
    log.push(`scores ${date} (${r.source}): ${r.games.length} in feed`);
  }
  await sql()`update settings set last_scores_sync = now() where id = 1`;
  log.push(`scores: ${updates} updated, ${finals} final, ${postponed} postponed`);
  return { updates, finals, postponed };
}

/* ---------------- clocks ---------------- */
function localClock(tz, d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
const fmtTimeIn = (iso, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const dow = date => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));

/* ---------------- the two daily jobs ---------------- */
export const BATCH_TZ = 'America/Denver';
export function batchClock(d = new Date()) { return localClock(BATCH_TZ, d); }
const now = () => Date.now();

/** 5 AM Mountain (Vercel cron, 12:00 UTC): schedule refresh + every game that has tipped off.
 *  Runs once per Mountain day; `force` re-runs it (first load, or a manual catch-up). */
export async function dailyJob(log = [], force = false) {
  const clock = batchClock();
  if (!force && !await once(`daily:${clock.date}`)) { log.push(`skipped: already ran on ${clock.date}`); return false; }
  // The schedule rarely changes: refresh it weekly (Mondays, Mountain time) or when the table is empty.
  // Postponements in between are caught by the score pass, and the next weekly refresh re-adds the game.
  const [{ n }] = await sql()`select count(*)::int as n from games`;
  const monday = new Date(now()).toLocaleDateString('en-US', { weekday: 'short', timeZone: BATCH_TZ }) === 'Mon';
  if (force || n === 0 || monday) { try { await syncSchedule(log); } catch (e) { log.push(`schedule failed: ${e.message}`); } }
  else log.push('schedule: weekly refresh not due');
  await syncScores(log);
  return true;
}

/** Morning message (Vercel cron, 16:00 UTC): yesterday's result + tonight's to-do, to both players.
 *  Database only, no feed calls. Once per Mountain day per player. */
export async function morningJob(log = [], force = false) {
  const now = new Date();
  const todayET = etDate(now);
  const clock = batchClock(now);
  const L = await loadLeague(etDate(new Date(now - 3 * 86400e3)), etDate(new Date(now.getTime() + 10 * 86400e3)));
  const byDate = groupByDate(L.games);
  const todays = (byDate.get(todayET) || []).filter(g => g.status !== 'postponed');
  // most recent fully scored day before today
  let lastDay = null;
  for (const [date, dayGames] of [...byDate].reverse()) {
    const played = dayGames.filter(g => g.status !== 'postponed');
    if (date >= todayET || !played.length || !played.every(g => g.status === 'final')) continue;
    lastDay = { date, day: scoreDay(date, played, L.picks, L.rules) }; break;
  }
  for (const pl of L.players) {
    const me = pl.code, opp = otherPlayer(me), tz = pl.tz || 'America/New_York';
    if (pl.notify_results === false) continue;
    if (!force && !await once(`morning:${me}:${clock.date}`)) { log.push(`morning already sent to ${me}`); continue; }
    const parts = [];
    if (lastDay && (force || await once(`result:${lastDay.date}:${me}`))) {
      const d = lastDay.day;
      const who = d.dayWinner === 'tie' ? 'Tied' : d.dayWinner === me ? 'You took it' : `${L.names[opp]} took it`;
      const bonus = d[me].bonus ? ` (+${d[me].bonus} show-up bonus for you)` : d[opp].bonus ? ` (+${d[opp].bonus} show-up bonus for ${L.names[opp]})` : '';
      parts.push(`${dow(lastDay.date)}: ${L.names.UP} ${d.UP.total}–${d.KP.total} ${L.names.KP}. ${who}${bonus}.`);
    }
    const open = todays.filter(g => isPickable(g, L.rules, now));
    const missing = missingPicks(me, open, L.picks);
    const callsWaiting = missing.filter(m => m.items.includes('call')).length;
    if (todays.length) {
      const firstTip = todays.map(g => g.tipoff).sort()[0];
      parts.push(missing.length
        ? `Tonight: ${todays.length} game${todays.length > 1 ? 's' : ''}, ${missing.length} still need your input${callsWaiting ? ` (${callsWaiting} line${callsWaiting > 1 ? 's' : ''} from ${L.names[opp]} to call)` : ''}. First tip ${fmtTimeIn(firstTip, tz)}. Skip the day and ${L.names[opp]} banks +${L.rules.showUpBonus}.`
        : `Tonight: ${todays.length} game${todays.length > 1 ? 's' : ''}, you're all set. First tip ${fmtTimeIn(firstTip, tz)}.`);
    }
    if (!parts.length) { log.push(`nothing to say to ${me}`); continue; }
    const title = lastDay && todays.length ? 'Last night and tonight' : lastDay ? 'Last night' : `${todays.length} game${todays.length > 1 ? 's' : ''} tonight`;
    await sendTo(me, { title, body: parts.join(' '), tag: 'morning', url: '/#slate' });
    log.push(`morning -> ${me}`);
  }
}

/** Immediately tell the responder when a line lands (called from /api/pick). */
export async function notifyLinePosted(game, selector, line) {
  const resp = otherPlayer(selector);
  const [pl] = await sql()`select name, notify_lines from players where code = ${resp}`;
  const [sel] = await sql()`select name from players where code = ${selector}`;
  if (!pl || pl.notify_lines === false) return;
  if (!await once(`line:${game.id}:${resp}`)) return;
  await sendTo(resp, { title: `${sel?.name || selector} posted a line`, body: `${TEAMS[game.away].name} @ ${TEAMS[game.home].name}: winner by ${line}. Over or under?`, tag: 'lines', url: '/#slate' });
}
