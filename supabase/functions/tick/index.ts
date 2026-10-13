// `tick` edge function: keeps the league running without anyone touching a spreadsheet.
//   ?job=schedule  pull the regular-season schedule (new games, moved tip-offs, postponements)
//   ?job=scores    pull live/final scores for yesterday and today, then send any due notifications
//   body {job:'test-push'}  (from the app, signed in) send a test notification to the caller
//
// Secrets (Dashboard -> Edge Functions -> Secrets): CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT (mailto:you@example.com). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';
import { DEFAULT_RULES, PLAYER_CODES, otherPlayer, assignSelector, groupByDate, scoreDay, missingPicks, isPickable } from '../_shared/scoring.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const ESPN_TO_CODE: Record<string, string> = { ATL: 'ATL', BOS: 'BOS', BKN: 'BKN', CHA: 'CHA', CHI: 'CHI', CLE: 'CLE', DAL: 'DAL', DEN: 'DEN', DET: 'DET', GS: 'GSW', GSW: 'GSW', HOU: 'HOU', IND: 'IND', LAC: 'LAC', LAL: 'LAL', MEM: 'MEM', MIA: 'MIA', MIL: 'MIL', MIN: 'MIN', NO: 'NOP', NOP: 'NOP', NY: 'NYK', NYK: 'NYK', OKC: 'OKC', ORL: 'ORL', PHI: 'PHI', PHX: 'PHX', POR: 'POR', SAC: 'SAC', SA: 'SAS', SAS: 'SAS', TOR: 'TOR', UTAH: 'UTA', UTA: 'UTA', WSH: 'WAS', WAS: 'WAS' };
const TEAM_NAMES: Record<string, string> = { ATL: 'Hawks', BOS: 'Celtics', BKN: 'Nets', CHA: 'Hornets', CHI: 'Bulls', CLE: 'Cavaliers', DAL: 'Mavericks', DEN: 'Nuggets', DET: 'Pistons', GSW: 'Warriors', HOU: 'Rockets', IND: 'Pacers', LAC: 'Clippers', LAL: 'Lakers', MEM: 'Grizzlies', MIA: 'Heat', MIL: 'Bucks', MIN: 'Timberwolves', NOP: 'Pelicans', NYK: 'Knicks', OKC: 'Thunder', ORL: 'Magic', PHI: '76ers', PHX: 'Suns', POR: 'Trail Blazers', SAC: 'Kings', SAS: 'Spurs', TOR: 'Raptors', UTA: 'Jazz', WAS: 'Wizards' };
const ET = 'America/New_York';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const job = url.searchParams.get('job') || body.job;
    const log: string[] = [];
    if (job === 'test-push') {
      const player = await callerPlayer(req);
      if (!player) return json({ error: 'not signed in or not linked to a player' }, 401);
      const n = await sendTo(player, { title: 'NBA Challenge', body: 'Notifications are working on this device. 🏀', tag: 'test' });
      return json({ ok: true, sent: n });
    }
    const secret = req.headers.get('x-cron-secret');
    if (!Deno.env.get('CRON_SECRET') || secret !== Deno.env.get('CRON_SECRET')) return json({ error: 'bad cron secret' }, 401);
    if (job === 'schedule') await syncSchedule(log);
    else if (job === 'scores') { await syncScores(log); await notify(log); }
    else return json({ error: 'unknown job' }, 400);
    return json({ ok: true, log });
  } catch (e) {
    console.error(e);
    return json({ error: String(e?.message || e) }, 500);
  }
});

