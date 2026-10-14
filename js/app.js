// NBA Challenge web app. Renders four views (Slate, Standings, History, Settings) from the store.
import { createStore, DemoStore } from './store.js';
import { TEAMS, teamLogo, teamName } from './teams.js';
import { DEFAULT_RULES, PLAYER_CODES, otherPlayer, scoreGame, scoreDay, computeStandings, groupByDate, isLocked, isPickable, gameWinner, gameMargin, missingPicks, hasAnyPick } from './scoring.js';

const CFG = window.NBA_CONFIG;
let store = createStore(CFG);
const ui = { view: 'slate', date: null, expanded: null, season: 'current', lastSeason: null, pendingLine: {}, lineTimer: {} };
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- dates & formatting ---------------- */
const ET = 'America/New_York';
function etDate(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function localDateObj(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(y, m - 1, d, 12); }
const fmtTime = (iso) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const fmtDow = (ds) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(localDateObj(ds));
const fmtLong = (ds) => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(localDateObj(ds));
const fmtShort = (ds) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(localDateObj(ds));
function countdown(iso) {
  const ms = new Date(iso) - store.now();
  if (ms <= 0) return 'locked';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
const name = (code) => store.players[code]?.name || code;
const initial = (code) => code[0];

/* ---------------- boot ---------------- */
async function boot() {
  applyTheme(localStorage.getItem('nbac.theme') || 'system');
  try { await store.init(); }
  catch (e) {
    if (store.mode === 'live') {
      // No API behind this page (opened from a plain static host): run the demo instead.
      console.warn('API unavailable, running demo:', e.message);
      store = new DemoStore(CFG, e.message);
      try { await store.init(); } catch (e2) { $('#app').innerHTML = `<div class="empty"><div class="big">⚠️</div><b>Could not start</b><div>${esc(e2.message)}</div></div>`; return; }
    } else { $('#app').innerHTML = `<div class="empty"><div class="big">⚠️</div><b>Could not start</b><div>${esc(e.message)}</div></div>`; return; }
  }
  store.onChange(render);
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (['slate', 'standings', 'history', 'settings'].includes(v)) { ui.view = v; render(); } });
  const v = location.hash.replace('#', ''); if (['slate', 'standings', 'history', 'settings'].includes(v)) ui.view = v;
  setInterval(() => { if (ui.view === 'slate') render(); }, 60000);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
}

/* ---------------- render ---------------- */
function render() {
  const app = $('#app');
  if (store.mode === 'live' && !store.me) { app.innerHTML = renderAuth(); bindAuth(); return; }
  const games = store.gameList();
  const standings = computeStandings(games, store.picks, store.rules);
  document.documentElement.style.setProperty('--me-color', `var(--${store.me.toLowerCase()})`);
  document.documentElement.style.setProperty('--me-soft', `var(--${store.me.toLowerCase()}-soft)`);
  const todayET = etDate(store.now());
  const todo = missingPicks(store.me, games.filter(g => g.date === todayET && isPickable(g, store.rules, store.now())), store.picks).length;
  app.innerHTML = `
    <div class="app">
      ${renderTopbar(standings)}
      <main>
        ${ui.view === 'slate' ? renderSlate(games, standings) : ui.view === 'standings' ? renderStandings(games, standings) : ui.view === 'history' ? renderHistory(standings) : renderSettings()}
      </main>
      ${renderTabbar(todo)}
    </div>
    <div class="toast" id="toast" role="status"></div>`;
  bindGlobal();
  if (ui.view === 'slate') bindSlate();
  if (ui.view === 'standings') bindChart();
  if (ui.view === 'settings') bindSettings();
}

function renderTopbar(st) {
  const lead = st.leader;
  return `<header class="topbar"><div class="topbar-inner">
    <div class="brand"><h1>NBA Challenge</h1><span class="season">${esc(CFG.SEASON)} · ${esc(name('UP'))} vs ${esc(name('KP'))}</span></div>
    <div class="scoreboard" aria-label="Season score">
      <div class="side up ${lead === 'UP' ? 'lead' : ''}"><span class="who">${esc(name('UP'))}</span><span class="pts num">${st.UP.total}</span></div>
      <div class="mid">${lead ? `${esc(name(lead))}<br>+${st.margin}` : 'tied'}</div>
      <div class="side kp ${lead === 'KP' ? 'lead' : ''}"><span class="who">${esc(name('KP'))}</span><span class="pts num">${st.KP.total}</span></div>
    </div>
    ${store.mode === 'demo'
      ? `<button class="me-chip" data-act="switch" title="Demo: switch player"><span class="dot" style="background:var(--${store.me.toLowerCase()})"></span>${esc(name(store.me))} ⇄</button>`
      : `<span class="me-chip"><span class="dot" style="background:var(--${store.me.toLowerCase()})"></span>${esc(name(store.me))}</span>`}
  </div>
  ${store.mode === 'demo' ? `<div class="topbar-sub"><span class="mode">Demo</span><span class="grow">saved in this browser only · demo day ${esc(fmtShort(etDate(store.now())))}</span><button class="btn small ghost" data-act="advance">Advance a day ⏩</button></div>` : ''}
  </header>`;
}

