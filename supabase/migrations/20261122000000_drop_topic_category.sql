-- Topic categories are gone: topics are the only top-level filter. feed_state() returns whole topic rows, so
-- nothing else reads this column.
alter table topics drop column if exists category;
