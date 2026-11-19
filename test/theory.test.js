import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spellChord, spellScale, noteName, relativeMinor, signatureAccidentals } from '../public/lib/theory.js';

const names = (ns) => ns.map(noteName).join(' ');

test('chord spelling uses correct letter names', () => {
  assert.equal(names(spellChord('C', 'maj')), 'C E G');
  assert.equal(names(spellChord('E♭', 'min7')), 'E♭ G♭ B♭ D♭');
  assert.equal(names(spellChord('F♯', 'dom7')), 'F♯ A♯ C♯ E');
  assert.equal(names(spellChord('B', 'dim7')), 'B D F A♭');
  assert.equal(names(spellChord('C♯', 'aug')), 'C♯ E♯ G𝄪');
  assert.equal(names(spellChord('B♭', 'm7b5')), 'B♭ D♭ F♭ A♭');
});

test('scales', () => {
  assert.equal(names(spellScale('F', 'major')), 'F G A B♭ C D E');
  assert.equal(names(spellScale('A', 'minor_pentatonic')), 'A C D E G');
  assert.equal(names(spellScale('E', 'blues')), 'E G A B♭ B D');
  assert.equal(names(spellScale('G♯', 'harmonic_minor')), 'G♯ A♯ B C♯ D♯ E F𝄪');
});

test('keys', () => {
  assert.equal(relativeMinor('E♭'), 'C');
  assert.equal(relativeMinor('A'), 'F♯');
  assert.deepEqual(signatureAccidentals(3), ['F♯', 'C♯', 'G♯']);
  assert.deepEqual(signatureAccidentals(-2), ['B♭', 'E♭']);
});

import { keySigMap, keySigSteps, writtenNote, staffNoteName, staffNoteMidi, keySigCount } from '../public/lib/theory.js';
import { GENERATOR_KINDS } from '../public/lib/generators.js';

test('staff notation helpers', () => {
  assert.equal(staffNoteMidi({ d: 28, acc: 0 }), 60); // middle C
  assert.equal(staffNoteMidi({ d: 30, acc: 0 }), 64); // E4, bottom line of the treble staff
  assert.equal(staffNoteMidi({ d: 18, acc: 0 }), 43); // G2, bottom line of the bass staff
  assert.equal(keySigCount('B♭'), -2);
  assert.equal(staffNoteName(writtenNote(31, 1)), 'F♯'); // F4 in G major
  assert.equal(staffNoteName(writtenNote(30, -3)), 'E♭');
  assert.equal(staffNoteName(writtenNote(30, -3, 0)), 'E'); // explicit natural
  assert.deepEqual(keySigSteps(2, 'treble'), [8, 5]);
  assert.deepEqual(keySigSteps(-2, 'bass'), [2, 5]);
  assert.deepEqual(Object.keys(keySigMap(-3)).sort(), ['2', '5', '6']);
});

test('staff_notes cards stay in range, follow the key and agree with their own answer', () => {
  const gen = GENERATOR_KINDS.staff_notes.generate;
  for (let i = 0; i < 400; i++) {
    const clef = ['treble', 'bass', 'either', 'grand'][i % 4];
    const notes = 1 + (i % 6);
    const c = gen({ clef, notes, range: ['staff', 'one_ledger', 'two_ledgers'][i % 3], max_leap: 1 + (i % 4), keys: 'C,G,B♭', accidentals: i % 2 === 0, audio: 'always' });
    assert.equal(c.kind, 'staff');
    assert.equal(c.notes.length, notes);
    assert.equal(c.answer.split(' – ').length, notes);
    for (const n of c.notes) {
      assert.ok(n.d >= 14 && n.d <= 42, `step ${n.d} within two ledger lines of the grand staff`);
      assert.equal(n.staff, c.clef === 'grand' ? (n.d >= 28 ? 'treble' : 'bass') : c.clef);
      assert.equal(n.midi, staffNoteMidi(n));
    }
    for (let k = 1; k < notes; k++) assert.ok(Math.abs(c.notes[k].d - c.notes[k - 1].d) <= 1 + (i % 4), 'steps respect the largest leap');
  }
  // Without accidentals the notes are just the key's notes.
  const c = gen({ clef: 'treble', notes: 8, keys: 'D', accidentals: false });
  for (const n of c.notes) assert.equal(n.acc, [3, 0].includes(n.d % 7) ? 1 : 0);
});
