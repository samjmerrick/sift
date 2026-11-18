// Generates supabase/migrations/*_seed.sql from the files in seed/. Run: npm run build:seed
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv } from '../public/lib/csv.js';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const j = (o) => `${q(JSON.stringify(o))}::jsonb`;

const topics = [
  // name, color, weight, curated_ratio
  ['AI', '#7c3aed', 4, 0.9],
  ['Russian', '#dc2626', 2.5, 0.3],
  ['Guitar', '#d97706', 2, 0.4],
  ['Piano', '#0891b2', 1.5, 0.4],
];
const sources = [
  // topic, kind, name, config, include, exclude, weight
  ['AI', 'hn', 'Hacker News: AI', { min_points: 150, days: 3 },
    'AI, LLM, LLMs, GPT, Claude, Gemini, Llama, model, models, neural, transformer, agents, agent, inference, OpenAI, Anthropic, DeepMind, diffusion, embedding, embeddings, fine-tuning, RAG', '', 1],
  ['AI', 'rss', 'Simon Willison', { url: 'https://simonwillison.net/atom/everything/' }, '', '', 1.2],
  ['AI', 'rss', 'Hugging Face blog', { url: 'https://huggingface.co/blog/feed.xml' }, '', '', 1],
  ['AI', 'rss', 'Lobsters: AI', { url: 'https://lobste.rs/t/ai.rss', max_age_days: 7 }, '', '', 1],
  ['AI', 'rss', 'Ahead of AI (Sebastian Raschka)', { url: 'https://magazine.sebastianraschka.com/feed', max_age_days: 30 }, '', '', 1.2],
  ['AI', 'rss', 'Interconnects (Nathan Lambert)', { url: 'https://www.interconnects.ai/feed', max_age_days: 30 }, '', '', 1],
  ['AI', 'rss', 'Latent Space', { url: 'https://www.latent.space/feed', max_age_days: 30 }, '', '', 0.9],
  ['Russian', 'rss', 'Russian With Max', { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCklUqFEcJqFnWKEBozw5p4g', max_age_days: 30 }, '', '', 1.2],
  ['Russian', 'rss', 'Real Russian Club', { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCyJznKYS9kkP7RWWq3YAbFw', max_age_days: 30 }, '', '', 1],
  ['Guitar', 'rss', 'JustinGuitar', { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCBNkm8o5LiEVLxO8w0p2sfQ', max_age_days: 30 }, '', '', 1.2],
  ['Guitar', 'rss', 'Paul Davids', { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC_Oa7Ph3v94om5OyxY1nPKg', max_age_days: 30 }, '', '', 1],
  ['Guitar', 'rss', 'Marty Music', { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCmnlTWVJysjWPFiZhQ5uudg', max_age_days: 14 }, '', '', 0.8],
  ['Guitar', 'rss', 'Guitar World lessons', { url: 'https://www.guitarworld.com/feeds/all', max_age_days: 14 }, 'lesson, lessons, technique, how to, practice, practise, exercise, exercises, theory, chord, chords, scale, scales, lick, licks, riff, riffs, tips, beginner, beginners, learn, fretboard, picking, fingerpicking, improvise, improvisation', 'deal, deals, sale, price, giveaway', 1],
  ['Guitar', 'rss', 'Guitar Player lessons', { url: 'https://www.guitarplayer.com/feeds/all', max_age_days: 14 }, 'lesson, lessons, technique, how to, practice, practise, exercise, exercises, theory, chord, chords, scale, scales, lick, licks, riff, riffs, tips, beginner, beginners, learn, fretboard, picking, fingerpicking, improvise, improvisation', 'deal, deals, sale, price, giveaway', 1],
  ['Guitar', 'rss', 'Premier Guitar lessons', { url: 'https://www.premierguitar.com/feeds/feed.rss', max_age_days: 14 }, 'lesson, lessons, technique, how to, practice, practise, exercise, exercises, theory, chord, chords, scale, scales, lick, licks, riff, riffs, tips, beginner, beginners, learn, fretboard, picking, fingerpicking, improvise, improvisation', 'deal, deals, sale, price, giveaway', 0.9],
  ['Piano', 'rss', 'Nahre Sol', { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC8R8FRt1KcPiR-rtAflXmeg', max_age_days: 60 }, '', '', 1.2],
  ['Piano', 'rss', 'Josh Wright', { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCp4DtLatjb5dBNHHYcvVXCw', max_age_days: 30 }, '', '', 1],
  ['Piano', 'rss', 'Adam Neely (music theory)', { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCnkp4xDOwqqJD7sSM3xdUiQ', max_age_days: 60 }, '', '', 0.9],
  ['Piano', 'rss', 'PianoTV', { url: 'https://www.pianotv.net/feed/', max_age_days: 60 }, '', '', 1.2],
  ['Piano', 'rss', 'Musicnotes blog', { url: 'https://www.musicnotes.com/blog/feed/', max_age_days: 30 }, '', '', 0.9],
  ['Piano', 'rss', 'Ethan Hein (music theory)', { url: 'https://www.ethanhein.com/wp/feed/', max_age_days: 60 }, '', '', 1],
];
const DECK = 'Russian core vocabulary';
const generators = [
  // topic, kind, name, config, weight
  ['Russian', 'flashcards', 'Russian vocabulary', { deck: DECK, new_per_day: 10 }, 3],
  ['Guitar', 'guitar_chord', 'Chord shapes', { set: 'open,seventh,barre', mode: 'quiz' }, 2],
  ['Guitar', 'guitar_scale', 'Scale shapes', { scales: 'major,minor_pentatonic,major_pentatonic,natural_minor,blues', labels: 'notes' }, 2],
  ['Guitar', 'fretboard_note', 'Fretboard notes', { strings: '6,5,4,3,2,1', naturals_only: true }, 1],
  ['Guitar', 'prompts', 'Practice prompts', { label: 'Practice', lines: read('seed/guitar-prompts.txt') }, 1],
  ['Piano', 'piano_chord', 'Chord spelling', { qualities: 'maj,min,dim,aug,maj7,min7,dom7,m7b5' }, 2],
  ['Piano', 'key_signature', 'Key signatures', { include_minor: true }, 1],
  ['Piano', 'ear_interval', 'Ear training: intervals', { intervals: 'm2,M2,m3,M3,P4,TT,P5,m6,M6,m7,M7,P8', direction: 'both' }, 1.5],
  ['Piano', 'prompts', 'Practice prompts', { label: 'Practice', lines: read('seed/piano-prompts.txt') }, 1],
];

const topicId = (name) => `(select id from topics where name = ${q(name)})`;
const out = ['-- Generated by scripts/build-seed.js from seed/. Starter content; edit everything in the app afterwards.', ''];
out.push('insert into topics (name, color, weight, curated_ratio, position) values');
out.push(topics.map(([n, c, w, r], i) => `  (${q(n)}, ${q(c)}, ${w}, ${r}, ${i + 1})`).join(',\n') + ';', '');
out.push('insert into sources (topic_id, kind, name, config, include, exclude, weight) values');
out.push(sources.map(([t, k, n, c, inc, exc, w]) => `  (${topicId(t)}, ${q(k)}, ${q(n)}, ${j(c)}, ${q(inc)}, ${q(exc)}, ${w})`).join(',\n') + ';', '');
out.push(`insert into decks (name) values (${q(DECK)});`, '');
out.push('insert into cards (deck_id, front, back, note, position) values');
const deckId = `(select id from decks where name = ${q(DECK)})`;
out.push(parseCsv(read('seed/russian-core.csv')).map(([f, b, n = ''], i) => `  (${deckId}, ${q(f)}, ${q(b)}, ${q(n)}, ${i + 1})`).join(',\n') + ';', '');
out.push('insert into generators (topic_id, kind, name, config, weight) values');
out.push(generators.map(([t, k, n, c, w]) => {
  if (c.deck) {
    const { deck, ...rest } = c;
    return `  (${topicId(t)}, ${q(k)}, ${q(n)}, ${j(rest)} || jsonb_build_object('deck_id', ${deckId}), ${w})`;
  }
  return `  (${topicId(t)}, ${q(k)}, ${q(n)}, ${j(c)}, ${w})`;
}).join(',\n') + ';', '');

const file = 'supabase/migrations/20261118000001_seed.sql';
writeFileSync(new URL(file, root), out.join('\n'));
console.log(`wrote ${file}`);
