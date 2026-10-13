-- Schedules the `tick` edge function. Run AFTER deploying the function and setting the
-- CRON_SECRET secret. Replace <PROJECT_REF> and <CRON_SECRET>.
--   scores:   every 10 minutes - today's/yesterday's scores, auto-lock/score, notifications
--   schedule: once a day at 09:00 UTC - full schedule refresh (new games, time changes, postponements)

select cron.unschedule(jobname) from cron.job where jobname in ('nbac-scores', 'nbac-schedule');

select cron.schedule('nbac-scores', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/tick?job=scores',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb)
$$);

select cron.schedule('nbac-schedule', '0 9 * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/tick?job=schedule',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb)
$$);
