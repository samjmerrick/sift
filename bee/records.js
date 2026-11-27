// How Sift's tables are kept in the personal database (bee-database). Used by everything in bee/.
//
// Every Sift row is one record: project "sift", collection = the table name, metadata = the row itself (with
// Sift's own numeric `id`, or the table's key for muted_domains, app_settings and item_content). Title and content
// hold readable text so the rows are searchable like any other record.

export const PROJECT = 'sift';

/** The project and collection descriptions Sift defines in bee-database on start. */
export const PROJECT_INFO = {
  project: {
    name: 'Sift',
    description: 'Sift, the personal reading and practice feed.',
    guide: "Sift's data. Every record is one row of one of its tables: the collection is the table and `metadata` is "
      + 'the row, with Sift\'s own numeric `id` (muted_domains is keyed by `domain`, app_settings by `key`, item_content '
      + "by `item_id`). Rows refer to each other by those ids (source_id, topic_id, deck_id). Sift's app is the normal "
      + 'way to change them; if you add a record here, give it an unused numeric id.',
  },
  collections: {
    topics: 'Topics in the feed.', sources: 'RSS and Hacker News sources.', generators: 'Practice card types.',
    decks: 'Flashcard and note decks.', cards: 'Cards in a deck.', items: 'Fetched articles.',
    saved_cards: 'Saved practice cards.', muted_domains: 'Muted sites.', app_settings: 'App settings.',
    item_content: 'Reader text of articles.',
  },
};

/** Tables, in load order (parents first). */
export const TABLES = ['topics', 'sources', 'generators', 'decks', 'cards', 'items', 'saved_cards', 'muted_domains', 'app_settings', 'item_content'];

/** Tables keyed by something other than a numeric `id`. */
export const KEYS = { muted_domains: 'domain', app_settings: 'key', item_content: 'item_id' };

/** The row's key within its table (its `id`, or the KEYS column). */
export const rowKey = (table, row) => String(row[KEYS[table] || 'id']);

const clip = (s, n) => (s == null ? '' : String(s)).slice(0, n);

function titleOf(table, r) {
  switch (table) {
    case 'topics': case 'sources': case 'generators': case 'decks': return clip(r.name, 200);
    case 'items': return clip(r.title, 300);
    case 'cards': return clip(r.front, 200);
    case 'saved_cards': return clip(r.payload?.title || r.payload?.front || 'Saved card', 200);
    case 'item_content': return clip(r.title || `Reader text for item ${r.item_id}`, 300);
    case 'muted_domains': return clip(r.domain, 200);
    case 'app_settings': return clip(r.key, 200);
    default: return '';
  }
}

function contentOf(table, r) {
  switch (table) {
    case 'items': return [r.title, r.summary, r.url].filter(Boolean).join('\n');
    case 'cards': return [r.front, r.back, r.note].filter(Boolean).join('\n');
    case 'sources': return [r.name, r.kind, r.config?.url].filter(Boolean).join('\n');
    // The reader's HTML lives in metadata; keep the searchable text short.
    case 'item_content': return clip(r.title || r.error || 'Reader text', 300);
    default: return titleOf(table, r) || table;
  }
}

/** The bee-database fields for one Sift row. */
export function toRecord(table, row) {
  return { project: PROJECT, collection: table, title: titleOf(table, row), content: contentOf(table, row) || table, tags: [], metadata: row };
}