const ICONS = {
  slate: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  standings: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  history: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
function renderTabbar(todo) {
  const tabs = [['slate', 'Slate'], ['standings', 'Standings'], ['history', 'History'], ['settings', 'Settings']];
  return `<nav class="tabbar"><div class="tabbar-inner">${tabs.map(([k, l]) => `<div class="tab-wrap"><button class="tab ${ui.view === k ? 'active' : ''}" data-view="${k}" aria-current="${ui.view === k}">${ICONS[k]}<span>${l}</span></button>${k === 'slate' && todo ? `<span class="count" title="Picks left today">${todo}</span>` : ''}</div>`).join('')}</div></nav>`;
}

/* ---------------- Slate ---------------- */
function renderSlate(games, standings) {
  const now = store.now();
  const todayET = etDate(now);
  const byDate = groupByDate(games);
  const dates = [];
  for (let i = -1; i <= 9; i++) { const d = addDays(todayET, i); if (byDate.has(d) || d === todayET) dates.push(d); }
  if (!ui.date || !dates.includes(ui.date)) ui.date = byDate.has(todayET) ? todayET : (dates.find(d => d > todayET && byDate.has(d)) || todayET);
  const dayGames = byDate.get(ui.date) || [];
  const day = scoreDay(ui.date, dayGames, store.picks, store.rules);
  const windowEnd = addDays(todayET, store.rules.pickWindowDays);
  const chips = dates.map(d => {
    const gs = byDate.get(d) || [];
    const prog = pickProgress(store.me, gs);
    const cls = [d === ui.date ? 'active' : '', d === todayET ? 'today' : '', d > windowEnd ? 'future' : '', prog.total && prog.done === prog.total ? 'done' : '', gs.length && gs.every(g => isLocked(g, now)) ? 'locked' : ''].join(' ');
    return `<button class="day-chip ${cls}" data-date="${d}"><span class="dow">${d === todayET ? 'Today' : esc(fmtDow(d))}</span><span class="dom">${+d.slice(8)}</span><span class="n">${gs.length ? gs.length + ' gm' : 'off'}</span><span class="ring"><i style="width:${prog.total ? Math.round(prog.done / prog.total * 100) : 0}%"></i></span></button>`;
  }).join('');

  const anyFinal = dayGames.some(g => g.status === 'final');
  const first = dayGames[0];
  let notices = '';
  if (dayGames.length) {
    if (ui.date > windowEnd) notices += notice('info', '📅', `Picks for this day open on <strong>${esc(fmtLong(addDays(ui.date, -store.rules.pickWindowDays)))}</strong> (${store.rules.pickWindowDays} days ahead).`);
    else {
      const open = dayGames.filter(g => isPickable(g, store.rules, now));
      const mine = missingPicks(store.me, open, store.picks);
      const theirs = missingPicks(otherPlayer(store.me), open, store.picks);
      const linesWaitingOnMe = mine.filter(m => m.items.includes('line')).length;
      const callsWaitingOnMe = mine.filter(m => m.items.includes('call')).length;
      const linesWaitingOnThem = theirs.filter(m => m.items.includes('line')).length;
      if (mine.length) notices += notice('todo', '✍️', `<strong>${mine.length} game${mine.length > 1 ? 's' : ''} still need${mine.length > 1 ? '' : 's'} your input.</strong> ${linesWaitingOnMe ? `${esc(name(otherPlayer(store.me)))} is waiting on ${linesWaitingOnMe} line${linesWaitingOnMe > 1 ? 's' : ''} from you. ` : ''}${callsWaitingOnMe ? `${callsWaitingOnMe} line${callsWaitingOnMe > 1 ? 's' : ''} to call. ` : ''}`);
      else if (open.length) notices += notice('good', '✅', `<strong>You're all set for this day.</strong> ${linesWaitingOnThem ? `Waiting on ${esc(name(otherPlayer(store.me)))} for ${linesWaitingOnThem} line${linesWaitingOnThem > 1 ? 's' : ''}.` : ''}`);
      if (!open.length && !anyFinal) notices += notice('info', '🔒', 'All games this day are locked. Scores and points arrive with the 5 AM Mountain refresh.');
    }
    if (day.UP.bonus || day.KP.bonus) { const w = day.UP.bonus ? 'UP' : 'KP'; notices += notice('good', '🎁', `<strong>Show-up bonus:</strong> ${esc(name(otherPlayer(w)))} made no picks this day, so ${esc(name(w))} gets +${store.rules.showUpBonus}.`); }
  }

  if (store.mode === 'live' && store.games.size === 0) {
    return `<section class="view" id="view-slate"><div class="empty"><div class="big">📡</div><b>Schedule not loaded yet</b><div class="muted">The server tries to pull the NBA schedule when the app opens on an empty database.${store.lastSyncError ? `<br><br><span style="color:var(--bad)">${esc(store.lastSyncError)}</span>` : ''}</div><button class="btn primary" data-act="loadschedule">Load schedule from this device</button><div class="muted" id="loadsched-status" style="font-size:13px"></div></div></section>`;
  }
  return `<section class="view" id="view-slate">
    <div class="daystrip">${chips}</div>
    <div class="dayhead">
      <div><h2>${esc(fmtLong(ui.date))}</h2><div class="sub">${dayGames.length ? `${dayGames.length} game${dayGames.length > 1 ? 's' : ''} · first tip ${esc(fmtTime(first.tipoff))}` : 'No games'}${dayGames.some(g => g.cup) ? ' · NBA Cup night' : ''}</div></div>
      ${anyFinal ? `<div class="dayscore num" title="Points this day"><span class="u">${day.UP.total}</span><span class="vs">${esc(name('UP'))} · ${esc(name('KP'))}</span><span class="k">${day.KP.total}</span></div>` : ''}
    </div>
    ${notices}
    <div class="games">${dayGames.length ? dayGames.map(g => renderCard(g, now)).join('') : `<div class="empty"><div class="big">🏀</div><b>No games on this day</b><div>Pick another day above.</div></div>`}</div>
  </section>`;
}
function notice(kind, ico, html) { return `<div class="notice ${kind}"><span class="ico">${ico}</span><div>${html}</div></div>`; }
function pickProgress(player, games) {
  let total = 0, done = 0;
  for (const g of games) {
    const mine = store.pickFor(g.id, player) || {}; const opp = store.pickFor(g.id, otherPlayer(player)) || {};
    total++; if (mine.winner) done++;
    if (g.selector === player) { total++; if (mine.line != null) done++; }
    else if (opp.line != null) { total++; if (mine.ou) done++; }
  }
  return { total, done };
}

function renderCard(g, now, readOnly = false) {
  const me = store.me, opp = otherPlayer(me);
  const locked = isLocked(g, now), final = g.status === 'final';
  const editable = !readOnly && store.canEdit(g);
  const picks = store.picksFor(g.id);
  const mine = picks[me] || {}, theirs = picks[opp] || {};
  const score = scoreGame(g, picks, store.rules);
  const winner = gameWinner(g), margin = gameMargin(g);
  const oppHasWinner = store.oppHasWinner(g.id, opp);
  const statusPill = final ? `<span class="pill">Final</span>` : g.status === 'postponed' ? `<span class="pill">Postponed</span>` : g.status === 'live' ? `<span class="pill live">Live${g.clock ? ' · ' + esc(g.clock) : ''}</span>` : locked ? `<span class="pill" title="Scores are pulled once a day at 5 AM Mountain">Locked · scores at 5 AM MT</span>` : !isPickable(g, store.rules, now) ? `<span class="pill">Opens later</span>` : (new Date(g.tipoff) - now < 2 * 3600e3 ? `<span class="pill soon" title="Picks lock at tip-off">Locks in ${esc(countdown(g.tipoff))}</span>` : `<span class="pill open" title="Picks lock at tip-off">Open · ${esc(countdown(g.tipoff))}</span>`);

  const team = (code, scoreVal) => {
    const t = TEAMS[code];
    const isMine = mine.winner === code, isTheirs = (locked || store.mode === 'demo' && false) && theirs.winner === code;
    const tags = [];
    if (isMine) tags.push(`<i class="${me.toLowerCase()[0]}" title="${esc(name(me))}">${initial(me)}${final ? (winner === code ? '✓' : '✗') : ''}</i>`);
    if (locked && theirs.winner === code) tags.push(`<i class="${opp.toLowerCase()[0]}" title="${esc(name(opp))}">${initial(opp)}${final ? (winner === code ? '✓' : '✗') : ''}</i>`);
    const cls = ['team', isMine ? 'mine' : '', final ? (winner === code ? 'won' : 'lost') : ''].join(' ');
    return `<button class="${cls}" data-team="${code}" data-game="${g.id}" ${editable ? '' : 'disabled'} aria-pressed="${isMine}" aria-label="Pick ${esc(teamName(code, 'full'))} to win">
      <span class="tag">${tags.join('')}</span>
      <img class="logo" src="${teamLogo(code)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'logo-fallback',textContent:'${code}',style:'background:${t.color}'}))">
      <span class="abbr">${code}</span><span class="nm">${esc(t.name)}</span>
      ${final || g.status === 'live' ? `<span class="score num">${scoreVal ?? ''}</span>` : ''}
    </button>`;
  };

  const sel = g.selector, resp = otherPlayer(sel), iAmSelector = sel === me;
  const line = picks[sel]?.line ?? null, call = picks[resp]?.ou ?? null;
  const frozen = call != null;
  let duel = `<div class="duel-head"><span>Margin duel</span><span class="who ${sel.toLowerCase()}">${esc(name(sel))}</span><span>sets the line ·</span><span class="who ${resp.toLowerCase()}">${esc(name(resp))}</span><span>calls it</span></div>`;
  if (final) {
    const d = score.duel;
    let text;
    if (d.line == null) text = `No line was posted. ${d.winner ? `<b>${esc(name(d.winner))} +${store.rules.spreadPoint}</b>` : 'No point.'}`;
    else if (d.call == null) text = `Line ${d.line}, never answered. ${d.winner ? `<b>${esc(name(d.winner))} +${store.rules.spreadPoint}</b>` : 'No point.'}`;
    else if (d.reason === 'push') text = `Line ${d.line} · ${d.call === 'O' ? 'Over' : 'Under'} · <span class="push">Push</span> on ${margin}. ${d.winner ? `<b>${esc(name(d.winner))} +${store.rules.spreadPoint}</b>` : 'No point.'}`;
    else text = `Line ${d.line} · ${esc(name(resp))} called <b>${d.call === 'O' ? 'Over' : 'Under'}</b> · <span class="${d.winner === resp ? 'hit' : 'miss'}">${d.winner === resp ? 'Hit' : 'Missed'}</span> on ${margin}. <b>${esc(name(d.winner))} +${store.rules.spreadPoint}</b>`;
    duel += `<div class="outcome">${text}</div>`;
  } else if (iAmSelector) {
    const pending = ui.pendingLine[g.id];
    const shown = pending ?? line;
    if (editable && !frozen) {
      duel += shown == null
        ? `<div class="duel-row"><button class="btn me" data-act="postline" data-game="${g.id}">Post a line</button><span class="status">Pick the margin you think the winner covers. ${esc(name(resp))} will call Over or Under.</span></div>`
        : `<div class="duel-row"><div class="stepper"><button data-act="line" data-d="-1" data-game="${g.id}" aria-label="Lower line" ${shown <= store.rules.lineMin ? 'disabled' : ''}>−</button><span class="val num">${shown}</span><button data-act="line" data-d="1" data-game="${g.id}" aria-label="Raise line" ${shown >= store.rules.lineMax ? 'disabled' : ''}>+</button></div><span class="status">Your line: winner by <b>${shown}</b>. ${call ? '' : `${esc(name(resp))} hasn't called it yet.`}</span><button class="btn small ghost" data-act="clearline" data-game="${g.id}">Clear</button></div>`;
    } else {
      duel += `<div class="duel-row"><div class="line-big num">${line ?? '—'}<small>your line</small></div><span class="status">${line == null ? (locked ? `You never posted a line.${store.rules.noLine === 'responder' && hasAnyPick(theirs) ? ` ${esc(name(resp))} takes the point.` : ''}` : 'No line yet.') : call ? `${esc(name(resp))} called <b>${call === 'O' ? 'OVER' : 'UNDER'}</b>${locked ? '' : ' · line frozen'}` : `${esc(name(resp))} hasn't answered.${locked && store.rules.unansweredLine === 'selector' ? ' Point to you.' : ''}`}</span></div>`;
    }
  } else {
    if (line == null) duel += `<div class="duel-row"><span class="status">${locked ? `${esc(name(sel))} never posted a line.${store.rules.noLine === 'responder' && hasAnyPick(mine) ? ' <b>Point to you.</b>' : ''}` : `Waiting for <b>${esc(name(sel))}</b> to post a line.`}</span></div>`;
    else duel += `<div class="duel-row"><div class="line-big num">${line}<small>${esc(name(sel))}'s line</small></div>
      <div class="seg lg" role="group" aria-label="Over or under"><button data-act="call" data-ou="U" data-game="${g.id}" class="${call === 'U' ? 'on' : ''}" ${editable ? '' : 'disabled'} aria-pressed="${call === 'U'}">UNDER</button><button data-act="call" data-ou="O" data-game="${g.id}" class="${call === 'O' ? 'on' : ''}" ${editable ? '' : 'disabled'} aria-pressed="${call === 'O'}">OVER</button></div>
      ${!call && locked ? `<span class="status">You never answered.${store.rules.unansweredLine === 'selector' ? ` ${esc(name(sel))} takes the point.` : ''}</span>` : ''}</div>`;
  }

  const foot = final
    ? `<div class="card-foot"><span class="chip up ${score.UP.total ? '' : 'zero'}">${esc(name('UP'))} +${score.UP.total}</span><span class="chip kp ${score.KP.total ? '' : 'zero'}">${esc(name('KP'))} +${score.KP.total}</span><span class="spacer"></span><span>${esc(teamName(winner))} by ${margin}</span></div>`
    : `<div class="card-foot"><span class="opp-status"><span class="dot ${oppHasWinner ? 'on' : ''}"></span>${esc(name(opp))}: ${oppHasWinner ? (locked ? `picked ${esc(theirs.winner || '')}` : 'picked (hidden until tip-off)') : 'no pick yet'}</span>${sel === opp ? `<span class="opp-status"><span class="dot ${line != null ? 'on' : ''}"></span>line ${line != null ? 'posted' : 'pending'}</span>` : `<span class="opp-status"><span class="dot ${call ? 'on' : ''}"></span>${call ? 'called ' + (call === 'O' ? 'over' : 'under') : 'no call yet'}</span>`}</div>`;

  return `<article class="card ${locked ? 'locked' : ''} ${final ? 'final' : ''}" id="g-${esc(g.id)}">
    <div class="card-head"><span class="time">${esc(fmtTime(g.tipoff))}</span><span class="arena">${esc(g.arena || '')}</span><span class="spacer"></span>${g.cup ? '<span class="pill cup">NBA Cup</span>' : ''}${statusPill}</div>
    <div class="matchup">${team(g.away, g.awayScore)}<div class="at">${final ? `<span class="margin">margin<b class="num">${margin}</b></span>` : '@'}</div>${team(g.home, g.homeScore)}</div>
    <div class="duel ${final ? 'result' : ''}">${duel}</div>
    ${foot}
  </article>`;
}

/* ---------------- Standings ---------------- */
function renderStandings(games, st) {
  if (ui.season === 'last') return renderLastSeason();
  const lead = st.leader;
  const settledDays = st.days.filter(d => d.settled).length;
  const totalDays = st.days.length;
  const tile = (p) => `<div class="tile ${p.toLowerCase()}">${lead === p ? '<span class="crown">Leader</span>' : ''}<span class="name"><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--${p.toLowerCase()})"></span>${esc(name(p))}</span><span class="big num">${st[p].total}</span><span class="sub">${st[p].daysWon} days won · ${st[p].streak ? `${st[p].streak}-day streak` : 'no streak'}</span></div>`;
  const rows = [
    ['Points', st.UP.total, st.KP.total],
    ['Days won', st.UP.daysWon, st.KP.daysWon],
    ['Winner picks', pct(st.UP.winnerPct, st.UP.winnerHits, st.UP.winnerPicks), pct(st.KP.winnerPct, st.KP.winnerHits, st.KP.winnerPicks), st.UP.winnerPct, st.KP.winnerPct],
    ['Over/Under calls hit', pct(st.UP.callPct, st.UP.callsHit, st.UP.callsMade), pct(st.KP.callPct, st.KP.callsHit, st.KP.callsMade), st.UP.callPct, st.KP.callPct],
    ['Lines defended', pct(st.UP.defendPct, st.UP.linesDefended, st.UP.linesSet), pct(st.KP.defendPct, st.KP.linesDefended, st.KP.linesSet), st.UP.defendPct, st.KP.defendPct],
    ['Points from winners', st.UP.winnerPts, st.KP.winnerPts],
    ['Points from duels', st.UP.spreadPts, st.KP.spreadPts],
    ['Show-up bonuses', st.UP.bonusPts, st.KP.bonusPts],
    ['Perfect days', st.UP.perfectDays, st.KP.perfectDays],
    ['Days skipped', st.UP.daysSkipped, st.KP.daysSkipped, -st.UP.daysSkipped, -st.KP.daysSkipped],
    ['Best day', st.UP.bestDay.date ? `${st.UP.bestDay.points}<small>${esc(fmtShort(st.UP.bestDay.date))}</small>` : '—', st.KP.bestDay.date ? `${st.KP.bestDay.points}<small>${esc(fmtShort(st.KP.bestDay.date))}</small>` : '—', st.UP.bestDay.points, st.KP.bestDay.points],
  ];
  return `<section class="view" id="view-standings">
    <div class="toggle-row" role="tablist"><button class="on" data-season="current">${esc(CFG.SEASON)}</button><button data-season="last">Last season</button></div>
    <div class="tiles">${tile('UP')}${tile('KP')}</div>
    <div class="leadline">${lead ? `<b>${esc(name(lead))}</b> leads by <b>${st.margin}</b>` : '<b>Dead even</b>'} · ${settledDays} of ${totalDays} game days played · ${st.gamesFinal} games final</div>
    <div class="section"><h3>The race <span class="eyebrow">cumulative points</span></h3>${st.race.length > 1 ? raceChart(st.race) : '<div class="muted">The race chart appears after the first completed game day.</div>'}<div class="legend"><span class="up">${esc(name('UP'))}</span><span class="kp">${esc(name('KP'))}</span></div></div>
    <div class="section"><h3>Season stats</h3><table class="stat-table"><thead><tr><th></th><th style="color:var(--up)">${esc(name('UP'))}</th><th style="color:var(--kp)">${esc(name('KP'))}</th></tr></thead><tbody>
      ${rows.map(([l, a, b, ca, cb]) => { const va = ca ?? (typeof a === 'number' ? a : 0), vb = cb ?? (typeof b === 'number' ? b : 0); return `<tr><td>${l}</td><td class="v ${va >= vb ? 'lead' : ''}">${a}</td><td class="v ${vb >= va ? 'lead' : ''}">${b}</td></tr>`; }).join('')}
    </tbody></table></div>
    <div class="section"><h3>How scoring works</h3>${rulesList()}</div>
  </section>`;
}
function pct(p, hits, n) { return n ? `${Math.round(p * 100)}%<small>${hits}/${n}</small>` : '—'; }
function rulesList() {
  const r = store.rules;
  return `<ul class="rules-list" style="list-style:none;padding:0;margin:0">
    <li><span class="pt">+${r.winnerPoint}</span><span>Pick the winner.</span></li>
    <li><span class="pt">+${r.spreadPoint}</span><span>Win the margin duel. The selector posts a line (the margin of victory). The other player calls Over or Under. Right call: the caller takes the point. Wrong call: the selector takes it. ${r.push === 'selector' ? 'An exact push counts as a miss, so the selector takes it.' : 'An exact push gives nobody the point.'}</span></li>
    <li><span class="pt">+${r.showUpBonus}</span><span>Show-up bonus: if you make picks on a day and your brother makes none, you get +${r.showUpBonus}.</span></li>
    <li><span class="pt">⏱</span><span>Picks lock at tip-off, game by game. You can pick up to ${r.pickWindowDays} days ahead. A line freezes once it has been answered.</span></li>
    <li><span class="pt">⚠️</span><span>${r.noLine === 'responder' ? 'Selector never posts a line: the other player takes the duel point (if they made a pick on that game).' : 'Selector never posts a line: nobody gets the duel point.'} ${r.unansweredLine === 'selector' ? 'Line posted but never answered: the selector takes the point.' : 'Line posted but never answered: nobody gets the point.'}</span></li>
  </ul>`;
}

function raceChart(race) {
  const W = 640, H = 260, m = { l: 36, r: 54, t: 12, b: 28 };
  const n = race.length, maxY = Math.max(5, ...race.map(r => Math.max(r.UP, r.KP)));
  const step = niceStep(maxY / 4);
  const yMax = Math.ceil(maxY / step) * step;
  const x = i => m.l + (n === 1 ? 0 : i / (n - 1)) * (W - m.l - m.r);
  const y = v => m.t + (1 - v / yMax) * (H - m.t - m.b);
  const path = k => race.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[k]).toFixed(1)}`).join(' ');
  const grid = []; for (let v = 0; v <= yMax; v += step) grid.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  const ticks = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map(i => `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(fmtShort(race[i].date))}</text>`);
  const last = race[n - 1];
  const lblUP = y(last.UP), lblKP = y(last.KP);
  const sep = Math.abs(lblUP - lblKP) < 14 ? (lblUP < lblKP ? -7 : 7) : 0;
  return `<div class="chart-wrap" id="race" data-race='${esc(JSON.stringify(race))}'>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative points by day">
      <g class="grid">${grid.join('')}</g>
      <path class="series up" d="${path('UP')}"/><path class="series kp" d="${path('KP')}"/>
      <circle class="end up" cx="${x(n - 1)}" cy="${lblUP}" r="4"/><circle class="end kp" cx="${x(n - 1)}" cy="${lblKP}" r="4"/>
      <text class="endlabel" x="${x(n - 1) + 8}" y="${lblUP + 4 + sep}">${last.UP}</text><text class="endlabel" x="${x(n - 1) + 8}" y="${lblKP + 4 - sep}">${last.KP}</text>
      <g class="axis">${ticks.join('')}</g>
      <line class="cross" id="race-cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" hidden/>
      <rect id="race-hit" x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/>
    </svg><div class="chart-tip" id="race-tip" hidden></div></div>`;
}
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function bindChart() {
  $$('[data-season]').forEach(b => b.onclick = () => { ui.season = b.dataset.season; render(); });
  const wrap = $('#race'); if (!wrap) return;
  const race = JSON.parse(wrap.dataset.race); const svg = $('svg', wrap); const hit = $('#race-hit'); const cross = $('#race-cross'); const tip = $('#race-tip');
  const move = (ev) => {
    const r = svg.getBoundingClientRect(); const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
    const W = 640, m = { l: 36, r: 54 }; const vx = px / r.width * W;
    const i = Math.max(0, Math.min(race.length - 1, Math.round((vx - m.l) / (W - m.l - m.r) * (race.length - 1))));
    const cx = m.l + i / (race.length - 1) * (W - m.l - m.r);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.hidden = false;
    tip.hidden = false; tip.style.left = (cx / W * r.width) + 'px'; tip.style.top = '8px'; tip.style.transform = 'translate(-50%, 0)';
    tip.innerHTML = `<div class="muted">${esc(fmtLong(race[i].date))}</div><div class="r"><span><i style="background:var(--up-chart)"></i>${esc(name('UP'))}</span><b class="num">${race[i].UP}</b></div><div class="r"><span><i style="background:var(--kp-chart)"></i>${esc(name('KP'))}</span><b class="num">${race[i].KP}</b></div>`;
  };
  hit.addEventListener('mousemove', move); hit.addEventListener('touchstart', move, { passive: true }); hit.addEventListener('touchmove', move, { passive: true });
  hit.addEventListener('mouseleave', () => { cross.hidden = true; tip.hidden = true; });
}

function renderLastSeason() {
  if (!ui.lastSeason) {
    fetch('data/season-2024-25.json').then(r => r.json()).then(d => { ui.lastSeason = d; render(); }).catch(() => { ui.lastSeason = { error: true }; render(); });
    return `<section class="view"><div class="toggle-row"><button data-season="current">${esc(CFG.SEASON)}</button><button class="on" data-season="last">Last season</button></div><div class="empty">Loading 2024-25…</div></section>`;
  }
  const d = ui.lastSeason;
  if (d.error) return `<section class="view"><div class="toggle-row"><button data-season="current">${esc(CFG.SEASON)}</button><button class="on" data-season="last">Last season</button></div><div class="empty">Could not load last season.</div></section>`;
  // Rebuild games/picks from the spreadsheet rows and score them with the sheet's rules.
  const games = [], picks = new Map();
  d.games.forEach((g, i) => {
    const homeWon = g.winner === g.home;
    const game = { id: 'h' + i, date: g.date, tipoff: g.tipoff, home: g.home, away: g.away, arena: g.arena, cup: g.cup, selector: g.selector, status: 'final', homeScore: homeWon ? 100 + g.margin : 100, awayScore: homeWon ? 100 : 100 + g.margin };
    const p = { UP: { winner: g.picks.UP }, KP: { winner: g.picks.KP } };
    p[g.selector].line = g.line; p[otherPlayer(g.selector)].ou = g.ou;
    games.push(game); picks.set(game.id, p);
  });
  const st = computeStandings(games, picks, { ...DEFAULT_RULES, push: 'nobody', unansweredLine: 'nobody', noLine: 'nobody', showUpBonus: 0 });
  const lead = d.totals.UP > d.totals.KP ? 'UP' : 'KP';
  const tile = (p) => `<div class="tile ${p.toLowerCase()}">${lead === p ? '<span class="crown">Champion</span>' : ''}<span class="name">${esc(name(p))}</span><span class="big num">${d.totals[p]}</span><span class="sub">${st[p].daysWon} days won · ${Math.round(st[p].winnerPct * 100)}% winners</span></div>`;
  return `<section class="view">
    <div class="toggle-row" role="tablist"><button data-season="current">${esc(CFG.SEASON)}</button><button class="on" data-season="last">Last season</button></div>
    <div class="tiles">${tile('UP')}${tile('KP')}</div>
    <div class="leadline"><b>2024-25 final.</b> ${d.games_scored} games scored from Nov 27 to Apr 13 · ${esc(name(lead))} won by <b>${Math.abs(d.totals.UP - d.totals.KP)}</b></div>
    <div class="section"><h3>The race <span class="eyebrow">from the spreadsheet</span></h3>${raceChart(st.race)}<div class="legend"><span class="up">${esc(name('UP'))}</span><span class="kp">${esc(name('KP'))}</span></div><div class="faint" style="font-size:12px">Chart uses the sheet's formula (a push scores nobody). Two pushes were hand-scored for the selector on the sheet, which is why the sheet total is UP ${d.totals.UP} and the chart ends at ${st.UP.total}.</div></div>
    <div class="section"><h3>2024-25 stats</h3><table class="stat-table"><thead><tr><th></th><th style="color:var(--up)">${esc(name('UP'))}</th><th style="color:var(--kp)">${esc(name('KP'))}</th></tr></thead><tbody>
      ${[['Days won', st.UP.daysWon, st.KP.daysWon], ['Winner picks', pct(st.UP.winnerPct, st.UP.winnerHits, st.UP.winnerPicks), pct(st.KP.winnerPct, st.KP.winnerHits, st.KP.winnerPicks), st.UP.winnerPct, st.KP.winnerPct], ['Over/Under calls hit', pct(st.UP.callPct, st.UP.callsHit, st.UP.callsMade), pct(st.KP.callPct, st.KP.callsHit, st.KP.callsMade), st.UP.callPct, st.KP.callPct], ['Lines defended', pct(st.UP.defendPct, st.UP.linesDefended, st.UP.linesSet), pct(st.KP.defendPct, st.KP.linesDefended, st.KP.linesSet), st.UP.defendPct, st.KP.defendPct], ['Pushes', st.UP.pushes, st.KP.pushes, 0, 0], ['Best day', `${st.UP.bestDay.points}<small>${esc(fmtShort(st.UP.bestDay.date))}</small>`, `${st.KP.bestDay.points}<small>${esc(fmtShort(st.KP.bestDay.date))}</small>`, st.UP.bestDay.points, st.KP.bestDay.points]]
        .map(([l, a, b, ca, cb]) => { const va = ca ?? a, vb = cb ?? b; return `<tr><td>${l}</td><td class="v ${va >= vb ? 'lead' : ''}">${a}</td><td class="v ${vb >= va ? 'lead' : ''}">${b}</td></tr>`; }).join('')}
    </tbody></table></div>
  </section>`;
}

/* ---------------- History ---------------- */
function renderHistory(st) {
  const days = st.days.filter(d => d.settled || d.games.some(x => x.game.status === 'final')).reverse();
  if (!days.length) return `<section class="view"><div class="empty"><div class="big">📜</div><b>No completed game days yet</b><div>Results show up here after the final buzzer.</div></div></section>`;
  return `<section class="view" id="view-history"><div class="daylist">${days.map(d => {
    const cls = d.dayWinner === 'UP' ? 'win-up' : d.dayWinner === 'KP' ? 'win-kp' : 'tie';
    const open = ui.expanded === d.date;
    return `<button class="dayrow ${cls}" data-expand="${d.date}" aria-expanded="${open}">
      <span><span class="d">${esc(fmtLong(d.date))}</span><br><span class="m">${d.games.length} games${d.settled ? (d.dayWinner === 'tie' ? ' · tied' : ` · ${esc(name(d.dayWinner))} took the day`) : ' · scores arrive at 5 AM MT'}${d.UP.bonus || d.KP.bonus ? ` · <span class="bonus">+${store.rules.showUpBonus} show-up bonus to ${esc(name(d.UP.bonus ? 'UP' : 'KP'))}</span>` : ''}</span></span>
      <span class="s num"><span class="u">${d.UP.total}</span><span class="d2">–</span><span class="k">${d.KP.total}</span></span>
    </button>${open ? `<div class="games" style="margin:4px 0 10px">${d.games.map(x => renderCard(x.game, store.now(), true)).join('')}</div>` : ''}`;
  }).join('')}</div></section>`;
}

/* ---------------- Settings ---------------- */
function renderSettings() {
  const r = store.rules;
  const theme = localStorage.getItem('nbac.theme') || 'system';
  const prefs = store.mode === 'live' ? store.myPrefs() : {};
  const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
  return `<section class="view" id="view-settings">
    <div class="section"><h3>Players</h3>
      ${store.mode === 'demo' ? `<div class="switch"><div class="lbl"><b>I am</b><span>Demo only: switch sides to make the other player's picks.</span></div><div class="seg"><button data-act="switchto" data-p="UP" class="${store.me === 'UP' ? 'on' : ''}" style="--me-color:var(--up)">${esc(name('UP'))}</button><button data-act="switchto" data-p="KP" class="${store.me === 'KP' ? 'on' : ''}" style="--me-color:var(--kp)">${esc(name('KP'))}</button></div></div>` : `<div class="switch"><div class="lbl"><b>Playing as ${esc(name(store.me))}</b><span>Signed in on this device.</span></div><div class="row"><button class="btn small" data-act="changepin">Change PIN</button><button class="btn small ghost" data-act="signout">Sign out</button></div></div>`}
      <div class="row"><div class="field grow"><label for="name-up">${PLAYER_CODES[0]} display name</label><input id="name-up" value="${esc(name('UP'))}" maxlength="16"></div><div class="field grow"><label for="name-kp">${PLAYER_CODES[1]} display name</label><input id="name-kp" value="${esc(name('KP'))}" maxlength="16"></div></div>
      <div><button class="btn small" data-act="savenames">Save names</button></div>
    </div>
    <div class="section"><h3>Notifications</h3>
      <div class="switch"><div class="lbl"><b>Push notifications on this device</b><span>${store.mode === 'live' ? 'Daily pick reminder, "line posted" alerts and the day\'s result. On iPhone, add the app to your Home Screen first.' : 'Available in live mode (deployed on Vercel with the API).'}</span></div><button class="sw" id="push-sw" data-act="togglepush" aria-pressed="false" ${store.mode === 'demo' ? 'disabled' : ''}></button></div>
      <div class="switch"><div class="lbl"><b>Morning message</b><span>Around 9 AM Mountain (11 AM Eastern): last night's result plus tonight's games and what you still owe.</span></div><button class="sw ${prefs.notify_results !== false ? 'on' : ''}" data-pref="notify_results" aria-pressed="${prefs.notify_results !== false}" ${store.mode === 'demo' ? 'disabled' : ''}></button></div>
      <div class="switch"><div class="lbl"><b>Line posted</b><span>The moment your brother posts a line, so you can call Over or Under.</span></div><button class="sw ${prefs.notify_lines !== false ? 'on' : ''}" data-pref="notify_lines" aria-pressed="${prefs.notify_lines !== false}" ${store.mode === 'demo' ? 'disabled' : ''}></button></div>
      ${store.mode === 'live' ? `<div class="row"><button class="btn small" data-act="saveprefs">Save notification settings</button><button class="btn small ghost" data-act="testpush">Send a test notification</button></div>` : ''}
    </div>
    <div class="section"><h3>House rules</h3>
      <div class="switch"><div class="lbl"><b>Push on the line</b><span>Margin lands exactly on the line.</span></div><select data-rule="push">${opt('nobody', r.push, 'Nobody scores')}${opt('selector', r.push, 'Selector scores (a push is a miss)')}</select></div>
      <div class="switch"><div class="lbl"><b>Half-point lines</b><span>Lines like 7.5 remove pushes entirely.</span></div><button class="sw ${r.halfPointLines ? 'on' : ''}" data-rule-toggle="halfPointLines" aria-pressed="${r.halfPointLines}"></button></div>
      <div class="switch"><div class="lbl"><b>Line never posted</b><span>The selector forgot to set a line.</span></div><select data-rule="noLine">${opt('responder', r.noLine, 'Other player scores')}${opt('nobody', r.noLine, 'Nobody scores')}</select></div>
      <div class="switch"><div class="lbl"><b>Line never answered</b><span>The other player never called Over/Under.</span></div><select data-rule="unansweredLine">${opt('selector', r.unansweredLine, 'Selector scores')}${opt('nobody', r.unansweredLine, 'Nobody scores')}</select></div>
      <div class="switch"><div class="lbl"><b>Show-up bonus</b><span>Points for picking on a day your brother skipped.</span></div><input type="number" min="0" max="10" step="1" data-rule-num="showUpBonus" value="${r.showUpBonus}"></div>
      <div class="switch"><div class="lbl"><b>Pick window</b><span>How many days ahead picks open.</span></div><input type="number" min="1" max="14" step="1" data-rule-num="pickWindowDays" value="${r.pickWindowDays}"></div>
      <div class="faint" style="font-size:12px">Rule changes apply to every game, including ones already scored. Agree on them together before the season starts.</div>
    </div>
    <div class="section"><h3>Appearance</h3>
      <div class="switch"><div class="lbl"><b>Theme</b></div><div class="seg"><button data-theme="system" class="${theme === 'system' ? 'on' : ''}">Auto</button><button data-theme="dark" class="${theme === 'dark' ? 'on' : ''}">Dark</button><button data-theme="light" class="${theme === 'light' ? 'on' : ''}">Light</button></div></div>
    </div>
    ${store.mode === 'demo' ? `<div class="section"><h3>Demo controls</h3>
      <div class="switch"><div class="lbl"><b>Advance the demo clock one day</b><span>Past games get simulated finals and random picks for both players.</span></div><button class="btn small" data-act="advance">Advance ⏩</button></div>
      <div class="switch"><div class="lbl"><b>Reset the demo</b><span>Clears all demo picks and results from this browser.</span></div><button class="btn small danger" data-act="reset">Reset</button></div>
    </div>` : ''}
    <div class="section"><h3>About</h3><dl class="kv"><dt>Mode</dt><dd>${store.mode === 'demo' ? `Demo (this browser only)${store.reason ? ' · API unreachable: ' + esc(store.reason) : ''}` : 'Live (Vercel API + Neon)'}</dd>${store.mode === 'demo' && store.scheduleNote ? `<dt>Schedule</dt><dd>${esc(store.scheduleNote)}</dd>` : ''}${store.mode === 'live' ? `<dt>Scores refresh</dt><dd>Once a day at 5:00 AM Mountain${store.lastScoresSync ? ` · last ${esc(new Date(store.lastScoresSync).toLocaleString())}` : ' · not run yet'}</dd><dt>Schedule synced</dt><dd>${store.lastScheduleSync ? esc(new Date(store.lastScheduleSync).toLocaleString()) : 'not yet'} · <button class="btn small ghost" data-act="loadschedule">Refresh from this device</button><span id="loadsched-status" class="faint"></span></dd>${store.lastSyncError ? `<dt>Last sync error</dt><dd style="color:var(--bad)">${esc(store.lastSyncError)}<br><span class="faint">${esc(new Date(store.lastSyncErrorAt).toLocaleString())}</span></dd>` : ''}` : ''}<dt>Season</dt><dd>${esc(CFG.SEASON)}</dd><dt>Games loaded</dt><dd>${store.games.size}</dd><dt>Next up</dt><dd>NBA Cup bracket · Playoff bracket</dd></dl></div>
  </section>`;
}

/* ---------------- Auth ---------------- */
function renderAuth() {
  ui.authPlayer = ui.authPlayer || (localStorage.getItem('nbac.lastPlayer') || 'UP');
  return `<div class="app"><main><div class="auth"><div class="brand"><h2>NBA Challenge</h2><span class="season">${esc(CFG.SEASON)} · ${esc(name('UP'))} vs ${esc(name('KP'))}</span></div>
    <form id="auth-form" class="section">
      <div class="field"><label>Who are you?</label><div class="tiles" role="radiogroup">${PLAYER_CODES.map(p => `<button type="button" class="tile ${p.toLowerCase()}" data-auth-player="${p}" role="radio" aria-checked="${ui.authPlayer === p}" style="align-items:center;${ui.authPlayer === p ? `outline:2px solid var(--${p.toLowerCase()});` : 'opacity:.6;'}"><span class="big num" style="font-size:40px">${esc(name(p))}</span></button>`).join('')}</div></div>
      ${store.needsPin?.has(ui.authPlayer)
        ? `<div class="notice info"><span class="ico">👋</span><div><strong>First time here.</strong> Create a PIN for ${esc(name(ui.authPlayer))} (4 to 8 digits). You'll use it to sign in on every device.</div></div>
           <div class="field"><label for="pin">New PIN</label><input id="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" autocomplete="new-password" maxlength="8" required placeholder="••••••"></div>
           <div class="field"><label for="pin2">Repeat PIN</label><input id="pin2" type="password" inputmode="numeric" pattern="[0-9]{4,8}" autocomplete="new-password" maxlength="8" required placeholder="••••••"></div>
           <button class="btn primary" type="submit">Create PIN and sign in</button>`
        : `<div class="field"><label for="pin">PIN</label><input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" maxlength="8" required placeholder="••••••"></div>
           <button class="btn primary" type="submit">Sign in</button>`}
      <div id="auth-err" style="font-size:13px;color:var(--bad)"></div></form>
    <div class="faint" style="font-size:12px;text-align:center">Two players, two PINs. You can change yours in Settings.</div></div></main></div>`;
}
function bindAuth() {
  $$('[data-auth-player]').forEach(b => b.onclick = () => { ui.authPlayer = b.dataset.authPlayer; render(); $('#pin')?.focus(); });
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault(); $('#auth-err').textContent = '';
    try {
      if (store.needsPin?.has(ui.authPlayer)) {
        if ($('#pin').value !== $('#pin2').value) throw new Error('The two PINs do not match.');
        await store.setupPin(ui.authPlayer, $('#pin').value.trim());
      } else await store.signIn(ui.authPlayer, $('#pin').value.trim());
      try { localStorage.setItem('nbac.lastPlayer', ui.authPlayer); } catch {}
    } catch (err) { $('#auth-err').textContent = err.message; }
  };
}
function pinBox() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal" role="dialog" aria-modal="true"><h3>Change PIN</h3>
    <div class="field"><label for="pin-cur">Current PIN</label><input id="pin-cur" type="password" inputmode="numeric" maxlength="8" required></div>
    <div class="field"><label for="pin-new">New PIN (4 to 8 digits)</label><input id="pin-new" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" required></div>
    <div id="pin-err" style="font-size:13px;color:var(--bad)"></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-no>Cancel</button><button type="submit" class="btn primary">Save PIN</button></div></form>`;
  bg.onclick = (e) => { if (e.target === bg || e.target.dataset.no != null) bg.remove(); };
  bg.querySelector('form').onsubmit = async (e) => { e.preventDefault(); try { await store.changePin($('#pin-cur', bg).value, $('#pin-new', bg).value); bg.remove(); toast('PIN changed'); } catch (err) { $('#pin-err', bg).textContent = err.message; } };
  document.body.appendChild(bg);
}

