-- NBA Challenge database. Run this once in the Supabase SQL editor (Dashboard -> SQL -> New query).
-- Everything below is safe to re-run.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- players ----------
create table if not exists players (
  code            text primary key check (code in ('UP','KP')),
  name            text not null,
  color           text,
  auth_user_id    uuid unique references auth.users(id) on delete set null,
  tz              text not null default 'America/New_York',
  reminder_time   time not null default '11:00',
  notify_pretip   boolean not null default true,
  notify_lines    boolean not null default true,
  notify_results  boolean not null default true
);
insert into players (code, name, color) values ('UP','UP','#4f8cff'), ('KP','KP','#ff7a1a') on conflict (code) do nothing;

-- ---------- league settings (one row) ----------
create table if not exists settings (
  id     int primary key default 1 check (id = 1),
  rules  jsonb not null default '{}'::jsonb,
  season text not null default '2026-27'
);
insert into settings (id) values (1) on conflict do nothing;

-- ---------- games (synced from the schedule feed by the `tick` function) ----------
create table if not exists games (
  id          text primary key,                  -- 'espn:<eventId>'
  date        date not null,                     -- game date in US Eastern time
  tipoff      timestamptz not null,
  home        text not null,
  away        text not null,
  arena       text,
  cup         boolean not null default false,    -- NBA Cup group/knockout game (still regular season)
  selector    text not null check (selector in ('UP','KP')),
  status      text not null default 'scheduled' check (status in ('scheduled','live','final','postponed')),
  home_score  int,
  away_score  int,
  clock       text,
  final_at    timestamptz,
  updated_at  timestamptz not null default now()
);
create index if not exists games_date_idx on games(date);
create index if not exists games_tipoff_idx on games(tipoff);

