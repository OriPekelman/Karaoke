/**
 * Best-effort reader for MuseScore's own format (.mscz / .mscx).
 *
 * MusicXML is the supported, well-specified path; this exists so a .mscz
 * dragged straight out of MuseScore usually just works. It covers the common
 * case — vocal staves, plain durations, dots, tuplets, ties, lyrics, and one
 * voice per singer — and deliberately ignores everything else.
 */

import { accidentalClass, quartersToSeconds, instrumentName } from './musicxml.js';
import { parseXML } from './dom.js';
import { chordText, stepFromTpc } from './chords.js';

// Fifths-ordered tonal pitch classes; 14 is a plain C.
const TPC_STEPS = ['C', 'G', 'D', 'A', 'E', 'B', 'F'];
const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DURATION_QUARTERS = {
  long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: .5,
  '16th': .25, '32nd': .125, '64th': .0625, '128th': .03125, '256th': .015625,
};

const child = (p, n) => { for (const c of p.children) if (c.nodeName === n) return c; return null; };
const children = (p, n) => [...p.children].filter(c => c.nodeName === n);
const text = (p, n, d = '') => child(p, n)?.textContent?.trim() ?? d;
const number = (p, n, d) => { const v = parseFloat(text(p, n, '')); return isFinite(v) ? v : d; };

function fromTpc(tpc, midi) {
  if (!isFinite(tpc)) {
    const pc = ((midi % 12) + 12) % 12;
    const sharpSpelling = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
    const alters = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
    return { step: sharpSpelling[pc], alter: alters[pc] };
  }
  const step = TPC_STEPS[((tpc % 7) + 7) % 7];
  const alter = Math.floor((tpc - 6) / 7) - 1;
  return { step, alter };
}

export function parseMuseScore(xmlText) {
  const doc = parseXML(xmlText);
  if (doc.querySelector('parsererror')) throw new Error('file is not well-formed XML');

  const score = doc.getElementsByTagName('Score')[0] || doc.documentElement;
  // Only the score's own staves: linked parts live in <Excerpt> and would
  // otherwise arrive a second time, as a chorus of duplicate singers.
  const staves = [...score.children].filter(s => s.nodeName === 'Staff' && child(s, 'Measure'));
  if (!staves.length) throw new Error('no staves found — export the score as MusicXML instead');

  const names = staffNames(score);
  const tempos = [];
  const rawChords = [];
  const lanes = staves.flatMap(staff => scanStaff(staff, tempos, rawChords)
    .map(lane => ({ ...lane, staff: staff.getAttribute('id') || '', name: names.get(staff.getAttribute('id')) || '' })));

  const picked = pickLanes(lanes);
  if (!picked.length) throw new Error('no playable notes found');

  const map = tempos.length ? tempos.sort((a, b) => a.q - b.q) : [{ q: 0, bpm: 100 }];
  if (map[0].q > 1e-6) map.unshift({ q: 0, bpm: map[0].bpm });

  const shared = new Set(picked.filter((l, i) => picked.some((o, j) => j !== i && o.staff === l.staff)).map(l => l.staff));

  const voices = picked.map((lane, order) => ({
    key: `${lane.staff}/${lane.voice}`,
    label: laneLabel(lane, shared.has(lane.staff), order),
    order,
    notes: lane.notes.map((n, i) => {
      const start = quartersToSeconds(n.q, map);
      const end = quartersToSeconds(n.q + n.qdur, map);
      return {
        index: i, q: n.q, qdur: n.qdur, start, end,
        dur: Math.max(0.04, end - start),
        midi: n.midi, step: n.step, alter: n.alter,
        octave: Math.floor(n.midi / 12) - 1,
        fifths: n.fifths,
        accidental: accidentalClass(n.step, n.alter, n.fifths),
        lyrics: n.lyrics,
      };
    }),
  }));

  // Whatever else plays. MuseScore's own format is read best-effort and only
  // the top note of a chord survives the scan, so this is a sketch of the
  // accompaniment rather than the whole of it; the MusicXML export is exact.
  const singing = new Set(picked.map(l => `${l.staff}/${l.voice}`));
  const rest = lanes.filter(l => l.notes.length && !singing.has(`${l.staff}/${l.voice}`));
  const accompaniment = rest.length ? {
    label: [...new Set(rest.map(l => instrumentName(l.name)).filter(Boolean))].length === 1
      ? instrumentName(rest[0].name) : 'Accompaniment',
    notes: rest
      .flatMap(lane => lane.notes.map(n => {
        const start = quartersToSeconds(n.q, map);
        const end = quartersToSeconds(n.q + n.qdur, map);
        return {
          q: n.q, qdur: n.qdur, start, end, dur: Math.max(0.04, end - start),
          midi: n.midi, step: n.step, alter: n.alter, octave: Math.floor(n.midi / 12) - 1,
          fifths: n.fifths, accidental: accidentalClass(n.step, n.alter, n.fifths), lyrics: {},
        };
      }))
      .sort((a, b) => a.start - b.start || a.midi - b.midi)
      .map((n, i) => ({ ...n, index: i })),
  } : null;

  const trackKeys = [...new Set(voices.flatMap(v => v.notes.flatMap(n => Object.keys(n.lyrics))))].sort();

  const meta = doc.getElementsByTagName('metaTag');
  const tag = name => [...meta].find(m => m.getAttribute('name') === name)?.textContent?.trim() || '';

  return {
    title: tag('workTitle') || tag('movementTitle') || 'Untitled',
    composer: [tag('composer'), tag('lyricist') && `words: ${tag('lyricist')}`].filter(Boolean).join(' · '),
    voices,
    accompaniment,
    chords: dedupeChords(rawChords, map),
    tracks: (trackKeys.length ? trackKeys : ['1']).map((key, i) => ({ key, label: `Verse ${key}`, order: i })),
    duration: Math.max(...voices.map(v => v.notes.at(-1)?.end ?? 0)),
    source: 'musescore',
  };
}

