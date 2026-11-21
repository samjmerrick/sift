// Share balancing for the feed: pure maths, no DOM. Shares are percentages that always add up to 100.

/** Turn raw topic weights into shares summing to 100 (even split if every weight is zero). */
export function sharesFromWeights(weights) {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!weights.length) return [];
  if (total <= 0) return weights.map(() => 100 / weights.length);
  return weights.map((w) => (Math.max(0, w) / total) * 100);
}

/** Round shares to whole percentages that still add up to exactly 100 (largest remainder). */
export function toPercents(shares) {
  const floors = shares.map((s) => Math.floor(s + 1e-9));
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => [s - Math.floor(s + 1e-9), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; floors[i]++; left--; }
  return floors;
}

/** Falloff presets: each step down the rank multiplies a topic's weight by `ratio`. */
export const FALLOFFS = [['even', 'Even', 1], ['gentle', 'Gentle', 0.9], ['smooth', 'Smooth', 0.8], ['steep', 'Steep', 0.7]];
export const DEFAULT_FALLOFF = 0.8;

/** Weights for `n` ranked topics: rank 0 gets 2, each next rank is `ratio` times the one above. */
export function rankWeights(n, ratio) {
  const r = Math.min(1, Math.max(0.1, Number(ratio) || DEFAULT_FALLOFF));
  return Array.from({ length: n }, (_, i) => Math.round(2 * r ** i * 1e4) / 1e4);
}

/**
 * `ordered` is every topic in rank order, visible ones first (hidden ones after). Returns the changes needed so
 * visible topics sit at positions 0..n-1 with weights from `ratio`, and hidden ones follow: [{ id, position?, weight? }].
 */
export function rankPatches(ordered, ratio) {
  const visible = ordered.filter((t) => t.enabled);
  const weights = rankWeights(visible.length, ratio);
  const patches = [];
  ordered.forEach((t, i) => {
    const patch = {};
    if (t.position !== i) patch.position = i;
    const w = t.enabled ? weights[i] : null;
    if (w != null && Math.abs(Number(t.weight) - w) > 1e-6) patch.weight = w;
    if (Object.keys(patch).length) patches.push({ id: t.id, ...patch });
  });
  return patches;
}

/** Rank order from stored positions: visible topics first, then hidden, each by position then id. */
export const rankOrder = (topics) => topics.slice().sort((a, b) => (b.enabled - a.enabled) || (a.position - b.position) || (a.id - b.id));
