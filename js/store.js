// Data layer. Two implementations of the same interface:
//   DemoStore  - everything lives in this browser (localStorage), with a demo clock you can
//                advance to see locking, scoring and the show-up bonus in action.
//   LiveStore  - Supabase (Postgres + Auth + Realtime). Both players share one database;
//                the `tick` edge function syncs the schedule/scores and sends push alerts.
import { DEFAULT_RULES, PLAYER_CODES, otherPlayer, assignSelector, groupByDate, isLocked, isPickable, isValidLine, gameWinner } from './scoring.js';

const LS_KEY = 'nbac.demo.v2';

class BaseStore {
  constructor(config) {
    this.config = config;
    this.games = new Map();
    this.picks = new Map();      // gameId -> { UP: {winner,line,ou}, KP: {...} }
    this.rules = { ...DEFAULT_RULES };
    this.players = JSON.parse(JSON.stringify(config.PLAYERS));
    this.me = null;
    this.listeners = new Set();
    this.ready = false;
  }
  now() { return new Date(); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }
  gameList() { return [...this.games.values()]; }
  pickFor(gameId, player) { return (this.picks.get(gameId) || {})[player] || null; }
  picksFor(gameId) { return this.picks.get(gameId) || {}; }
  seasonStart() {
    let min = null;
    for (const g of this.games.values()) if (!min || g.date < min) min = g.date;
    return min;
  }
  canEdit(game) { return !!this.me && isPickable(game, this.rules, this.now()); }
  /** The responder has answered: the line is frozen. */
  lineFrozen(game) { return this.pickFor(game.id, otherPlayer(game.selector))?.ou != null; }

  // ---- mutations shared by both stores (validation, then persist) ----
  async setWinner(gameId, team) {
    const g = this.games.get(gameId);
    if (!g || !this.canEdit(g)) throw new Error('This game is locked.');
    if (team != null && team !== g.home && team !== g.away) throw new Error('Not a team in this game.');
    await this.persistPick(gameId, this.me, { winner: team });
  }
  async setLine(gameId, line) {
    const g = this.games.get(gameId);
    if (!g || !this.canEdit(g)) throw new Error('This game is locked.');
    if (g.selector !== this.me) throw new Error(`${this.players[g.selector].name} sets the line for this game.`);
    if (this.lineFrozen(g)) throw new Error('The line is frozen once the other player has answered it.');
    if (line != null && !isValidLine(line, this.rules)) throw new Error('Line must be a whole number' + (this.rules.halfPointLines ? ' or half point' : '') + ` between ${this.rules.lineMin} and ${this.rules.lineMax}.`);
    await this.persistPick(gameId, this.me, { line });
  }
  async setCall(gameId, ou) {
    const g = this.games.get(gameId);
    if (!g || !this.canEdit(g)) throw new Error('This game is locked.');
    if (g.selector === this.me) throw new Error('You set the line; your brother makes the call.');
    if (this.pickFor(gameId, g.selector)?.line == null) throw new Error('No line posted yet.');
    if (ou != null && ou !== 'O' && ou !== 'U') throw new Error('Call must be Over or Under.');
    await this.persistPick(gameId, this.me, { ou });
  }
  applyPick(gameId, player, patch) {
    const all = this.picks.get(gameId) || {};
    const cur = { ...(all[player] || {}) , ...patch };
    for (const k of Object.keys(cur)) if (cur[k] == null) delete cur[k];
    if (Object.keys(cur).length) all[player] = cur; else delete all[player];
    if (Object.keys(all).length) this.picks.set(gameId, all); else this.picks.delete(gameId);
  }
}

