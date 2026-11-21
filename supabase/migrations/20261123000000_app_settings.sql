-- Small key/value store for app-wide settings (e.g. the topic rank "falloff"). A missing key means "use the default".
create table app_settings (
  key text primary key,
  value jsonb not null
);

alter table public.app_settings enable row level security;
create policy "owner only" on public.app_settings for all to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
grant select, insert, update, delete on public.app_settings to authenticated;

-- Existing installs: seed the stack rank from the current weights, so the most-weighted topic starts at the top.
-- The app recomputes weights from rank and falloff the first time the Topics screen opens.
update topics t set position = r.rn - 1
from (select id, row_number() over (order by enabled desc, weight desc, position, id) as rn from topics) r
where r.id = t.id;
