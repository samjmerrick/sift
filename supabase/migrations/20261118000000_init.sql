-- Sift schema. Single-user: every table is readable/writable by any *authenticated* user and nobody else,
-- so disable public sign-ups in Supabase (Authentication → Sign In / Providers) and create just your own user.

create table topics (
  id bigint generated always as identity primary key,
  name text not null,
  color text not null default '#6b7280',
  weight real not null default 1,           -- share of the feed
  curated_ratio real not null default 0.6,  -- chance a slot is an article (vs practice card) when articles exist
  enabled boolean not null default true,
  position int not null default 0
);

create table sources (
  id bigint generated always as identity primary key,
  topic_id bigint not null references topics(id) on delete cascade,
  kind text not null check (kind in ('rss', 'hn', 'reddit')),
  name text not null,
  config jsonb not null default '{}',
  include text not null default '',         -- comma-separated keywords; at least one must match (if set)
  exclude text not null default '',         -- comma-separated keywords; none may match
  weight real not null default 1,
  enabled boolean not null default true,
  last_fetched timestamptz,
  last_error text
);

create table items (
  id bigint generated always as identity primary key,
  source_id bigint not null references sources(id) on delete cascade,
  topic_id bigint not null references topics(id) on delete cascade,
  url text not null unique,
  title text not null,
  title_key text not null,
  summary text not null default '',
  image text,
  domain text,
  comments_url text,
  community_score int,
  comment_count int,
  published_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  seen_at timestamptz,
  reaction smallint not null default 0 check (reaction in (-1, 0, 1)),
  saved_at timestamptz
);
create index items_unseen on items (topic_id, published_at desc) where seen_at is null;
create index items_title_key on items (title_key);
create index items_source on items (source_id);

create table generators (
  id bigint generated always as identity primary key,
  topic_id bigint not null references topics(id) on delete cascade,
  kind text not null,
  name text not null,
  config jsonb not null default '{}',
  weight real not null default 1,
  enabled boolean not null default true
);

create table decks (
  id bigint generated always as identity primary key,
  name text not null
);

create table cards (
  id bigint generated always as identity primary key,
  deck_id bigint not null references decks(id) on delete cascade,
  front text not null,
  back text not null,
  note text not null default '',
  position int not null default 0,
  due timestamptz,                          -- null = never studied
  interval_days real not null default 0,
  ease real not null default 2.5,
  reps int not null default 0,
  lapses int not null default 0,
  introduced_at timestamptz
);
create index cards_due on cards (deck_id, due);

create table saved_cards (
  id bigint generated always as identity primary key,
  topic_id bigint references topics(id) on delete set null,
  payload jsonb not null,
  saved_at timestamptz not null default now()
);

-- Row level security: signed-in user only.
do $$
declare t text;
begin
  foreach t in array array['topics', 'sources', 'items', 'generators', 'decks', 'cards', 'saved_cards'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "owner only" on %I for all to authenticated using (true) with check (true)', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- Views (security_invoker so RLS applies to the caller).
create view source_stats with (security_invoker = true) as
  select s.*,
    (select count(*) from items i where i.source_id = s.id) as item_count,
    (select count(*) from items i where i.source_id = s.id and i.seen_at is null) as unseen_count
  from sources s;

create view deck_stats with (security_invoker = true) as
  select d.id, d.name, count(c.id) as cards, count(c.due) as studied, count(c.id) filter (where c.due <= now()) as due_now
  from decks d left join cards c on c.deck_id = d.id
  group by d.id;

create view saved_items with (security_invoker = true) as
  select i.*, s.name as source_name from items i join sources s on s.id = i.source_id where i.saved_at is not null;

grant select on source_stats, deck_stats, saved_items to authenticated;

-- Everything the feed needs in one round trip: config, unread articles, your reaction history, and
-- each deck's review queue. p_day_start is the start of "today" in your timezone (for new-card limits).
create function feed_state(p_day_start timestamptz default date_trunc('day', now()))
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
