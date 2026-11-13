/**
 * MusicXML → singable note streams, one per voice.
 *
 * A "voice" here is a part+`<voice>` that carries lyrics: Zerlina and Don
 * Giovanni in a duet, the three lines of a round, or just the one vocal staff in
 * a song. Everything without words — accompaniment, dynamics, beaming, layout —
 * is discarded, because the app draws text and a dot, not a score.
 *
 * The other axis, `<lyric number>`, stays what it was: the same voice singing
 * the same notes in another language. Voices are *when*, tracks are *what in*.
 */

import { parseXML } from './dom.js';
import { chordText } from './chords.js';

const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const DEFAULT_TEMPO = 100;

/** What the key signature already does to this letter, e.g. F in G major → +1. */
export function keyAlterFor(step, fifths) {
  if (fifths > 0) return SHARP_ORDER.slice(0, Math.min(7, fifths)).includes(step) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, Math.min(7, -fifths)).includes(step) ? -1 : 0;
  return 0;
}

/**
 * Colour class of a note. A note is only "raised" or "lowered" relative to the
 * key it lives in — a B flat in B flat major is ordinary and stays neutral,
 * a B natural in the same key is an event and gets coloured.
 */
export function accidentalClass(step, alter, fifths) {
  const inKey = keyAlterFor(step, fifths);
  if (alter > inKey) return 'sharp';
  if (alter < inKey) return 'flat';
  return 'natural';
}

export const toMidi = (step, alter, octave) => (octave + 1) * 12 + STEP_SEMITONE[step] + alter;

const child = (parent, name) => {
  for (const c of parent.children) if (c.nodeName === name) return c;
  return null;
};
const children = (parent, name) => [...parent.children].filter(c => c.nodeName === name);
const num = (parent, name, fallback) => {
  const c = child(parent, name);
  const v = c ? parseFloat(c.textContent) : NaN;
  return isFinite(v) ? v : fallback;
};

export function parseMusicXML(text) {
  const doc = parseXML(text);
  if (doc.querySelector('parsererror')) throw new Error('file is not well-formed XML');

  const root = doc.documentElement;
  if (root.nodeName === 'score-timewise') {
    throw new Error('score-timewise is not supported — re-export as score-partwise');
  }
  if (root.nodeName !== 'score-partwise') throw new Error('not a MusicXML score');

  const parts = [...doc.getElementsByTagName('part')].filter(p => p.getAttribute('id'));
  if (!parts.length) throw new Error('score contains no parts');

  const partNames = new Map();
  for (const sp of doc.getElementsByTagName('score-part')) {
    partNames.set(sp.getAttribute('id'), child(sp, 'part-name')?.textContent?.trim() || '');
  }

  const tracks = new Map();   // lyric number → { key, label, order }
  const scanned = parts.map(p => scanPart(p, tracks));
  const picked = pickVoices(scanned);
  if (!picked.length) throw new Error('score contains no playable notes');

  const tempos = normaliseTempos(scanned.flatMap(s => s.tempos));
  const perPart = new Map();
  for (const p of picked) perPart.set(p.partIndex, (perPart.get(p.partIndex) || 0) + 1);

  const voices = picked.map((p, order) => {
    const raw = scanned[p.partIndex].notes.filter(n => n.voice === p.voice && !n.rest && !n.chord);
    const partId = parts[p.partIndex].getAttribute('id');
    return {
      key: `${partId}/${p.voice}`,
      label: voiceLabel(partNames.get(partId), p.voice, perPart.get(p.partIndex) > 1, order),
      order,
      notes: timeNotes(mergeTies(raw), tempos),
    };
  });

  const usedTracks = [...tracks.values()]
    .filter(t => voices.some(v => v.notes.some(n => n.lyrics[t.key])))
    .sort((a, b) => a.order - b.order);

  return {
    title: readWork(doc) || partNames.get(parts[picked[0].partIndex].getAttribute('id')) || 'Untitled',
    composer: readCreator(doc),
    voices,
    accompaniment: readAccompaniment(scanned, picked, parts, partNames, tempos),
    chords: timeChords(scanned.flatMap(part => part.chords), tempos),
    tracks: usedTracks.length ? usedTracks : [{ key: '1', label: 'Lyrics', order: 1 }],
    duration: Math.max(...voices.map(v => v.notes.at(-1)?.end ?? 0)),
    source: 'musicxml',
  };
}

