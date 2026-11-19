// Generated (non-article) card kinds. Everything here is deterministic code or your own data — no LLM.
import {
  CHORDS, SCALES, MAJOR_ROOTS, MINOR_ROOTS, CHORD_ROOTS, MAJOR_KEYS, INTERVALS,
  OPEN_SHAPES, BARRE_SHAPES, STANDARD_TUNING, STRING_NAMES,
  spellChord, spellScale, noteName, parseNote, pc, pcName, signatureAccidentals, relativeMinor,
  STAFF, MIDDLE_C, keySigCount, keySigMap, writtenNote, staffNoteName, staffNoteMidi, octaveOf, letterOf,
} from './theory.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const DAY = 86400000;

/**
 * Each kind declares a form schema (rendered by the settings UI) and a generate() function.
 * generate(config, ctx) returns a card payload or null (nothing to show right now).
 * Every payload has a `key`; the feed avoids repeating recently shown keys.
 */
export const GENERATOR_KINDS = {
  flashcards: {
    label: 'Flashcards (spaced repetition)',
    description: 'Cards from one of your decks. Due reviews come first, then new cards up to a daily limit. Tap to reveal, then grade yourself.',
    fields: [
      { key: 'deck_id', label: 'Deck', type: 'deck' },
      { key: 'new_per_day', label: 'New cards per day', type: 'number', default: 10 },
      { key: 'reverse', label: 'Also quiz in reverse (back → front)', type: 'checkbox', default: false },
    ],
    generate(cfg, { decks, excludeKeys, now = Date.now() }) {
      const deck = decks?.[cfg.deck_id];
      if (!deck) return null;
      const free = (c) => !excludeKeys.has(`card:${c.id}`);
      let card = deck.due.find((c) => c.due <= now && free(c));
      let status = card ? (card.reps === 0 ? 'relearn' : 'review') : null;
      if (!card && deck.introduced_today < Number(cfg.new_per_day ?? 10)) {
        card = deck.new.find(free);
        status = 'new';
      }
      if (!card) return null;
      const reverse = cfg.reverse && status !== 'new' && Math.random() < 0.5;
      return {
        key: `card:${card.id}`, kind: 'flashcard', card_id: card.id, deck_id: Number(cfg.deck_id), status, deck: deck.name,
        front: reverse ? card.back : card.front, back: reverse ? card.front : card.back, note: card.note,
      };
    },
  },

  guitar_chord: {
    label: 'Guitar chord shapes',
    description: 'A chord diagram. In quiz mode you see the name first and tap to reveal the shape.',
    fields: [
      { key: 'set', label: 'Chord sets', type: 'multiselect', options: ['open', 'seventh', 'sus', 'barre'], default: 'open,seventh,barre' },
      { key: 'mode', label: 'Mode', type: 'select', options: ['quiz', 'show'], default: 'quiz' },
    ],
    generate(cfg) {
      const sets = new Set(list(cfg.set || 'open'));
      const pool = OPEN_SHAPES.filter(([, , , tag]) => sets.has(tag))
        .map(([root, q, shape]) => ({ root, q, frets: [...shape].map((c) => (c === 'x' ? null : Number(c))), shape: 'open' }));
      if (sets.has('barre')) {
        for (const [base, q, offs, tag] of BARRE_SHAPES) {
          if (tag === 'seventh' && !sets.has('seventh')) continue;
          for (let n = 1; n <= 9; n++) {
            const rootPc = (STANDARD_TUNING[base === 'E' ? 0 : 1] + n) % 12;
            pool.push({ root: pcName(rootPc), q, frets: offs.map((o) => (o === null ? null : n + o)), shape: `${base}-shape barre, fret ${n}` });
          }
        }
      }
      if (!pool.length) return null;
      const c = pick(pool);
      const name = c.root + CHORDS[c.q].symbol;
      const notes = spellChord(c.root, c.q).map(noteName).join(' ');
      return { key: `chord:${name}:${c.frets.join('')}`, kind: 'guitar_chord', name, quality: CHORDS[c.q].name, frets: c.frets, shape: c.shape, notes, quiz: cfg.mode !== 'show' };
    },
  },

  guitar_scale: {
    label: 'Guitar scale shapes',
    description: 'A scale in one position on the fretboard, rooted on the low E or A string. Roots are highlighted.',
    fields: [
      { key: 'scales', label: 'Scales', type: 'multiselect', options: Object.keys(SCALES), default: 'major,minor_pentatonic' },
      { key: 'labels', label: 'Dot labels', type: 'select', options: ['notes', 'degrees', 'none'], default: 'notes' },
    ],
    generate(cfg) {
      const scaleKey = pick(list(cfg.scales).filter((s) => SCALES[s]).length ? list(cfg.scales).filter((s) => SCALES[s]) : ['major']);
      const scale = SCALES[scaleKey];
      const rootName = pick(scale.minorish ? MINOR_ROOTS : MAJOR_ROOTS);
      const notes = spellScale(rootName, scaleKey);
      const degreeLabels = scale.iv.map(([d, s]) => {
        const natural = [0, 2, 4, 5, 7, 9, 11][d - 1];
        return (s < natural ? '♭' : s > natural ? '♯' : '') + d;
      });
      const rootString = Math.random() < 0.5 ? 0 : 1;
      let rootFret = (pc(parseNote(rootName)) - STANDARD_TUNING[rootString] + 12) % 12;
      if (rootFret === 0 && Math.random() < 0.5) rootFret = 12;
      const start = Math.max(0, rootFret - 1);
      const end = start + 4;
      const dots = [];
      for (let s = 0; s < 6; s++) {
        for (let f = start; f <= end; f++) {
          const i = notes.findIndex((n) => pc(n) === (STANDARD_TUNING[s] + f) % 12);
          if (i < 0) continue;
          const label = cfg.labels === 'degrees' ? degreeLabels[i] : cfg.labels === 'none' ? '' : noteName(notes[i]);
          dots.push({ s, f, label, root: i === 0 });
        }
      }
      return {
        key: `scale:${rootName}:${scaleKey}:${rootString}`, kind: 'fretboard', title: `${rootName} ${scale.name}`,
        subtitle: `Root on the ${STRING_NAMES[rootString]} string, fret ${rootFret}`,
        notes: notes.map(noteName).join(' '), start, end, dots, quiz: false,
      };
    },
  },

  fretboard_note: {
    label: 'Fretboard note finder',
    description: 'Find every place a note appears on one string (frets 0–12). Tap to reveal.',
    fields: [
      { key: 'strings', label: 'Strings (6 = low E)', type: 'multiselect', options: ['6', '5', '4', '3', '2', '1'], default: '6,5' },
      { key: 'naturals_only', label: 'Natural notes only', type: 'checkbox', default: true },
    ],
    generate(cfg) {
      const strings = list(cfg.strings).map(Number).filter((n) => n >= 1 && n <= 6);
      const stringNo = pick(strings.length ? strings : [6]);
      const s = 6 - stringNo;
      const pcs = cfg.naturals_only ? [0, 2, 4, 5, 7, 9, 11] : [...Array(12).keys()];
      const target = pick(pcs);
      const f0 = (target - STANDARD_TUNING[s] + 12) % 12;
      const frets = f0 + 12 <= 12 ? [f0, f0 + 12] : [f0];
      return {
        key: `fretnote:${stringNo}:${target}`, kind: 'fretboard', quiz: true,
        title: `Find ${pcName(target)} on string ${stringNo} (${STRING_NAMES[s]})`,
        answer: `Fret${frets.length > 1 ? 's' : ''} ${frets.join(' and ')}`,
        start: 0, end: 12, dots: frets.map((f) => ({ s, f, label: pcName(target), root: true })),
      };
    },
  },

  piano_chord: {
    label: 'Chord spelling',
    description: 'Name the notes of a chord, then reveal the answer on a keyboard.',
    fields: [
      { key: 'qualities', label: 'Chord types', type: 'multiselect', options: Object.keys(CHORDS), default: 'maj,min,dom7' },
    ],
    generate(cfg) {
      const qs = list(cfg.qualities).filter((q) => CHORDS[q]);
      const q = pick(qs.length ? qs : ['maj']);
      const root = pick(CHORD_ROOTS);
      const notes = spellChord(root, q);
      const rootPc = pc(notes[0]);
      const keys = CHORDS[q].iv.map(([, s]) => rootPc + s);
      return {
        key: `pchord:${root}${q}`, kind: 'keyboard', quiz: true,
        title: `Spell ${root}${CHORDS[q].symbol}`, subtitle: `${root} ${CHORDS[q].name}`,
        answer: notes.map(noteName).join(' – '), keys,
      };
    },
  },

  key_signature: {
    label: 'Key signatures',
    description: 'Questions about key signatures, relative minors, and the circle of fifths.',
    fields: [{ key: 'include_minor', label: 'Include minor keys', type: 'checkbox', default: true }],
    generate(cfg) {
      const [key, n] = pick(MAJOR_KEYS);
      const accs = signatureAccidentals(n);
      const sig = n === 0 ? 'no sharps or flats' : `${Math.abs(n)} ${n > 0 ? 'sharp' : 'flat'}${Math.abs(n) > 1 ? 's' : ''}: ${accs.join(' ')}`;
      const rel = relativeMinor(key);
      const variants = [
        { q: `What is the key signature of ${key} major?`, a: sig },
        { q: `Which major key has ${n === 0 ? 'no sharps or flats' : `${Math.abs(n)} ${n > 0 ? 'sharp' : 'flat'}${Math.abs(n) > 1 ? 's' : ''}`}?`, a: `${key} major (relative minor: ${rel} minor)` },
      ];
      if (cfg.include_minor) {
        variants.push({ q: `What is the relative minor of ${key} major?`, a: `${rel} minor — same signature (${sig})` });
        variants.push({ q: `What is the key signature of ${rel} minor?`, a: `${sig} (relative major: ${key} major)` });
      }
      const v = pick(variants);
      return { key: `keysig:${v.q}`, kind: 'quiz', title: v.q, answer: v.a };
    },
  },

  ear_interval: {
    label: 'Ear training: intervals',
    description: 'Listen to two notes and name the interval. Plays through your phone speaker.',
    fields: [
      { key: 'intervals', label: 'Intervals', type: 'multiselect', options: Object.keys(INTERVALS), default: 'm3,M3,P4,P5,P8' },
      { key: 'direction', label: 'Direction', type: 'select', options: ['up', 'down', 'both', 'harmonic'], default: 'up' },
    ],
    generate(cfg) {
      const ivs = list(cfg.intervals).filter((i) => INTERVALS[i]);
      const iv = pick(ivs.length ? ivs : ['P5']);
      const [name, semis] = INTERVALS[iv];
      const low = 55 + Math.floor(Math.random() * 13); // G3..G4
      let dir = cfg.direction || 'up';
      if (dir === 'both') dir = Math.random() < 0.5 ? 'up' : 'down';
      const notes = dir === 'down' ? [low + semis, low] : [low, low + semis];
      return { key: `ear:${iv}:${low}`, kind: 'ear', title: 'Name this interval', notes, harmonic: dir === 'harmonic', answer: name, direction: dir };
    },
  },

  staff_notes: {
    label: 'Sight reading: name the notes',
    description: 'Notes on a treble, bass or grand staff to name, one note or a short passage. No instrument needed; tap to check and hear them.',
    fields: [
      { key: 'clef', label: 'Clef', type: 'select', options: ['treble', 'bass', 'either', 'grand'], default: 'treble', help: '"Either" picks treble or bass for each card; "grand" shows both staves together.' },
      { key: 'notes', label: 'Notes per card', type: 'number', default: 1, help: '1 for a single note, up to 8 for a short passage.' },
      { key: 'range', label: 'Range', type: 'select', options: ['staff', 'one_ledger', 'two_ledgers'], default: 'one_ledger' },
      { key: 'max_leap', label: 'Largest step between notes', type: 'number', default: 2, help: 'In letter names: 1 = neighbours only, 2 = up to a 3rd, 4 = up to a 5th. Passages only.' },
      { key: 'keys', label: 'Key signatures', type: 'multiselect', options: ['C', 'G', 'D', 'A', 'E', 'F', 'B♭', 'E♭', 'A♭'], default: 'C' },
      { key: 'accidentals', label: 'Add the odd accidental (♯ ♭ ♮)', type: 'checkbox', default: false },
      { key: 'audio', label: 'Play the notes', type: 'select', options: ['after_reveal', 'always', 'off'], default: 'after_reveal', help: 'Piano-like tones through the speaker. "After reveal" lets you read first, then check by ear.' },
    ],
    generate(cfg) {
      const clefChoice = ['treble', 'bass', 'either', 'grand'].includes(cfg.clef) ? cfg.clef : 'treble';
      const clef = clefChoice === 'either' ? pick(['treble', 'bass']) : clefChoice;
      const extra = { staff: 0, one_ledger: 2, two_ledgers: 4 }[cfg.range] ?? 2;
      const [lo, hi] = clef === 'grand' ? [STAFF.bass.bottom - extra, STAFF.treble.bottom + 8 + extra]
        : [STAFF[clef].bottom - extra, STAFF[clef].bottom + 8 + extra];
      const count = Math.min(8, Math.max(1, Math.round(Number(cfg.notes) || 1)));
      const maxLeap = Math.min(7, Math.max(1, Math.round(Number(cfg.max_leap) || 2)));
      const keyNames = list(cfg.keys).filter((k) => ['C', 'G', 'D', 'A', 'E', 'F', 'B♭', 'E♭', 'A♭'].includes(k));
      const keyName = pick(keyNames.length ? keyNames : ['C']);
      const keyN = keySigCount(keyName);
      const inKey = keySigMap(keyN);

      // Pick the written steps: a single note anywhere in range, or a gentle random walk.
      const steps = [lo + Math.floor(Math.random() * (hi - lo + 1))];
      while (steps.length < count) {
        const prev = steps[steps.length - 1];
        const options = [];
        for (let s = -maxLeap; s <= maxLeap; s++) {
          const d = prev + s;
          if (d < lo || d > hi) continue;
          const w = s === 0 ? 0.5 : Math.max(0.4, 4 - Math.abs(s));
          options.push([d, w]);
        }
        let r = Math.random() * options.reduce((t, [, w]) => t + w, 0);
        let next = options[options.length - 1][0];
        for (const [d, w] of options) { r -= w; if (r <= 0) { next = d; break; } }
        steps.push(next);
      }

      const notes = steps.map((d) => {
        const base = inKey[letterOf(d)] ?? 0;
        let explicit;
        if (cfg.accidentals && Math.random() < 0.22) explicit = pick([-1, 0, 1].filter((a) => a !== base));
        const n = writtenNote(d, keyN, explicit);
        return { d, acc: n.acc, show: explicit !== undefined, staff: clef === 'grand' ? (d >= MIDDLE_C ? 'treble' : 'bass') : clef, name: staffNoteName(n), octave: octaveOf(d), midi: staffNoteMidi(n) };
      });
      const names = notes.map((n) => n.name);
      return {
        key: `staff:${clef}:${keyN}:${notes.map((n) => `${n.d}${n.acc}`).join('.')}`, kind: 'staff',
        title: count === 1 ? 'Name this note' : `Name these ${count} notes`,
        subtitle: [clef === 'grand' ? 'Grand staff' : STAFF[clef].label[0].toUpperCase() + STAFF[clef].label.slice(1), keyN ? `key of ${keyName} major` : null].filter(Boolean).join(' · '),
        clef, keyN, notes, answer: names.join(' – '),
        detail: notes.map((n) => `${n.name}${n.octave}`).join('  ') + (notes.some((n) => n.d === MIDDLE_C) ? '  (C4 = middle C)' : ''),
        audio: ['after_reveal', 'always', 'off'].includes(cfg.audio) ? cfg.audio : 'after_reveal',
      };
    },
  },

  prompts: {
    label: 'Text cards from a list',
    description: 'Shows one line at random from your list — practice prompts, tips, quotes, facts. One card per line.',
    fields: [
      { key: 'label', label: 'Card label', type: 'text', default: 'Tip' },
      { key: 'lines', label: 'Lines (one card per line)', type: 'textarea', default: '' },
    ],
    generate(cfg, { generatorId }) {
      const lines = String(cfg.lines || '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return null;
      const i = Math.floor(Math.random() * lines.length);
      return { key: `prompt:${generatorId}:${i}`, kind: 'prompt', label: cfg.label || 'Tip', text: lines[i] };
    },
  },
};

/**
 * Spaced-repetition update (SM-2 flavoured). grade: again | good | easy.
 * Returns the fields to write back to the card row; times are epoch ms.
 */
export function scheduleReview(card, grade, now = Date.now()) {
  let { interval_days: iv = 0, ease = 2.5, reps = 0, lapses = 0 } = card;
  let due;
  if (grade === 'again') {
    if (reps > 0) lapses++;
    reps = 0; iv = 0; ease = Math.max(1.3, ease - 0.2);
    due = now + 10 * 60000;
  } else {
    reps++;
    if (grade === 'easy') {
      iv = reps === 1 ? 4 : Math.max(iv, 1) * ease * 1.3;
      ease += 0.15;
    } else {
      iv = reps === 1 ? 1 : reps === 2 ? 3 : Math.max(iv, 1) * ease;
    }
    due = now + Math.round(iv * DAY);
  }
  return { due, interval_days: iv, ease, reps, lapses, introduced_at: card.introduced_at ?? now };
}

/** Apply a review to the in-memory deck queue so the feed reflects it without reloading. */
export function applyReviewToDeck(deck, card, update) {
  if (!deck) return;
  const wasNew = card.due == null;
  deck.new = deck.new.filter((c) => c.id !== card.id);
  deck.due = deck.due.filter((c) => c.id !== card.id);
  if (wasNew) deck.introduced_today++;
  if (update.due - Date.now() < 12 * 3600e3) deck.due.push({ ...card, ...update });
  deck.due.sort((a, b) => a.due - b.due);
}
