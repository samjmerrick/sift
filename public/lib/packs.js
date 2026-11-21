// Starter packs: ready-made topics (with sources, card types and flashcard decks) that can be added from
// Settings → Topics. A pack is a JSON file in public/starters/ (listed in starters/index.json), so anyone can
// write their own: see "Starter packs" in the README.
import { GENERATOR_KINDS } from './generators.js';
import { SOURCE_KINDS } from './source-kinds.js';
import { rebalance } from './rank.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Returns a list of problems with a pack (empty when it is valid). */
export function validatePack(pack) {
  const errs = [];
  if (!isObj(pack)) return ['pack must be an object'];
  if (!pack.name) errs.push('pack needs a name');
  const decks = new Set();
  for (const d of pack.decks || []) {
    if (!d.name) errs.push('deck needs a name');
    else decks.add(d.name);
    if (!Array.isArray(d.cards) || d.cards.some((c) => !Array.isArray(c) || !c[0] || !c[1])) errs.push(`deck "${d.name}": cards must be [front, back, note?] arrays`);
  }
  if (!Array.isArray(pack.topics) || !pack.topics.length) errs.push('pack needs at least one topic');
  for (const t of pack.topics || []) {
    if (!t.name) errs.push('topic needs a name');
    for (const s of t.sources || []) {
      if (!SOURCE_KINDS[s.kind]) errs.push(`${t.name}: unknown source kind "${s.kind}"`);
      if (!s.name) errs.push(`${t.name}: source needs a name`);
      if (s.kind === 'rss' && !s.config?.url) errs.push(`${t.name}/${s.name}: rss source needs config.url`);
    }
    for (const c of t.cards || []) {
      if (!GENERATOR_KINDS[c.kind]) errs.push(`${t.name}: unknown card type "${c.kind}"`);
      if (!c.name) errs.push(`${t.name}: card type needs a name`);
      if ((c.kind === 'flashcards' || c.kind === 'notes') && !decks.has(c.config?.deck)) errs.push(`${t.name}/${c.name}: deck "${c.config?.deck}" is not defined in the pack`);
      if (c.config?.lines != null && !Array.isArray(c.config.lines)) errs.push(`${t.name}/${c.name}: lines must be an array`);
    }
  }
  return errs;
}

/**
 * Add a pack's content through `data` (see lib/data.js). Topics and decks that already exist (same name) are
 * skipped, so installing twice is harmless. Returns what was added.
 */
export async function installPack(data, pack) {
  const problems = validatePack(pack);
  if (problems.length) throw new Error(`Invalid pack: ${problems[0]}`);
  const existingTopics = new Set((await data.topics()).map((t) => t.name));
  const existingDecks = new Map((await data.deckStats()).map((d) => [d.name, d.id]));
  const added = { topics: 0, sources: 0, cards: 0, decks: 0 };

  const deckIds = new Map();
  for (const d of pack.decks || []) {
    if (existingDecks.has(d.name)) { deckIds.set(d.name, existingDecks.get(d.name)); continue; }
    const row = await data.insert('decks', { name: d.name });
    await data.addCards(row.id, d.cards);
    deckIds.set(d.name, row.id);
    added.decks++;
  }

  for (const t of pack.topics) {
    if (existingTopics.has(t.name)) continue;
    const row = await data.insert('topics', {
      name: t.name, color: t.color || '#64748b', curated_ratio: t.curated_ratio ?? 0.5, position: await data.nextTopicPosition(),
    });
    added.topics++;
    for (const s of t.sources || []) {
      await data.insert('sources', { topic_id: row.id, kind: s.kind, name: s.name, config: s.config || {}, include: s.include || '', exclude: s.exclude || '', weight: s.weight ?? 1 });
      added.sources++;
    }
    for (const c of t.cards || []) {
      const { deck, lines, ...rest } = c.config || {};
      const config = { ...rest };
      if (lines) config.lines = lines.join('\n');
      if (deck) config.deck_id = deckIds.get(deck);
      await data.insert('generators', { topic_id: row.id, kind: c.kind, name: c.name, config, weight: c.weight ?? 1 });
      added.cards++;
    }
  }
  if (added.topics) await rebalance(data); // new topics join the bottom of the stack rank
  return added;
}
