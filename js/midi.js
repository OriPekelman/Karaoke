/**
 * Standard MIDI files, and the karaoke dialect of them.
 *
 * A `.kar` is an ordinary MIDI file whose words ride in text meta-events: lines
 * beginning with `@` are metadata (`@T` title, `@L` language), `\` starts a new
 * paragraph and `/` a new line, and a syllable that continues a word arrives
 * with no leading space while one that starts a word arrives with a space. That
 * last convention is the whole of the hyphenation, and it is what lets a MIDI
 * file say "vor-rei" rather than "vor rei".
 *
 * The rest is the same reading the other formats get: whoever carries the words
 * is a voice, everything else is accompaniment, and the tempo map turns ticks
 * into seconds. There is a great deal of licensed karaoke MIDI in the world and
 * this is what opens it.
 */

import { accidentalClass } from './musicxml.js';

const SHARP_SPELLING = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const SHARP_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const DEFAULT_US_PER_QUARTER = 500000;      // 120bpm, what the spec assumes
const LYRIC_WINDOW = 0.35;                  // how near a note a syllable must fall

class Reader {
  constructor(bytes) { this.bytes = bytes; this.at = 0; }
  get done() { return this.at >= this.bytes.length; }
  u8() { return this.bytes[this.at++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0; }
  bytesOf(n) { const out = this.bytes.subarray(this.at, this.at + n); this.at += n; return out; }
  text(n) { return new TextDecoder('utf-8', { fatal: false }).decode(this.bytesOf(n)); }
  /** Variable-length quantity: seven bits at a time, high bit says "more". */
  varint() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return value;
  }
}

export function parseMidi(arrayBuffer) {
  const reader = new Reader(new Uint8Array(arrayBuffer));
  if (reader.text(4) !== 'MThd') throw new Error('not a MIDI file');
  reader.u32();                                   // header length, always 6
  reader.u16();                                   // format: 0, 1 or 2 — all read the same here
  const trackCount = reader.u16();
  const division = reader.u16();
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI is not supported — use a tick-based file');

  const tempos = [{ tick: 0, us: DEFAULT_US_PER_QUARTER }];
  const notes = [];        // { track, channel, tick, endTick, midi }
  const words = [];        // { tick, text }
  const trackNames = new Map();
  const meta = {};

  for (let track = 0; track < trackCount && !reader.done; track++) {
    if (reader.text(4) !== 'MTrk') break;
    // Read the length first, then take the position: `reader.at + reader.u32()`
    // would evaluate the left side before u32() advanced it, and every track
    // would end four bytes early.
    const length = reader.u32();
    const end = reader.at + length;
    let tick = 0;
    let status = 0;
    const open = new Map();                       // channel/pitch → the note-on waiting to close

    while (reader.at < end) {
      tick += reader.varint();
      let byte = reader.u8();
      if (byte < 0x80) { reader.at--; byte = status; } else { status = byte; }   // running status

      if (byte === 0xff) {                        // meta
        const type = reader.u8();
        const length = reader.varint();
        const body = type === 0x51 ? reader.bytesOf(length) : null;
        if (type === 0x51 && length === 3) {
          tempos.push({ tick, us: (body[0] << 16) | (body[1] << 8) | body[2] });
        } else if (type === 0x03) {
          trackNames.set(track, reader.text(length).trim());
        } else if (type === 0x59 && length === 2) {
          // Key signature: sharps positive, flats negative — the same `fifths`
          // the other readers use, so accidentals colour against the real key.
          const raw = reader.bytesOf(2);
          if (meta.fifths === undefined) meta.fifths = (raw[0] << 24) >> 24;
        } else if (type === 0x01 || type === 0x05) {
          // Both carry words: .kar uses text, the MIDI spec's own lyric event is 0x05.
          const text = reader.text(length);
          if (text.startsWith('@')) readTag(text, meta);
          else words.push({ tick, track, text });
        } else if (!body) {
          reader.bytesOf(length);
        }
        if (type === 0x2f) break;                 // end of track
      } else if (byte === 0xf0 || byte === 0xf7) {
        reader.bytesOf(reader.varint());          // sysex, of no interest here
      } else {
        const command = byte & 0xf0;
        const channel = byte & 0x0f;
        const a = reader.u8();
        const b = command === 0xc0 || command === 0xd0 ? 0 : reader.u8();
        const key = `${channel}:${a}`;
        if (command === 0x90 && b > 0) {
          open.set(key, { track, channel, tick, midi: a });
        } else if (command === 0x80 || (command === 0x90 && b === 0)) {
          const held = open.get(key);
          if (held) { held.endTick = tick; notes.push(held); open.delete(key); }
        }
      }
    }
    for (const held of open.values()) { held.endTick = tick; notes.push(held); }
    reader.at = end;
  }

  if (!notes.length) throw new Error('this MIDI file has no notes');
  return assemble({ notes, words, trackNames, meta, tempos, division });
}

/** `@T title`, `@L language`, `@KMIDI KARAOKE FILE` and friends. */
function readTag(text, meta) {
  const tag = text[1];
  const value = text.slice(2).trim();
  if (tag === 'T') meta.titles = [...(meta.titles ?? []), value];
  else if (tag === 'L') meta.language = value;
  else if (tag === 'I') meta.info = value;
}

