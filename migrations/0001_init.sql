-- Sift on D1 (SQLite). Same tables as the Supabase build, with the final column set.
-- Booleans are 0/1, JSON columns are text, timestamps are ISO-8601 text; the API layer converts them back.
CREATE TABLE topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  weight REAL NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'articles' CHECK (kind IN ('articles', 'cards'))
);
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('rss', 'hn')),
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  include TEXT NOT NULL DEFAULT '',
  exclude TEXT NOT NULL DEFAULT '',
  weight REAL NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fetched TEXT,
  last_error TEXT
);
CREATE INDEX sources_topic ON sources (topic_id);
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  image TEXT,
  domain TEXT,
  comments_url TEXT,
  community_score INTEGER,
  comment_count INTEGER,
  published_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  seen_at TEXT,
  reaction INTEGER NOT NULL DEFAULT 0 CHECK (reaction IN (-1, 0, 1)),
  saved_at TEXT
);
CREATE INDEX items_unseen ON items (published_at DESC) WHERE seen_at IS NULL;
CREATE INDEX items_title_key ON items (title_key);
CREATE INDEX items_source ON items (source_id);
CREATE INDEX items_topic ON items (topic_id);
CREATE INDEX items_saved ON items (saved_at) WHERE saved_at IS NOT NULL;
CREATE INDEX items_reaction ON items (source_id, domain) WHERE reaction <> 0;
CREATE INDEX items_domain ON items (domain);
CREATE TABLE generators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  weight REAL NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX generators_topic ON generators (topic_id);
CREATE TABLE decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT ''
);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  due TEXT,
  interval_days REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  introduced_at TEXT
);
CREATE INDEX cards_due ON cards (deck_id, due);
CREATE TABLE saved_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  payload TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE INDEX saved_cards_topic ON saved_cards (topic_id);
CREATE TABLE item_content (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  title TEXT, byline TEXT, site_name TEXT,
  html TEXT NOT NULL DEFAULT '',
  text_length INTEGER NOT NULL DEFAULT 0,
  lead_image TEXT, error TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE muted_domains (
  domain TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Work for the runner on bee (fetching feeds, reading articles). The Worker waits on these.
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX jobs_status ON jobs (status, id);

CREATE VIEW source_stats AS
  SELECT s.*,
    (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS item_count,
    (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.seen_at IS NULL) AS unseen_count
  FROM sources s;
CREATE VIEW deck_stats AS
  SELECT d.id, d.name, COUNT(c.id) AS cards, COUNT(c.due) AS studied,
    COUNT(CASE WHEN c.due <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 1 END) AS due_now, d.lang
  FROM decks d LEFT JOIN cards c ON c.deck_id = d.id GROUP BY d.id;
CREATE VIEW saved_items AS
  SELECT i.*, s.name AS source_name FROM items i JOIN sources s ON s.id = i.source_id WHERE i.saved_at IS NOT NULL;
CREATE VIEW domain_stats AS
  SELECT d.domain,
    COALESCE(i.total, 0) AS total, COALESCE(i.unread, 0) AS unread, COALESCE(i.up, 0) AS up, COALESCE(i.down, 0) AS down,
    i.last_published,
    (m.domain IS NOT NULL) AS muted
  FROM (SELECT domain FROM items WHERE domain IS NOT NULL AND domain <> '' UNION SELECT domain FROM muted_domains) d
  LEFT JOIN (
    SELECT domain, COUNT(*) AS total, SUM(seen_at IS NULL) AS unread, SUM(reaction = 1) AS up, SUM(reaction = -1) AS down,
      MAX(published_at) AS last_published
    FROM items WHERE domain IS NOT NULL AND domain <> '' GROUP BY domain) i ON i.domain = d.domain
  LEFT JOIN muted_domains m ON m.domain = d.domain;
