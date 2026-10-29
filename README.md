# NBA Challenge

A two-player NBA pick'em for the 2026-27 regular season. It replaces the 24-25 spreadsheet with a
phone-friendly web app (installable like a native app) that locks picks at tip-off, scores every game
automatically, and sends push notifications so nobody forgets to pick.

**Stack:** static web app (no build step) + Vercel serverless API (`api/`) + Neon Postgres. Free tiers all round.

**Players:** UP vs KP (display names are editable in Settings).

## The game

Same scoring as the spreadsheet:

| Points | How |
|---|---|
| +1 | Pick the winner. |
| +1 | Win the **margin duel**. One player (the *selector*, alternating game by game) posts a line: the margin of victory. The other player calls **Over** or **Under**. Right call: the caller takes the point. Wrong call: the selector takes it. |
| +2 | **Show-up bonus** (new): make picks on a day your brother skips entirely and you bank +2. |

House rules you can toggle in Settings (both players see the same rules):

* **Push on the line** (margin lands exactly on the line): nobody scores *(the sheet's formula)*, or the selector scores.
  Last season had 13 pushes; 11 scored for nobody and 2 were hand-scored for the selector. Pick one and stick to it.
* **Half-point lines** (7.5): removes pushes altogether.
* **Line never posted**: the other player takes the duel point (if they picked that game), or nobody.
* **Line never answered**: the selector takes the point, or nobody.
* **Show-up bonus** amount and **pick window** (default: 14 days ahead).

Other mechanics:

* Picks lock **per game at tip-off**. Scores and points arrive in one batch at **5 AM Mountain** the next morning (one feed request per game day, nothing in between).
* A line **freezes once it has been answered**, so the selector can't move it after seeing the call.
* Your winner pick is **hidden from your brother until tip-off** (the line and the call are always visible, they have to be).
* **NBA Cup group and knockout games count like any other game** (they carry a Cup label on the slate). The Cup final is not a regular-season game: it shows on the slate but is decided in the **Cup bracket** (below), not scored in the Challenge. Postponed games drop out and come back on their new date.
* The **Monday check** (part of the 5 AM batch) re-reads the schedule: moved tip-offs, postponements and cancellations. From the end of Cup group play until the Cup final it runs **daily**, so the quarterfinal and semifinal matchups land in the app as soon as the NBA schedules them. Feeds label Cup games (NBA.com's `gameSubLabel`, ESPN's event notes); groups themselves are derived from who plays whom.

### The Cup bracket (side game)

The **Cup** tab follows the NBA Cup. During November it shows the six groups with live standings (record, point differential, who is in a wildcard spot). Once the four quarterfinals are on the schedule the **bracket opens**: each player picks all four quarterfinals, both conference semifinals and the champion. A semifinal pick must be one of your own quarterfinal winners, the champion one of your finalists (changing an earlier pick clears what depended on it). The whole bracket **locks at the first quarterfinal tip-off**, and your brother's bracket is hidden until then.

| Bracket points | For |
|---|---|
| +1 | each correct quarterfinal |
| +2 | each correct semifinal |
| +3 | the champion |

Bracket points are a separate tally shown on the Cup tab (and in the Cup tile on the bracket); they do not count toward the season score. Picks are saved through `/api/cup` into the `cup_picks` table; the morning message mentions an unfinished bracket while it is open.

## What's in the app

* **Slate**: a strip from yesterday through two weeks ahead with a progress bar per day, then one card per game: tap a team to pick the winner, post or adjust your line with the stepper, or call Over/Under. Cards show lock countdowns, live scores, final margins and who earned what.
* **Cup**: NBA Cup group standings, then the knockout bracket with both players' picks, results and bracket points. The tab badge counts the bracket picks you still owe while it is open.
* **Play-In** and **Playoffs**: placeholders for the postseason brackets (coming soon, under development).
* **Standings**: season score tiles, the cumulative "race" chart, and stats (days won, streaks, winner %, Over/Under %, lines defended, bonuses, perfect days, best day). A toggle shows **last season's** full numbers from the spreadsheet (UP 290, KP 267).
* **History**: every completed day with the day score; tap to expand the games.
* **Settings**: names, PIN, notifications (daily reminder time, pre-tip nudge, "line posted" alerts, nightly result), house rules, theme.

## Running it

### Demo mode (no setup)

Open the app with `?demo=1` (or from any static host without the API) and it runs entirely in that browser: a demo clock set to a mid-season day, simulated results behind it, and a player switch in the header so you can play both sides. **Advance a day** plays out the next day. If `data/schedule-2026-27.json` exists (see below) the demo uses the real schedule, otherwise a sample slate. The sample has the Cup group games but no knockout games, so the demo invents the quarterfinals, semifinals and final from the simulated group standings once group play is over (advance past Dec 1 to see the bracket open).

### Live mode (Vercel + Neon)

Already done: the Neon project **NBA Challenge** (`quiet-flower-84539406`, database `nba`) exists with the schema from `db/schema.sql` applied. Each player creates their own PIN the first time they sign in (do that right after deploying, before sharing the URL). Later additive schema changes (the `cup_stage` column and the `cup_picks` table) are applied by the API itself on first use (`lib/db.js` `migrate()`), so a redeploy needs no manual migration.

1. **Deploy on Vercel**: vercel.com → *Add New Project* → import `despite-the-finite/NBA-Challenge` → Framework preset **Other**, no build command, output directory blank → add the environment variables below → Deploy. Every push to `main` redeploys.

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon connection string: Neon console → project *NBA Challenge* → **Connect** → copy the pooled connection string |
   | `CRON_SECRET` | any long random passphrase you make up (protects `/api/tick`; also goes into the GitHub Actions secret) |
   | `VAPID_SUBJECT` | optional, `mailto:you@example.com` (contact address attached to push messages) |

   The login-cookie secret and the push (VAPID) keys are generated by the server on first use and kept in the database, so there is nothing else to paste. Set `SESSION_SECRET`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` only if you want to supply your own.

2. **Load the schedule**: nothing to do. The first time anyone signs in on an empty database, the app pulls the official NBA.com schedule (ESPN as fallback) once and assigns selectors. To force a refresh by hand:
   ```sh
   curl "https://<your-app>.vercel.app/api/tick?job=daily&force=1" -H "Authorization: Bearer <CRON_SECRET>"
   ```
   No internet on the server? Download `https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json` in a browser and run `DATABASE_URL=... node tools/import_schedule.mjs scheduleLeagueV2_1.json --db`.

3. **The 5 AM Mountain batch** runs by itself: `vercel.json` schedules `/api/tick?job=daily` at 12:00 UTC, which is 5 AM Mountain (6 AM during daylight saving, i.e. the first two weeks and the last month of the season). It scores every game that has tipped off (normally one feed request, for yesterday), marks postponed games, and refreshes the schedule once a week (Mondays). Feeds are tried in order: NBA.com, ESPN scoreboard, ESPN per-team schedules; Settings → About also offers "Refresh from this device", which fetches the schedule in your browser and hands it to the server. Nothing touches the NBA feeds at any other time, and opening the app never triggers a fetch.

   **The morning message** is the second cron, `/api/tick?job=morning` at 16:00 UTC (9 AM Mountain, 11 AM Eastern). It reads the database and sends one push to each of you; it never calls the feeds. Vercel's free plan allows exactly these two daily crons, so there is no other scheduler, no GitHub workflow, nothing else to configure.

4. **On each phone**: open the app URL, pick your name, create (then later enter) your PIN, add it to the Home Screen (iPhone: Share → *Add to Home Screen*; Android: *Install app*), open it from the Home Screen, then Settings → turn on push notifications. iPhone only delivers web push to Home Screen apps. Change your PIN in Settings.

## Notifications you will get

* **Morning message** around 9 AM Mountain / 11 AM Eastern: last night's result (scored in the 5 AM batch) plus tonight's games, how many picks you still owe, and any lines waiting for your call.
* **Line posted**: the moment your brother posts a line you haven't answered.

## Project layout

```
index.html, css/app.css, js/app.js      the app (plain ES modules, no build step)
js/scoring.js                           the scoring engine (pure functions, shared with the API)
js/cup.js                               NBA Cup: groups from the schedule, standings, knockout bracket, bracket picks and points
js/store.js                             demo store (localStorage) and live store (fetches /api)
js/teams.js                             team codes, names, colors, logo URLs
config.js                               API path and player defaults
sw.js, manifest.webmanifest, icons/     PWA install + push
api/auth.js                             sign in with player + PIN (signed cookie), change PIN
api/state.js                            league state, delta polling, hides opponent picks until tip-off
api/pick.js                             save a winner / line / call with every rule enforced
api/cup.js                              save a Cup bracket (validated, locked at the first quarterfinal tip-off)
api/settings.js, api/push.js            rules, names, reminder prefs, push subscriptions
api/tick.js                             cron entry: the 5 AM batch and the morning message
lib/feeds.js                            NBA.com and ESPN feed parsers (one normalized shape)
lib/league.js                           sync + notification logic;  lib/notify.js web push;  lib/auth.js sessions
db/schema.sql                           Neon schema
data/season-2024-25.json                last season, from the spreadsheet
data/sample-schedule.json               demo slate (data/schedule-2026-27.json replaces it once imported)
tools/prep_data.py                      rebuilds the data files from the spreadsheet
tools/import_schedule.mjs               imports a downloaded NBA.com schedule file
tools/test_scoring.mjs, tools/test_api.mjs, tools/test_cup.mjs   npm test
```

## Roadmap

* Playoff bracket (series winners and games-in-series).
* Weekly recap notification and a "rivalry" page (each player's best and worst teams to pick).
