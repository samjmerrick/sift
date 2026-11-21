-- Small key/value store for app-wide settings (e.g. the topic rank "falloff"). A missing key means "use the default".
create table app_settings (
  key text primary key,
  value jsonb not null
);

alter table public.app_settings enable row level security;
create policy "owner only" on public.app_settings for all to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
grant select, insert, update, delete on public.app_settings to authenticated;
