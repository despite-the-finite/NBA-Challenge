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
export async function syncSchedule(log = [], prefetched = null) {
  const { source, games: fetched } = prefetched || await fetchSchedule(SEASON);
  if (!fetched.length) throw new Error('schedule feed returned no regular-season games');
  const existing = await sql()`select id, date, tipoff, home, away, selector, status from games`;
  const known = new Map(existing.map(r => [r.id, { ...r, date: typeof r.date === 'string' ? r.date : toDateStr(r.date) }]));
  const seasonStart = [...fetched.map(g => g.date), ...known.values()].map(x => x.date || x).sort()[0];
  const all = [...fetched, ...[...known.values()].filter(k => !fetched.some(f => f.id === k.id))];
  const byDate = groupByDate(all);
  let inserted = 0, updated = 0;
  for (const g of fetched) {
    const prev = known.get(g.id);
    if (!prev) {
      const selector = assignSelector(g, byDate.get(g.date) || [g], seasonStart);
      await sql()`insert into games (id, date, tipoff, home, away, arena, cup, selector, status, source_ids)
        values (${g.id}, ${g.date}, ${g.tipoff}, ${g.home}, ${g.away}, ${g.arena}, ${g.cup}, ${selector}, 'scheduled', ${JSON.stringify(g.sourceIds)})
        on conflict (id) do nothing`;
      inserted++;
    } else if (new Date(prev.tipoff).toISOString() !== g.tipoff || prev.status === 'postponed') {
      await sql()`update games set tipoff = ${g.tipoff}, arena = coalesce(${g.arena}, arena), cup = ${g.cup}, status = case when status = 'postponed' then 'scheduled' else status end,
        source_ids = source_ids || ${JSON.stringify(g.sourceIds)}::jsonb, updated_at = now() where id = ${g.id}`;
      updated++;
    }
  }
  // Games that vanished from the schedule before tipping off were postponed (they come back under a new date/id).
  let postponed = 0;
  const fetchedIds = new Set(fetched.map(g => g.id));
  for (const k of known.values()) {
    if (!fetchedIds.has(k.id) && k.status === 'scheduled' && k.date >= SEASON.start) {
      await sql()`update games set status = 'postponed', updated_at = now() where id = ${k.id}`; postponed++;
    }
  }
  await sql()`update settings set last_schedule_sync = now() where id = 1`;
  log.push(`schedule(${source}): ${fetched.length} games, ${inserted} new, ${updated} changed, ${postponed} postponed`);
  return { inserted, updated, postponed };
}

/** Batch-score every game that has tipped off and is not final yet (normally just yesterday's slate;
 *  more dates only when a previous run was missed). One feed request per date. */