/** Chord symbols in seconds, in order, each written once. */
function dedupeChords(chords, map) {
  const seen = new Set();
  return chords
    .map(c => ({ ...c, start: quartersToSeconds(c.q, map) }))
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

/** Staff id → the instrument name its <Part> declares. */
function staffNames(score) {
  const names = new Map();
  for (const part of [...score.children].filter(c => c.nodeName === 'Part')) {
    const name = (text(part, 'trackName', '') || text(part, 'longName', '')).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    for (const staff of children(part, 'Staff')) names.set(staff.getAttribute('id'), name);
  }
  return names;
}

/** Same rule as the MusicXML side: a lane sings if it carries words. */
function pickLanes(lanes) {
  const withNotes = lanes.filter(l => l.notes.length);
  const mostLyrics = Math.max(0, ...withNotes.map(l => l.lyricCount));
  if (mostLyrics > 0) {
    const floor = Math.max(3, mostLyrics * 0.12);
    return withNotes.filter(l => l.lyricCount >= floor);
  }
  const busiest = withNotes.reduce((a, b) => (!a || b.notes.length > a.notes.length ? b : a), null);
  return busiest ? [busiest] : [];
}

function laneLabel(lane, sharesStaff, order) {
  if (!lane.name) return `Voice ${order + 1}`;
  return sharesStaff ? `${lane.name} ${lane.voice}` : lane.name;
}

/**
 * One staff, every voice lane on it. Two singers sharing a stave is ordinary in
 * a hymnal or a two-part song, so each lane is kept and judged on its own words;
 * whoever is only holding the bar open gets dropped later, for lack of lyrics.
 */
function scanStaff(staff, tempos, chords) {
  let q = 0;
  let fifths = 0;
  const byVoice = new Map();
  const laneOf = key => {
    if (!byVoice.has(key)) byVoice.set(key, { voice: key, notes: [], lyricCount: 0, openTies: [] });
    return byVoice.get(key);
  };

  for (const measure of children(staff, 'Measure')) {
    const voices = children(measure, 'voice');
    const lanes = voices.length ? voices : [measure];
    let measureLength = 0;

    lanes.forEach((lane, laneIndex) => {
      const out = laneOf(String(laneIndex + 1));
      let cursor = q;
      for (const el of lane.children) {
        switch (el.nodeName) {
          case 'KeySig':
            fifths = number(el, 'accidental', number(el, 'concertClefType', fifths)) || 0;
            break;
          case 'Tempo': {
            const bps = number(el, 'tempo', NaN);
            if (isFinite(bps) && bps > 0) tempos.push({ q: cursor, bpm: bps * 60 });
            break;
          }
          case 'Tuplet':
            lane._tuplet = number(el, 'normalNotes', 1) / Math.max(1, number(el, 'actualNotes', 1));
            break;
          case 'endTuplet':
            lane._tuplet = 1;
            break;
          case 'Harmony': {
            // MuseScore stores the root as a tonal pitch class and the quality
            // as the text a player would read; both are what we want.
            const root = stepFromTpc(number(el, 'root', NaN));
            if (!root) break;
            const bass = stepFromTpc(number(el, 'base', NaN));
            chords.push({
              q: cursor,
              ...chordText({
                step: root.step, alter: root.alter,
                kindText: text(el, 'name', ''),
                bassStep: bass?.step, bassAlter: bass?.alter ?? 0,
              }),
            });
            break;
          }
          case 'Rest':
            cursor += durationOf(el, lane._tuplet || 1, 4);
            break;
          case 'Chord': {
            const qdur = durationOf(el, lane._tuplet || 1, 4);
            const noteEls = children(el, 'Note');
            // Melody = top note of any chord.
            let top = null;
            for (const ne of noteEls) {
              const midi = number(ne, 'pitch', NaN);
              if (!isFinite(midi)) continue;
              if (!top || midi > top.midi) top = { midi, tpc: number(ne, 'tpc', NaN), el: ne };
            }
            if (top) {
              const { step, alter } = fromTpc(top.tpc, top.midi);
              const lyrics = readLyrics(el);
              const lyric = Object.keys(lyrics).length ? lyrics : null;
              if (lyric) out.lyricCount++;
              const tiedFrom = out.openTies.length && out.openTies[out.openTies.length - 1] === top.midi;
              // A tie that continues forward is a Spanner with a <next> anchor.
              const hasTie = [...top.el.getElementsByTagName('Spanner')]
                .some(s => s.getAttribute('type') === 'Tie' && child(s, 'next'));
              if (tiedFrom && out.notes.length && !lyric) {
                out.notes[out.notes.length - 1].qdur += qdur;
                out.openTies.pop();
              } else {
                out.notes.push({ q: cursor, qdur, midi: top.midi, step, alter, fifths, lyrics });
              }
              if (hasTie) out.openTies.push(top.midi); else out.openTies.length = 0;
            }
            cursor += qdur;
            break;
          }
        }
      }
      measureLength = Math.max(measureLength, cursor - q);
    });

    q += measureLength > 0 ? measureLength : 4;
  }

  return [...byVoice.values()].map(({ voice, notes, lyricCount }) => ({ voice, notes, lyricCount }));
}

function durationOf(el, tupletRatio, fallbackBarQuarters) {
  const type = text(el, 'durationType', 'quarter');
  if (type === 'measure') return fallbackBarQuarters;
  let base = DURATION_QUARTERS[type];
  if (base == null) return 1;
  const dots = number(el, 'dots', 0);
  let total = base;
  for (let i = 0; i < dots; i++) total += base / Math.pow(2, i + 1);
  return total * tupletRatio;
}

/** One entry per verse; MuseScore numbers them with <no>, zero-based. */
function readLyrics(chordEl) {
  const out = {};
  for (const l of children(chordEl, 'Lyrics')) {
    const t = text(l, 'text', '').replace(/<[^>]*>/g, '').trim();
    if (!t) continue;
    const key = String(number(l, 'no', 0) + 1);
    const syllabicCode = number(l, 'syllabic', NaN);
    // Newer files write the enum as a string; older ones as a number.
    const asText = text(l, 'syllabic', '');
    const syllabic = asText || ({ 0: 'single', 1: 'begin', 2: 'end', 3: 'middle' })[syllabicCode] || 'single';
    out[key] = { text: t, syllabic, extend: !!child(l, 'ticks') };
  }
  return out;
}

export { STEP_SEMITONE };
