// League state loading, schedule/score syncing, and the notification rules.
import { sql } from './db.js';
import { sendTo, once } from './notify.js';
import { fetchSchedule, fetchRecentScores, etDate } from './feeds.js';
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

export async function syncScores(log = []) {
  const { source, games } = await fetchRecentScores();
  let updates = 0, finals = 0;
  for (const g of games) {
    const rows = await sql()`select id, status from games where id = ${g.id}`;
    if (!rows.length) continue;                       // not a game we track (or schedule not loaded yet)
    const prev = rows[0];
    if (prev.status === 'final' && g.status === 'final') continue;
    const newlyFinal = g.status === 'final' && prev.status !== 'final';
    await sql()`update games set status = ${g.status}, home_score = ${g.homeScore}, away_score = ${g.awayScore}, clock = ${g.clock},
      final_at = case when ${newlyFinal} then now() else final_at end, source_ids = source_ids || ${JSON.stringify(g.sourceIds)}::jsonb, updated_at = now() where id = ${g.id}`;
    updates++; if (newlyFinal) finals++;
  }
  await sql()`update settings set last_scores_sync = now() where id = 1`;
  log.push(`scores(${source}): ${updates} updated, ${finals} newly final`);
  return { updates, finals };
}

/** Called from /api/state: refresh scores at most every few minutes, only when something is in play. */
export async function maybeRefreshScores() {
  const rows = await sql()`select last_scores_sync from settings where id = 1`;
  const last = rows[0]?.last_scores_sync ? new Date(rows[0].last_scores_sync) : null;
  if (last && Date.now() - last.getTime() < 3 * 60e3) return false;
  const live = await sql()`select 1 from games where status in ('scheduled','live') and tipoff <= now() and tipoff > now() - interval '8 hours' limit 1`;
  if (!live.length) return false;
  try { await syncScores(); await notifyAll(); return true; } catch (e) { console.error('refresh failed', e); return false; }
}

/* ---------------- notifications ---------------- */
function localClock(tz, d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
const fmtTimeIn = (iso, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const dow = date => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));

/** Daily reminder, pre-tip nudge, unanswered lines, and the nightly result. Idempotent (notifications_log). */
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
    if (todays.length && clock.time >= (pl.reminder_time || '11:00').slice(0, 5) && await once(`reminder:${me}:${clock.date}`) && missing.length) {
      await sendTo(me, { title: `${todays.length} game${todays.length > 1 ? 's' : ''} tonight`, body: `${missing.length} still need your input. First tip ${fmtTimeIn(firstTip, tz)}. Skip the day and ${L.names[opp]} banks +${L.rules.showUpBonus}.`, tag: 'reminder', url: '/#slate' });
      log.push(`reminder -> ${me}`);
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
  for (const [date, dayGames] of byDate) {
    const played = dayGames.filter(g => g.status !== 'postponed');
    if (date > todayET || !played.length || !played.every(g => g.status === 'final')) continue;
    if (!await once(`result:${date}`)) continue;
    const day = scoreDay(date, played, L.picks, L.rules);
    const title = day.dayWinner === 'tie' ? `${dow(date)} ends tied ${day.UP.total}–${day.KP.total}` : `${L.names[day.dayWinner]} takes ${dow(date)}`;
    const bonus = day.UP.bonus ? ` ${L.names.UP} +${day.UP.bonus} show-up bonus.` : day.KP.bonus ? ` ${L.names.KP} +${day.KP.bonus} show-up bonus.` : '';
    for (const p of L.players) if (p.notify_results !== false) await sendTo(p.code, { title, body: `${L.names.UP} ${day.UP.total} – ${day.KP.total} ${L.names.KP} over ${played.length} games.${bonus}`, tag: 'result', url: '/#history' });
    log.push(`result ${date}`);
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