function json(obj: unknown, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

/* ---------------- ESPN ---------------- */
function etDate(d: Date) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
const compact = (ds: string) => ds.replace(/-/g, '');

async function fetchScoreboard(dates: string): Promise<any[]> {
  const r = await fetch(`${ESPN}?dates=${dates}&limit=1000`);
  if (!r.ok) throw new Error(`ESPN ${r.status} for ${dates}`);
  return (await r.json()).events || [];
}

function parseEvent(ev: any) {
  const comp = ev.competitions?.[0]; if (!comp) return null;
  if (ev.season?.type !== 2) return null;                      // 1 = preseason, 2 = regular season, 3 = playoffs
  const home = comp.competitors.find((c: any) => c.homeAway === 'home'), away = comp.competitors.find((c: any) => c.homeAway === 'away');
  const h = ESPN_TO_CODE[(home?.team?.abbreviation || '').toUpperCase()], a = ESPN_TO_CODE[(away?.team?.abbreviation || '').toUpperCase()];
  if (!h || !a) return null;                                     // All-Star etc.
  const headline = (comp.notes || []).map((n: any) => n.headline || '').join(' ');
  if (/cup/i.test(headline) && /(final|championship)/i.test(headline)) return null;  // NBA Cup final is not a regular-season game
  const state = comp.status?.type?.state;                        // pre | in | post
  const status = state === 'post' ? (comp.status?.type?.completed ? 'final' : 'postponed') : state === 'in' ? 'live' : 'scheduled';
  const tip = new Date(ev.date);
  return {
    id: `espn:${ev.id}`, date: etDate(tip), tipoff: tip.toISOString(), home: h, away: a,
    arena: comp.venue?.fullName || null, cup: /cup/i.test(headline), status,
    home_score: state === 'pre' ? null : Number(home.score ?? 0), away_score: state === 'pre' ? null : Number(away.score ?? 0),
    clock: state === 'in' ? `Q${comp.status.period} ${comp.status.displayClock}` : null,
  };
}

async function syncSchedule(log: string[]) {
  const start = Deno.env.get('SEASON_START') || '2026-10-01', end = Deno.env.get('SEASON_END') || '2027-04-30';
  const { data: existing } = await admin.from('games').select('id,date,tipoff,home,away,selector');
  const known = new Map((existing || []).map((g: any) => [g.id, g]));
  const fetched: any[] = [];
  // month by month keeps each response small
  let cur = new Date(start + 'T00:00:00Z');
  while (cur < new Date(end + 'T00:00:00Z')) {
    const next = new Date(cur); next.setUTCMonth(next.getUTCMonth() + 1);
    const to = next < new Date(end + 'T00:00:00Z') ? next : new Date(end + 'T00:00:00Z');
    for (const ev of await fetchScoreboard(`${compact(cur.toISOString().slice(0, 10))}-${compact(to.toISOString().slice(0, 10))}`)) { const g = parseEvent(ev); if (g) fetched.push(g); }
    cur = next;
  }
  const seasonStart = [...fetched.map(g => g.date), ...(existing || []).map((g: any) => g.date)].sort()[0];
  const byDate = groupByDate([...fetched, ...(existing || []).filter((g: any) => !fetched.some(f => f.id === g.id))]);
  const rows = fetched.map(g => {
    const prev = known.get(g.id);
    const selector = prev?.selector || assignSelector(g, byDate.get(g.date) || [g], seasonStart);
    const row: any = { ...g, selector, updated_at: new Date().toISOString() };
    if (prev) { delete row.status; delete row.home_score; delete row.away_score; delete row.clock; }  // scores come from the scores job
    return row;
  });
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from('games').upsert(rows.slice(i, i + 200), { onConflict: 'id' });
    if (error) throw error;
  }
  log.push(`schedule: ${fetched.length} games fetched, ${rows.filter(r => !known.has(r.id)).length} new`);
}

async function syncScores(log: string[]) {
  const now = new Date();
  const today = etDate(now), yesterday = etDate(new Date(now.getTime() - 86400e3));
  const events = [...await fetchScoreboard(compact(yesterday)), ...await fetchScoreboard(compact(today))];
  let finals = 0, updates = 0;
  for (const ev of events) {
    const g = parseEvent(ev); if (!g) continue;
    const { data: prev } = await admin.from('games').select('id,status,selector').eq('id', g.id).maybeSingle();
    if (!prev) {   // a game we have not seen (schedule job has not run yet): insert with a selector
      const { data: dayGames } = await admin.from('games').select('id,date,tipoff,home,away').eq('date', g.date);
      const { data: first } = await admin.from('games').select('date').order('date').limit(1);
      const selector = assignSelector(g, [...(dayGames || []), g], first?.[0]?.date || g.date);
      const { error } = await admin.from('games').insert({ ...g, selector }); if (error) throw error; continue;
    }
    const patch: any = { status: g.status, home_score: g.home_score, away_score: g.away_score, clock: g.clock, tipoff: g.tipoff, updated_at: now.toISOString() };
    if (g.status === 'final' && prev.status !== 'final') { patch.final_at = now.toISOString(); finals++; }
    const { error } = await admin.from('games').update(patch).eq('id', g.id); if (error) throw error; updates++;
  }
  log.push(`scores: ${updates} games updated, ${finals} newly final`);
}

/* ---------------- notifications ---------------- */
async function loadLeague() {
  const [{ data: players }, { data: settings }, { data: games }, { data: winners }, { data: duels }] = await Promise.all([
    admin.from('players').select('*'), admin.from('settings').select('rules').eq('id', 1).maybeSingle(),
    admin.from('games').select('*').gte('date', etDate(new Date(Date.now() - 3 * 86400e3))).lte('date', etDate(new Date(Date.now() + 10 * 86400e3))),
    admin.from('winner_picks').select('*'), admin.from('duel_picks').select('*'),
  ]);
  const rules = { ...DEFAULT_RULES, ...(settings?.rules || {}) };
  const gameList = (games || []).map((r: any) => ({ id: r.id, date: r.date, tipoff: r.tipoff, home: r.home, away: r.away, selector: r.selector, status: r.status, homeScore: r.home_score, awayScore: r.away_score }));
  const picks = new Map<string, any>();
  const put = (gid: string, p: string, patch: any) => { const all = picks.get(gid) || {}; all[p] = { ...(all[p] || {}), ...patch }; picks.set(gid, all); };
  for (const w of winners || []) put(w.game_id, w.player_code, { winner: w.winner });
  for (const d of duels || []) put(d.game_id, d.player_code, { line: d.line == null ? null : Number(d.line), ou: d.ou });
  const names: Record<string, string> = {}; for (const p of players || []) names[p.code] = p.name;
  return { players: players || [], rules, games: gameList, picks, names };
}

