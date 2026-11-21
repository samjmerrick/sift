import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharesFromWeights, toPercents, rankWeights, rankPatches, rankOrder, FALLOFFS } from '../public/lib/balance.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('weights become shares that add up to 100', () => {
  assert.deepEqual(sharesFromWeights([4, 2, 2, 1, 1]), [40, 20, 20, 10, 10]);
  assert.deepEqual(sharesFromWeights([0, 0]), [50, 50]);
  assert.deepEqual(sharesFromWeights([]), []);
});

test('rounding keeps whole percentages summing to exactly 100', () => {
  assert.deepEqual(toPercents([100 / 3, 100 / 3, 100 / 3]), [34, 33, 33]);
  for (let n = 1; n < 25; n++) assert.equal(sum(toPercents(sharesFromWeights(rankWeights(n, 0.8)))), 100);
});

test('rank weights start at 2 and fall by the ratio each step', () => {
  assert.deepEqual(rankWeights(4, 1), [2, 2, 2, 2]);
  assert.deepEqual(rankWeights(4, 0.5), [2, 1, 0.5, 0.25]);
  assert.deepEqual(rankWeights(3, 0.8), [2, 1.6, 1.28]);
  assert.deepEqual(rankWeights(0, 0.8), []);
  assert.deepEqual(rankWeights(1, 0.7), [2]);
  assert.equal(rankWeights(2, 'junk')[1], 1.6, 'a bad ratio falls back to the default');
  assert.deepEqual(FALLOFFS.map(([, , r]) => r), [1, 0.9, 0.8, 0.7]);
});

test('steeper falloff gives the top topic a bigger share, and shares stay descending', () => {
  const top = FALLOFFS.map(([, , r]) => toPercents(sharesFromWeights(rankWeights(5, r)))[0]);
  assert.deepEqual(top, [...top].sort((a, b) => a - b));
  assert.equal(top[0], 20);
  const smooth = sharesFromWeights(rankWeights(5, 0.8));
  assert.ok(smooth.every((s, i) => i === 0 || s < smooth[i - 1]));
});

test('rankPatches changes only rows whose position or weight moved, and leaves hidden weights alone', () => {
  const t = (id, position, weight, enabled = true) => ({ id, position, weight, enabled });
  const settled = [t(1, 0, 2), t(2, 1, 1.6), t(3, 2, 1.28), t(4, 3, 7, false)];
  assert.deepEqual(rankPatches(settled, 0.8), [], 'nothing to do when already consistent');
  const swapped = [settled[1], settled[0], settled[2], settled[3]];
  assert.deepEqual(rankPatches(swapped, 0.8), [{ id: 2, position: 0, weight: 2 }, { id: 1, position: 1, weight: 1.6 }]);
  assert.deepEqual(rankPatches(settled, 1), [{ id: 2, weight: 2 }, { id: 3, weight: 2 }]);
  assert.deepEqual(rankPatches(rankOrder([t(2, 5, 1.6, false), t(3, 9, 2), t(1, 0, 2)]), 1), [{ id: 3, position: 1 }, { id: 2, position: 2 }]);
});

test('rankOrder lists visible topics by position first, then hidden ones', () => {
  const order = rankOrder([{ id: 1, position: 0, enabled: false }, { id: 2, position: 3, enabled: true }, { id: 3, position: 1, enabled: true }, { id: 4, position: 1, enabled: true }]);
  assert.deepEqual(order.map((x) => x.id), [3, 4, 2, 1]);
});
