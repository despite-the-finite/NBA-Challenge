// Shared scoring engine. Pure functions, no DOM. Imported by the web app and by
// the Supabase edge function (supabase/functions/_shared/scoring.js is a copy;
// run tools/check-shared.sh to confirm they match).
//
// The game (from the 2024-25 spreadsheet):
//   * Every game has a "selector" who sets the LINE: the margin of victory.
//   * The other player (the "responder") calls OVER or UNDER that margin.
//   * Both players pick a WINNER.
//   * +1 for the correct winner. +1 for winning the margin duel: the responder
//     wins it when the call is right, the selector wins it when the call is wrong,
//     and an exact push gives nobody the point (configurable, see DEFAULT_RULES.push).

export const DEFAULT_RULES = {
  winnerPoint: 1,
  spreadPoint: 1,
  // Responder never answered a posted line: the selector did their job, so they take the point.
  unansweredLine: 'selector',   // 'selector' | 'nobody'
  // Selector never posted a line: the responder takes the point (if they showed up for the game).
  noLine: 'responder',          // 'responder' | 'nobody'
  // Margin lands exactly on the line. The 24-25 sheet gave nobody the point (11 of 13 pushes;
  // 2 were hand-scored for the selector). 'selector' treats a push as a missed call.
  push: 'nobody',               // 'nobody' | 'selector'
  // Bonus for the player who made picks on a day the other player made none.
  showUpBonus: 2,
  // How far ahead picks open.
  pickWindowDays: 14,
  // Allow half-point lines (no pushes) in addition to whole numbers.
  halfPointLines: false,
  lineMin: 1,
  lineMax: 30,
};

export const PLAYER_CODES = ['UP', 'KP'];

export function otherPlayer(code) {
  return code === 'UP' ? 'KP' : 'UP';
}

/** NBA Cup games are shown on the slate but sit outside the Challenge: no picks, no points, no selector turn. */
export function countsForChallenge(game) {
  return !game.cup && game.status !== 'postponed';
}

export function isLocked(game, now = new Date()) {
  return new Date(game.tipoff).getTime() <= now.getTime() || game.status === 'final' || game.status === 'live';
}

export function isPickable(game, rules = DEFAULT_RULES, now = new Date()) {
  if (!countsForChallenge(game)) return false;
  if (isLocked(game, now)) return false;
  const windowMs = rules.pickWindowDays * 24 * 3600 * 1000;
  return new Date(game.tipoff).getTime() - now.getTime() <= windowMs;
}

/** Deterministic selector for a game: alternate within the day, and alternate the
 *  day's starting player by the day's parity, so both players select ~equally. */
export function assignSelector(game, dayGames, seasonStartDate) {
  const sorted = [...dayGames].filter(g => !g.cup || g.id === game.id).sort(compareGames);
  const idx = Math.max(0, sorted.findIndex(g => g.id === game.id));
  const dayIndex = daysBetween(seasonStartDate, game.date);
  return (idx + dayIndex) % 2 === 0 ? 'UP' : 'KP';
}

export function compareGames(a, b) {
  const t = new Date(a.tipoff) - new Date(b.tipoff);
  if (t !== 0) return t;
  return (a.home + a.away).localeCompare(b.home + b.away);
}

export function daysBetween(a, b) {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 86400000);
}

export function gameWinner(game) {
  if (game.status !== 'final' || game.homeScore == null || game.awayScore == null) return null;
  if (game.homeScore === game.awayScore) return null;
  return game.homeScore > game.awayScore ? game.home : game.away;
}

export function gameMargin(game) {
  if (game.status !== 'final') return null;
  return Math.abs(game.homeScore - game.awayScore);
}

export function hasAnyPick(pick) {
  return !!pick && (pick.winner != null || pick.line != null || pick.ou != null);
}

/**
 * Score one final game.
 * picks: { UP: {winner, line, ou}, KP: {...} } (either may be missing)
 * Returns { UP: {winner, spread, total}, KP: {...}, duel: {...} }
 */
