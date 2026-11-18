-- Hourly fetch inside Supabase: pg_cron calls the sift-fetch Edge Function via pg_net, authenticated with a
-- random secret that is generated here and kept in Vault (it never leaves the project).
-- After applying, run once:  select private.schedule_fetch('https://<project-ref>.supabase.co');
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end $$;

create function private.schedule_fetch(project_url text, schedule text default '17 * * * *')
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from vault.secrets where name = 'sift_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'sift_cron_secret', 'Sift: hourly fetch job → sift-fetch function');
  end if;
  if exists (select 1 from vault.secrets where name = 'sift_project_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'sift_project_url'), rtrim(project_url, '/'));
  else
    perform vault.create_secret(rtrim(project_url, '/'), 'sift_project_url', 'Sift: project URL for the fetch job');
  end if;
  perform cron.schedule('sift-fetch', schedule, $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'sift_project_url') || '/functions/v1/sift-fetch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sift_cron_secret')),
      body := '{"action":"cron"}'::jsonb,
      timeout_milliseconds := 150000);
  $job$);
  return 'scheduled sift-fetch: ' || schedule;
end $$;
revoke execute on function private.schedule_fetch(text, text) from public, anon, authenticated;
