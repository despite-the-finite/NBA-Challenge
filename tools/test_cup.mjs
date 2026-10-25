// NBA Cup module: groups derived from the schedule, standings, the knockout bracket, pick validation and
// bracket scoring. Also replays the demo slate to make sure its 60 group games form six groups of five.
// Run: node tools/test_cup.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCupStage, splitCup, cupGroups, groupStandings, cupField, buildBracket, bracketLocked, bracketOpen, cleanBracketPicks, slotOptions, bracketMissing, scoreBracket, CUP_RULES } from '../js/cup.js';

/* ---- labels ---- */
assert.equal(parseCupStage('Emirates NBA Cup West Group A'), 'West A');
assert.equal(parseCupStage('Emirates NBA Cup - East Group C'), 'East C');
assert.equal(parseCupStage('Emirates NBA Cup - Quarterfinals'), 'QF');
assert.equal(parseCupStage('Semifinal'), 'SF');
assert.equal(parseCupStage('Championship'), 'F');
assert.equal(parseCupStage('Emirates NBA Cup Group Play'), null);
assert.equal(parseCupStage('QF'), 'QF');
assert.equal(parseCupStage(''), null);

/* ---- the demo slate: 60 group games -> 6 groups of 5, 3 per conference ---- */
const sample = JSON.parse(readFileSync(new URL('../data/sample-schedule.json', import.meta.url)));
const sampleGames = sample.games.map(g => ({ ...g, status: 'scheduled', homeScore: null, awayScore: null }));
const groups = cupGroups(sampleGames);
assert.equal(groups.length, 6);
assert.deepEqual(groups.map(g => g.teams.length), [5, 5, 5, 5, 5, 5]);
assert.deepEqual(groups.map(g => g.conf), ['East', 'East', 'East', 'West', 'West', 'West']);
assert.deepEqual(groups.map(g => g.games.length), [10, 10, 10, 10, 10, 10]);
assert.equal(groups[0].label, 'East Group 1', 'unlabeled groups are numbered');
assert.equal(buildBracket(sampleGames).ready, false);

/* ---- a small synthetic cup: two groups per conference would not be a real Cup, so build the real shape ---- */
const E = [['BOS', 'NYK', 'PHI', 'TOR', 'BKN'], ['MIL', 'CLE', 'CHI', 'DET', 'IND'], ['MIA', 'ORL', 'ATL', 'CHA', 'WAS']];
const W = [['OKC', 'HOU', 'DAL', 'SAS', 'MEM'], ['DEN', 'MIN', 'UTA', 'POR', 'LAC'], ['LAL', 'GSW', 'PHX', 'SAC', 'NOP']];
const games = [];
let day = 0;
for (const [gi, grp] of [...E, ...W].entries()) {
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
    const d = new Date(Date.UTC(2026, 10, 3 + (day++ % 25)));
    const date = d.toISOString().slice(0, 10);
    // deterministic result: the lower index wins by (5 - i) points, so group order is index order
    games.push({ id: `g:${date.replace(/-/g, '')}-${grp[j]}-${grp[i]}`, date, tipoff: `${date}T00:00:00Z`, home: grp[i], away: grp[j], cup: true, cupStage: gi < 3 ? `East ${'ABC'[gi]}` : `West ${'ABC'[gi - 3]}`, status: 'final', homeScore: 100 + (5 - i) + j, awayScore: 100 });
  }
}
const g2 = cupGroups(games);
assert.deepEqual(g2.map(g => g.label), ['East Group A', 'East Group B', 'East Group C', 'West Group A', 'West Group B', 'West Group C']);
const st = groupStandings(g2[0]);
assert.deepEqual(st.map(r => r.team), ['BOS', 'NYK', 'PHI', 'TOR', 'BKN']);
assert.equal(st[0].w, 4); assert.equal(st[4].l, 4);
const field = cupField(g2);
assert.equal(field.complete, true);
assert.deepEqual(field.East.winners.sort(), ['BOS', 'MIA', 'MIL']);
assert.ok(['NYK', 'CLE', 'ORL'].includes(field.East.wildcard));
assert.equal(field.West.seeds.length, 4);

