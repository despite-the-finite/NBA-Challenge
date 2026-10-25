-- NBA Challenge database (Neon Postgres). Applied once; safe to re-run.
-- The Vercel API is the only client, connecting as the database owner, so access rules live in
-- the API (lib/*.js) and this file holds the data model and integrity constraints.

create table if not exists players (
  code            text primary key check (code in ('UP','KP')),
  name            text not null,
  color           text,
  pin_hash        text,                       -- scrypt hash of the sign-in PIN (null until the player creates one)
  pin_salt        text,
  failed_pins     int  not null default 0,
  locked_until    timestamptz,
  tz              text not null default 'America/New_York',
  reminder_time   text not null default '11:00',
  notify_pretip   boolean not null default true,
  notify_lines    boolean not null default true,
  notify_results  boolean not null default true
);
insert into players (code, name, color) values ('UP','UP','#4f8cff'), ('KP','KP','#ff7a1a') on conflict (code) do nothing;

create table if not exists settings (
  id                  int primary key default 1 check (id = 1),
  rules               jsonb not null default '{}'::jsonb,
  season              text not null default '2026-27',
  last_scores_sync    timestamptz,
  last_schedule_sync  timestamptz,
  session_secret      text,     -- generated on first use (signs login cookies)
  vapid_public        text,     -- generated on first use (web push keys)
  vapid_private       text,
  last_sync_error     text,     -- most recent feed/sync failure, shown in Settings -> About
  last_sync_error_at  timestamptz
);
alter table settings add column if not exists last_sync_error text, add column if not exists last_sync_error_at timestamptz;
alter table settings add column if not exists session_secret text, add column if not exists vapid_public text, add column if not exists vapid_private text;
insert into settings (id) values (1) on conflict do nothing;

-- One row per regular-season game. id is a natural key, 'g:YYYYMMDD-AWAY-HOME' (ET date), so
-- schedule and score feeds from different providers line up.
create table if not exists games (
  id          text primary key,
  date        date not null,
  tipoff      timestamptz not null,
  home        text not null,
  away        text not null,
  arena       text,
  cup         boolean not null default false,
  cup_stage   text,                              -- NBA Cup label from the feed when it has one: 'East A', 'QF', 'SF', 'F'
  selector    text not null check (selector in ('UP','KP')),
  status      text not null default 'scheduled' check (status in ('scheduled','live','final','postponed')),
  home_score  int,
  away_score  int,
  clock       text,
  source_ids  jsonb not null default '{}'::jsonb,   -- {"nba":"0022600001","espn":"401..."}
  final_at    timestamptz,
  updated_at  timestamptz not null default now()
);
alter table games add column if not exists cup_stage text;
create index if not exists games_date_idx on games(date);
create index if not exists games_updated_idx on games(updated_at);

-- A player's picks for a game. Cleared values are nulls (rows are never deleted) so that
-- clients polling for changes see the clearing too.
create table if not exists picks (
  game_id     text not null references games(id) on delete cascade,
  player_code text not null references players(code),
  winner      text,
  line        numeric(4,1),
  ou          text check (ou in ('O','U')),
  updated_at  timestamptz not null default now(),
  primary key (game_id, player_code)
);
create index if not exists picks_updated_idx on picks(updated_at);

-- The NBA Cup bracket side game: one row per player, picks = { "<quarterfinal game id>": team, "SF-East": team,
-- "SF-West": team, "F": team }. Validated and locked (first quarterfinal tip-off) by api/cup.js.
create table if not exists cup_picks (
  player_code text primary key references players(code),
  picks       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists push_subscriptions (
  endpoint    text primary key,
  player_code text not null references players(code),
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create table if not exists notifications_log (
  key      text primary key,
  sent_at  timestamptz not null default now()
);
