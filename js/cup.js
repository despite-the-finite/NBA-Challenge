// NBA Cup: groups, group standings, the knockout bracket and bracket scoring. Pure functions, no DOM,
// shared by the web app and the API (like scoring.js).
//
// The Cup side game: once the quarterfinal matchups are on the schedule, each player fills in the whole
// bracket (four quarterfinals, two conference semifinals, the final). The bracket locks at the first
// quarterfinal tip-off. Points per correct pick: CUP_RULES. It is a separate tally from the season score.
//
// Groups are not configured anywhere: every team plays its four group games against the four other teams
// in its group, so the groups fall out of the schedule. Feeds may label games ("West Group A",
// "Quarterfinal", "Championship"); when they don't, a team's first four Cup games are its group games
// and the knockout rounds are told apart by date order.
import { TEAMS } from './teams.js';
import { compareGames, gameWinner } from './scoring.js';

export const CUP_RULES = { qf: 1, sf: 2, f: 3 };
export const CONFERENCES = ['East', 'West'];
const KNOCKOUT = ['QF', 'SF', 'F'];

export const isKnockoutStage = (stage) => KNOCKOUT.includes(stage);
export const confOf = (team) => TEAMS[team]?.conf || null;

/** Stage from a feed label: 'East A' | 'West C' | 'QF' | 'SF' | 'F' | null. */
export function parseCupStage(label) {
  if (!label) return null;
  if (isKnockoutStage(label)) return label;
  const g = /(East|West)(?:ern)?\s*(?:Conference)?\s*(?:Group)?\s*([A-C])\b/i.exec(label);
  if (g) return `${g[1][0].toUpperCase()}${g[1].slice(1).toLowerCase()} ${g[2].toUpperCase()}`;
  if (/quarter/i.test(label)) return 'QF';
  if (/semi/i.test(label)) return 'SF';
  if (/(final|championship)/i.test(label)) return 'F';
  return null;
}

/** Cup games split into group play and knockout rounds (postponed games excluded). */
export function splitCup(games) {
  const cup = games.filter(g => g.cup && g.status !== 'postponed').sort(compareGames);
  const seen = {};
  const group = [], knockout = [];
  for (const g of cup) {
    let ko;
    if (isKnockoutStage(g.cupStage)) ko = true;
    else if (g.cupStage) ko = false;
    else ko = (seen[g.home] || 0) >= 4 || (seen[g.away] || 0) >= 4;
    seen[g.home] = (seen[g.home] || 0) + 1; seen[g.away] = (seen[g.away] || 0) + 1;
    (ko ? knockout : group).push(g);
  }
  return { group, knockout };
}

/** The six groups: [{ key, conf, label, teams, games }], East first. */
export function cupGroups(games) {
  const { group } = splitCup(games);
  const parent = new Map();
  const find = t => { if (!parent.has(t)) parent.set(t, t); let r = t; while (parent.get(r) !== r) r = parent.get(r); return r; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const g of group) union(g.home, g.away);
  const labels = new Map(), members = new Map();
  for (const g of group) if (g.cupStage && !isKnockoutStage(g.cupStage)) labels.set(find(g.home), g.cupStage);
  for (const t of parent.keys()) { const r = find(t); if (!members.has(r)) members.set(r, []); members.get(r).push(t); }
  const groups = [];
  for (const [r, teams] of members) {
    teams.sort();
    groups.push({ key: r, conf: confOf(teams[0]) || 'East', label: labels.get(r) || null, teams, games: group.filter(g => find(g.home) === r) });
  }
  groups.sort((a, b) => a.conf.localeCompare(b.conf) || (a.label || '~').localeCompare(b.label || '~') || a.teams[0].localeCompare(b.teams[0]));
  const n = { East: 0, West: 0 };
  for (const g of groups) {
    n[g.conf]++;
    g.label = g.label ? g.label.replace(/^(East|West) ([A-C])$/, '$1 Group $2') : `${g.conf} Group ${n[g.conf]}`;
  }
  return groups;
}

const cmpRow = (a, b) => b.w - a.w || a.l - b.l || b.diff - a.diff || b.pf - a.pf || a.team.localeCompare(b.team);

/** Standings inside one group: [{ team, w, l, diff, pf, played, left }], best first.
 *  Sorted by record, then point differential, then points scored (the NBA's own tiebreaks start with head-to-head). */
export function groupStandings(group) {
  const rows = Object.fromEntries(group.teams.map(t => [t, { team: t, w: 0, l: 0, diff: 0, pf: 0, played: 0, left: 0 }]));
  for (const g of group.games) {
    const w = gameWinner(g);
    if (!w) { if (g.status !== 'final') { rows[g.home].left++; rows[g.away].left++; } continue; }
    const l = w === g.home ? g.away : g.home;
    rows[w].w++; rows[l].l++; rows[w].played++; rows[l].played++;
    const m = Math.abs(g.homeScore - g.awayScore);
    rows[w].diff += m; rows[l].diff -= m; rows[g.home].pf += g.homeScore; rows[g.away].pf += g.awayScore;
  }
  return Object.values(rows).sort(cmpRow);
}

