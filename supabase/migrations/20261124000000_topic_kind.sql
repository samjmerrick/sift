-- A topic is either for reading (articles from sources) or for practice (generated cards), never both.
alter table topics add column kind text not null default 'articles' check (kind in ('articles', 'cards'));

create schema if not exists private;

-- Topics with card types but no sources become card topics; topics with both are split: the original keeps its
-- sources and articles, and a new "<name> practice" topic (placed right after it) takes the card types and saved cards.
create or replace function private.split_mixed_topics() returns int
language plpgsql set search_path = public as $$
declare
  t record;
  new_id bigint;
  new_name text;
  n int;
  split int := 0;
begin
  update topics tp set kind = 'cards'
  where tp.kind = 'articles'
    and exists (select 1 from generators g where g.topic_id = tp.id)
    and not exists (select 1 from sources s where s.topic_id = tp.id);

  for t in
    select * from topics tp
    where tp.kind = 'articles'
      and exists (select 1 from generators g where g.topic_id = tp.id)
      and exists (select 1 from sources s where s.topic_id = tp.id)
    order by tp.position, tp.id
  loop
    new_name := t.name || ' practice';
    n := 1;
    while exists (select 1 from topics where name = new_name) loop
      n := n + 1;
      new_name := t.name || ' practice ' || n;
    end loop;

    update topics set position = position + 1 where position > t.position;
    insert into topics (name, color, weight, enabled, position, kind)
    values (new_name, t.color, t.weight, t.enabled, t.position + 1, 'cards')
    returning id into new_id;

    update generators set topic_id = new_id where topic_id = t.id;
    update saved_cards set topic_id = new_id where topic_id = t.id;
    split := split + 1;
  end loop;
  return split;
end $$;
revoke execute on function private.split_mixed_topics() from public, anon, authenticated;

select private.split_mixed_topics();

alter table topics drop column curated_ratio;
