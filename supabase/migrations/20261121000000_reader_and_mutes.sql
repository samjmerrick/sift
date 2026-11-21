-- In-app reader cache and muted domains.
create table item_content (
  item_id bigint primary key references items(id) on delete cascade,
  status text not null check (status in ('ok', 'failed')),
  title text,
  byline text,
  site_name text,
  html text not null default '',
  text_length int not null default 0,
  lead_image text,
  error text,
  fetched_at timestamptz not null default now()
);

create table muted_domains (
  domain text primary key,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['item_content', 'muted_domains'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "owner only" on public.%I for all to authenticated using ((select private.is_owner())) with check ((select private.is_owner()))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- feed_state, now leaving out items from muted domains.
create or replace function feed_state(p_day_start timestamptz default date_trunc('day', now()))
returns jsonb
language sql stable security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'topics', (select coalesce(jsonb_agg(t order by t.position, t.id), '[]') from topics t),
    'sources', (select coalesce(jsonb_agg(s), '[]') from sources s),
    'generators', (select coalesce(jsonb_agg(g), '[]') from generators g where g.enabled),
    'items', (select coalesce(jsonb_agg(to_jsonb(i) - 'title_key' - 'fetched_at'), '[]') from (
        select i.* from items i join sources s on s.id = i.source_id
        where i.seen_at is null and s.enabled
          and not exists (select 1 from muted_domains m where m.domain = i.domain)
        order by i.published_at desc limit 1000) i),
    'affinity', (select coalesce(jsonb_agg(a), '[]') from (
        select source_id, domain, count(*) filter (where reaction = 1) as up, count(*) filter (where reaction = -1) as down
        from items where reaction <> 0 group by source_id, domain) a),
    'decks', (select coalesce(jsonb_object_agg(d.id, jsonb_build_object(
        'name', d.name,
        'introduced_today', (select count(*) from cards c where c.deck_id = d.id and c.introduced_at >= p_day_start),
        'due', (select coalesce(jsonb_agg(c order by c.due), '[]') from (
            select * from cards c where c.deck_id = d.id and c.due is not null and c.due <= now() + interval '12 hours'
            order by c.due limit 60) c),
        'new', (select coalesce(jsonb_agg(c order by c.position), '[]') from (
            select * from cards c where c.deck_id = d.id and c.due is null order by c.position limit 40) c)
      )), '{}') from decks d)
  );
$$;
grant execute on function feed_state(timestamptz) to authenticated;
revoke execute on function feed_state(timestamptz) from anon, public;
