-- Reading notes: a `notes` card type shows cards from a deck as plain reading material. feed_state() now hands the
-- app a random sample of cards (up to 30) for decks used by an enabled notes card type.
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
            select * from cards c where c.deck_id = d.id and c.due is null order by c.position limit 40) c),
        'sample', case when exists (select 1 from generators g where g.enabled and g.kind = 'notes' and g.config->>'deck_id' = d.id::text)
          then (select coalesce(jsonb_agg(c), '[]') from (select * from cards c where c.deck_id = d.id order by random() limit 30) c)
          else '[]'::jsonb end
      )), '{}') from decks d)
  );
$$;
grant execute on function feed_state(timestamptz) to authenticated;
revoke execute on function feed_state(timestamptz) from anon, public;

-- Existing installs: the machine learning starter's concept deck becomes reading material.
update generators g set kind = 'notes', config = jsonb_build_object('deck_id', g.config->'deck_id')
from decks d
where g.kind = 'flashcards' and d.id = (g.config->>'deck_id')::bigint and d.name = 'Machine learning concepts';