/* ============================ DEMO ============================ */
export class DemoStore extends BaseStore {
  constructor(config) {
    super(config);
    this.mode = 'demo';
    this.state = { picks: {}, results: {}, me: 'UP', clockOffsetMs: null, rules: {}, players: {} };
  }
  async init() {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) this.state = { ...this.state, ...JSON.parse(raw) }; } catch {}
    const res = await fetch('data/sample-schedule.json');
    const data = await res.json();
    const seasonStart = data.games[0].date;
    const byDate = groupByDate(data.games);
    for (const [, dayGames] of byDate) {
      for (const g of dayGames) {
        this.games.set(g.id, { ...g, selector: assignSelector(g, dayGames, seasonStart), status: 'scheduled', homeScore: null, awayScore: null });
      }
    }
    if (this.state.clockOffsetMs == null) {
      // First visit: pretend it is a busy mid-season evening with a month of history behind us.
      const target = new Date('2026-11-27T12:00:00-05:00');
      this.state.clockOffsetMs = target.getTime() - Date.now();
      this.save();
      this.simulatePast();
    }
    this.rules = { ...DEFAULT_RULES, ...(this.state.rules || {}) };
    for (const p of PLAYER_CODES) if (this.state.players?.[p]?.name) this.players[p].name = this.state.players[p].name;
    this.me = this.state.me || 'UP';
    for (const [id, r] of Object.entries(this.state.results)) { const g = this.games.get(id); if (g) Object.assign(g, r); }
    for (const [id, p] of Object.entries(this.state.picks)) this.picks.set(id, p);
    this.ready = true;
  }
  now() { return new Date(Date.now() + (this.state.clockOffsetMs || 0)); }
  save() { try { localStorage.setItem(LS_KEY, JSON.stringify(this.state)); } catch {} }
  async persistPick(gameId, player, patch) {
    this.applyPick(gameId, player, patch);
    const all = this.picks.get(gameId);
    if (all) this.state.picks[gameId] = all; else delete this.state.picks[gameId];
    this.save(); this.emit();
  }
  switchPlayer(code) { this.me = code; this.state.me = code; this.save(); this.emit(); }
  async setRules(patch) { this.rules = { ...this.rules, ...patch }; this.state.rules = { ...(this.state.rules || {}), ...patch }; this.save(); this.emit(); }
  async setPlayerName(code, name) { this.players[code].name = name; this.state.players = { ...(this.state.players || {}), [code]: { name } }; this.save(); this.emit(); }
  /** Move the demo clock forward one day and play out everything that is now in the past. */
  advanceDay() { this.state.clockOffsetMs += 24 * 3600 * 1000; this.save(); this.simulatePast(); }
  resetDemo() { try { localStorage.removeItem(LS_KEY); } catch {} location.reload(); }
  /** Give both players plausible picks on past games, then random finals. Deterministic per game id. */
  simulatePast() {
    const now = this.now();
    const rnd = seeded;
    const byDate = groupByDate(this.gameList());
    for (const [date, dayGames] of byDate) {
      const started = dayGames.filter(g => new Date(g.tipoff) <= now);
      if (!started.length) continue;
      // Occasionally a player skips a whole day, so the show-up bonus shows up in the demo.
      const skip = rnd(date + 'skip') < 0.18 ? (rnd(date + 'who') < 0.5 ? 'UP' : 'KP') : null;
      for (const g of started) {
        const picks = this.picks.get(g.id) || {};
        for (const p of PLAYER_CODES) {
          if (p === skip) continue;
          if (picks[p]?.winner && (g.selector !== p ? true : picks[p].line != null)) continue;
          const homeFav = rnd(g.id + 'fav') < 0.58;
          const pick = { ...(picks[p] || {}) };
          if (!pick.winner) pick.winner = rnd(g.id + p + 'w') < 0.72 ? (homeFav ? g.home : g.away) : (homeFav ? g.away : g.home);
          if (g.selector === p) { if (pick.line == null) pick.line = 4 + Math.floor(rnd(g.id + 'line') * 11); }
          else if (!pick.ou) pick.ou = rnd(g.id + p + 'ou') < 0.5 ? 'O' : 'U';
          picks[p] = pick;
        }
        // a responder cannot have a call without a line
        const resp = otherPlayer(g.selector);
        if (picks[resp]?.ou && picks[g.selector]?.line == null) delete picks[resp].ou;
        if (Object.keys(picks).length) { this.picks.set(g.id, picks); this.state.picks[g.id] = picks; }
        this.finishGame(g, rnd);
      }
    }
    this.save(); this.emit();
  }
  finishGame(g, rnd) {
    if (g.status === 'final') return;
    const homeWins = rnd(g.id + 'res') < 0.56;
    const margin = 1 + Math.floor(Math.pow(rnd(g.id + 'm'), 1.6) * 28);
    const loser = 95 + Math.floor(rnd(g.id + 's') * 25);
    const r = { status: 'final', homeScore: homeWins ? loser + margin : loser, awayScore: homeWins ? loser : loser + margin };
    Object.assign(g, r); this.state.results[g.id] = r;
  }
}

