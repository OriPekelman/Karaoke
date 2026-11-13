/**
 * A real instrument for the accompaniment.
 *
 * A thousand piano notes rendered as triangle waves sound like a test signal,
 * and the accompaniment is where most of the notes are. This loads actual
 * recorded piano notes — the FluidR3 General MIDI soundfont, rendered to one
 * mp3 per pitch and published on GitHub under CC-BY, which is both open and
 * reachable from a browser.
 *
 * Three things keep it honest. It loads **only the pitches a score actually
 * needs**, rounded to every third semitone and shifted at most a tone and a half
 * either way — a song usually wants a dozen files, not eighty-eight. The bytes
 * go into the same store everything else does, so the second time is free and
 * works offline. And if any of it fails — no network, a blocked host, a browser
 * that will not decode mp3 — nothing breaks: the synth falls back to the tone it
 * always used, which is why this is an improvement rather than a dependency.
 */

import { getCached, setCached } from './store.js';

const BASE = 'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM';
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const STEP = 3;              // a sample every three semitones: ±1.5 to reach any note
const LOW = 21, HIGH = 108;  // the range the soundfont covers, A0 to C8

const nameOf = midi => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

export class Instrument {
  constructor(ctx, name = 'acoustic_grand_piano') {
    this.ctx = ctx;
    this.name = name;
    this.buffers = new Map();     // anchor midi → AudioBuffer
    this.loading = new Map();
    this.failed = false;
  }

  /** The sampled pitch this note is played from. */
  anchor(midi) {
    const clamped = Math.max(LOW, Math.min(HIGH, Math.round(midi)));
    return Math.max(LOW, Math.min(HIGH, Math.round(clamped / STEP) * STEP));
  }

  has(midi) { return this.buffers.has(this.anchor(midi)); }

  /**
   * Fetch what these notes need, quietly. Failures are remembered rather than
   * retried on every note, and the caller is never made to wait.
   */
  async load(midis) {
    if (this.failed) return false;
    const wanted = [...new Set(midis.map(m => this.anchor(m)))]
      .filter(a => !this.buffers.has(a) && !this.loading.has(a));
    if (!wanted.length) return this.buffers.size > 0;

    await Promise.all(wanted.map(anchor => {
      const job = this._fetch(anchor)
        .then(buffer => { if (buffer) this.buffers.set(anchor, buffer); })
        .catch(() => {})
        .finally(() => this.loading.delete(anchor));
      this.loading.set(anchor, job);
      return job;
    }));

    if (!this.buffers.size) this.failed = true;
    return this.buffers.size > 0;
  }

  async _fetch(anchor) {
    const url = `${BASE}/${this.name}-mp3/${nameOf(anchor)}.mp3`;
    let bytes = await getCached(`sample:${url}`).catch(() => null);
    if (!bytes) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      bytes = await res.arrayBuffer();
      setCached(`sample:${url}`, bytes).catch(() => {});
    }
    // decodeAudioData detaches the buffer it is given, so it gets a copy.
    return this.ctx.decodeAudioData(bytes.slice(0));
  }

  /**
   * Sound one note. Returns false when this pitch is not loaded, which is the
   * caller's signal to fall back to the synthesised tone.
   */
  play(midi, at, dur, { gain = 1, destination, release = 0.18 }) {
    const anchor = this.anchor(midi);
    const buffer = this.buffers.get(anchor);
    if (!buffer) return null;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    // A recorded note carries its own attack and decay; pitch is all we change.
    source.playbackRate.value = Math.pow(2, (midi - anchor) / 12);

    const level = this.ctx.createGain();
    level.gain.setValueAtTime(gain, at);
    // Let it ring to the end of the note, then damp it as a finger leaves a key.
    level.gain.setTargetAtTime(0.0001, at + dur, release);

    source.connect(level).connect(destination);
    const stopAt = at + dur + release * 4;
    source.start(at);
    source.stop(stopAt);
    return { source, stop: () => { try { source.stop(); } catch { /* already done */ } } };
  }
}
