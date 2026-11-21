-- Settings → Domains: one row per site your articles link to, with counts and whether it is muted. Muted domains
-- with no items are included too, so they can still be unmuted.
create view domain_stats with (security_invoker = true) as
  select d.domain,
    coalesce(i.total, 0) as total,
    coalesce(i.unread, 0) as unread,
    coalesce(i.up, 0) as up,
    coalesce(i.down, 0) as down,
    i.last_published,
    (m.domain is not null) as muted
  from (select domain from items where domain is not null and domain <> ''
        union select domain from muted_domains) d
  left join (
    select domain, count(*) as total, count(*) filter (where seen_at is null) as unread,
      count(*) filter (where reaction = 1) as up, count(*) filter (where reaction = -1) as down,
      max(published_at) as last_published
    from items where domain is not null and domain <> '' group by domain) i on i.domain = d.domain
  left join muted_domains m on m.domain = d.domain;

grant select on domain_stats to authenticated;
