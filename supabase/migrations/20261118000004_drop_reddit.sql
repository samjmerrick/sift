-- Reddit blocks cloud servers and its API now needs approval, so Reddit sources are removed.
delete from sources where kind = 'reddit';
alter table sources drop constraint if exists sources_kind_check;
alter table sources add constraint sources_kind_check check (kind in ('rss', 'hn'));
