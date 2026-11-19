import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharesFromWeights, setShare, setGroupShare, toPercents, weightFromPercent } from '../public/lib/balance.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('weights become shares that add up to 100', () => {
  assert.deepEqual(sharesFromWeights([4, 2, 2, 1, 1]), [40, 20, 20, 10, 10]);
  assert.deepEqual(sharesFromWeights([0, 0]), [50, 50]);
  assert.deepEqual(sharesFromWeights([]), []);
});

test('moving one share spreads the change over the unlocked others', () => {
  const s = sharesFromWeights([4, 2, 2, 1, 1]);
  const t = setShare(s, [false, true, false, false, false], 0, 60);
  close(sum(t), 100);
  close(t[0], 60); close(t[1], 20); // locked topic holds
  close(t[2], 10); close(t[3], 5); // others shrink in proportion
  const capped = setShare(s, [false, true, false, false, false], 0, 95);
  close(capped[0], 80); // can't take the locked share
  const stuck = setShare(s, [false, true, true, true, true], 0, 90);
  assert.deepEqual(stuck, s); // nothing left to give way
  close(sum(setShare([50, 50, 0], [false, false, false], 2, 40)), 100);
});

test('group sliders scale a category and keep the total at 100', () => {
  const s = sharesFromWeights([4, 2, 2, 1, 1]);
  const t = setGroupShare(s, [false, false, false, false, false], [1, 2], 70);
  close(sum(t), 100); close(t[1] + t[2], 70); close(t[1], t[2]);
  const lockedMember = setGroupShare(s, [false, false, true, false, false], [1, 2], 60);
  close(sum(lockedMember), 100); close(lockedMember[2], 20); close(lockedMember[1], 40);
  assert.deepEqual(setGroupShare(s, [false, true, true, false, false], [1, 2], 10), s);
});

test('rounding keeps whole percentages summing to exactly 100', () => {
  assert.deepEqual(toPercents([100 / 3, 100 / 3, 100 / 3]), [34, 33, 33]);
  for (let n = 1; n < 25; n++) assert.equal(sum(toPercents(sharesFromWeights(Array.from({ length: n }, (_, i) => 1 + (i % 4) * 0.7)))), 100);
  assert.equal(weightFromPercent(13), 1.3);
});
