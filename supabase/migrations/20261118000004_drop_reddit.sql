-- Reddit blocks cloud servers and its API now needs approval, so Reddit sources are removed.
-- Adds the replacement RSS/YouTube sources to existing installs (fresh installs get them from the seed).
delete from sources where kind = 'reddit';
alter table sources drop constraint if exists sources_kind_check;
alter table sources add constraint sources_kind_check check (kind in ('rss', 'hn'));

insert into sources (topic_id, kind, name, config, include, exclude, weight)
select v.topic_id, v.kind, v.name, v.config, v.include, v.exclude, v.weight
from (values
  ((select id from topics where name = 'AI'), 'hn', 'Hacker News: AI', '{"min_points":150,"days":3}'::jsonb, 'AI, LLM, LLMs, GPT, Claude, Gemini, Llama, model, models, neural, transformer, agents, agent, inference, OpenAI, Anthropic, DeepMind, diffusion, embedding, embeddings, fine-tuning, RAG', '', 1),
  ((select id from topics where name = 'AI'), 'rss', 'Simon Willison', '{"url":"https://simonwillison.net/atom/everything/"}'::jsonb, '', '', 1.2),
  ((select id from topics where name = 'AI'), 'rss', 'Hugging Face blog', '{"url":"https://huggingface.co/blog/feed.xml"}'::jsonb, '', '', 1),
  ((select id from topics where name = 'AI'), 'rss', 'Lobsters: AI', '{"url":"https://lobste.rs/t/ai.rss","max_age_days":7}'::jsonb, '', '', 1),
  ((select id from topics where name = 'AI'), 'rss', 'Ahead of AI (Sebastian Raschka)', '{"url":"https://magazine.sebastianraschka.com/feed","max_age_days":30}'::jsonb, '', '', 1.2),
  ((select id from topics where name = 'AI'), 'rss', 'Interconnects (Nathan Lambert)', '{"url":"https://www.interconnects.ai/feed","max_age_days":30}'::jsonb, '', '', 1),
  ((select id from topics where name = 'AI'), 'rss', 'Latent Space', '{"url":"https://www.latent.space/feed","max_age_days":30}'::jsonb, '', '', 0.9),
  ((select id from topics where name = 'Russian'), 'rss', 'Russian With Max', '{"url":"https://www.youtube.com/feeds/videos.xml?channel_id=UCklUqFEcJqFnWKEBozw5p4g","max_age_days":30}'::jsonb, '', '', 1.2),
  ((select id from topics where name = 'Russian'), 'rss', 'Real Russian Club', '{"url":"https://www.youtube.com/feeds/videos.xml?channel_id=UCyJznKYS9kkP7RWWq3YAbFw","max_age_days":30}'::jsonb, '', '', 1),
  ((select id from topics where name = 'Guitar'), 'rss', 'JustinGuitar', '{"url":"https://www.youtube.com/feeds/videos.xml?channel_id=UCBNkm8o5LiEVLxO8w0p2sfQ","max_age_days":30}'::jsonb, '', '', 1.2),
  ((select id from topics where name = 'Guitar'), 'rss', 'Paul Davids', '{"url":"https://www.youtube.com/feeds/videos.xml?channel_id=UC_Oa7Ph3v94om5OyxY1nPKg","max_age_days":30}'::jsonb, '', '', 1),
  ((select id from topics where name = 'Guitar'), 'rss', 'Marty Music', '{"url":"https://www.youtube.com/feeds/videos.xml?channel_id=UCmnlTWVJysjWPFiZhQ5uudg","max_age_days":14}'::jsonb, '', '', 0.8),
  ((select id from topics where name = 'Guitar'), 'rss', 'Guitar World lessons', '{"url":"https://www.guitarworld.com/feeds/all","max_age_days":14}'::jsonb, 'lesson, lessons, technique, how to, practice, practise, exercise, exercises, theory, chord, chords, scale, scales, lick, licks, riff, riffs, tips, beginner, beginners, learn, fretboard, picking, fingerpicking, improvise, improvisation', 'deal, deals, sale, price, giveaway', 1),
  ((select id from topics where name = 'Guitar'), 'rss', 'Guitar Player lessons', '{"url":"https://www.guitarplayer.com/feeds/all","max_age_days":14}'::jsonb, 'lesson, lessons, technique, how to, practice, practise, exercise, exercises, theory, chord, chords, scale, scales, lick, licks, riff, riffs, tips, beginner, beginners, learn, fretboard, picking, fingerpicking, improvise, improvisation', 'deal, deals, sale, price, giveaway', 1),
  ((select id from topics where name = 'Guitar'), 'rss', 'Premier Guitar lessons', '{"url":"https://www.premierguitar.com/feeds/feed.rss","max_age_days":14}'::jsonb, 'lesson, lessons, technique, how to, practice, practise, exercise, exercises, theory, chord, chords, scale, scales, lick, licks, riff, riffs, tips, beginner, beginners, learn, fretboard, picking, fingerpicking, improvise, improvisation', 'deal, deals, sale, price, giveaway', 0.9),
  ((select id from topics where name = 'Piano'), 'rss', 'Nahre Sol', '{"url":"https://www.youtube.com/feeds/videos.xml?channel_id=UC8R8FRt1KcPiR-rtAflXmeg","max_age_days":60}'::jsonb, '', '', 1.2),
  ((select id from topics where name = 'Piano'), 'rss', 'Josh Wright', '{"url":"https://www.youtube.com/feeds/videos.xml?channel_id=UCp4DtLatjb5dBNHHYcvVXCw","max_age_days":30}'::jsonb, '', '', 1),
  ((select id from topics where name = 'Piano'), 'rss', 'Adam Neely (music theory)', '{"url":"https://www.youtube.com/feeds/videos.xml?channel_id=UCnkp4xDOwqqJD7sSM3xdUiQ","max_age_days":60}'::jsonb, '', '', 0.9),
  ((select id from topics where name = 'Piano'), 'rss', 'PianoTV', '{"url":"https://www.pianotv.net/feed/","max_age_days":60}'::jsonb, '', '', 1.2),
  ((select id from topics where name = 'Piano'), 'rss', 'Musicnotes blog', '{"url":"https://www.musicnotes.com/blog/feed/","max_age_days":30}'::jsonb, '', '', 0.9),
  ((select id from topics where name = 'Piano'), 'rss', 'Ethan Hein (music theory)', '{"url":"https://www.ethanhein.com/wp/feed/","max_age_days":60}'::jsonb, '', '', 1)
) as v(topic_id, kind, name, config, include, exclude, weight)
where v.topic_id is not null and not exists (select 1 from sources s where s.name = v.name);
