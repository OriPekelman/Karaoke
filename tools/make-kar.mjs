/**
 * Writes a genuine Soft-Karaoke .kar file, so the reader is tested against the
 * real format rather than against my idea of it: format 1, a Words track whose
 * text events carry @-tags and leading-space syllables, a melody on channel 4,
 * and an accompaniment underneath.
 */
import { writeFileSync } from 'node:fs';

const DIV = 480;
const bytes = a => Uint8Array.from(a);
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = n => [(n >>> 8) & 255, n & 255];

function varint(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}
const ascii = s => [...Buffer.from(s, 'utf8')];

function track(events) {
  // events: [{ tick, data: [...] }] — sorted, then written as deltas
  events.sort((a, b) => a.tick - b.tick);
  const body = [];
  let last = 0;
  for (const e of events) {
    body.push(...varint(e.tick - last), ...e.data);
    last = e.tick;
  }
  body.push(...varint(0), 0xff, 0x2f, 0x00);          // end of track
  return [...ascii('MTrk'), ...be32(body.length), ...body];
}

const meta = (type, text) => [0xff, type, ...varint(ascii(text).length), ...ascii(text)];
const noteOn = (ch, midi, vel = 90) => [0x90 | ch, midi, vel];
const noteOff = (ch, midi) => [0x80 | ch, midi, 0];

// ── the tune: Frère Jacques, with the syllables the format expects ──
// A leading space starts a word; no leading space continues one.
const melody = [
  ['C4', 1, ' Frè'], ['D4', 1, 're'], ['E4', 1, ' Jac'], ['C4', 1, 'ques,'],
  ['C4', 1, ' Frè'], ['D4', 1, 're'], ['E4', 1, ' Jac'], ['C4', 1, 'ques,'],
  ['E4', 1, ' Dor'], ['F4', 1, 'mez'], ['G4', 2, ' vous?'],
  ['E4', 1, ' Dor'], ['F4', 1, 'mez'], ['G4', 2, ' vous?'],
];
const PITCH = { C4: 60, D4: 62, E4: 64, F4: 65, G4: 67, C3: 48, G3: 55, E3: 52 };

const words = [
  { tick: 0, data: meta(0x01, '@KMIDI KARAOKE FILE') },
  { tick: 0, data: meta(0x01, '@V0100') },
  { tick: 0, data: meta(0x01, '@T Frère Jacques') },
  { tick: 0, data: meta(0x01, '@T traditionnel') },
  { tick: 0, data: meta(0x01, '@LFRENCH') },
];
const tune = [{ tick: 0, data: meta(0x03, 'Melody') }];
let tick = 0;
for (const [name, beats, syllable] of melody) {
  const midi = PITCH[name];
  const length = beats * DIV;
  words.push({ tick, data: meta(0x01, syllable) });
  tune.push({ tick, data: noteOn(4, midi) });
  tune.push({ tick: tick + length - 10, data: noteOff(4, midi) });
  tick += length;
}

// a plain accompaniment: root notes under each bar, on another channel
const under = [{ tick: 0, data: meta(0x03, 'Piano') }];
for (let bar = 0; bar * 4 * DIV < tick; bar++) {
  const at = bar * 4 * DIV;
  for (const midi of [PITCH.C3, PITCH.E3, PITCH.G3]) {
    under.push({ tick: at, data: noteOn(0, midi, 60) });
    under.push({ tick: at + 4 * DIV - 20, data: noteOff(0, midi) });
  }
}

// format 1, four tracks
const header = [...ascii('MThd'), ...be32(6), ...be16(1), ...be16(4), ...be16(DIV)];
const conductor = track([
  { tick: 0, data: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] },   // 500000 µs = 120bpm
  { tick: 0, data: [0xff, 0x59, 0x02, 0x00, 0x00] },         // C major
  { tick: 0, data: meta(0x03, 'Soft Karaoke') },
]);

const file = bytes([...header, ...conductor, ...track(words), ...track(tune), ...track(under)]);
const out = process.argv[2] ?? 'frere-jacques.kar';
writeFileSync(out, file);
console.log(`${out}  ${file.length} bytes · ${melody.length} syllables · 3 tracks`);
