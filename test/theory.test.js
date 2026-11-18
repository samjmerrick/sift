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