function assemble({ notes, words, trackNames, meta, tempos, division }) {
  const map = tempos.sort((a, b) => a.tick - b.tick);
  const seconds = tickToSeconds(map, division);
  const quarters = tick => tick / division;

  // Whoever the words land on is the singer. A karaoke file puts the syllable at
  // the same tick as the note it belongs to, so an exact hit wins; otherwise the
  // nearest note within a beat or so claims it. The line with the most claims
  // carries the song.
  const sung = new Map();
  const byTick = new Map();
  for (const note of notes) {
    if (!byTick.has(note.tick)) byTick.set(note.tick, []);
    byTick.get(note.tick).push(note);
  }

  for (const word of words) {
    const stripped = word.text.replace(/[\\/]/g, '').trim();
    if (!stripped) continue;
    let best = highest(byTick.get(word.tick));
    if (!best) {
      let gap = Infinity;
      for (const note of notes) {
        const distance = Math.abs(seconds(note.tick) - seconds(word.tick));
        if (distance < gap) { gap = distance; best = note; }
      }
      if (gap > LYRIC_WINDOW) continue;
    }
    const key = `${best.track}:${best.channel}`;
    sung.set(key, (sung.get(key) ?? 0) + 1);
    (best.words ??= []).push(word.text);
  }

  const voiceKey = [...sung.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? busiestLine(notes);

  const isMine = n => `${n.track}:${n.channel}` === voiceKey;
  // The singing line is read as a melody, so a chord on it keeps its top note.
  const mine = onePerTick(notes.filter(isMine)).sort((a, b) => a.tick - b.tick);
  const rest = notes.filter(n => !isMine(n)).sort((a, b) => a.tick - b.tick);
  if (!mine.length) throw new Error('this MIDI file has no singable line');

  const fifths = meta.fifths ?? 0;
  const shape = (list, withWords) => list.map((n, index) => {
    const start = seconds(n.tick);
    const end = Math.max(start + 0.05, seconds(n.endTick ?? n.tick));
    const pc = ((n.midi % 12) + 12) % 12;
    const step = SHARP_SPELLING[pc];
    const alter = SHARP_ALTER[pc];
    return {
      index, q: quarters(n.tick), qdur: Math.max(0.05, quarters((n.endTick ?? n.tick) - n.tick)),
      start, end, dur: Math.max(0.04, end - start),
      midi: n.midi, step, alter, octave: Math.floor(n.midi / 12) - 1, fifths,
      accidental: accidentalClass(step, alter, fifths),
      lyrics: withWords ? { ...(n.lyric ?? {}) } : {},
    };
  });

  hyphenate(mine);
  const voiceNotes = shape(mine, true);
  const accompaniment = rest.length ? { label: 'Accompaniment', notes: shape(rest, false) } : null;
  const [track, channel] = voiceKey.split(':');

  return {
    title: meta.titles?.[0] || trackNames.get(Number(track)) || 'Untitled',
    composer: (meta.titles?.slice(1) ?? []).join(' · '),
    voices: [{
      key: voiceKey,
      label: trackNames.get(Number(track)) || `Channel ${Number(channel) + 1}`,
      order: 0,
      notes: voiceNotes,
    }],
    accompaniment,
    tracks: [{ key: '1', label: meta.language || 'Lyrics', order: 0, named: !!meta.language }],
    duration: voiceNotes.at(-1)?.end ?? 0,
    source: 'midi',
  };
}

/**
 * Turn the raw text events into syllables, and work out where the hyphens go.
 *
 * The convention is about *leading* space: a syllable that begins a word arrives
 * with one, a syllable that continues a word arrives without. So a note joins to
 * the next when the next syllable has no leading space — which means a syllable
 * can only be classified once its successor is known.
 */
function hyphenate(list) {
  const raw = list.map(n => (n.words ?? []).join(''));
  const sung = raw.map(text => text.replace(/[\\/]/g, ' ').trim());

  list.forEach((note, i) => {
    if (!sung[i]) return;
    // The next syllable that actually has words decides whether this one joins.
    let next = -1;
    for (let j = i + 1; j < list.length; j++) if (sung[j]) { next = j; break; }
    const joins = next >= 0 && !/^[\s\\/]/.test(raw[next]);
    note.lyric = { 1: { text: sung[i], syllabic: joins ? 'middle' : 'single', extend: false } };
  });
}

/** The top note of a chord: this line is read as a melody. */
function onePerTick(list) {
  const byTick = new Map();
  for (const note of list) {
    const held = byTick.get(note.tick);
    if (!held || note.midi > held.midi) byTick.set(note.tick, note);
  }
  return [...byTick.values()];
}

const highest = list => (list?.length ? list.reduce((a, b) => (b.midi > a.midi ? b : a)) : null);

function busiestLine(notes) {
  const tally = new Map();
  for (const n of notes) {
    const key = `${n.track}:${n.channel}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Integrate the tempo map: ticks → seconds. */
function tickToSeconds(map, division) {
  const marks = [{ tick: 0, seconds: 0, us: map[0]?.us ?? DEFAULT_US_PER_QUARTER }];
  for (const change of map) {
    if (change.tick === 0) { marks[0].us = change.us; continue; }
    const last = marks[marks.length - 1];
    const elapsed = (change.tick - last.tick) / division * (last.us / 1e6);
    marks.push({ tick: change.tick, seconds: last.seconds + elapsed, us: change.us });
  }
  return tick => {
    let mark = marks[0];
    for (const candidate of marks) { if (candidate.tick <= tick) mark = candidate; else break; }
    return mark.seconds + (tick - mark.tick) / division * (mark.us / 1e6);
  };
}