/* ---- knockout: unlabeled games are staged by order; labeled ones by label ---- */
const ko = (date, away, home, cupStage, result) => ({ id: `g:${date.replace(/-/g, '')}-${away}-${home}`, date, tipoff: `${date}T01:00:00Z`, home, away, cup: true, cupStage, status: result ? 'final' : 'scheduled', homeScore: result ? result[0] : null, awayScore: result ? result[1] : null });
const qfs = [ko('2026-12-09', 'NYK', 'BOS', null), ko('2026-12-09', 'MIA', 'MIL', 'QF'), ko('2026-12-10', 'LAL', 'OKC', null), ko('2026-12-10', 'DEN', 'HOU', null)];
let all = [...games, ...qfs];
let b = buildBracket(all);
assert.equal(b.ready, true); assert.equal(b.qf.length, 4); assert.equal(b.lockAt, '2026-12-09T01:00:00Z');
assert.deepEqual(b.qf.map(q => q.conf), ['East', 'East', 'West', 'West']);
assert.deepEqual(b.sf.map(s => s.feeders.length), [2, 2]);
assert.equal(splitCup(all).knockout.length, 4, 'knockout games are told apart from group games without labels');
assert.equal(bracketOpen(b, new Date('2026-12-05T00:00:00Z')), true);
assert.equal(bracketLocked(b, new Date('2026-12-09T01:00:00Z')), true);
assert.equal(buildBracket([...games, ...qfs.slice(0, 3)]).ready, false, 'not ready with three quarterfinals');

/* ---- picks: consistency rules ---- */
const slotOf = team => b.qf.find(q => q.teams.includes(team)).key;
const [qE1, qE2, qW1, qW2] = ['BOS', 'MIL', 'OKC', 'DEN'].map(slotOf);
const raw = { [qE1]: 'BOS', [qE2]: 'MIL', [qW1]: 'OKC', [qW2]: 'DEN', 'SF-East': 'BOS', 'SF-West': 'LAL', F: 'BOS' };
let picks = cleanBracketPicks(raw, b);
assert.equal(picks['SF-West'], undefined, 'a semifinal pick must be one of your quarterfinal picks');
assert.equal(picks.F, 'BOS');
assert.deepEqual(slotOptions(b.sf[0], picks), ['BOS', 'MIL']);
assert.deepEqual(slotOptions(b.f, picks), ['BOS', null]);
assert.equal(bracketMissing(picks, b), 1);
assert.deepEqual(cleanBracketPicks({ [qE1]: 'LAL', F: 'BOS', 'SF-East': 'BOS' }, b), {}, 'bad teams are dropped and the cascade follows');
assert.deepEqual(cleanBracketPicks(null, b), {});
picks = cleanBracketPicks({ ...raw, 'SF-West': 'OKC', F: 'OKC' }, b);
assert.equal(bracketMissing(picks, b), 0);

/* ---- scoring as results come in ---- */
all = [...games, ko('2026-12-09', 'NYK', 'BOS', null, [100, 90]), ko('2026-12-09', 'MIA', 'MIL', 'QF', [90, 100]), ko('2026-12-10', 'LAL', 'OKC', null, [110, 100]), ko('2026-12-10', 'DEN', 'HOU', null, [105, 100])];
b = buildBracket(all);
let sc = scoreBracket(picks, b);
assert.equal(sc.total, 2 * CUP_RULES.qf, 'BOS and OKC right, MIL and DEN wrong');
assert.deepEqual(Object.values(sc.hits), [true, false, false, true], 'slots sort by tip-off then team codes: BOS, MIL, HOU, OKC games');
assert.equal(sc.max, 4 * CUP_RULES.qf + 2 * CUP_RULES.sf + CUP_RULES.f);
all.push(ko('2026-12-13', 'MIA', 'BOS', 'SF', [99, 101]), ko('2026-12-13', 'HOU', 'OKC', 'SF', [120, 100]));
b = buildBracket(all);
assert.equal(b.sf[0].game.home, 'BOS'); assert.equal(b.sf[1].winner, 'OKC');
sc = scoreBracket(picks, b);
assert.equal(sc.total, 2 * CUP_RULES.qf + CUP_RULES.sf, 'OKC semifinal right, Heat beat the Celtics');
all.push(ko('2026-12-16', 'MIA', 'OKC', 'F', [112, 104]));
b = buildBracket(all);
assert.equal(b.champion, 'OKC');
assert.equal(scoreBracket(picks, b).total, 2 * CUP_RULES.qf + CUP_RULES.sf + CUP_RULES.f);
assert.equal(scoreBracket({}, b).total, 0);
assert.equal(bracketLocked(b), true);
console.log('cup tests passed: labels, groups, standings, field, bracket, picks, scoring');
