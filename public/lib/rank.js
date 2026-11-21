// Topic stack rank: positions + falloff → the weights the feed reads. Works over any data layer with the shape of lib/data.js.
import { DEFAULT_FALLOFF, rankOrder, rankPatches } from './balance.js';

/** Apply `rankPatches` to the database (changed rows only). Returns the patches. */
export async function saveRank(data, ordered, ratio) {
  const patches = rankPatches(ordered, ratio);
  for (const { id, ...patch } of patches) await data.update('topics', id, patch);
  return patches;
}

/** Recompute positions and weights from the current order and falloff (call after adding, showing, hiding or deleting topics). */
export async function rebalance(data) {
  const [topics, falloff] = await Promise.all([data.topics(), data.setting('falloff', DEFAULT_FALLOFF)]);
  return saveRank(data, rankOrder(topics), falloff);
}