export function scoreGame(game, picks = {}, rules = DEFAULT_RULES) {
  const empty = { winner: 0, spread: 0, total: 0 };
  const result = { UP: { ...empty }, KP: { ...empty }, duel: null };
  if (game.status !== 'final') return result;

  const actual = gameWinner(game);
  const margin = gameMargin(game);
  const sel = game.selector;
  const resp = otherPlayer(sel);
  const selPick = picks[sel] || {};
  const respPick = picks[resp] || {};

  for (const p of PLAYER_CODES) {
    if (picks[p] && picks[p].winner && picks[p].winner === actual) result[p].winner = rules.winnerPoint;
  }

  const line = selPick.line;
  const call = respPick.ou;
  let duel = { line, call, margin, winner: null, reason: '' };
  if (line == null) {
    if (rules.noLine === 'responder' && hasAnyPick(respPick)) {
      duel.winner = resp; duel.reason = 'no line posted';
    } else duel.reason = 'no line posted';
  } else if (call == null) {
    if (rules.unansweredLine === 'selector') { duel.winner = sel; duel.reason = 'line not answered'; }
    else duel.reason = 'line not answered';
  } else if (margin === line) {
    duel.reason = 'push';
    if (rules.push === 'selector') duel.winner = sel;
  } else {
    const respRight = (call === 'O' && margin > line) || (call === 'U' && margin < line);
    duel.winner = respRight ? resp : sel;
    duel.reason = respRight ? `${call === 'O' ? 'over' : 'under'} hit` : `${call === 'O' ? 'over' : 'under'} missed`;
  }
  if (duel.winner) result[duel.winner].spread = rules.spreadPoint;
  result.duel = duel;
  for (const p of PLAYER_CODES) result[p].total = result[p].winner + result[p].spread;
  return result;
}

/** Group games by their ET date. */
export function groupByDate(games) {
  const map = new Map();
  for (const g of [...games].sort(compareGames)) {
    if (!map.has(g.date)) map.set(g.date, []);
    map.get(g.date).push(g);
  }
  return map;
}

/** A day is settled when every game that day is final (or there are no games). */
export function dayIsSettled(dayGames) {
  return dayGames.length > 0 && dayGames.every(g => g.status === 'final');
}

/**
 * Score a whole day. picksByGame: Map/obj gameId -> {UP:{...},KP:{...}}
 * Returns { date, UP:{winner,spread,bonus,total,picked}, KP:{...}, games:[{game, score}], settled, dayWinner }
 */
export function scoreDay(date, allDayGames, picksByGame, rules = DEFAULT_RULES) {
  const tally = { UP: { winner: 0, spread: 0, bonus: 0, total: 0, picked: 0 }, KP: { winner: 0, spread: 0, bonus: 0, total: 0, picked: 0 } };
  const games = [];
  const dayGames = allDayGames.filter(countsForChallenge);
  const cupGames = allDayGames.filter(g => g.cup).length;
  for (const g of dayGames) {
    const picks = (picksByGame instanceof Map ? picksByGame.get(g.id) : picksByGame[g.id]) || {};
    for (const p of PLAYER_CODES) if (hasAnyPick(picks[p])) tally[p].picked++;
    const score = scoreGame(g, picks, rules);
    for (const p of PLAYER_CODES) { tally[p].winner += score[p].winner; tally[p].spread += score[p].spread; }
    games.push({ game: g, picks, score });
  }
  const settled = dayIsSettled(dayGames);
  // Show-up bonus: once the day is over, the player who picked gets a bonus if the other picked nothing.
  const dayOver = dayGames.length > 0 && (settled || dayGames.every(g => isLocked(g)));
  if (dayOver && rules.showUpBonus > 0) {
    if (tally.UP.picked > 0 && tally.KP.picked === 0) tally.UP.bonus = rules.showUpBonus;
    if (tally.KP.picked > 0 && tally.UP.picked === 0) tally.KP.bonus = rules.showUpBonus;
  }
  for (const p of PLAYER_CODES) tally[p].total = tally[p].winner + tally[p].spread + tally[p].bonus;
  let dayWinner = null;
  if (settled) dayWinner = tally.UP.total > tally.KP.total ? 'UP' : tally.KP.total > tally.UP.total ? 'KP' : 'tie';
  return { date, ...tally, games, settled, dayWinner, cupGames };
}

