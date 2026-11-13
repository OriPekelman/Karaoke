/**
 * Turns note streams into what the screen needs.
 *
 * Two axes cross here. A score can carry the same tune in several languages —
 * each <lyric number> is a track, and tracks share one note stream, so a
 * singable translation lines up syllable-for-note with the original. And a score
 * can carry several people singing — each is a voice, with a note stream of its
 * own and therefore a clock of its own: in a round the same words arrive eight
 * bars apart, and in a duet they are not even the same words.
 *
 * So line breaks are planned per voice, on whichever of its languages has the
 * finest syllable grain, and expressed as note ranges; the voice's other
 * languages are sliced against those same ranges, so the translations under a
 * sung line always say the same thing. Across voices nothing is shared — each
 * one is on the line it is on.
 */

import { detectLanguage } from './language.js';

const SOLFEGE = { C: 'do', D: 're', E: 'mi', F: 'fa', G: 'sol', A: 'la', B: 'ti' };
const RAISED = { do: 'di', re: 'ri', fa: 'fi', sol: 'si', la: 'li', mi: 'mi♯', ti: 'ti♯' };
const LOWERED = { re: 'ra', mi: 'me', sol: 'se', la: 'le', ti: 'te', do: 'do♭', fa: 'fa♭' };

const MAX_LINE_CHARS = 36;
const BREAK_GAP_QUARTERS = 0.9;   // a rest this long is a breath
const PUNCTUATED = /[.!?;:,—–]["')\]]?$/;
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

export function buildScore(parsed) {
  const declared = parsed.tracks?.length ? parsed.tracks : [{ key: '1', label: 'Lyrics', order: 0 }];
  const voices = (parsed.voices ?? []).map(v => buildVoice(v, declared)).filter(Boolean);
  if (!voices.length) throw new Error('score contains no singable line');
  assignBadges(voices);

  // The language buttons offer what some voice can actually sing.
  const tracks = declared.filter(meta => voices.some(v => v.tracks.some(t => t.key === meta.key)));
  const offered = tracks.length ? tracks : voices[0].tracks.map(({ key, label, order }) => ({ key, label, order }));
  const alternatives = readTracks(voices, offered);

  return {
    ...parsed,
    voices,
    tracks: offered,
    // Whether the lyric lines are alternatives for the same music — languages,
    // to be read together — or the successive stanzas of a strophic song, which
    // are sung one after another and must not share the stage.
    alternatives,
    guideNotes: mergeVoices(voices),
    duration: Math.max(...voices.map(v => v.duration)),
  };
}

/**
 * Decide what the numbered lyric lines are, and name them if the score did not.
 *
 * A score that names its lines is believed. Otherwise the words decide: two
 * lines in different languages are a translation and belong together; two in the
 * same language are stanzas and do not. When the languages cannot be told apart
 * the answer is "stanzas", because showing verse two on top of verse one is the
 * mistake a singer actually notices.
 */
function readTracks(voices, offered) {
  if (offered.length < 2) return true;
  if (offered.every(t => t.named)) return true;

  // Put the words back together first. A score stores "vor-rei" as two
  // syllables, and "vor rei" is not a word in any language — every syllable
  // carries the hyphen that split it, so the text can be made readable again.
  const sample = key => voices
    .flatMap(v => v.tracks.filter(t => t.key === key))
    .map(t => t.syllables.map((s, i) => s.text + (s.hyphenAfter && i < t.syllables.length - 1 ? '' : ' ')).join(''))
    .join(' ');

  const found = offered.map(t => ({ track: t, guess: detectLanguage(sample(t.key)) }));
  const codes = found.map(f => f.guess?.code);
  const different = codes.every(Boolean) && new Set(codes).size === codes.length;

  // Name what was recognised — "Français" tells a singer something "Verse 1"
  // never does. All or none: a stack reading "Verse 1 / Deutsch" is worse than
  // one reading "Verse 1 / Verse 2", because it implies the first line is not a
  // language. Every voice holds its own copy of the track and the rows are
  // labelled from those, so a new name has to reach all of them.
  const nameable = different && found.every(f => f.track.named || f.guess?.confident);
  if (nameable) {
    for (const { track, guess } of found) {
      if (track.named) continue;
      track.label = guess.name;
      for (const voice of voices) {
        for (const own of voice.tracks) if (own.key === track.key) own.label = guess.name;
      }
    }
  }
  return different;
}

/**
 * One singer: syllables, lines and pitch range of their own. The result is also
 * what the dot and the canvas read, so it carries `notes` and `range` under the
 * names the stage already expects.
 */
function buildVoice(voice, declared) {
  const notes = voice.notes;
  if (!notes.length) return null;
  const hasAnyLyric = notes.some(n => n.lyrics && Object.keys(n.lyrics).length);

  const tracks = declared.map(meta => {
    const syllables = buildSyllables(notes, meta.key, !hasAnyLyric);
    return { ...meta, syllables, dir: RTL.test(syllables.map(s => s.text).join('')) ? 'rtl' : 'ltr' };
  }).filter(t => t.syllables.length);
  if (!tracks.length) return null;

  // Break lines using whichever language subdivides this voice's melody most finely.
  const reference = tracks.reduce((a, b) => (b.syllables.length > a.syllables.length ? b : a));
  const bounds = planLines(reference.syllables);
  for (const track of tracks) track.lines = sliceLines(track, bounds);

  let lo = Infinity, hi = -Infinity;
  for (const n of notes) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
  const span = Math.max(10, hi - lo + 4);       // floor the range so narrow tunes still move
  const centre = (lo + hi) / 2;

  return {
    ...voice,
    notes,
    tracks,
    lineCount: bounds.length,
    range: { lo: centre - span / 2, hi: centre + span / 2, min: lo, max: hi },
    duration: notes[notes.length - 1].end,
  };
}

/**
 * One stream for the guide tone: every voice at the same level, so a duet is
 * heard as a duet. Notes two singers hold in unison are folded together rather
 * than sounded twice — doubling them only makes them beat against each other.
 */
function mergeVoices(voices) {
  if (voices.length === 1) return voices[0].notes;
  const all = voices.flatMap(v => v.notes).sort((a, b) => a.start - b.start || a.midi - b.midi);
  const out = [];
  for (const n of all) {
    // Sorted by onset, so a unison twin can only be among the last few.
    let twin = null;
    for (let i = out.length - 1; i >= 0 && n.start - out[i].start < 0.02; i--) {
      if (out[i].midi === n.midi) { twin = out[i]; break; }
    }
    if (twin) { twin.end = Math.max(twin.end, n.end); continue; }
    out.push({ ...n });
  }
  return out;
}

/**
 * A letter for each voice, to sit inside its dot — S, A, T, B for a choir, I,
 * II, III for the voices of a round, D and Z for Don Giovanni and Zerlina. One
 * character carries best at dot size, so it is the first choice; initials, and
 * then numbers, are what collisions fall back to.
 */
function assignBadges(voices) {
  const ordinal = /(?:^|\s)(I{1,3}|IV|VI{0,3}|V)$/;
  const clean = v => v.label.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

  const initial = v => {
    const label = clean(v);
    const roman = ordinal.exec(label);
    if (roman) return roman[1];
    return [...label][0]?.toUpperCase() ?? '?';
  };
  const initials = v => {
    const words = clean(v).split(' ').filter(Boolean);
    if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
    return words[0] ? words[0].slice(0, 2).replace(/^./, c => c.toUpperCase()) : '?';
  };

  let badges = voices.map(initial);
  const clashing = b => badges.filter(x => x === b).length > 1;
  if (badges.some(clashing)) badges = badges.map((b, i) => (clashing(b) ? initials(voices[i]) : b));
  if (badges.some(clashing)) badges = voices.map((_, i) => String(i + 1));

  voices.forEach((v, i) => { v.badge = badges[i]; });
}

/** The version of a language this voice sings, or its own if it has no such verse. */
export function trackFor(voice, key) {
  return voice.tracks.find(t => t.key === key) ?? voice.tracks[0];
}

/** Syllables for one language. Notes with no word of their own extend the last one. */
function buildSyllables(notes, key, useSolfege) {
  const syllables = [];
  for (const note of notes) {
    const lyric = useSolfege ? { text: fallbackText(note), syllabic: 'single' } : note.lyrics?.[key];
    const last = syllables[syllables.length - 1];

    // A melisma: the word holds while the dot keeps moving in pitch.
    if (!lyric && last) {
      last.notes.push(note);
      last.end = note.end;
      continue;
    }
    if (!lyric) continue;

    syllables.push({
      index: syllables.length,
      track: key,
      text: lyric.text,
      hyphenAfter: lyric.syllabic === 'begin' || lyric.syllabic === 'middle',
      notes: [note],
      start: note.start,
      end: note.end,
      q: note.q,
      firstNote: note.index,
    });
  }

  for (const s of syllables) {
    const alt = s.notes.find(n => n.accidental !== 'natural');
    s.accidental = alt ? alt.accidental : 'natural';
    s.midi = s.notes[0].midi;
    s.lastNote = s.notes[s.notes.length - 1].index;
  }
  return syllables;
}

function fallbackText(note) {
  const base = SOLFEGE[note.step] || String(note.step).toLowerCase();
  if (note.alter > 0) return RAISED[base] || base + '♯';
  if (note.alter < 0) return LOWERED[base] || base + '♭';
  return base;
}

/**
 * Decide where lines break; returns note-index ranges.
 *
 * Punctuation alone is a bad signal — "Au clair de la lune," is a comma in the
 * middle of a phrase, while "Götterfunken," ends one. So the music decides
 * first: a rest, or a syllable held out, is where a singer breathes and is a
 * hard break. Punctuation only proposes a break. Those pieces are then packed
 * into lines up to a readable width, and a piece is never split.
 */
function planLines(syllables) {
  const held = syllables.map(s => s.notes.reduce((n, x) => n + x.qdur, 0));

  // "Held out" only means anything relative to the tune: a half note is a
  // phrase ending in Ode to Joy and completely ordinary in Amazing Grace.
  const median = [...held].sort((a, b) => a - b)[held.length >> 1] || 1;
  const heldLimit = Math.max(1.6, median * 2);

  const pieces = [];
  let piece = [];
  for (let i = 0; i < syllables.length; i++) {
    piece.push(syllables[i]);
    const kind = breakAfter(syllables, i, held[i], heldLimit);
    if (kind) { pieces.push({ syllables: piece, hard: kind === 'hard' }); piece = []; }
  }
  if (piece.length) pieces.push({ syllables: piece, hard: true });

  const bounds = [];
  let group = [];
  for (const p of pieces) {
    group.push(p);
    if (!p.hard) continue;
    for (const line of pack(group)) {
      const flat = line.flatMap(x => x.syllables);
      bounds.push({ from: flat[0].firstNote, to: flat[flat.length - 1].lastNote });
    }
    group = [];
  }
  return bounds;
}

/** 'hard' (the music breathes), 'soft' (punctuation offers), or null. */
function breakAfter(syllables, i, held, heldLimit) {
  const syl = syllables[i];
  const next = syllables[i + 1];
  if (!next) return 'hard';
  if (syl.hyphenAfter) return null;                      // never break inside a word
  if (next.q - (syl.q + held) >= BREAK_GAP_QUARTERS) return 'hard';
  if (held >= heldLimit) return 'hard';
  return PUNCTUATED.test(syl.text) ? 'soft' : null;
}

/**
 * Split one breath-group into lines, minimising raggedness rather than filling
 * greedily — greedy would hang "Himmlische," off the end of the line before it
 * instead of starting the line it belongs to.
 */
function pack(pieces) {
  const n = pieces.length;
  const w = pieces.map(pieceWidth);
  const best = [0, ...Array(n).fill(Infinity)];
  const from = Array(n + 1).fill(0);

  for (let j = 1; j <= n; j++) {
    let width = -1;
    for (let i = j - 1; i >= 0; i--) {
      width += w[i] + 1;
      const over = width > MAX_LINE_CHARS;
      if (over && j - i > 1) break;                      // a lone piece may overflow
      const slack = MAX_LINE_CHARS - width;
      const cost = best[i] + (over ? 0 : slack * slack);
      if (cost < best[j]) { best[j] = cost; from[j] = i; }
    }
  }

  const lines = [];
  for (let j = n; j > 0; j = from[j]) lines.unshift(pieces.slice(from[j], j));
  return lines;
}

// Width as the reader sees it: syllables run together, joined by a hyphen or a space.
const pieceWidth = p => p.syllables.reduce((n, s) => n + s.text.length, 0) + p.syllables.length - 1;

function sliceLines(track, bounds) {
  return bounds.map((b, index) => {
    const syllables = track.syllables.filter(s => s.firstNote >= b.from && s.firstNote <= b.to);
    for (const s of syllables) s.line = index;
    const notes = syllables.flatMap(s => s.notes);
    return {
      index,
      track: track.key,
      syllables,
      notes,
      start: notes.length ? notes[0].start : 0,
      end: notes.length ? notes[notes.length - 1].end : 0,
      text: syllables.map((s, i) => s.text + (s.hyphenAfter || i === syllables.length - 1 ? '' : ' ')).join(''),
    };
  });
}

/** The line to show at time t: the one being sung, or the one about to be. */
export function lineIndexAt(track, t) {
  const lines = track.lines;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].notes.length && t < lines[i].end) return i;
  }
  return lines.length - 1;
}