/** Who is (currently) through: per conference the three group leaders and the best runner-up (wildcard),
 *  seeded 1-4. `complete` once every group game is final. */
export function cupField(groups) {
  const out = { complete: groups.length === 6 && groups.every(g => g.games.length >= 10 && g.games.every(x => x.status === 'final')) };
  for (const conf of CONFERENCES) {
    const tables = groups.filter(g => g.conf === conf).map(groupStandings);
    const winners = tables.map(t => t[0]).filter(Boolean).sort(cmpRow);
    const runners = tables.map(t => t[1]).filter(Boolean).sort(cmpRow);
    const wildcard = runners[0] || null;
    out[conf] = { winners: winners.map(r => r.team), wildcard: wildcard?.team || null, seeds: [...winners.map(r => r.team), ...(wildcard ? [wildcard.team] : [])] };
  }
  return out;
}

/**
 * The knockout bracket from the knockout games on the schedule.
 * Slots: one per quarterfinal (key = game id), 'SF-East', 'SF-West', 'F'.
 * Each slot: { key, stage, conf, game, teams, winner, feeders }. `ready` once all four quarterfinals are
 * scheduled; `lockAt` is the first quarterfinal tip-off.
 */
export function buildBracket(games) {
  const { knockout } = splitCup(games);
  let qfN = 0, sfN = 0;
  const staged = [...knockout].sort(compareGames).map(g => {
    let s = isKnockoutStage(g.cupStage) ? g.cupStage : (qfN < 4 ? 'QF' : sfN < 2 ? 'SF' : 'F');
    if (s === 'QF') qfN++; else if (s === 'SF') sfN++;
    return { ...g, cupStage: s };
  });
  const qf = staged.filter(g => g.cupStage === 'QF').map(g => ({ key: g.id, stage: 'QF', conf: confOf(g.home), game: g, teams: [g.away, g.home], winner: gameWinner(g), feeders: [] }));
  const sfGames = staged.filter(g => g.cupStage === 'SF');
  const fGame = staged.find(g => g.cupStage === 'F') || null;
  const sf = CONFERENCES.map(conf => {
    const game = sfGames.find(g => confOf(g.home) === conf) || null;
    return { key: `SF-${conf}`, stage: 'SF', conf, game, teams: game ? [game.away, game.home] : null, winner: game ? gameWinner(game) : null, feeders: qf.filter(q => q.conf === conf).map(q => q.key) };
  });
  const f = { key: 'F', stage: 'F', conf: null, game: fGame, teams: fGame ? [fGame.away, fGame.home] : null, winner: fGame ? gameWinner(fGame) : null, feeders: sf.map(s => s.key) };
  const lockAt = qf.length ? qf.map(q => q.game.tipoff).sort()[0] : null;
  return { qf, sf, f, slots: [...qf, ...sf, f], lockAt, ready: qf.length === 4, champion: f.winner, knockout: staged };
}

export function bracketLocked(bracket, now = new Date()) {
  if (!bracket.lockAt) return false;
  return new Date(bracket.lockAt).getTime() <= now.getTime() || bracket.qf.some(q => q.game.status === 'live' || q.game.status === 'final');
}
export function bracketOpen(bracket, now = new Date()) { return bracket.ready && !bracketLocked(bracket, now); }

/** Keep only consistent picks: a quarterfinal pick is one of its two teams, a semifinal pick is one of the
 *  player's own quarterfinal picks in that conference, the final pick one of their semifinal picks. */
export function cleanBracketPicks(raw, bracket) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const q of bracket.qf) { const t = raw[q.key]; if (typeof t === 'string' && q.teams.includes(t)) out[q.key] = t; }
  for (const s of bracket.sf) { const t = raw[s.key]; const opts = s.feeders.map(k => out[k]).filter(Boolean); if (typeof t === 'string' && opts.includes(t)) out[s.key] = t; }
  const fo = bracket.sf.map(s => out[s.key]).filter(Boolean);
  if (typeof raw.F === 'string' && fo.includes(raw.F)) out.F = raw.F;
  return out;
}

/** What a player can choose from in a slot: the real teams for a quarterfinal, else their picks from the feeding slots. */
export function slotOptions(slot, picks = {}) {
  if (slot.stage === 'QF') return slot.teams;
  return slot.feeders.map(k => picks[k] || null);
}

export function bracketMissing(picks, bracket) { return bracket.slots.filter(s => !picks?.[s.key]).length; }

/** Bracket points for one player: { total, max, hits: { slotKey: true|false } } (only decided slots appear in hits). */
export function scoreBracket(picks, bracket, rules = CUP_RULES) {
  let total = 0; const hits = {};
  for (const s of bracket.slots) {
    if (!s.winner) continue;
    const hit = picks?.[s.key] === s.winner; hits[s.key] = hit;
    if (hit) total += rules[s.stage.toLowerCase()];
  }
  return { total, hits, max: bracket.qf.length * rules.qf + bracket.sf.length * rules.sf + rules.f };
}

/** A game that is in the Cup bracket but not in the Challenge (the final is not a regular-season game). */
export function bracketOnly(game) { return !!game.cup && game.cupStage === 'F'; }
