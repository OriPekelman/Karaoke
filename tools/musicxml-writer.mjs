/**
 * Writes MusicXML from a compact score spec — the shape used by the demos and
 * by anything you author yourself. See tools/example-song.mjs for a template.
 *
 * A spec looks like:
 *
 *   {
 *     title, composer, rights,
 *     divisions: 4,            // ticks per quarter note
 *     fifths: 0,               // key signature, +sharps / -flats
 *     beats: 4, beatType: 4,
 *     tempo: 96,               // quarter notes per minute
 *     tracks: [{ label: 'English', syllables: [...] }, ...],
 *     measures: [{ notes: ['E4/4', 'r/2', ...], pickup?: true }, ...],
 *   }
 *
 * For several singers — a round, a duet — give `parts` instead of `measures`:
 *
 *     parts: [{ name: 'Voice I', measures: [...] },
 *             { name: 'Voice II', measures: [...], tracks: [...] }]
 *
 * Each part gets its own note stream and so its own place in the piece; a part
 * without `tracks` of its own sings the score's, which is what a round wants,
 * while a duet gives each singer their own words. Track order is the language
 * order, and must agree between parts for the languages to line up.
 *
 * Note syntax: "G4/6" is a G in octave 4 lasting 6 divisions; "F#4/2" and
 * "Bb4/4" carry accidentals; "r/4" is a rest.
 *
 * Syllable syntax: one entry per *pitched* note, in order. "text" is a whole
 * word; "text|begin", "|middle", "|end" hyphenate a word across notes; "" means
 * the previous syllable is held across this note (a melisma).
 */

const STEP_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const ACCIDENTAL_NAME = { 2: 'double-sharp', 1: 'sharp', 0: 'natural', '-1': 'flat', '-2': 'flat-flat' };

const TYPE_BY_QUARTERS = [
  [4, 'whole'], [3, 'half'], [2, 'half'], [1.5, 'quarter'], [1, 'quarter'],
  [0.75, 'eighth'], [0.5, 'eighth'], [0.375, '16th'], [0.25, '16th'], [0.125, '32nd'],
];

export const keyAlter = (step, fifths) =>
  fifths > 0 ? (SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0)
    : fifths < 0 ? (FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0) : 0;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function noteType(quarters) {
  for (const [q, name] of TYPE_BY_QUARTERS) if (Math.abs(quarters - q) < 1e-6) return name;
  return 'quarter';
}
const isDotted = q => [3, 1.5, 0.75, 0.375].some(d => Math.abs(q - d) < 1e-6);

export function parsePitch(token) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(token);
  if (!m) throw new Error(`bad pitch: ${token}`);
  return { step: m[1], alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0, octave: Number(m[3]) };
}

/** One entry per singer, whether the spec names them or not. */
export const partsOf = spec =>
  spec.parts ?? [{ name: 'Voice', measures: spec.measures, tracks: spec.tracks }];

/** Throws with a useful message if a spec will not produce a singable score. */
export function validate(spec, name = 'score') {
  const bar = (spec.beats * 4 / spec.beatType) * spec.divisions;
  let total = 0;

  for (const part of partsOf(spec)) {
    const where = spec.parts ? `${name} / ${part.name}` : name;
    const pitched = part.measures.flatMap(m => m.notes).filter(n => !n.startsWith('r/')).length;
    for (const track of part.tracks ?? spec.tracks) {
      if (track.syllables.length !== pitched) {
        throw new Error(
          `${where}: track "${track.label}" has ${track.syllables.length} syllables for ${pitched} pitched notes. ` +
          `Every pitched note needs an entry — use "" for a note the previous syllable is held across.`);
      }
    }
    part.measures.forEach((m, i) => {
      if (m.pickup) return;
      const held = m.notes.reduce((s, n) => s + Number(n.split('/')[1]), 0);
      if (Math.abs(held - bar) > 1e-6) {
        throw new Error(`${where}: measure ${i + 1} holds ${held} divisions, expected ${bar}`);
      }
    });
    total += pitched;
  }
  return total;
}