/** Season standings and fun stats from all games + picks. */
export function computeStandings(games, picksByGame, rules = DEFAULT_RULES) {
  const days = [];
  for (const [date, dayGames] of groupByDate(games)) { const d = scoreDay(date, dayGames, picksByGame, rules); if (d.games.length) days.push(d); }
  const s = {
    UP: blankStats(), KP: blankStats(), days, race: [],
    gamesFinal: games.filter(g => g.status === 'final' && countsForChallenge(g)).length,
  };
  let cum = { UP: 0, KP: 0 };
  for (const d of days) {
    for (const p of PLAYER_CODES) {
      const t = s[p];
      t.total += d[p].total; t.winnerPts += d[p].winner; t.spreadPts += d[p].spread; t.bonusPts += d[p].bonus;
    }
    if (d.settled) {
      cum.UP += d.UP.total; cum.KP += d.KP.total;
      s.race.push({ date: d.date, UP: cum.UP, KP: cum.KP });
      if (d.dayWinner === 'UP') { s.UP.daysWon++; s.KP.daysLost++; }
      else if (d.dayWinner === 'KP') { s.KP.daysWon++; s.UP.daysLost++; }
      else { s.UP.daysTied++; s.KP.daysTied++; }
      for (const p of PLAYER_CODES) {
        if (d[p].total > s[p].bestDay.points) s[p].bestDay = { points: d[p].total, date: d.date };
        if (d[p].picked > 0) { s[p].daysPicked++; } else { s[p].daysSkipped++; }
      }
      // perfect day: every game final and picked, and max points on each
      for (const p of PLAYER_CODES) {
        const maxPts = d.games.length * (rules.winnerPoint + rules.spreadPoint);
        if (d.games.length >= 3 && d[p].winner + d[p].spread === maxPts) s[p].perfectDays++;
      }
    }
    for (const { game, picks, score } of d.games) {
      if (game.status !== 'final') continue;
      const actual = gameWinner(game);
      for (const p of PLAYER_CODES) {
        const pk = picks[p];
        if (pk && pk.winner) { s[p].winnerPicks++; if (pk.winner === actual) s[p].winnerHits++; }
      }
      const sel = game.selector, resp = otherPlayer(sel);
      if (score.duel && score.duel.line != null && score.duel.call != null) {
        s[sel].linesDefended += score.duel.winner === sel ? 1 : 0;
        s[sel].linesSet++;
        s[resp].callsMade++;
        s[resp].callsHit += score.duel.winner === resp ? 1 : 0;
        if (score.duel.winner === null) { s.UP.pushes++; s.KP.pushes++; }
      }
    }
  }
  // Current day-win streak (settled days only, ties break the streak)
  const settled = days.filter(d => d.settled);
  for (const p of PLAYER_CODES) {
    let streak = 0;
    for (let i = settled.length - 1; i >= 0; i--) { if (settled[i].dayWinner === p) streak++; else break; }
    s[p].streak = streak;
    s[p].winnerPct = s[p].winnerPicks ? s[p].winnerHits / s[p].winnerPicks : 0;
    s[p].callPct = s[p].callsMade ? s[p].callsHit / s[p].callsMade : 0;
    s[p].defendPct = s[p].linesSet ? s[p].linesDefended / s[p].linesSet : 0;
  }
  s.leader = s.UP.total > s.KP.total ? 'UP' : s.KP.total > s.UP.total ? 'KP' : null;
  s.margin = Math.abs(s.UP.total - s.KP.total);
  return s;
}

function blankStats() {
  return {
    total: 0, winnerPts: 0, spreadPts: 0, bonusPts: 0,
    daysWon: 0, daysLost: 0, daysTied: 0, daysPicked: 0, daysSkipped: 0, perfectDays: 0,
    winnerPicks: 0, winnerHits: 0, winnerPct: 0,
    linesSet: 0, linesDefended: 0, defendPct: 0,
    callsMade: 0, callsHit: 0, callPct: 0,
    pushes: 0, streak: 0, bestDay: { points: 0, date: null },
  };
}

/** Lines may be whole numbers (or halves when enabled) within range. */
export function isValidLine(line, rules = DEFAULT_RULES) {
  if (typeof line !== 'number' || !isFinite(line)) return false;
  if (line < rules.lineMin || line > rules.lineMax) return false;
  const step = rules.halfPointLines ? 0.5 : 1;
  return Math.abs(line / step - Math.round(line / step)) < 1e-9;
}

/** What is still missing from a player's picks for a set of (unlocked) games. */
export function missingPicks(player, games, picksByGame) {
  const todo = [];
  for (const g of games) {
    if (!countsForChallenge(g)) continue;
    const picks = (picksByGame instanceof Map ? picksByGame.get(g.id) : picksByGame[g.id]) || {};
    const mine = picks[player] || {};
    const opp = picks[otherPlayer(player)] || {};
    const items = [];
    if (!mine.winner) items.push('winner');
    if (g.selector === player) { if (mine.line == null) items.push('line'); }
    else if (opp.line != null && !mine.ou) items.push('call');
    if (items.length) todo.push({ game: g, items });
  }
  return todo;
}