/**
 * Everything that plays but does not sing — the piano under a Lied, the strings
 * under an aria. It is read from the same scan the voices came from, so it costs
 * nothing extra, and it keeps chord tones: an accompaniment without its chords
 * is not an accompaniment.
 *
 * Ties are merged per part and voice, because a tie only ever joins notes within
 * one line, and the result is one stream sorted by onset — which is all the
 * scheduler wants.
 */
function readAccompaniment(scanned, picked, parts, partNames, tempos) {
  const singing = new Set(picked.map(p => `${p.partIndex}/${p.voice}`));
  const lines = new Map();
  const players = new Set();

  scanned.forEach((part, partIndex) => {
    for (const note of part.notes) {
      if (note.rest || !note.step) continue;
      const key = `${partIndex}/${note.voice}`;
      if (singing.has(key)) continue;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(note);
      players.add(partNames.get(parts[partIndex].getAttribute('id')) || '');
    }
  });
  if (!lines.size) return null;

  const notes = [...lines.values()]
    .flatMap(line => timeNotes(mergeTies(line), tempos))
    .sort((a, b) => a.start - b.start || a.midi - b.midi)
    .map((n, i) => ({ ...n, index: i }));
  if (!notes.length) return null;

  const unique = [...new Set([...players].map(instrumentName).filter(Boolean))];
  return { label: unique.length === 1 ? unique[0] : 'Accompaniment', notes };
}

/**
 * A part name as a person would write it. Engravers set them for the page —
 * "PIANO." with a full stop, or a name broken across two lines — and none of
 * that belongs in a button.
 */
