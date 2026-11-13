/**
 * A soft guide tone that sings the melody with you, plus optional playback of a
 * dropped backing track. Both are scheduled against the transport's clock.
 */

import { Instrument } from './instrument.js';

const LOOKAHEAD = 0.4;   // seconds of notes queued ahead of the playhead
const TICK = 60;         // scheduler interval, ms
const BUS_GAIN = 0.28;     // one voice; shared out when there are more
const ACCOMP_GAIN = 0.12;  // underneath the singing, never level with it

export class Synth {
  constructor(ctx, transport) {
    this.ctx = ctx;
    this.transport = transport;
    this.notes = [];
    this.enabled = true;
    this.transpose = 0;
    this._cursor = 0;
    this._voices = new Set();
    this._timer = null;

    this.out = ctx.createGain();
    this.out.gain.value = 0.9;

    this.bus = ctx.createGain();
    this.bus.gain.value = BUS_GAIN;
    const colour = ctx.createBiquadFilter();
    colour.type = 'lowpass';
    colour.frequency.value = 2600;
    colour.Q.value = 0.4;
    this.bus.connect(colour).connect(this.out);
    this.out.connect(ctx.destination);

    // The accompaniment plays underneath, on its own bus: darker and quieter, so
    // it supports the line you are singing instead of competing with it. Its own
    // switch, too — the tone is your note, this is everyone else's.
    this.accompaniment = [];
    this.accompanying = false;
    this._accompCursor = 0;
    this.accompBus = ctx.createGain();
    this.accompBus.gain.value = ACCOMP_GAIN;
    const warmth = ctx.createBiquadFilter();
    warmth.type = 'lowpass';
    warmth.frequency.value = 1700;
    warmth.Q.value = 0.3;
    this.accompBus.connect(warmth).connect(this.out);

    // A recorded piano for the accompaniment when it can be had, the
    // synthesised tone when it cannot. The guide tone stays synthetic on
    // purpose: it has to sustain any length of note, and your own line should
    // not share a timbre with the instruments underneath it.
    this.piano = new Instrument(ctx, 'acoustic_grand_piano');

    // A shared, very slight vibrato keeps the tone from sounding like a test signal.
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 5.1;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 3.2;
    this.lfo.connect(this.lfoGain);
    this._awake = false;

    // `offset` is where the recording sits against song time; `stretch` is how
    // much longer a second of recording is than a second of score, so an aligned
    // cover plays at its own speed while the score's clock does the bending.
    this.track = { buffer: null, source: null, gain: ctx.createGain(), offset: 0, stretch: 1, name: '' };
    this.track.gain.gain.value = 0.9;
    this.track.gain.connect(this.out);
  }

  /**
   * Start the vibrato — but only once the browser has allowed the context to
   * run. Starting an oscillator on a context the autoplay policy has suspended
   * gets you a warning in the console at load, before the singer has done
   * anything at all, so it waits for the gesture like everything else.
   */
  wake() {
    if (this._awake || this.ctx.state !== 'running') return false;
    this.lfo.start();
    this._awake = true;
    return true;
  }

  /**
   * `voices` is how many people are singing at once, not how many notes there
   * are: a duet puts twice as much through the bus as a song does, so the bus
   * gives way by the square root of it — enough to keep the level steady,
   * little enough that a part still sounds like a part.
   */
  setNotes(notes, voices = 1) {
    this.notes = notes;
    this.bus.gain.value = BUS_GAIN / Math.sqrt(Math.max(1, voices));
    this.reset();
  }

  /** The other instruments, already timed against the same clock. */
  setAccompaniment(notes) {
    this.accompaniment = notes ?? [];
    this._accompCursor = 0;
    // Only the pitches this score reaches, and only once per session.
    if (this.accompaniment.length) {
      this.piano.load(this.accompaniment.map(n => n.midi + this.transpose)).catch(() => {});
    }
  }

  reset() {
    this._cursor = 0;
    for (const v of this._voices) v.stop();
    this._voices.clear();
    this.stopTrack();
  }

  start() {
    if (this._timer) return;
    this.wake();
    this._syncCursor();
    this.startTrack();
    this._timer = setInterval(() => this._schedule(), TICK);
    this._schedule();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    this.silence();
    this.stopTrack();
  }

  /** Let every sounding voice fall away, without touching the schedule. */
  silence() {
    for (const v of this._voices) v.release();
  }

  /** Called after a seek: drop anything queued and re-aim at the playhead. */
  resync() {
    for (const v of this._voices) v.stop();
    this._voices.clear();
    this._syncCursor();
    if (this._timer) { this.stopTrack(); this.startTrack(); }
  }

  _syncCursor() {
    const t = this.transport.time;
    this._cursor = 0;
    while (this._cursor < this.notes.length && this.notes[this._cursor].end <= t) this._cursor++;
    this._accompCursor = 0;
    while (this._accompCursor < this.accompaniment.length && this.accompaniment[this._accompCursor].end <= t) this._accompCursor++;
  }

