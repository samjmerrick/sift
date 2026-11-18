import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function openDb(file = process.env.SIFT_DB || join(root, 'data', 'sift.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  if (!db.prepare('SELECT 1 FROM topics LIMIT 1').get()) seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6b7280',
      weight REAL NOT NULL DEFAULT 1,      -- share of the feed
      curated_ratio REAL NOT NULL DEFAULT 0.6, -- chance a slot is an article (vs a generated card) when articles exist
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,                  -- rss | hn | reddit
      name TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',   -- JSON, depends on kind
      include TEXT NOT NULL DEFAULT '',    -- comma-separated keywords; at least one must match (if set)
      exclude TEXT NOT NULL DEFAULT '',    -- comma-separated keywords; none may match
      weight REAL NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fetched INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      topic_id INTEGER NOT NULL,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      title_key TEXT NOT NULL,             -- normalised title for de-duplication
      summary TEXT NOT NULL DEFAULT '',
      image TEXT,
      domain TEXT,
      comments_url TEXT,
      community_score INTEGER,
      comment_count INTEGER,
      published_at INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      seen_at INTEGER,
      reaction INTEGER NOT NULL DEFAULT 0, -- 1 up, -1 down
      saved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS items_unseen ON items(topic_id, seen_at);
    CREATE INDEX IF NOT EXISTS items_title_key ON items(title_key);
    CREATE TABLE IF NOT EXISTS generators (
      id INTEGER PRIMARY KEY,
      topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      weight REAL NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS decks (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY,
      deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      front TEXT NOT NULL,
      back TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      -- spaced repetition state (SM-2 style)
      due INTEGER,                          -- null = never studied
      interval_days REAL NOT NULL DEFAULT 0,
      ease REAL NOT NULL DEFAULT 2.5,
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      introduced_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS cards_due ON cards(deck_id, due);
    CREATE TABLE IF NOT EXISTS saved_cards (
      id INTEGER PRIMARY KEY,
      topic_id INTEGER,
      payload TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    );
  `);
}

function readSeed(name) {
  return readFileSync(join(root, 'seed', name), 'utf8');
}

export function parseCsv(text) {
  // Minimal CSV: comma or tab separated, double quotes for fields containing separators.
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.includes('\t') ? '\t' : ',';
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    if (out[0] && out[1]) rows.push(out);
  }
  return rows;
}

export function importCards(db, deckId, rows) {
  const start = db.prepare('SELECT COALESCE(MAX(position), 0) p FROM cards WHERE deck_id = ?').get(deckId).p;
  const ins = db.prepare('INSERT INTO cards (deck_id, front, back, note, position) VALUES (?, ?, ?, ?, ?)');
  rows.forEach(([front, back, note = ''], i) => ins.run(deckId, front, back, note, start + i + 1));
  return rows.length;
}

function seed(db) {
  const topic = db.prepare('INSERT INTO topics (name, color, weight, curated_ratio, position) VALUES (?, ?, ?, ?, ?)');
  const ai = topic.run('AI', '#7c3aed', 4, 0.9, 1).lastInsertRowid;
  const ru = topic.run('Russian', '#dc2626', 2.5, 0.3, 2).lastInsertRowid;
  const gtr = topic.run('Guitar', '#d97706', 2, 0.4, 3).lastInsertRowid;
  const pno = topic.run('Piano', '#0891b2', 1.5, 0.4, 4).lastInsertRowid;

  const src = db.prepare('INSERT INTO sources (topic_id, kind, name, config, include, exclude, weight) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const j = JSON.stringify;
  src.run(ai, 'hn', 'Hacker News: AI', j({ min_points: 150, days: 3 }),
    'AI, LLM, LLMs, GPT, Claude, Gemini, Llama, model, models, neural, transformer, agents, agent, inference, OpenAI, Anthropic, DeepMind, diffusion, embedding, embeddings, fine-tuning, RAG', '', 1);
  src.run(ai, 'rss', 'Simon Willison', j({ url: 'https://simonwillison.net/atom/everything/' }), '', '', 1.2);
  src.run(ai, 'rss', 'Hugging Face blog', j({ url: 'https://huggingface.co/blog/feed.xml' }), '', '', 1);
  src.run(ai, 'reddit', 'r/LocalLLaMA', j({ subreddit: 'LocalLLaMA', period: 'week', limit: 15, min_score: 300 }), '', '', 1);
  src.run(ai, 'reddit', 'r/MachineLearning', j({ subreddit: 'MachineLearning', period: 'week', limit: 10, min_score: 100 }), '', '', 1);
  src.run(ru, 'reddit', 'r/russian', j({ subreddit: 'russian', period: 'week', limit: 15, min_score: 50 }), '', '', 1);
  src.run(ru, 'reddit', 'r/russianlearning', j({ subreddit: 'russianlearning', period: 'week', limit: 10, min_score: 10 }), '', '', 1);
  src.run(gtr, 'reddit', 'r/guitarlessons', j({ subreddit: 'guitarlessons', period: 'week', limit: 15, min_score: 50 }), '', '', 1.2);
  src.run(gtr, 'reddit', 'r/Guitar', j({ subreddit: 'Guitar', period: 'week', limit: 10, min_score: 500 }), '', 'NGD, new guitar day', 0.8);
  src.run(pno, 'reddit', 'r/piano', j({ subreddit: 'piano', period: 'week', limit: 15, min_score: 100 }), '', '', 1);
  src.run(pno, 'reddit', 'r/musictheory', j({ subreddit: 'musictheory', period: 'week', limit: 10, min_score: 100 }), '', '', 1);

  const deck = db.prepare('INSERT INTO decks (name) VALUES (?)');
  const ruDeck = deck.run('Russian core vocabulary').lastInsertRowid;
  importCards(db, ruDeck, parseCsv(readSeed('russian-core.csv')));

  const gen = db.prepare('INSERT INTO generators (topic_id, kind, name, config, weight) VALUES (?, ?, ?, ?, ?)');
  gen.run(ru, 'flashcards', 'Russian vocabulary', j({ deck_id: Number(ruDeck), new_per_day: 10 }), 3);
  gen.run(gtr, 'guitar_chord', 'Chord shapes', j({ set: 'open,barre,seventh', mode: 'quiz' }), 2);
  gen.run(gtr, 'guitar_scale', 'Scale shapes', j({ scales: 'major,minor_pentatonic,major_pentatonic,natural_minor,blues', keys: 'all', frets: 12 }), 2);
  gen.run(gtr, 'fretboard_note', 'Fretboard notes', j({ strings: '6,5,4,3,2,1', naturals_only: true }), 1);
  gen.run(gtr, 'prompts', 'Practice prompts', j({ label: 'Practice', lines: readSeed('guitar-prompts.txt') }), 1);
  gen.run(pno, 'piano_chord', 'Chord spelling', j({ qualities: 'maj,min,dim,aug,maj7,min7,dom7,m7b5', keys: 'all' }), 2);
  gen.run(pno, 'key_signature', 'Key signatures', j({ include_minor: true }), 1);
  gen.run(pno, 'ear_interval', 'Ear training: intervals', j({ intervals: 'm2,M2,m3,M3,P4,TT,P5,m6,M6,m7,M7,P8', direction: 'both' }), 1.5);
  gen.run(pno, 'prompts', 'Practice prompts', j({ label: 'Practice', lines: readSeed('piano-prompts.txt') }), 1);
}
