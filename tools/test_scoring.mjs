// Replays the 2024-25 spreadsheet through the scoring engine and checks that every
// game's points match the spreadsheet formulas. Run: node tools/test_scoring.mjs
import { readFileSync } from 'node:fs';
import { scoreGame, computeStandings, DEFAULT_RULES, isValidLine } from '../js/scoring.js';

const season = JSON.parse(readFileSync(new URL('../data/season-2024-25.json', import.meta.url)));
// The spreadsheet formula gave nobody the point on an unanswered line or a push. Two push rows
// (Nov 30 and Dec 4, 2024) were hand-edited to give the selector the point, so the formula total is
// UP 288 while the sheet shows UP 290. The replay expects exactly those two mismatches.
const sheetRules = { ...DEFAULT_RULES, unansweredLine: 'nobody', noLine: 'nobody', showUpBonus: 0 };
let mismatches = 0;
const games = [], picks = {};
season.games.forEach((g, i) => {
  const winnerIsHome = g.winner === g.home;
  const game = { id: 'h' + i, date: g.date, tipoff: g.tipoff, home: g.home, away: g.away, selector: g.selector,
    status: 'final', homeScore: winnerIsHome ? 100 + g.margin : 100, awayScore: winnerIsHome ? 100 : 100 + g.margin };
  const p = { UP: { winner: g.picks.UP }, KP: { winner: g.picks.KP } };
  p[g.selector].line = g.line;
  p[g.selector === 'UP' ? 'KP' : 'UP'].ou = g.ou;
  const s = scoreGame(game, p, sheetRules);
  if (s.UP.total !== g.points.UP || s.KP.total !== g.points.KP) {
    mismatches++; console.log('sheet differs on', g.date, g.away, '@', g.home, 'sheet', g.points, 'engine', s.UP.total, s.KP.total, s.duel.reason);
  }
  games.push(game); picks[game.id] = p;
});
const st = computeStandings(games, picks, sheetRules);
console.log('games', season.games.length, 'mismatches', mismatches, 'totals', st.UP.total, st.KP.total, 'expected', season.totals);
console.assert(mismatches === 2, 'expected exactly the two hand-edited push rows to differ');
console.assert(st.UP.total === season.totals.UP - 2 && st.KP.total === season.totals.KP, 'totals differ');
// rules checks
const g = { id: 'x', date: '2026-10-20', tipoff: '2026-10-20T23:30:00Z', home: 'BOS', away: 'NYK', selector: 'UP', status: 'final', homeScore: 110, awayScore: 100 };
const r1 = scoreGame(g, { UP: { winner: 'BOS', line: 8 }, KP: { winner: 'BOS', ou: 'O' } });
console.assert(r1.UP.total === 1 && r1.KP.total === 2, 'over hit');
const r2 = scoreGame(g, { UP: { winner: 'BOS', line: 10 }, KP: { winner: 'NYK', ou: 'U' } });
console.assert(r2.UP.total === 1 && r2.KP.total === 0, 'push gives nobody the point by default');
const r2b = scoreGame(g, { UP: { winner: 'BOS', line: 10 }, KP: { winner: 'NYK', ou: 'U' } }, { ...DEFAULT_RULES, push: 'selector' });
console.assert(r2b.UP.total === 2 && r2b.KP.total === 0, 'push rule selector');
const r3 = scoreGame(g, { UP: { winner: 'BOS', line: 8 }, KP: { winner: 'BOS' } });
console.assert(r3.UP.total === 2 && r3.KP.total === 1, 'unanswered line -> selector');
const r4 = scoreGame(g, { UP: { winner: 'BOS' }, KP: { winner: 'BOS' } });
console.assert(r4.UP.total === 1 && r4.KP.total === 2, 'no line -> responder');
const r5 = scoreGame(g, { UP: { winner: 'BOS' }, KP: {} });
console.assert(r5.UP.total === 1 && r5.KP.total === 0, 'no line, responder absent -> nobody');
console.assert(isValidLine(7) && !isValidLine(7.5) && isValidLine(7.5, { ...DEFAULT_RULES, halfPointLines: true }) && !isValidLine(0), 'line validation');
console.log('all scoring checks passed; days:', st.days.length, 'UP days won', st.UP.daysWon, 'KP days won', st.KP.daysWon, 'streak', st.UP.streak, st.KP.streak);
