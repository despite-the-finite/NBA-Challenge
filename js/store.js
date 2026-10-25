// Data layer. Two implementations of one interface:
//   DemoStore - everything lives in this browser (localStorage) with a demo clock you can advance,
//               so you can see locking, scoring and the show-up bonus without a server.
//   LiveStore - talks to the Vercel API (/api/*) backed by Neon Postgres. Both players share one
//               database; the API enforces the rules; a light poll keeps both phones in sync.
import { DEFAULT_RULES, PLAYER_CODES, otherPlayer, assignSelector, groupByDate, isLocked, isPickable, isValidLine, gameWinner } from './scoring.js';
import { CONFERENCES, cupGroups, cupField, buildBracket, bracketOpen, bracketLocked, cleanBracketPicks } from './cup.js';

const LS_KEY = 'nbac.demo.v2';

class BaseStore {
  constructor(config) {
    this.config = config;
    this.games = new Map();
    this.picks = new Map();      // gameId -> { UP: {winner,line,ou}, KP: {...} }
    this.cupPicks = new Map();   // player -> { picks: {slot: team}, count, hidden }   (NBA Cup bracket)
    this.rules = { ...DEFAULT_RULES };
    this.players = JSON.parse(JSON.stringify(config.PLAYERS));
    this.me = null;
    this.listeners = new Set();
  }
  now() { return new Date(); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }
  gameList() { return [...this.games.values()]; }
  pickFor(gameId, player) { return (this.picks.get(gameId) || {})[player] || null; }
  picksFor(gameId) { return this.picks.get(gameId) || {}; }
  canEdit(game) { return !!this.me && game.status !== 'postponed' && isPickable(game, this.rules, this.now()); }
  /** The responder has answered: the line is frozen. */
  lineFrozen(game) { return this.pickFor(game.id, otherPlayer(game.selector))?.ou != null; }
  oppHasWinner(gameId, player) { return !!this.pickFor(gameId, player)?.winner || !!this.pickFor(gameId, player)?.hasWinner; }
  /** A player's bracket picks ({} when none, or when the other player's are still hidden). */
  cupPicksFor(player) { return this.cupPicks.get(player)?.picks || {}; }
  cupPickInfo(player) { return this.cupPicks.get(player) || { picks: {}, count: 0, hidden: false }; }
  bracket() { return buildBracket(this.gameList()); }
  async setBracketPicks(picks) {
    const bracket = this.bracket();
    if (!this.me) throw new Error('Sign in first.');
    if (!bracket.ready) throw new Error('The bracket opens once the quarterfinal matchups are set.');
    if (!bracketOpen(bracket, this.now())) throw new Error('The bracket locked at the first quarterfinal tip-off.');
    await this.persistCupPicks(cleanBracketPicks(picks, bracket));
  }

  // ---- mutations (validated here for instant feedback; the API validates again) ----
  async setWinner(gameId, team) {
    const g = this.games.get(gameId);
    if (!g || !this.canEdit(g)) throw new Error('This game is locked.');
    if (team != null && team !== g.home && team !== g.away) throw new Error('Not a team in this game.');
    await this.persistPick(gameId, { winner: team });
  }
  async setLine(gameId, line) {
    const g = this.games.get(gameId);
    if (!g || !this.canEdit(g)) throw new Error('This game is locked.');
    if (g.selector !== this.me) throw new Error(`${this.players[g.selector].name} sets the line for this game.`);
    if (this.lineFrozen(g)) throw new Error('The line is frozen once the other player has answered it.');
    if (line != null && !isValidLine(line, this.rules)) throw new Error('Line must be a whole number' + (this.rules.halfPointLines ? ' or half point' : '') + ` between ${this.rules.lineMin} and ${this.rules.lineMax}.`);
    await this.persistPick(gameId, { line });
  }
  async setCall(gameId, ou) {
    const g = this.games.get(gameId);
    if (!g || !this.canEdit(g)) throw new Error('This game is locked.');
    if (g.selector === this.me) throw new Error('You set the line; your brother makes the call.');
    if (this.pickFor(gameId, g.selector)?.line == null) throw new Error('No line posted yet.');
    if (ou != null && ou !== 'O' && ou !== 'U') throw new Error('Call must be Over or Under.');
    await this.persistPick(gameId, { ou });
  }
  applyPick(gameId, player, patch) {
    const all = this.picks.get(gameId) || {};
    const cur = { ...(all[player] || {}), ...patch };
    for (const k of Object.keys(cur)) if (cur[k] == null || cur[k] === false) delete cur[k];
    if (Object.keys(cur).length) all[player] = cur; else delete all[player];
    if (Object.keys(all).length) this.picks.set(gameId, all); else this.picks.delete(gameId);
  }
}