-- ---------- picks ----------
-- Winner picks are private until tip-off (so nobody copies the other's pick).
create table if not exists winner_picks (
  game_id     text not null references games(id) on delete cascade,
  player_code text not null references players(code),
  winner      text not null,
  updated_at  timestamptz not null default now(),
  primary key (game_id, player_code)
);
-- The duel: the selector's line and the responder's Over/Under call. Always visible to both.
create table if not exists duel_picks (
  game_id     text not null references games(id) on delete cascade,
  player_code text not null references players(code),
  line        numeric(4,1),
  ou          text check (ou in ('O','U')),
  updated_at  timestamptz not null default now(),
  primary key (game_id, player_code)
);

create table if not exists push_subscriptions (
  endpoint    text primary key,
  player_code text not null references players(code),
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

-- Dedupes notifications: one row per (kind, target) ever sent.
create table if not exists notifications_log (
  key      text primary key,
  sent_at  timestamptz not null default now()
);

-- ---------- helpers ----------
create or replace function my_player_code() returns text language sql stable security definer set search_path = public as $$
  select code from players where auth_user_id = auth.uid()
$$;

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists winner_picks_touch on winner_picks;
create trigger winner_picks_touch before update on winner_picks for each row execute function touch_updated_at();
drop trigger if exists duel_picks_touch on duel_picks;
create trigger duel_picks_touch before update on duel_picks for each row execute function touch_updated_at();

-- Game rules enforced in the database, so they hold even if a client misbehaves:
--   * a pick can only be made before tip-off and within the pick window
--   * only the selector sets a line, only the responder calls Over/Under
--   * a call needs a posted line; a line freezes once it has been answered
--   * the winner must be one of the two teams
create or replace function check_pick_window() returns trigger language plpgsql security definer set search_path = public as $$
declare g games%rowtype; window_days int;
begin
  select * into g from games where id = coalesce(new.game_id, old.game_id);
  if g.id is null then raise exception 'unknown game'; end if;
  if g.tipoff <= now() then raise exception 'This game is locked (tipped off at %).', g.tipoff; end if;
  select coalesce((rules->>'pickWindowDays')::int, 7) into window_days from settings where id = 1;
  if g.tipoff > now() + make_interval(days => window_days) then raise exception 'Picks for this game open % days before tip-off.', window_days; end if;
  if tg_table_name = 'winner_picks' and tg_op <> 'DELETE' then
    if new.winner not in (g.home, g.away) then raise exception 'Winner must be % or %.', g.home, g.away; end if;
  end if;
  if tg_table_name = 'duel_picks' then
    if tg_op <> 'DELETE' then
      if new.player_code = g.selector then
        if new.ou is not null then raise exception 'The selector does not call Over/Under.'; end if;
        if exists (select 1 from duel_picks d where d.game_id = g.id and d.player_code <> g.selector and d.ou is not null)
           and (tg_op = 'INSERT' or new.line is distinct from old.line) then
          raise exception 'The line is frozen once it has been answered.';
        end if;
      else
        if new.line is not null then raise exception 'Only the selector (%) sets the line.', g.selector; end if;
        if new.ou is not null and not exists (select 1 from duel_picks d where d.game_id = g.id and d.player_code = g.selector and d.line is not null) then
          raise exception 'No line has been posted yet.';
        end if;
      end if;
    elsif old.player_code = g.selector and exists (select 1 from duel_picks d where d.game_id = g.id and d.player_code <> g.selector and d.ou is not null) then
      raise exception 'The line is frozen once it has been answered.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists winner_picks_guard on winner_picks;
create trigger winner_picks_guard before insert or update or delete on winner_picks for each row execute function check_pick_window();
drop trigger if exists duel_picks_guard on duel_picks;
create trigger duel_picks_guard before insert or update or delete on duel_picks for each row execute function check_pick_window();

-- Who has picked a winner (without revealing which team) so the app can show "KP has picked".
create or replace view pick_status with (security_invoker = false) as
  select game_id, player_code from winner_picks;
grant select on pick_status to authenticated;

-- ---------- row level security ----------
alter table players enable row level security;
alter table settings enable row level security;
alter table games enable row level security;
alter table winner_picks enable row level security;
alter table duel_picks enable row level security;
alter table push_subscriptions enable row level security;
alter table notifications_log enable row level security;

drop policy if exists players_read on players;      create policy players_read on players for select to authenticated using (true);
drop policy if exists players_update on players;    create policy players_update on players for update to authenticated using (true) with check (true);
drop policy if exists settings_read on settings;    create policy settings_read on settings for select to authenticated using (true);
drop policy if exists settings_write on settings;   create policy settings_write on settings for all to authenticated using (my_player_code() is not null) with check (my_player_code() is not null);
drop policy if exists games_read on games;          create policy games_read on games for select to authenticated using (true);
-- winner picks: your own always; the other player's only after tip-off
drop policy if exists winner_read on winner_picks;  create policy winner_read on winner_picks for select to authenticated
  using (player_code = my_player_code() or exists (select 1 from games g where g.id = game_id and g.tipoff <= now()));
drop policy if exists winner_write on winner_picks; create policy winner_write on winner_picks for all to authenticated
  using (player_code = my_player_code()) with check (player_code = my_player_code());
drop policy if exists duel_read on duel_picks;      create policy duel_read on duel_picks for select to authenticated using (true);
drop policy if exists duel_write on duel_picks;     create policy duel_write on duel_picks for all to authenticated
  using (player_code = my_player_code()) with check (player_code = my_player_code());
drop policy if exists push_own on push_subscriptions; create policy push_own on push_subscriptions for all to authenticated
  using (player_code = my_player_code()) with check (player_code = my_player_code());

-- Realtime: the app listens for the other player's lines, calls and locked picks, and for scores.
do $$ begin
  begin alter publication supabase_realtime add table games; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table winner_picks; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table duel_picks; exception when duplicate_object then null; end;
end $$;

-- ---------- link the two accounts to the two players ----------
-- 1. Dashboard -> Authentication -> Users -> "Add user" for each brother (tick "Auto confirm").
-- 2. Then run (with the real emails):
-- update players set auth_user_id = (select id from auth.users where email = 'up@example.com')  where code = 'UP';
-- update players set auth_user_id = (select id from auth.users where email = 'kp@example.com')  where code = 'KP';