  _schedule() {
    const horizon = this.transport.time + LOOKAHEAD * this.transport.rate;

    if (this.enabled) {
      while (this._cursor < this.notes.length && this.notes[this._cursor].start < horizon) {
        const note = this.notes[this._cursor++];
        const at = this.transport.contextTimeFor(note.start);
        if (at < this.ctx.currentTime - 0.05) continue;
        this._voice(note, at, (note.end - note.start) / this.transport.rate);
      }
    }

    if (this.accompanying) {
      while (this._accompCursor < this.accompaniment.length && this.accompaniment[this._accompCursor].start < horizon) {
        const note = this.accompaniment[this._accompCursor++];
        const at = this.transport.contextTimeFor(note.start);
        if (at < this.ctx.currentTime - 0.05) continue;
        this._voice(note, at, (note.end - note.start) / this.transport.rate, true);
      }
    } else {
      // Keep the cursor level with the clock so switching on lands in the right place.
      while (this._accompCursor < this.accompaniment.length && this.accompaniment[this._accompCursor].start < horizon) this._accompCursor++;
    }
  }

  _voice(note, at, dur, under = false) {
    const ctx = this.ctx;
    const midi = note.midi + this.transpose;

    if (under && this.piano.has(midi)) {
      const played = this.piano.play(midi, at, dur, { gain: 0.85, destination: this.accompBus });
      if (played) {
        const voice = {
          stop: () => { played.stop(); this._voices.delete(voice); },
          release: () => { played.stop(); this._voices.delete(voice); },
        };
        played.source.onended = () => this._voices.delete(voice);
        this._voices.add(voice);
        return;
      }
    }

    const freq = 440 * Math.pow(2, (midi - 69) / 12);

    const osc = ctx.createOscillator();
    osc.type = under ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(freq, at);
    if (!under) this.lfoGain.connect(osc.frequency);

    const shimmer = ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.setValueAtTime(freq * 2, at);

    // A third partial gives the sung tone a little body without making it
    // sound like an instrument competing with the accompaniment.
    const upper = ctx.createOscillator();
    upper.type = 'sine';
    upper.frequency.setValueAtTime(freq * 3, at);
    const upperGain = ctx.createGain();
    upperGain.gain.value = under ? 0 : 0.05;
    upper.connect(upperGain);

    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = under ? 0.04 : 0.12;
    shimmer.connect(shimmerGain);

    const gain = ctx.createGain();
    const peak = under ? 0.5 : 0.9;
    const attack = Math.min(under ? 0.012 : 0.03, dur * 0.2);
    // Struck rather than sung: the accompaniment decays instead of sustaining.
    const release = Math.min(under ? 0.3 : 0.12, dur * (under ? 0.9 : 0.35));
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + attack);
    gain.gain.setTargetAtTime(peak * (under ? 0.28 : 0.62), at + attack, under ? 0.16 : 0.09);
    gain.gain.setTargetAtTime(0.0001, at + Math.max(attack, dur - release), release / 3);

    osc.connect(gain);
    shimmerGain.connect(gain);
    upperGain.connect(gain);
    gain.connect(under ? this.accompBus : this.bus);

    const stopAt = at + dur + 0.3;
    osc.start(at); shimmer.start(at); upper.start(at);
    osc.stop(stopAt); shimmer.stop(stopAt); upper.stop(stopAt);

    const voice = {
      stop: () => { try { osc.stop(); shimmer.stop(); upper.stop(); } catch {} this._voices.delete(voice); },
      release: () => {
        const now = ctx.currentTime;
        try {
          gain.gain.cancelScheduledValues(now);
          gain.gain.setTargetAtTime(0.0001, now, 0.03);
          osc.stop(now + 0.2); shimmer.stop(now + 0.2); upper.stop(now + 0.2);
        } catch {}
        this._voices.delete(voice);
      },
    };
    osc.onended = () => this._voices.delete(voice);
    this._voices.add(voice);
  }

  // ── backing track ────────────────────────────────────────────────────

  async loadTrack(file) {
    const buffer = await this.ctx.decodeAudioData(await file.arrayBuffer());
    this.stopTrack();
    this.track.buffer = buffer;
    this.track.name = file.name;
    if (this.transport.playing) this.startTrack();
    return buffer;
  }

  clearTrack() {
    this.stopTrack();
    this.track.buffer = null;
    this.track.name = '';
    this.track.offset = 0;
    this.track.stretch = 1;
  }

  startTrack() {
    const { buffer } = this.track;
    if (!buffer) return;
    const songTime = this.transport.time;
    const stretch = this.track.stretch || 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    // The transport's own speed control still applies on top; when the score has
    // been stretched to match the recording, the two cancel and the recording
    // plays exactly as it was performed.
    src.playbackRate.value = this.transport.rate * stretch;
    src.connect(this.track.gain);

    const pos = songTime * stretch + this.track.offset;
    if (pos >= buffer.duration) return;
    if (pos < 0) src.start(this.transport.contextTimeFor(-this.track.offset / stretch), 0);
    else src.start(this.ctx.currentTime, pos);
    this.track.source = src;
  }

  stopTrack() {
    if (this.track.source) {
      try { this.track.source.stop(); } catch {}
      this.track.source = null;
    }
  }
}
