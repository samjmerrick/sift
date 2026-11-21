// Share balancing for the feed: pure maths, no DOM. Shares are percentages that always add up to 100.

/** Turn raw topic weights into shares summing to 100 (even split if every weight is zero). */
export function sharesFromWeights(weights) {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!weights.length) return [];
  if (total <= 0) return weights.map(() => 100 / weights.length);
  return weights.map((w) => (Math.max(0, w) / total) * 100);
}

/**
 * Set one topic's share and spread the difference over the unlocked others in proportion to what they have now.
 * `locked` is an array of booleans. The topic can't take more than 100 minus the locked shares.
 */
export function setShare(shares, locked, index, value) {
  const out = shares.slice();
  const lockedSum = out.reduce((s, v, i) => s + (i !== index && locked[i] ? v : 0), 0);
  const others = out.map((_, i) => i).filter((i) => i !== index && !locked[i]);
  const max = others.length ? 100 - lockedSum : out[index];
  const v = Math.min(Math.max(0, Number(value) || 0), Math.max(0, max));
  out[index] = v;
  if (!others.length) return out;
  const rest = 100 - lockedSum - v;
  const current = others.reduce((s, i) => s + out[i], 0);
  for (const i of others) out[i] = current > 0 ? (out[i] / current) * rest : rest / others.length;
  return out;
}

/** Round shares to whole percentages that still add up to exactly 100 (largest remainder). */
export function toPercents(shares) {
  const floors = shares.map((s) => Math.floor(s + 1e-9));
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => [s - Math.floor(s + 1e-9), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; floors[i]++; left--; }
  return floors;
}

/** Percentages → the `weight` stored on each topic (100% across all topics = a total weight of 10). */
export const weightFromPercent = (pct) => Math.round(pct * 10) / 100;