export function instrumentName(raw) {
  const name = (raw || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
  if (name.length > 2 && name === name.toUpperCase() && /\p{Lu}/u.test(name)) {
    return name.charAt(0) + name.slice(1).toLowerCase();
  }
  return name;
}

/**
 * Chord symbols on the same clock as everything else, in order, with the
 * duplicates a multi-staff part produces folded away — a piano writes the same
 * symbol over both staves and it should appear once.
 */
function timeChords(chords, tempos) {
  const seen = new Set();
  return chords
    .map(c => ({ ...c, start: quartersToSeconds(c.q, tempos) }))
    .sort((a, b) => a.start - b.start)
    .filter(c => {
      // One symbol per moment. A part written across two staves repeats it, and
      // a transposing instrument may even spell it differently — but two chords
      // cannot sound at the same instant, so the first spelling wins.
      const key = c.start.toFixed(2);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Position one voice's notes in seconds, and give them everything the app reads. */
function timeNotes(merged, tempos) {
  return merged.map((n, i) => {
    const start = quartersToSeconds(n.q, tempos);
    const end = quartersToSeconds(n.q + n.qdur, tempos);
    return {
      index: i,
      q: n.q,
      qdur: n.qdur,
      start,
      end,
      dur: Math.max(0.04, end - start),
      midi: toMidi(n.step, n.alter, n.octave),
      step: n.step,
      alter: n.alter,
      octave: n.octave,
      fifths: n.fifths,
      accidental: accidentalClass(n.step, n.alter, n.fifths),
      lyrics: n.lyrics,
    };
  });
}

/**
 * What to call a line on stage. Part names carry the engraver's line breaks and
 * font markup ("Singstimme\nVoice"), so only the first line of one survives.
 */
function voiceLabel(partName, voice, shareParts, order) {
  const name = (partName || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  if (!name) return `Voice ${order + 1}`;
  return shareParts ? `${name} ${voice}` : name;
}

function readWork(doc) {
  const wt = doc.getElementsByTagName('work-title')[0]?.textContent?.trim();
  if (wt) return wt;
  for (const c of doc.getElementsByTagName('credit-words')) {
    const t = c.textContent.trim();
    if (t) return t;
  }
  return '';
}

function readCreator(doc) {
  const list = [...doc.getElementsByTagName('creator')];
  const composer = list.find(c => c.getAttribute('type') === 'composer') || list[0];
  const lyricist = list.find(c => c.getAttribute('type') === 'lyricist');
  const bits = [composer?.textContent?.trim(), lyricist && lyricist !== composer ? `words: ${lyricist.textContent.trim()}` : '']
    .filter(Boolean);
  return bits.join(' · ');
}

/** Walk one <part>, producing notes stamped with absolute position in quarter notes. */
function scanPart(part, tracks) {
  let divisions = 4;
  let fifths = 0;
  let beats = 4, beatType = 4;
  let measureStart = 0;
  const notes = [];
  const tempos = [];
  const chords = [];

  for (const measure of children(part, 'measure')) {
    let cursor = 0;       // divisions from start of measure
    let furthest = 0;
    let chordAnchor = 0;

    const noteTempo = (el, atDiv) => {
      if (el.hasAttribute('tempo')) {
        const bpm = parseFloat(el.getAttribute('tempo'));
        if (isFinite(bpm) && bpm > 0) tempos.push({ q: measureStart + atDiv / divisions, bpm });
      }
    };

    for (const el of measure.children) {
      switch (el.nodeName) {
        case 'attributes': {
          divisions = num(el, 'divisions', divisions);
          const key = child(el, 'key');
          if (key) fifths = num(key, 'fifths', fifths);
          const time = child(el, 'time');
          if (time) { beats = num(time, 'beats', beats); beatType = num(time, 'beat-type', beatType); }
          break;
        }
        case 'direction': {
          for (const s of el.getElementsByTagName('sound')) noteTempo(s, cursor);
          break;
        }
        case 'harmony': {
          // A chord symbol belongs to the beat it is written over; <offset>
          // moves it, and it is in divisions like everything else here.
          const root = child(el, 'root');
          const bass = child(el, 'bass');
          const kindEl = child(el, 'kind');
          if (!root) break;
          const at = cursor + num(el, 'offset', 0);
          chords.push({
            q: measureStart + at / divisions,
            ...chordText({
              step: child(root, 'root-step')?.textContent?.trim(),
              alter: num(root, 'root-alter', 0),
              kind: kindEl?.textContent?.trim() || 'major',
              kindText: kindEl?.getAttribute('text') ?? undefined,
              bassStep: bass ? child(bass, 'bass-step')?.textContent?.trim() : undefined,
              bassAlter: bass ? num(bass, 'bass-alter', 0) : 0,
            }),
          });
          break;
        }
        case 'sound':
          noteTempo(el, cursor);
          break;
        case 'backup':
          cursor -= num(el, 'duration', 0);
          break;
        case 'forward':
          cursor += num(el, 'duration', 0);
          break;
        case 'note': {
          const grace = !!child(el, 'grace');
          const chord = !!child(el, 'chord');
          const rest = !!child(el, 'rest');
          const duration = grace ? 0 : num(el, 'duration', 0);
          const at = chord ? chordAnchor : cursor;

          const pitch = child(el, 'pitch');
          const note = {
            q: measureStart + at / divisions,
            qdur: duration / divisions,
            voice: child(el, 'voice')?.textContent?.trim() || '1',
            rest, chord, grace, fifths,
            step: pitch ? child(pitch, 'step')?.textContent?.trim() : null,
            alter: pitch ? num(pitch, 'alter', 0) : 0,
            octave: pitch ? num(pitch, 'octave', 4) : 4,
            tieStart: false,
            tieStop: false,
            lyrics: readLyrics(el, tracks),
          };
          for (const t of children(el, 'tie')) {
            if (t.getAttribute('type') === 'start') note.tieStart = true;
            if (t.getAttribute('type') === 'stop') note.tieStop = true;
          }
          if (!rest && !pitch) note.rest = true; // unpitched percussion — ignore as melody
          if (!grace) notes.push(note);

          if (!grace && !chord) { chordAnchor = cursor; cursor += duration; }
          break;
        }
      }
      if (cursor > furthest) furthest = cursor;
    }

    const measureQuarters = furthest > 0 ? furthest / divisions : (beats * 4) / beatType;
    measureStart += measureQuarters;
  }

  return { notes, tempos, chords };
}

/**
 * Every <lyric> line on a note becomes its own track — that is how a score
 * carries the same song in several languages, one verse number each.
 */
function readLyrics(noteEl, tracks) {
  const out = {};
  for (const l of children(noteEl, 'lyric')) {
    const key = l.getAttribute('number') || '1';
    const text = [...l.getElementsByTagName('text')].map(t => t.textContent).join('').trim();
    if (!text) continue;
    const given = l.getAttribute('name');
    if (!tracks.has(key)) {
      tracks.set(key, {
        key,
        label: given || guessLabel(text, key),
        // Whether the score said what this line *is*. A named line is a language
        // the engraver declared; a bare number could be a translation or the next
        // stanza, and only the words themselves can settle that.
        named: !!given,
        order: parseFloat(key) || tracks.size + 1,
      });
    } else if (!tracks.get(key).named && given) {
      tracks.get(key).label = given;
      tracks.get(key).named = true;
    }
    out[key] = {
      text,
      syllabic: child(l, 'syllabic')?.textContent?.trim() || 'single',
      extend: !!child(l, 'extend'),
    };
  }
  return out;
}

function guessLabel(text, key) {
  if (/[֐-׿]/.test(text)) return 'עברית / ייִדיש';
  if (/[؀-ۿ]/.test(text)) return 'العربية';
  if (/[Ѐ-ӿ]/.test(text)) return 'Русский';
  return `Verse ${key}`;
}

/**
 * Every voice that sings, in score order — so a duet arrives as two lines and
 * an aria as one. A part+voice qualifies on lyrics alone: that is what separates
 * Leporello from the flute doubling him, and it is why the orchestra never shows
 * up. The floor keeps a stray "Solo" or a two-word cue on a violin out.
 *
 * With no words anywhere there is nothing to qualify, so the busiest voice wins
 * and the app sings it in solfège.
 */
function pickVoices(scanned) {
  const all = [];
  for (let p = 0; p < scanned.length; p++) {
    const tally = new Map();
    for (const n of scanned[p].notes) {
      if (n.rest || n.chord) continue;
      const t = tally.get(n.voice) || { lyrics: 0, notes: 0 };
      if (n.lyrics && Object.keys(n.lyrics).length) t.lyrics++;
      t.notes++;
      tally.set(n.voice, t);
    }
    for (const [voice, t] of tally) all.push({ partIndex: p, voice, ...t });
  }

  const mostLyrics = Math.max(0, ...all.map(v => v.lyrics));
  if (mostLyrics > 0) {
    const floor = Math.max(3, mostLyrics * 0.12);
    return all.filter(v => v.lyrics >= floor);
  }
  const busiest = all.reduce((a, b) => (!a || b.notes > a.notes ? b : a), null);
  return busiest && busiest.notes ? [busiest] : [];
}

function mergeTies(raw) {
  const sorted = [...raw].sort((a, b) => a.q - b.q);
  const out = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.tieStart && n.tieStop &&
        prev.step === n.step && prev.alter === n.alter && prev.octave === n.octave) {
      prev.qdur += n.qdur;
      prev.tieStart = n.tieStart;
      for (const [k, v] of Object.entries(n.lyrics)) if (!prev.lyrics[k]) prev.lyrics[k] = v;
      continue;
    }
    out.push({ ...n });
  }
  return out;
}

function normaliseTempos(tempos) {
  const list = [...tempos].sort((a, b) => a.q - b.q);
  const out = [];
  for (const t of list) {
    if (out.length && Math.abs(out[out.length - 1].q - t.q) < 1e-6) out[out.length - 1] = t;
    else out.push(t);
  }
  if (!out.length || out[0].q > 1e-6) out.unshift({ q: 0, bpm: out[0]?.bpm ?? DEFAULT_TEMPO });
  return out;
}

/** Integrate the tempo map: quarter-note position → seconds. */
export function quartersToSeconds(q, tempos) {
  let seconds = 0;
  for (let i = 0; i < tempos.length; i++) {
    const from = tempos[i].q;
    const to = i + 1 < tempos.length ? tempos[i + 1].q : Infinity;
    if (q <= from) break;
    const span = Math.min(q, to) - from;
    seconds += span * (60 / tempos[i].bpm);
    if (q <= to) break;
  }
  return seconds;
}