/* ============================ DEMO ============================ */
export class DemoStore extends BaseStore {
  constructor(config, reason = '') {
    super(config);
    this.mode = 'demo';
    this.reason = reason;
    this.state = { picks: {}, results: {}, me: 'UP', clockOffsetMs: null, rules: {}, players: {}, cupPicks: {}, extraGames: [] };
  }
  async init() {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) this.state = { ...this.state, ...JSON.parse(raw) }; } catch {}
    // Prefer the real schedule if it has been imported (tools/import_schedule.mjs), else the sample slate.
    let data = null;
    try { const r = await fetch('data/schedule-2026-27.json'); if (r.ok) data = await r.json(); } catch {}
    if (!data) data = await (await fetch('data/sample-schedule.json')).json();
    this.scheduleNote = data.note || '';
    const seasonStart = data.games[0].date;
    for (const [, dayGames] of groupByDate([...data.games, ...(this.state.extraGames || [])])) {
      for (const g of dayGames) this.games.set(g.id, { ...g, selector: assignSelector(g, dayGames, seasonStart), status: 'scheduled', homeScore: null, awayScore: null });
    }
    this.seasonStart = seasonStart;
    if (this.state.clockOffsetMs == null) {
      // First visit: pretend it is a busy mid-season day with a month of history behind us.
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
    this.loadCupPicks();
  }
  loadCupPicks() {
    this.cupPicks.clear();
    for (const p of PLAYER_CODES) { const picks = this.state.cupPicks?.[p] || {}; this.cupPicks.set(p, { picks, count: Object.keys(picks).length, hidden: false }); }
  }
  now() { return new Date(Date.now() + (this.state.clockOffsetMs || 0)); }
  save() { try { localStorage.setItem(LS_KEY, JSON.stringify(this.state)); } catch {} }
  async persistPick(gameId, patch) {
    this.applyPick(gameId, this.me, patch);
    const all = this.picks.get(gameId);
    if (all) this.state.picks[gameId] = all; else delete this.state.picks[gameId];
    this.save(); this.emit();
  }
  async persistCupPicks(picks) {
    this.state.cupPicks = { ...(this.state.cupPicks || {}), [this.me]: picks };
    this.loadCupPicks(); this.save(); this.emit();
  }
  /** Same rule as the API: the other player's bracket stays hidden until it locks. */
  cupPickInfo(player) {
    const base = super.cupPickInfo(player);
    if (player !== this.me && base.count && !bracketLocked(this.bracket(), this.now())) return { picks: {}, count: base.count, hidden: true };
    return base;
  }
  cupPicksFor(player) { return this.cupPickInfo(player).picks; }
  switchPlayer(code) { this.me = code; this.state.me = code; this.save(); this.emit(); }
  async setRules(patch) { this.rules = { ...this.rules, ...patch }; this.state.rules = { ...(this.state.rules || {}), ...patch }; this.save(); this.emit(); }
  async setPlayerNames(names) { for (const p of PLAYER_CODES) if (names[p]) { this.players[p].name = names[p]; this.state.players = { ...(this.state.players || {}), [p]: { name: names[p] } }; } this.save(); this.emit(); }
  myPrefs() { return {}; }
  advanceDay() { this.state.clockOffsetMs += 24 * 3600 * 1000; this.save(); this.simulatePast(); }
  resetDemo() { try { localStorage.removeItem(LS_KEY); } catch {} location.reload(); }
  /** Give both players plausible picks on games that have tipped, then random finals. Deterministic per game id.
   *  Once the Cup groups are decided the knockout games are invented too (the sample schedule has none). */
  simulatePast() {
    for (let pass = 0; pass < 4; pass++) { this.simulateGames(); if (!this.ensureDemoKnockout()) break; }
    this.simulateBrackets();
    this.save(); this.emit();
  }
  simulateGames() {
    const now = this.now();
    const rnd = seeded;
    for (const [date, dayGames] of groupByDate(this.gameList())) {
      const started = dayGames.filter(g => new Date(g.tipoff) <= now);
      if (!started.length) continue;
      const skip = rnd(date + 'skip') < 0.18 ? (rnd(date + 'who') < 0.5 ? 'UP' : 'KP') : null;   // someone forgets now and then
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
        const resp = otherPlayer(g.selector);
        if (picks[resp]?.ou && picks[g.selector]?.line == null) delete picks[resp].ou;
        if (Object.keys(picks).length) { this.picks.set(g.id, picks); this.state.picks[g.id] = picks; }
        this.finishGame(g, rnd);
      }
    }
  }
  /** Quarterfinals once group play is done, semifinals once the quarterfinals are final, then the final. */
  ensureDemoKnockout() {
    const games = this.gameList();
    const groups = cupGroups(games);
    if (groups.length !== 6) return false;
    const field = cupField(groups);
    if (!field.complete) return false;
    const bracket = buildBracket(games);
    const lastGroupDate = groups.flatMap(gr => gr.games.map(g => g.date)).sort().pop();
    const shift = (n) => { const d = new Date(lastGroupDate + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const add = (date, timeET, away, home, cupStage, arena) => {
      const g = { id: `demo:${date.replace(/-/g, '')}-${away}-${home}`, date, tipoff: `${date}T${timeET}:00-05:00`, away, home, arena, cup: true, cupStage };
      this.state.extraGames.push(g);
      const dayGames = [...(groupByDate(this.gameList()).get(date) || []), g];
      this.games.set(g.id, { ...g, selector: assignSelector(g, dayGames, this.seasonStart), status: 'scheduled', homeScore: null, awayScore: null });
    };
    if (!bracket.qf.length) {
      for (const conf of CONFERENCES) { const s = field[conf].seeds; if (s.length < 4) return false; const date = shift(conf === 'West' ? 8 : 9); const arena = `${s[0]} home court`;
        add(date, '19:30', s[3], s[0], 'QF', arena); add(date, '22:00', s[2], s[1], 'QF', `${s[1]} home court`); }
      return true;
    }
    if (bracket.ready && bracket.qf.every(q => q.winner) && !bracket.sf.some(s => s.game)) {
      const date = shift(12);
      for (const conf of CONFERENCES) { const w = bracket.qf.filter(q => q.conf === conf).map(q => q.winner); add(date, conf === 'East' ? '16:30' : '21:00', w[1], w[0], 'SF', 'T-Mobile Arena, Las Vegas'); }
      return true;
    }
    if (bracket.sf.every(s => s.winner) && !bracket.f.game) { add(shift(15), '20:30', bracket.sf[1].winner, bracket.sf[0].winner, 'F', 'T-Mobile Arena, Las Vegas'); return true; }
    return false;
  }
  /** A player who never filled in the bracket gets a random one once it locks (like the random game picks). */
  simulateBrackets() {
    const bracket = buildBracket(this.gameList());
    if (!bracket.ready || !bracketLocked(bracket, this.now())) return;
    for (const p of PLAYER_CODES) {
      if (Object.keys(this.state.cupPicks?.[p] || {}).length) continue;
      const raw = {};
      for (const q of bracket.qf) raw[q.key] = q.teams[seeded(p + q.key) < 0.5 ? 0 : 1];
      for (const s of bracket.sf) { const o = s.feeders.map(k => raw[k]); raw[s.key] = o[seeded(p + s.key) < 0.5 ? 0 : 1]; }
      raw.F = seeded(p + 'F') < 0.5 ? raw['SF-East'] : raw['SF-West'];
      this.state.cupPicks = { ...(this.state.cupPicks || {}), [p]: cleanBracketPicks(raw, bracket) };
    }
    this.loadCupPicks();
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

/* ============================ LIVE (Vercel API + Neon) ============================ */
export class LiveStore extends BaseStore {
  constructor(config) {
    super(config);
    this.mode = 'live';
    this.api = config.API || '/api';
    this.prefs = {};
    this.lastSync = null;
    this.vapidPublicKey = '';
  }
  async call(path, opts = {}) {
    const r = await fetch(this.api + path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data = null; try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error(data?.error || `${r.status} ${r.statusText}`);
    return data;
  }
  async init() {
    const a = await this.call('/auth');
    for (const p of a.players || []) this.players[p.code] = { ...this.players[p.code], name: p.name, color: p.color || this.players[p.code].color };
    this.me = a.me;
    this.needsPin = new Set(a.needsPin || []);
    if (this.me) await this.loadAll();
    this.startPolling();
  }
  async signIn(player, pin) { const r = await this.call('/auth', { method: 'POST', body: { action: 'login', player, pin } }); this.me = r.me; await this.loadAll(); this.emit(); }
  async setupPin(player, pin) { const r = await this.call('/auth', { method: 'POST', body: { action: 'setupPin', player, pin } }); this.needsPin.delete(player); this.me = r.me; await this.loadAll(); this.emit(); }
  async signOut() { await this.call('/auth', { method: 'POST', body: { action: 'logout' } }); this.me = null; this.games.clear(); this.picks.clear(); this.emit(); }
  async changePin(currentPin, newPin) { await this.call('/auth', { method: 'POST', body: { action: 'changePin', currentPin, newPin } }); }
  async loadAll() {
    const s = await this.call('/state');
    this.games.clear(); this.picks.clear();
    this.ingest(s);
    for (const p of s.players || []) { this.players[p.code] = { ...this.players[p.code], name: p.name, color: p.color || this.players[p.code].color }; if (p.code === this.me) this.prefs = p; }
    if (s.rules) this.rules = { ...DEFAULT_RULES, ...s.rules };
    this.vapidPublicKey = s.vapidPublicKey || '';
    this.season = s.season; this.lastScheduleSync = s.lastScheduleSync; this.lastScoresSync = s.lastScoresSync; this.lastSyncError = s.lastSyncError; this.lastSyncErrorAt = s.lastSyncErrorAt;
  }
  ingest(s) {
    for (const g of s.games || []) this.games.set(g.id, g);
    for (const p of s.picks || []) this.applyPick(p.game_id, p.player_code, { winner: p.winner, line: p.line, ou: p.ou, hasWinner: p.has_winner });
    if (s.cupPicks) { this.cupPicks.clear(); for (const r of s.cupPicks) this.cupPicks.set(r.player_code, { picks: r.picks || {}, count: r.count || 0, hidden: !!r.hidden }); this.cupPicksKey = JSON.stringify(s.cupPicks); }
    this.lastSync = s.now;
  }
  async poll() {
    if (!this.me || !this.lastSync || document.hidden) return;
    try {
      const s = await this.call('/state?since=' + encodeURIComponent(this.lastSync));
      const cupChanged = s.cupPicks && JSON.stringify(s.cupPicks) !== this.cupPicksKey;
      if (s.games.length || s.picks.length || cupChanged) { this.ingest(s); this.emit(); } else this.lastSync = s.now;
    } catch (e) { console.warn('poll failed', e.message); }
  }
  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), 45000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.poll(); });
    window.addEventListener('focus', () => this.poll());
  }
  async persistPick(gameId, patch) {
    const r = await this.call('/pick', { method: 'POST', body: { gameId, ...patch } });
    this.applyPick(gameId, this.me, { winner: r.pick.winner, line: r.pick.line, ou: r.pick.ou });
    this.emit();
  }
  async persistCupPicks(picks) {
    const r = await this.call('/cup', { method: 'POST', body: { picks } });
    this.cupPicks.set(this.me, { picks: r.picks || {}, count: Object.keys(r.picks || {}).length, hidden: false });
    this.emit();
  }
  async setRules(patch) { const r = await this.call('/settings', { method: 'POST', body: { rules: patch } }); this.rules = { ...DEFAULT_RULES, ...r.rules }; this.emit(); }
  /** Fetch the season schedule from ESPN in this browser and hand it to the server. */
  async loadScheduleFromBrowser(onProgress = () => {}) {
    const { fetchEspnTeamSchedules } = await import('../lib/feeds.js');
    const endYear = Number((this.season || this.config.SEASON).slice(0, 4)) + 1;
    onProgress('Fetching 30 team schedules from ESPN…');
    const games = await fetchEspnTeamSchedules(endYear);
    if (games.length < 100) throw new Error(`ESPN returned only ${games.length} regular-season games.`);
    onProgress(`Sending ${games.length} games to the server…`);
    const r = await this.call('/schedule', { method: 'POST', body: { games } });
    await this.loadAll(); this.emit();
    return r;
  }
  async setPlayerNames(names) { await this.call('/settings', { method: 'POST', body: { names } }); for (const p of PLAYER_CODES) if (names[p]) this.players[p].name = names[p]; this.emit(); }
  async savePrefs(prefs) { await this.call('/settings', { method: 'POST', body: { prefs } }); Object.assign(this.prefs, prefs); this.emit(); }
  myPrefs() { return this.prefs || {}; }
  async enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser cannot receive push notifications. On iPhone, add the app to your Home Screen and open it from there.');
    if (!this.vapidPublicKey) throw new Error('Push is not configured on the server yet (VAPID_PUBLIC_KEY).');
    const reg = await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed.');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(this.vapidPublicKey) });
    await this.call('/push', { method: 'POST', body: { action: 'subscribe', subscription: sub.toJSON() } });
  }
  async disablePush() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await this.call('/push', { method: 'POST', body: { action: 'unsubscribe', endpoint: sub.endpoint } }); await sub.unsubscribe(); }
  }
  async pushEnabled() {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(reg && await reg.pushManager.getSubscription());
  }
  async sendTestPush() { const r = await this.call('/push', { method: 'POST', body: { action: 'test' } }); if (!r.sent) throw new Error('No device is subscribed yet. Turn notifications on first.'); }
}

function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

export function createStore(config) {
  const forceDemo = /[?&]demo=1/.test(location.search) || !config.API;
  return forceDemo ? new DemoStore(config) : new LiveStore(config);
}
export { isLocked, isPickable, gameWinner };