/* ---------------- events ---------------- */
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }
function bindGlobal() {
  $$('[data-view]').forEach(b => b.onclick = () => { ui.view = b.dataset.view; location.hash = ui.view; render(); window.scrollTo(0, 0); });
  $$('[data-act="switch"]').forEach(b => b.onclick = () => store.switchPlayer(otherPlayer(store.me)));
  $$('[data-act="advance"]').forEach(b => b.onclick = () => { store.advanceDay(); toast(`Demo clock: now ${fmtLong(etDate(store.now()))}`); });
  $$('[data-act="signout"]').forEach(b => b.onclick = () => store.signOut());
  $$('[data-act="loadschedule"]').forEach(b => b.onclick = () => guard(async () => {
    b.disabled = true; const st = $('#loadsched-status');
    try { const r = await store.loadScheduleFromBrowser(msg => { if (st) st.textContent = msg; }); toast(`Schedule loaded: ${r.inserted} new games`); }
    finally { b.disabled = false; }
  }));
}
function bindSlate() {
  $$('[data-date]').forEach(b => b.onclick = () => { ui.date = b.dataset.date; render(); });
  $$('.team[data-team]').forEach(b => b.onclick = () => guard(async () => {
    const cur = store.pickFor(b.dataset.game, store.me)?.winner;
    await store.setWinner(b.dataset.game, cur === b.dataset.team ? null : b.dataset.team);
    b.classList.add('pop');
  }));
  $$('[data-act="postline"]').forEach(b => b.onclick = () => guard(() => store.setLine(b.dataset.game, lastLine())));
  $$('[data-act="clearline"]').forEach(b => b.onclick = () => guard(() => { delete ui.pendingLine[b.dataset.game]; return store.setLine(b.dataset.game, null); }));
  $$('[data-act="line"]').forEach(b => b.onclick = () => {
    const id = b.dataset.game; const step = store.rules.halfPointLines ? 0.5 : 1;
    const cur = ui.pendingLine[id] ?? store.pickFor(id, store.me)?.line ?? lastLine();
    const next = Math.min(store.rules.lineMax, Math.max(store.rules.lineMin, cur + step * Number(b.dataset.d)));
    ui.pendingLine[id] = next;
    const val = b.parentElement.querySelector('.val'); if (val) val.textContent = next;
    const st = b.closest('.duel-row')?.querySelector('.status b'); if (st) st.textContent = next;
    b.parentElement.querySelector('[data-d="-1"]').disabled = next <= store.rules.lineMin; b.parentElement.querySelector('[data-d="1"]').disabled = next >= store.rules.lineMax;
    clearTimeout(ui.lineTimer[id]);
    ui.lineTimer[id] = setTimeout(() => guard(async () => { try { localStorage.setItem('nbac.lastLine', String(next)); } catch {} await store.setLine(id, next); delete ui.pendingLine[id]; }), 500);
  });
  $$('[data-act="call"]').forEach(b => b.onclick = () => guard(async () => {
    const cur = store.pickFor(b.dataset.game, store.me)?.ou;
    await store.setCall(b.dataset.game, cur === b.dataset.ou ? null : b.dataset.ou);
  }));
  $$('[data-expand]').forEach(b => b.onclick = () => { ui.expanded = ui.expanded === b.dataset.expand ? null : b.dataset.expand; render(); });
}
function lastLine() { try { const v = Number(localStorage.getItem('nbac.lastLine')); if (v) return v; } catch {} return 8; }
function bindSettings() {
  $$('[data-act="switchto"]').forEach(b => b.onclick = () => store.switchPlayer(b.dataset.p));
  $$('[data-act="changepin"]').forEach(b => b.onclick = () => pinBox());
  $$('[data-act="reset"]').forEach(b => b.onclick = () => confirmBox('Reset the demo?', 'All demo picks and simulated results in this browser will be cleared.', () => store.resetDemo()));
  $$('[data-act="savenames"]').forEach(b => b.onclick = () => guard(async () => { await store.setPlayerNames({ UP: $('#name-up').value.trim() || 'UP', KP: $('#name-kp').value.trim() || 'KP' }); toast('Names saved'); }));
  $$('[data-theme]').forEach(b => b.onclick = () => { applyTheme(b.dataset.theme); render(); });
  $$('[data-rule]').forEach(s => s.onchange = () => guard(() => store.setRules({ [s.dataset.rule]: s.value })));
  $$('[data-rule-toggle]').forEach(b => b.onclick = () => guard(() => store.setRules({ [b.dataset.ruleToggle]: !store.rules[b.dataset.ruleToggle] })));
  $$('[data-rule-num]').forEach(i => i.onchange = () => guard(() => store.setRules({ [i.dataset.ruleNum]: Math.max(+i.min, Math.min(+i.max, Number(i.value) || 0)) })));
  if (store.mode === 'live') {
    store.pushEnabled().then(on => { const sw = $('#push-sw'); if (sw) { sw.classList.toggle('on', on); sw.setAttribute('aria-pressed', on); } });
    $$('[data-act="togglepush"]').forEach(b => b.onclick = () => guard(async () => { if (b.classList.contains('on')) { await store.disablePush(); toast('Notifications off'); } else { await store.enablePush(); toast('Notifications on for this device'); } render(); }));
    $$('[data-pref]').forEach(b => b.onclick = () => { b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on')); });
    $$('[data-act="saveprefs"]').forEach(b => b.onclick = () => guard(async () => {
      const prefs = { tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
      $$('[data-pref]').forEach(x => prefs[x.dataset.pref] = x.classList.contains('on'));
      await store.savePrefs(prefs); toast('Reminder settings saved');
    }));
    $$('[data-act="testpush"]').forEach(b => b.onclick = () => guard(async () => { await store.sendTestPush(); toast('Test notification sent'); }));
  }
}
function applyTheme(t) {
  try { localStorage.setItem('nbac.theme', t); } catch {}
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}
async function guard(fn) { try { await fn(); } catch (e) { toast(e.message || String(e)); render(); } }
let toastTimer;
function toast(msg) { const t = $('#toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }
function confirmBox(title, body, onYes) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p class="muted" style="margin:0">${esc(body)}</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>Yes, do it</button></div></div>`;
  bg.onclick = (e) => { if (e.target === bg || e.target.dataset.no != null) bg.remove(); if (e.target.dataset.yes != null) { bg.remove(); onYes(); } };
  document.body.appendChild(bg);
}

boot();
