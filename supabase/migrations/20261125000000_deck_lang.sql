-- Decks carry their language (a BCP 47 tag such as 'ru', or '' when unknown) so the app can tag card text with it
-- for the right fonts, hyphenation and screen reader voice. feed_state() and deck_stats now include it.
alter table decks add column lang text not null default '' check (lang ~ '^([A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)?$');

-- Existing installs: decks whose card fronts are in Cyrillic were always tagged Russian; keep that.
update decks d set lang = 'ru'
where exists (select 1 from cards c where c.deck_id = d.id and c.front ~ '[А-Яа-яЁё]');

create or replace view deck_stats with (security_invoker = true) as
  select d.id, d.name, count(c.id) as cards, count(c.due) as studied, count(c.id) filter (where c.due <= now()) as due_now, d.lang
  from decks d left join cards c on c.deck_id = d.id
  group by d.id;

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
        'lang', d.lang,
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
