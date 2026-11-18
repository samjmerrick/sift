-- Move the owner check out of the API-exposed schema (it was callable as /rest/v1/rpc/is_owner),
-- and index the remaining foreign keys. Flagged by Supabase's security/performance advisors.
create schema if not exists private;
grant usage on schema private to authenticated;

create function private.is_owner() returns boolean
language sql stable security definer
set search_path = ''
as $$ select exists (select 1 from public.app_owner where user_id = auth.uid()) $$;
revoke execute on function private.is_owner() from public, anon;
grant execute on function private.is_owner() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['topics', 'sources', 'items', 'generators', 'decks', 'cards', 'saved_cards'] loop
    execute format('drop policy "owner only" on public.%I', t);
    execute format('create policy "owner only" on public.%I for all to authenticated using ((select private.is_owner())) with check ((select private.is_owner()))', t);
  end loop;
end $$;

drop function public.is_owner();

create index if not exists generators_topic on public.generators (topic_id);
create index if not exists sources_topic on public.sources (topic_id);
create index if not exists saved_cards_topic on public.saved_cards (topic_id);
