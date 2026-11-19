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

/** Scale a group of topics (by index) to a combined share; the unlocked topics outside it absorb the difference. */
export function setGroupShare(shares, locked, members, value) {
  const inGroup = new Set(members);
  const free = members.filter((i) => !locked[i]);
  if (!free.length) return shares.slice();
  const fixedInGroup = members.filter((i) => locked[i]).reduce((s, i) => s + shares[i], 0);
  const lockedOutside = shares.reduce((s, v, i) => s + (!inGroup.has(i) && locked[i] ? v : 0), 0);
  const outsideFree = shares.map((_, i) => i).filter((i) => !inGroup.has(i) && !locked[i]);
  const room = 100 - lockedOutside - fixedInGroup; // what the unlocked members could hold at most
  const groupTarget = outsideFree.length ? Math.min(Math.max(0, (Number(value) || 0) - fixedInGroup), room) : room;
  const out = shares.slice();
  const spread = (ids, total) => {
    const cur = ids.reduce((s, i) => s + out[i], 0);
    for (const i of ids) out[i] = cur > 0 ? (out[i] / cur) * total : total / ids.length;
  };
  spread(free, groupTarget);
  if (outsideFree.length) spread(outsideFree, room - groupTarget);
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
