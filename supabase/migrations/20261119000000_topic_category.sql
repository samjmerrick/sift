-- Topics can be grouped into categories (Music, News, Tech, ...). The feed's topic picker and the share balancer
-- use them to keep a long topic list manageable. Free text; an empty category means "Other".
alter table topics add column if not exists category text not null default '';

-- Tidy existing installs: categorise the topics that came from the built-in starter packs.
update topics set category = case name
    when 'AI' then 'Tech'
    when 'Programming' then 'Tech'
    when 'Science' then 'Science'
    when 'Russian' then 'Languages'
    when 'Guitar' then 'Music'
    when 'Piano' then 'Music'
  end
where category = '' and name in ('AI', 'Programming', 'Science', 'Russian', 'Guitar', 'Piano');
