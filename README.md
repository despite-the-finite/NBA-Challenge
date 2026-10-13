# NBA Challenge

A two-player NBA pick'em for the 2026-27 regular season. It replaces the 24-25 spreadsheet with a
phone-friendly web app (installable like a native app) that locks picks at tip-off, scores every game
automatically, and sends push notifications so nobody forgets to pick.

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
* **Show-up bonus** amount and **pick window** (default: 7 days ahead).

Other mechanics:

* Picks lock **per game at tip-off**. Scores and points fill in automatically after the final buzzer.
* A line **freezes once it has been answered**, so the selector can't move it after seeing the call.
* Your winner pick is **hidden from your brother until tip-off** (the line and the call are always visible, they have to be).
* Days with NBA Cup group/knockout games count as regular-season games (the Cup final does not).

## What's in the app

* **Slate**: a 9-day strip (yesterday through a week ahead) with a progress bar per day, then one card per game: tap a team to pick the winner, post or adjust your line with the stepper, or call Over/Under. Cards show lock countdowns, live scores, final margins and who earned what.
* **Standings**: season score tiles, the cumulative "race" chart, and stats (days won, streaks, winner %, Over/Under %, lines defended, bonuses, perfect days, best day). A toggle shows **last season's** full numbers from the spreadsheet (UP 290, KP 267).
* **History**: every completed day with the day score; tap to expand the games.
* **Settings**: names, notifications (daily reminder time, pre-tip nudge, "line posted" alerts, nightly result), house rules, theme.

## Two ways to run it

### 1. Demo mode (right now, no setup)

Open `index.html` from any static host (GitHub Pages works). With no Supabase values in `config.js` the app runs in **demo mode**: a sample 2026-27 slate (last season's matchups shifted into this season), a demo clock set to a mid-season day, simulated results behind it, and a player switch in the header so you can play both sides. Everything is saved in that browser only. Use **Advance a day** to watch locking, scoring and the show-up bonus work.

### 2. Live mode (both brothers, real schedule, real scores, push notifications)

Free tier is plenty. One-time setup, about 30 minutes:

1. **Host the app**: GitHub → repo Settings → Pages → Deploy from branch `main`, folder `/ (root)`. Your app URL will be `https://<you>.github.io/NBA-Challenge/`. (Any static host works; it must be HTTPS for push.)
2. **Create a Supabase project** (supabase.com, free). Note the Project URL and anon key (Project Settings → API).
3. **Database**: SQL Editor → paste and run `supabase/schema.sql`.
4. **Accounts**: Authentication → Users → *Add user* twice (one email + password per brother, tick *Auto confirm*). Then run the two `update players …` lines at the bottom of `schema.sql` with the real emails.
5. **Push keys**: on any computer run `npx web-push generate-vapid-keys`. Keep both keys.
6. **Deploy the sync function** (Supabase CLI, `npm i -g supabase`):
   ```sh
   supabase login
   supabase link --project-ref <PROJECT_REF>
   supabase secrets set CRON_SECRET=<long random string> VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> VAPID_SUBJECT=mailto:<your email>
   supabase functions deploy tick
   ```
   Then run `supabase/cron.sql` in the SQL Editor after filling in `<PROJECT_REF>` and `<CRON_SECRET>`. The function then runs every 10 minutes (scores, locking, notifications) and once a day (schedule refresh).
   Kick it once by hand so the schedule loads: `curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/tick?job=schedule" -H "x-cron-secret: <CRON_SECRET>"`.
7. **Point the app at it**: edit `config.js` with `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `VAPID_PUBLIC_KEY`, commit, push.
8. **On each phone**: open the app URL, sign in, add it to the Home Screen (iPhone: Share → *Add to Home Screen*; Android: *Install app*), open it from the Home Screen, then Settings → turn on push notifications. iPhone only delivers web push to Home Screen apps.

Scores and the schedule come from ESPN's public scoreboard feed (no API key). If ESPN changes its feed, only `parseEvent` in `supabase/functions/tick/index.ts` needs updating.

## Notifications you will get

* **Daily reminder** at your chosen local time, only on days you still have open picks ("7 games tonight, 3 still need your input. Skip the day and KP banks +2.").
* **60-minute nudge** before the first tip if picks are still missing.
* **Line posted**: when your brother posts a line you haven't answered.
* **Nightly result**: who took the day, once every game is final.

## Project layout

```
index.html, css/app.css, js/app.js      the app (no build step, plain ES modules)
js/scoring.js                           the scoring engine (pure functions, shared with the server)
js/store.js                             demo store (localStorage) and live store (Supabase)
js/teams.js                             team codes, names, colors, logo URLs
config.js                               Supabase / VAPID values (empty = demo mode)
sw.js, manifest.webmanifest, icons/     PWA install + push
data/season-2024-25.json                last season, from the spreadsheet
data/sample-schedule.json               demo slate (replaced by the real schedule in live mode)
supabase/schema.sql                     tables, rules enforced in the database, row-level security
supabase/functions/tick/index.ts        schedule + score sync, auto-scoring, push notifications
supabase/cron.sql                       the two cron jobs
tools/prep_data.py                      rebuilds the data files from the spreadsheet
tools/test_scoring.mjs                  replays the 24-25 sheet through the engine (node tools/test_scoring.mjs)
tools/check-shared.sh                   keeps the server copy of scoring.js in sync
```

## Roadmap

* NBA Cup bracket (knockout picks, with the group-stage games already flagged in the slate).
* Playoff bracket (series winners and games-in-series).
* Weekly recap notification and a "rivalry" page (each player's best and worst teams to pick).