export async function syncScores(log = []) {
  const due = await sql()`select distinct date from games where status in ('scheduled','live') and tipoff < now() - interval '3 hours' order by date desc limit 7`;
  const dates = due.map(r => (typeof r.date === 'string' ? r.date : toDateStr(r.date)));
  if (!dates.length) { log.push('scores: nothing due'); return { updates: 0, finals: 0, postponed: 0 }; }
  const results = await fetchScoresForDates(dates);
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

/* ---------------- the daily batch (5 AM Mountain) ---------------- */
export const BATCH_TZ = 'America/Denver';
export const BATCH_HOUR = 5;
export function batchClock(d = new Date()) { return localClock(BATCH_TZ, d); }
/** True when it is the batch hour in Mountain time (the two UTC crons cover MST and MDT; only one lands on 5 AM). */
export function isBatchHour(d = new Date()) { return Number(batchClock(d).time.slice(0, 2)) === BATCH_HOUR; }

/** Schedule refresh + yesterday's scores + any notifications now due. Runs once per Mountain day. */
export async function dailyJob(log = [], force = false) {
  const clock = batchClock();
  if (!force && !isBatchHour()) { log.push(`skipped: ${clock.time} Mountain is not the ${BATCH_HOUR}:00 batch hour`); return false; }
  if (!force && !await once(`daily:${clock.date}`)) { log.push(`skipped: already ran on ${clock.date}`); return false; }
  try { await syncSchedule(log); } catch (e) { log.push(`schedule failed: ${e.message}`); }
  await syncScores(log);
  await notifyAll(log);
  return true;
}

/* ---------------- notifications ---------------- */
function localClock(tz, d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
const fmtTimeIn = (iso, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const dow = date => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));

/** Morning reminder (with yesterday's result), pre-tip nudge, unanswered lines. Idempotent (notifications_log). */
export async function notifyAll(log = []) {
  const now = new Date();
  const todayET = etDate(now);
  const L = await loadLeague(etDate(new Date(now - 3 * 86400e3)), etDate(new Date(now.getTime() + 10 * 86400e3)));
  const byDate = groupByDate(L.games);
  const todays = (byDate.get(todayET) || []).filter(g => g.status !== 'postponed');
  for (const pl of L.players) {
    const me = pl.code, opp = otherPlayer(me), tz = pl.tz || 'America/New_York';
    const clock = localClock(tz, now);
    const open = todays.filter(g => isPickable(g, L.rules, now));
    const missing = missingPicks(me, open, L.picks);
    const firstTip = todays.length ? todays.map(g => g.tipoff).sort()[0] : null;
    // One morning message at the player's reminder time: yesterday's result (scored in the 5 AM batch) + tonight's to-do.
    if (clock.time >= (pl.reminder_time || '11:00').slice(0, 5) && await once(`reminder:${me}:${clock.date}`)) {
      const lines = [];
      let resultDate = null;
      for (const [date, dayGames] of [...byDate].reverse()) {
        const played = dayGames.filter(g => g.status !== 'postponed');
        if (date >= todayET || !played.length || !played.every(g => g.status === 'final')) continue;
        if (pl.notify_results !== false && await once(`result:${date}:${me}`)) {
          const day = scoreDay(date, played, L.picks, L.rules);
          const who = day.dayWinner === 'tie' ? 'Tied' : `${L.names[day.dayWinner]} took it`;
          const bonus = day[me].bonus ? ` (+${day[me].bonus} show-up bonus for you)` : day[opp].bonus ? ` (+${day[opp].bonus} show-up bonus for ${L.names[opp]})` : '';
          lines.push(`${dow(date)}: ${L.names.UP} ${day.UP.total}–${day.KP.total} ${L.names.KP}. ${who}${bonus}.`);
          resultDate = date;
        }
        break;
      }
      if (todays.length && missing.length) lines.push(`Tonight: ${todays.length} game${todays.length > 1 ? 's' : ''}, ${missing.length} still need your input. First tip ${fmtTimeIn(firstTip, tz)}. Skip the day and ${L.names[opp]} banks +${L.rules.showUpBonus}.`);
      if (lines.length) {
        const title = resultDate && todays.length ? 'Last night and tonight' : resultDate ? 'Last night' : `${todays.length} game${todays.length > 1 ? 's' : ''} tonight`;
        await sendTo(me, { title, body: lines.join(' '), tag: 'reminder', url: '/#slate' });
        log.push(`reminder -> ${me}`);
      }
    }
    if (pl.notify_pretip !== false && firstTip && missing.length) {
      const mins = (new Date(firstTip) - now) / 60000;
      if (mins > 0 && mins <= 75 && await once(`pretip:${me}:${todayET}`)) {
        await sendTo(me, { title: `Tip-off in about ${Math.round(mins)} min`, body: `${missing.length} pick${missing.length > 1 ? 's' : ''} still open. Lock them in before the buzzer.`, tag: 'pretip', url: '/#slate' });
        log.push(`pretip -> ${me}`);
      }
    }
    if (pl.notify_lines !== false) {
      const waiting = [];
      for (const g of L.games) {
        if (g.selector !== opp || !isPickable(g, L.rules, now)) continue;
        const line = L.picks.get(g.id)?.[opp]?.line, call = L.picks.get(g.id)?.[me]?.ou;
        if (line != null && call == null && await once(`line:${g.id}:${me}`)) waiting.push({ g, line });
      }
      if (waiting.length === 1) { const { g, line } = waiting[0]; await sendTo(me, { title: `${L.names[opp]} posted a line`, body: `${TEAMS[g.away].name} @ ${TEAMS[g.home].name}: winner by ${line}. Over or under?`, tag: 'lines', url: '/#slate' }); }
      else if (waiting.length > 1) await sendTo(me, { title: `${L.names[opp]} posted ${waiting.length} lines`, body: 'Make your Over/Under calls before tip-off.', tag: 'lines', url: '/#slate' });
      if (waiting.length) log.push(`lines(${waiting.length}) -> ${me}`);
    }
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