function localClock(tz: string, d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
const fmtTimeIn = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

async function once(key: string): Promise<boolean> {
  const { error } = await admin.from('notifications_log').insert({ key });
  return !error;   // false when the key already exists (unique violation)
}

async function notify(log: string[]) {
  const L = await loadLeague();
  const now = new Date();
  const todayET = etDate(now);
  const byDate = groupByDate(L.games);
  const todays = byDate.get(todayET) || [];

  for (const pl of L.players) {
    const me = pl.code, opp = otherPlayer(me);
    const clock = localClock(pl.tz || ET, now);
    const open = todays.filter(g => isPickable(g, L.rules, now));
    const missing = missingPicks(me, open, L.picks);
    const firstTip = todays.length ? todays.map(g => g.tipoff).sort()[0] : null;

    // 1. daily reminder at the player's chosen local time
    if (clock.time >= (pl.reminder_time || '11:00').slice(0, 5) && todays.length && await once(`reminder:${me}:${clock.date}`)) {
      if (missing.length) await sendTo(me, { title: `${todays.length} games tonight`, body: `${missing.length} still need your input. First tip ${fmtTimeIn(firstTip!, pl.tz || ET)}. Skip the day and ${L.names[opp]} banks +${L.rules.showUpBonus}.`, tag: 'reminder', url: './index.html#slate' });
    }
    // 2. nudge 60 minutes before the first tip
    if (pl.notify_pretip !== false && firstTip && missing.length) {
      const mins = (new Date(firstTip).getTime() - now.getTime()) / 60000;
      if (mins > 0 && mins <= 60 && await once(`pretip:${me}:${todayET}`)) await sendTo(me, { title: `Tip-off in ${Math.round(mins)} min`, body: `${missing.length} pick${missing.length > 1 ? 's' : ''} still open. Lock them in before the buzzer.`, tag: 'pretip' });
    }
    // 3. lines the other player posted that I have not answered (one grouped alert)
    if (pl.notify_lines !== false) {
      const waiting: any[] = [];
      for (const g of L.games) {
        if (g.selector !== opp || !isPickable(g, L.rules, now)) continue;
        const line = L.picks.get(g.id)?.[opp]?.line; const call = L.picks.get(g.id)?.[me]?.ou;
        if (line != null && call == null && await once(`line:${g.id}:${me}`)) waiting.push({ g, line });
      }
      if (waiting.length === 1) { const { g, line } = waiting[0]; await sendTo(me, { title: `${L.names[opp]} posted a line`, body: `${TEAM_NAMES[g.away]} @ ${TEAM_NAMES[g.home]}: winner by ${line}. Over or under?`, tag: 'lines' }); }
      else if (waiting.length > 1) await sendTo(me, { title: `${L.names[opp]} posted ${waiting.length} lines`, body: `Make your Over/Under calls before tip-off.`, tag: 'lines' });
    }
  }

  // 4. the day's result, once every game of a day is final
  for (const [date, dayGames] of byDate) {
    if (date > todayET || !dayGames.every(g => g.status === 'final')) continue;
    if (!await once(`result:${date}`)) continue;
    const day = scoreDay(date, dayGames, L.picks, L.rules);
    const title = day.dayWinner === 'tie' ? `Tied day: ${day.UP.total}–${day.KP.total}` : `${L.names[day.dayWinner!]} takes ${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: ET }).format(new Date(date + 'T12:00:00Z'))}`;
    const bonus = day.UP.bonus ? ` ${L.names.UP} +${day.UP.bonus} show-up bonus.` : day.KP.bonus ? ` ${L.names.KP} +${day.KP.bonus} show-up bonus.` : '';
    for (const p of L.players) if (p.notify_results !== false) await sendTo(p.code, { title, body: `${L.names.UP} ${day.UP.total} – ${day.KP.total} ${L.names.KP} over ${dayGames.length} games.${bonus}`, tag: 'result', url: './index.html#history' });
    log.push(`result sent for ${date}`);
  }
}

async function sendTo(player: string, payload: { title: string; body: string; tag?: string; url?: string }): Promise<number> {
  const pub = Deno.env.get('VAPID_PUBLIC_KEY'), priv = Deno.env.get('VAPID_PRIVATE_KEY');
  if (!pub || !priv) { console.warn('VAPID keys not set; skipping push'); return 0; }
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com', pub, priv);
  const { data: subs } = await admin.from('push_subscriptions').select('*').eq('player_code', player);
  let sent = 0;
  for (const s of subs || []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload)); sent++; }
    catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);  // device unsubscribed
      else console.error('push failed', e?.statusCode, e?.body || e?.message);
    }
  }
  return sent;
}

async function callerPlayer(req: Request): Promise<string | null> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return null;
  const { data } = await admin.from('players').select('code').eq('auth_user_id', user.id).maybeSingle();
  return data?.code || null;
}
