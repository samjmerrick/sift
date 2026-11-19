// Small, dependency-free music theory helpers: correct note spelling, chords, scales, keys.

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const ACC = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };

const mod = (n, m) => ((n % m) + m) % m;

export function parseNote(s) {
  const m = /^([A-Ga-g])([#♯b♭]*)$/.exec(String(s).trim());
  if (!m) throw new Error(`Bad note: ${s}`);
  const acc = [...m[2]].reduce((a, c) => a + (c === '#' || c === '♯' ? 1 : -1), 0);
  return { L: LETTERS.indexOf(m[1].toUpperCase()), acc };
}
export const pc = (n) => mod(LETTER_PC[n.L] + n.acc, 12);
export const noteName = (n) => LETTERS[n.L] + ACC[n.acc];

/** Spell the note that is `degree` (1-based letter steps) and `semis` semitones above root. */
export function spellAbove(root, degree, semis) {
  const L = mod(root.L + degree - 1, 7);
  let acc = mod(pc(root) + semis - LETTER_PC[L], 12);
  if (acc > 6) acc -= 12;
  return { L, acc };
}

export const CHORDS = {
  maj: { symbol: '', name: 'major', iv: [[1, 0], [3, 4], [5, 7]] },
  min: { symbol: 'm', name: 'minor', iv: [[1, 0], [3, 3], [5, 7]] },
  dim: { symbol: '°', name: 'diminished', iv: [[1, 0], [3, 3], [5, 6]] },
  aug: { symbol: '+', name: 'augmented', iv: [[1, 0], [3, 4], [5, 8]] },
  sus2: { symbol: 'sus2', name: 'suspended 2nd', iv: [[1, 0], [2, 2], [5, 7]] },
  sus4: { symbol: 'sus4', name: 'suspended 4th', iv: [[1, 0], [4, 5], [5, 7]] },
  '6': { symbol: '6', name: 'major 6th', iv: [[1, 0], [3, 4], [5, 7], [6, 9]] },
  maj7: { symbol: 'maj7', name: 'major 7th', iv: [[1, 0], [3, 4], [5, 7], [7, 11]] },
  min7: { symbol: 'm7', name: 'minor 7th', iv: [[1, 0], [3, 3], [5, 7], [7, 10]] },
  dom7: { symbol: '7', name: 'dominant 7th', iv: [[1, 0], [3, 4], [5, 7], [7, 10]] },
  m7b5: { symbol: 'm7♭5', name: 'half-diminished', iv: [[1, 0], [3, 3], [5, 6], [7, 10]] },
  dim7: { symbol: '°7', name: 'diminished 7th', iv: [[1, 0], [3, 3], [5, 6], [7, 9]] },
};

export const SCALES = {
  major: { name: 'major', minorish: false, iv: [[1, 0], [2, 2], [3, 4], [4, 5], [5, 7], [6, 9], [7, 11]] },
  natural_minor: { name: 'natural minor', minorish: true, iv: [[1, 0], [2, 2], [3, 3], [4, 5], [5, 7], [6, 8], [7, 10]] },
  harmonic_minor: { name: 'harmonic minor', minorish: true, iv: [[1, 0], [2, 2], [3, 3], [4, 5], [5, 7], [6, 8], [7, 11]] },
  dorian: { name: 'Dorian', minorish: true, iv: [[1, 0], [2, 2], [3, 3], [4, 5], [5, 7], [6, 9], [7, 10]] },
  mixolydian: { name: 'Mixolydian', minorish: false, iv: [[1, 0], [2, 2], [3, 4], [4, 5], [5, 7], [6, 9], [7, 10]] },
  major_pentatonic: { name: 'major pentatonic', minorish: false, iv: [[1, 0], [2, 2], [3, 4], [5, 7], [6, 9]] },
  minor_pentatonic: { name: 'minor pentatonic', minorish: true, iv: [[1, 0], [3, 3], [4, 5], [5, 7], [7, 10]] },
  blues: { name: 'blues', minorish: true, iv: [[1, 0], [3, 3], [4, 5], [5, 6], [5, 7], [7, 10]] },
};

export const MAJOR_ROOTS = ['C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'F', 'B♭', 'E♭', 'A♭', 'D♭'];
export const MINOR_ROOTS = ['A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D', 'G', 'C', 'F', 'B♭', 'E♭'];
export const CHORD_ROOTS = ['C', 'C♯', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export function spellChord(rootName, quality) {
  const root = parseNote(rootName);
  return CHORDS[quality].iv.map(([d, s]) => spellAbove(root, d, s));
}
export function spellScale(rootName, scale) {
  const root = parseNote(rootName);
  return SCALES[scale].iv.map(([d, s]) => spellAbove(root, d, s));
}

// Key signatures: number of sharps (+) or flats (-) for each major key.
export const MAJOR_KEYS = [
  ['C', 0], ['G', 1], ['D', 2], ['A', 3], ['E', 4], ['B', 5], ['F♯', 6], ['C♯', 7],
  ['F', -1], ['B♭', -2], ['E♭', -3], ['A♭', -4], ['D♭', -5], ['G♭', -6], ['C♭', -7],
];
const SHARP_ORDER = ['F♯', 'C♯', 'G♯', 'D♯', 'A♯', 'E♯', 'B♯'];
const FLAT_ORDER = ['B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭', 'F♭'];
export function signatureAccidentals(n) {
  return n >= 0 ? SHARP_ORDER.slice(0, n) : FLAT_ORDER.slice(0, -n);
}
export const relativeMinor = (major) => noteName(spellAbove(parseNote(major), 6, 9));

export const INTERVALS = {
  m2: ['minor 2nd', 1], M2: ['major 2nd', 2], m3: ['minor 3rd', 3], M3: ['major 3rd', 4],
  P4: ['perfect 4th', 5], TT: ['tritone', 6], P5: ['perfect 5th', 7], m6: ['minor 6th', 8],
  M6: ['major 6th', 9], m7: ['minor 7th', 10], M7: ['major 7th', 11], P8: ['octave', 12],
};

// Guitar
export const STANDARD_TUNING = [4, 9, 2, 7, 11, 4]; // pitch classes, string 6 (low E) → string 1 (high E)
export const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];
const SHARP_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const pcName = (p) => SHARP_NAMES[mod(p, 12)];

// Open-position chord shapes: frets from string 6 to string 1 ('x' = muted).
export const OPEN_SHAPES = [
  ['C', 'maj', 'x32010', 'open'], ['A', 'maj', 'x02220', 'open'], ['G', 'maj', '320003', 'open'],
  ['E', 'maj', '022100', 'open'], ['D', 'maj', 'xx0232', 'open'], ['A', 'min', 'x02210', 'open'],
  ['E', 'min', '022000', 'open'], ['D', 'min', 'xx0231', 'open'], ['F', 'maj', 'xx3211', 'open'],
  ['A', 'dom7', 'x02020', 'seventh'], ['E', 'dom7', '020100', 'seventh'], ['D', 'dom7', 'xx0212', 'seventh'],
  ['G', 'dom7', '320001', 'seventh'], ['C', 'dom7', 'x32310', 'seventh'], ['B', 'dom7', 'x21202', 'seventh'],
  ['A', 'min7', 'x02010', 'seventh'], ['E', 'min7', '022030', 'seventh'], ['D', 'min7', 'xx0211', 'seventh'],
  ['C', 'maj7', 'x32000', 'seventh'], ['F', 'maj7', 'xx3210', 'seventh'], ['A', 'maj7', 'x02120', 'seventh'],
  ['D', 'maj7', 'xx0222', 'seventh'], ['A', 'sus2', 'x02200', 'sus'], ['A', 'sus4', 'x02230', 'sus'],
  ['D', 'sus2', 'xx0230', 'sus'], ['D', 'sus4', 'xx0233', 'sus'], ['E', 'sus4', '022200', 'sus'],
];

// Movable barre shapes: offsets from the barre fret n (null = muted). 'E' shapes root on string 6, 'A' on string 5.
export const BARRE_SHAPES = [
  ['E', 'maj', [0, 2, 2, 1, 0, 0]], ['E', 'min', [0, 2, 2, 0, 0, 0]],
  ['E', 'dom7', [0, 2, 0, 1, 0, 0], 'seventh'], ['E', 'min7', [0, 2, 0, 0, 0, 0], 'seventh'],
  ['A', 'maj', [null, 0, 2, 2, 2, 0]], ['A', 'min', [null, 0, 2, 2, 1, 0]],
  ['A', 'dom7', [null, 0, 2, 0, 2, 0], 'seventh'], ['A', 'min7', [null, 0, 2, 0, 1, 0], 'seventh'],
  ['A', 'maj7', [null, 0, 2, 1, 2, 0], 'seventh'],
];

// ---------- Staff notation (for sight-reading cards) ----------
// A written note is { d, acc } where d is the diatonic step: octave * 7 + letter (C=0 … B=6), so middle C (C4) is 28.
// Both clefs share one vertical scale, which keeps the grand staff honest: middle C sits on the same ledger line.
export const STAFF = {
  treble: { bottom: 30, label: 'treble clef' }, // bottom line E4
  bass: { bottom: 18, label: 'bass clef' }, // bottom line G2
};
export const MIDDLE_C = 28;
export const letterOf = (d) => mod(d, 7);
export const octaveOf = (d) => Math.floor(d / 7);

/** Sharps (+) or flats (−) for a major key given by name, e.g. 'D' → 2, 'B♭' → −2. */
export const keySigCount = (name) => MAJOR_KEYS.find(([k]) => k === name)?.[1] ?? 0;

/** Accidental the key signature gives each letter (0..6 = C..B): { 3: 1 } for G major (F♯). */
export function keySigMap(n) {
  const map = {};
  const letterOfAcc = (a) => LETTERS.indexOf(a[0]);
  for (const a of signatureAccidentals(n)) map[letterOfAcc(a)] = n > 0 ? 1 : -1;
  return map;
}

// Where each accidental of a key signature sits, as steps above the bottom line (treble); bass is two steps lower.
const SIG_STEPS = { sharps: [8, 5, 9, 6, 3, 7, 4], flats: [4, 7, 3, 6, 2, 5, 1] };
export function keySigSteps(n, clef) {
  const steps = (n >= 0 ? SIG_STEPS.sharps : SIG_STEPS.flats).slice(0, Math.abs(n));
  return steps.map((s) => (clef === 'bass' ? s - 2 : s));
}

/** The concrete note for a written step in a key: the key signature's accidental unless one is given explicitly. */
export function writtenNote(d, keyN, explicitAcc) {
  const acc = explicitAcc ?? keySigMap(keyN)[letterOf(d)] ?? 0;
  return { d, acc };
}
export const staffNoteName = (n) => noteName({ L: letterOf(n.d), acc: n.acc });
export const staffNoteMidi = (n) => (octaveOf(n.d) + 1) * 12 + LETTER_PC[letterOf(n.d)] + n.acc;