export function buildMusicXML(spec) {
  const { title, composer, rights } = spec;
  const parts = partsOf(spec);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="4.0">');
  out.push('  <work><work-title>' + esc(title) + '</work-title></work>');
  out.push('  <identification>');
  if (composer) out.push('    <creator type="composer">' + esc(composer) + '</creator>');
  if (rights) out.push('    <rights>' + esc(rights) + '</rights>');
  out.push('    <encoding><software>karaoke/tools/musicxml-writer.mjs</software></encoding>');
  out.push('  </identification>');
  out.push('  <part-list>');
  parts.forEach((part, pi) => {
    out.push(`    <score-part id="P${pi + 1}"><part-name>${esc(part.name || `Voice ${pi + 1}`)}</part-name></score-part>`);
  });
  out.push('  </part-list>');

  parts.forEach((part, pi) => {
    out.push(`  <part id="P${pi + 1}">`);
    emitMeasures(out, part.measures, part.tracks ?? spec.tracks, spec);
    out.push('  </part>');
  });

  out.push('</score-partwise>');
  return out.join('\n') + '\n';
}

function emitMeasures(out, measures, tracks, spec) {
  const { divisions, fifths, beats, beatType, tempo } = spec;
  let syllableIndex = 0;
  measures.forEach((measure, mi) => {
    const implicit = measure.pickup ? ' implicit="yes"' : '';
    const number = measure.pickup ? 0 : mi + (measures[0].pickup ? 0 : 1);
    out.push(`    <measure number="${number}"${implicit}>`);

    if (mi === 0) {
      out.push('      <attributes>');
      out.push(`        <divisions>${divisions}</divisions>`);
      out.push(`        <key><fifths>${fifths}</fifths></key>`);
      out.push(`        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`);
      out.push('        <clef><sign>G</sign><line>2</line></clef>');
      out.push('      </attributes>');
      out.push(`      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`);
    }

    for (const token of measure.notes) {
      const [head, durText] = token.split('/');
      const duration = Number(durText);
      const quarters = duration / divisions;
      out.push('      <note>');

      if (head === 'r') {
        out.push('        <rest/>');
        out.push(`        <duration>${duration}</duration>`);
        out.push('        <voice>1</voice>');
        out.push(`        <type>${noteType(quarters)}</type>`);
        if (isDotted(quarters)) out.push('        <dot/>');
      } else {
        const { step, alter, octave } = parsePitch(head);
        out.push('        <pitch>');
        out.push(`          <step>${step}</step>`);
        if (alter) out.push(`          <alter>${alter}</alter>`);
        out.push(`          <octave>${octave}</octave>`);
        out.push('        </pitch>');
        out.push(`        <duration>${duration}</duration>`);
        out.push('        <voice>1</voice>');
        out.push(`        <type>${noteType(quarters)}</type>`);
        if (isDotted(quarters)) out.push('        <dot/>');
        if (alter !== keyAlter(step, fifths)) out.push(`        <accidental>${ACCIDENTAL_NAME[alter]}</accidental>`);

        // One <lyric> per language track, all hanging off this note.
        for (const [ti, track] of tracks.entries()) {
          const entry = track.syllables[syllableIndex];
          if (entry == null) continue;
          const [text, syllabic = 'single'] = String(entry).split('|');
          if (!text) continue;
          out.push(`        <lyric number="${ti + 1}" name="${esc(track.label)}">`);
          out.push(`          <syllabic>${syllabic}</syllabic>`);
          out.push(`          <text>${esc(text)}</text>`);
          out.push('        </lyric>');
        }
        syllableIndex++;
      }
      out.push('      </note>');
    }
    out.push('    </measure>');
  });
}

/** Split a whitespace-separated line of syllables. */
export const words = s => s.trim().split(/\s+/);