function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/* ============================ LIVE (Supabase) ============================ */
export class LiveStore extends BaseStore {
  constructor(config) {
    super(config);
    this.mode = 'live';
    this.user = null;
    this.playerRows = {};
  }
  async init() {
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js');
    this.sb = window.supabase.createClient(this.config.SUPABASE_URL, this.config.SUPABASE_ANON_KEY);
    const { data: { session } } = await this.sb.auth.getSession();
    this.user = session?.user || null;
    this.sb.auth.onAuthStateChange((_e, s) => {
      const changed = (s?.user?.id || null) !== (this.user?.id || null);
      this.user = s?.user || null;
      if (changed) this.loadAll().then(() => this.emit());
    });
    if (this.user) await this.loadAll();
    this.ready = true;
  }
  async signIn(email, password) {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }
  async signOut() { await this.sb.auth.signOut(); this.me = null; this.games.clear(); this.picks.clear(); this.emit(); }
  async loadAll() {
    if (!this.user) return;
    const [players, settings, games, winners, duels] = await Promise.all([
      this.sb.from('players').select('*'),
      this.sb.from('settings').select('*').eq('id', 1).maybeSingle(),
      this.sb.from('games').select('*').order('tipoff'),
      this.sb.from('winner_picks').select('*'),
      this.sb.from('duel_picks').select('*'),
    ]);
    for (const q of [players, settings, games, winners, duels]) if (q.error) throw q.error;
    for (const p of players.data) { this.playerRows[p.code] = p; this.players[p.code] = { ...this.players[p.code], name: p.name, color: p.color || this.players[p.code].color }; if (p.auth_user_id === this.user.id) this.me = p.code; }
    if (settings.data?.rules) this.rules = { ...DEFAULT_RULES, ...settings.data.rules };
    this.games.clear(); this.picks.clear();
    for (const g of games.data) this.games.set(g.id, rowToGame(g));
    for (const w of winners.data) this.applyPick(w.game_id, w.player_code, { winner: w.winner });
    for (const d of duels.data) this.applyPick(d.game_id, d.player_code, { line: d.line == null ? null : Number(d.line), ou: d.ou });
    // Which games the opponent has already picked (the pick itself stays hidden until tip-off).
    const { data: status } = await this.sb.from('pick_status').select('*');
    this.oppPicked = new Set((status || []).map(s => `${s.game_id}:${s.player_code}`));
    this.subscribeRealtime();
  }
  oppHasWinner(gameId, player) { return this.oppPicked?.has(`${gameId}:${player}`) || !!this.pickFor(gameId, player)?.winner; }
  subscribeRealtime() {
    if (this.channel) return;
    this.channel = this.sb.channel('nba')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'duel_picks' }, (p) => {
        const r = p.new?.game_id ? p.new : p.old;
        if (p.eventType === 'DELETE') this.applyPick(r.game_id, r.player_code, { line: null, ou: null });
        else this.applyPick(r.game_id, r.player_code, { line: r.line == null ? null : Number(r.line), ou: r.ou });
        this.emit();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'winner_picks' }, (p) => {
        const r = p.new?.game_id ? p.new : p.old;
        if (p.eventType === 'DELETE') this.applyPick(r.game_id, r.player_code, { winner: null });
        else { this.applyPick(r.game_id, r.player_code, { winner: r.winner }); this.oppPicked?.add(`${r.game_id}:${r.player_code}`); }
        this.emit();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, (p) => {
        if (p.new?.id) this.games.set(p.new.id, rowToGame(p.new));
        this.emit();
      })
      .subscribe();
  }
  async persistPick(gameId, player, patch) {
    if ('winner' in patch) {
      if (patch.winner == null) { const { error } = await this.sb.from('winner_picks').delete().match({ game_id: gameId, player_code: player }); if (error) throw error; }
      else { const { error } = await this.sb.from('winner_picks').upsert({ game_id: gameId, player_code: player, winner: patch.winner }, { onConflict: 'game_id,player_code' }); if (error) throw error; }
    } else {
      const cur = this.pickFor(gameId, player) || {};
      const row = { game_id: gameId, player_code: player, line: 'line' in patch ? patch.line : cur.line ?? null, ou: 'ou' in patch ? patch.ou : cur.ou ?? null };
      if (row.line == null && row.ou == null) { const { error } = await this.sb.from('duel_picks').delete().match({ game_id: gameId, player_code: player }); if (error) throw error; }
      else { const { error } = await this.sb.from('duel_picks').upsert(row, { onConflict: 'game_id,player_code' }); if (error) throw error; }
    }
    this.applyPick(gameId, player, patch); this.emit();
  }
  async setRules(patch) {
    this.rules = { ...this.rules, ...patch };
    const { error } = await this.sb.from('settings').upsert({ id: 1, rules: this.rules });
    if (error) throw error; this.emit();
  }
  async setPlayerName(code, name) {
    const { error } = await this.sb.from('players').update({ name }).eq('code', code);
    if (error) throw error; this.players[code].name = name; this.emit();
  }
  async savePrefs(prefs) {  // { tz, reminder_time, notify_lines, notify_results }
    const { error } = await this.sb.from('players').update(prefs).eq('code', this.me);
    if (error) throw error; Object.assign(this.playerRows[this.me], prefs); this.emit();
  }
  myPrefs() { return this.playerRows[this.me] || {}; }
  async enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser cannot receive push notifications. On iPhone, add the app to your Home Screen first.');
    if (!this.config.VAPID_PUBLIC_KEY) throw new Error('VAPID_PUBLIC_KEY is not set in config.js.');
    const reg = await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed.');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(this.config.VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await this.sb.from('push_subscriptions').upsert({ player_code: this.me, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent }, { onConflict: 'endpoint' });
    if (error) throw error;
    return true;
  }
  async disablePush() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await this.sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
  }
  async pushEnabled() {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(reg && await reg.pushManager.getSubscription());
  }
  async sendTestPush() {
    const { error } = await this.sb.functions.invoke('tick', { body: { job: 'test-push', player: this.me } });
    if (error) throw error;
  }
}

function rowToGame(r) {
  return { id: r.id, date: r.date, tipoff: r.tipoff, home: r.home, away: r.away, arena: r.arena, cup: r.cup, selector: r.selector,
    status: r.status, homeScore: r.home_score, awayScore: r.away_score, clock: r.clock };
}
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
}
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

export function createStore(config) {
  return config.SUPABASE_URL ? new LiveStore(config) : new DemoStore(config);
}
export { isLocked, isPickable, gameWinner };
