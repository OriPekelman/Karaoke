/**
 * The dot.
 *
 * It rides above the words: x follows the syllable being sung, y follows the
 * pitch. It never jumps between notes — position is an exponential glide, and
 * the sense of a new note comes from the pulse instead: a fast attack, a decay
 * to sustain, a fade before release, plus a ring that expands away on the onset.
 * Colour says whether the note sits outside the key.
 *
 * With several singers there is a dot each, lettered so you can tell them apart
 * at a glance, and all of them share one pitch scale — so a bass really does sit
 * below a soprano and the harmony is a vertical distance you can read. A dot is
 * filled while its voice sounds and hollow while it does not, so entries and
 * releases are visible: a ring expands away on the way in and closes on the way
 * out, and a ring fills around a waiting dot as its entry approaches.
 *
 * And because a phrase you cannot see is a phrase you cannot prepare, the last
 * seconds of a line sketch the next one to the right of it: a hollow target at
 * the pitch you have to find, a dotted line from where you are to where that is,
 * and the shape that follows it. Same band, same scale, so the interval is a
 * distance on the screen rather than something to work out.
 */

import { approach, clamp, envelope, easeOutCubic } from './util.js';

const BAND_PAD_TOP = 26;
const BAND_GAP = 30;          // breathing room between contour and the text
const GLIDE_Y = 0.052;        // seconds; how quickly pitch is chased
const GLIDE_X = 0.070;
const BASE_RADIUS = 10;
const RIPPLE_LIFE = 0.5;
const REST_BREATH = 0.9;      // a gap this long reads as a release, not a step
const AHEAD_WINDOW = 4.0;     // seconds before an entry that the next phrase appears
const AHEAD_NOTES = 6;        // how much of it is worth sketching
const LANE_FADE = 0.55;       // how far the voices that are not yours step back
const COUNT_IN_MAX = 8;       // beats worth counting before an entry
const AHEAD_SCALE = 0.5;      // the sketch is half the stage's own scale, both ways
const AHEAD_SCALE_MIN = 0.22; // below this it stops being readable; trim notes instead

export class Stage {
  constructor(canvas, bandEl, lineEl) {
    this.canvas = canvas;
    this.bandEl = bandEl;
    this.lineEl = lineEl;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.voices = [];
    this.lanes = [];
    this.range = null;
    this.rects = null;
    this.tonic = 0;

    // Dots outlive layout: a line change moves the words, not the singer.
    this.state = new Map();
    this.ripples = [];
    this.alpha = 1;
    this._lastFrame = 0;
    this.colours = readColours();

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
  }

  refreshColours() { this.colours = readColours(); }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.rect = rect;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    // Assigning width or height throws the backing store away and reallocates
    // it — several megabytes — so it is only done when the size really changed.
    if (dpr === this.dpr && w === this.canvas.width && h === this.canvas.height) return;
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /**
   * Which voices are drawn, yours first. One scale covers all of them, so the
   * band widens as voices are added and pitches stay comparable between them.
   */
  setVoices(voices) {
    this.voices = voices ?? [];
    this.lanes = [];
    this.state.clear();
    this.ripples.length = 0;
    this.range = unionRange(this.voices);
    const lead = this.voices[0];
    this.tonic = lead ? ((lead.notes[lead.notes.length - 1].midi % 12) + 12) % 12 : 0;
  }

  /** Geometry of the pitch band, in canvas-local pixels. */
  band() {
    const origin = this.canvas.getBoundingClientRect();
    const b = this.bandEl.getBoundingClientRect();
    const l = this.lineEl.getBoundingClientRect();
    const top = b.top - origin.top + BAND_PAD_TOP;
    const bottom = l.top - origin.top - BAND_GAP;
    return { top, bottom: Math.max(top + 40, bottom) };
  }

  yFor(midi, band) {
    const { lo, hi } = this.range;
    const t = clamp((midi - lo) / (hi - lo), 0, 1);
    return band.bottom - t * (band.bottom - band.top);
  }

  /**
   * Recompute note positions for the visible line of every drawn voice.
   * `rows` comes from LyricView.geometry(), in stacking order.
   */
  layout(rows) {
    this.lanes = [];
    if (!this.range || !rows?.length) return;
    const band = this.band();
    this._band = band;

    this.lanes = rows.map((row, i) => {
      const points = [];
      for (const syl of row.line?.syllables ?? []) {
        const r = row.rects?.get(syl.index);
        if (!r) continue;
        const k = syl.notes.length;
        syl.notes.forEach((note, n) => {
          const x = k === 1 ? r.centre : r.left + (r.right - r.left) * ((n + 0.5) / k);
          points.push({ note, syl, x, y: this.yFor(note.midi, band) });
        });
      }
      return {
        voice: row.voice,
        lead: i === 0,
        badge: row.voice.badge,
        points,
        // Only your own next phrase is sketched: everyone's would be a thicket.
        ahead: i === 0 ? this._sketch(row.nextLine, points, band) : null,
        state: this._stateFor(row.voice.key),
      };
    });
    this.rects = rows[0]?.rects ?? null;
  }

  _stateFor(key) {
    if (!this.state.has(key)) this.state.set(key, { dot: { x: 0, y: 0, ready: false }, lastNote: -1 });
    return this.state.get(key);
  }

  /**
   * The next phrase, laid out in the strip to the right of the current line.
   * Its notes have no words on screen yet, so they are spaced evenly — the
   * heights are the information, and those are true.
   */
  _sketch(line, points, band) {
    if (!line?.notes?.length || !this.rect) return null;
    let notes = line.notes.slice(0, AHEAD_NOTES);
    const lastX = points.length ? Math.max(...points.map(p => p.x)) : 0;
    const right = this.rect.width - 16;
    const from = Math.max(lastX + 36, this.rect.width * 0.72);
    if (right - from < 24) return null;                    // no room to say anything

    // A miniature, not a squashed copy. The sketch keeps the proportions of the
    // stage it sits on — the same pixels-per-note against pixels-per-semitone —
    // so a fourth in the phrase ahead looks like a fourth, and the shape you are
    // about to sing is the shape you will sing. Only the size changes.
    const spread = points.length > 1
      ? (lastX - Math.min(...points.map(p => p.x))) / (points.length - 1)
      : 44;
    const perNote = Math.max(18, Math.min(spread, 90));
    const perSemitone = (band.bottom - band.top) / (this.range.hi - this.range.lo);

    // The entry note keeps its true height, so its pitch stays comparable with
    // where the dot is now; the rest of the phrase hangs off it to scale.
    const anchor = this.yFor(notes[0].midi, band);
    const fit = (list, scale) => list.map((note, i) => ({
      note,
      x: from + i * perNote * scale,
      y: anchor - (note.midi - list[0].midi) * perSemitone * scale,
    }));

    let scale = Math.min(AHEAD_SCALE, (right - from) / Math.max(1, (notes.length - 1) * perNote));
    let sketched = fit(notes, scale);
    // Trim rather than shrink past legibility, and never draw outside the band.
    while (notes.length > 2 && (scale < AHEAD_SCALE_MIN || outsideBand(sketched, band))) {
      notes = notes.slice(0, -1);
      scale = Math.min(AHEAD_SCALE, (right - from) / Math.max(1, (notes.length - 1) * perNote));
      sketched = fit(notes, scale);
    }
    if (outsideBand(sketched, band)) return null;

    const first = notes[0];
    // Beats, not seconds: the count-in is only worth reading in the tune's own units.
    const perSecond = first.qdur / Math.max(0.05, first.end - first.start);
    return {
      start: line.start,
      lead: AHEAD_WINDOW,
      quarters: AHEAD_WINDOW * perSecond,
      points: sketched,
    };
  }

  /** Drop the glide: used after a seek, or when a voice's line has changed. */
  snap(key) {
    if (key == null) for (const s of this.state.values()) s.dot.ready = false;
    else if (this.state.has(key)) this.state.get(key).dot.ready = false;
  }

  render(time, { active = true } = {}) {
    const ctx = this.ctx;
    const now = performance.now() / 1000;
    const dt = this._lastFrame ? clamp(now - this._lastFrame, 0, 0.1) : 0.016;
    this._lastFrame = now;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const drawable = this.lanes.filter(l => l.points.length);
    if (!this.range || !drawable.length) return;

    const band = this._band || this.band();
    const c = this.colours;
    this._grid(ctx, band, c);

    const solo = drawable.length === 1;
    const resolved = drawable.map(lane => {
      const r = resolve(lane, time, now);
      const dot = lane.state.dot;
      if (!dot.ready) { dot.x = r.target.x; dot.y = r.target.y; dot.ready = true; }
      else if (active) {
        dot.x = approach(dot.x, r.target.x, dt, GLIDE_X);
        dot.y = approach(dot.y, r.target.y, dt, GLIDE_Y);
      } else { dot.x = r.target.x; dot.y = r.target.y; }
      this._marks(lane, r, time, now, c);
      return { lane, r, dot };
    });

    // Lines and note markers first, so every dot sits above every contour.
    for (const { lane, r } of resolved) {
      const fade = lane.lead ? 1 : LANE_FADE;
      this._contour(ctx, lane.points, r.index, c, fade);
      this._markers(ctx, lane.points, r.index, c, fade);
    }
    this._ripples(ctx, now);

    const lead = resolved.find(x => x.lane.lead);
    if (lead) this._ahead(ctx, lead, time, c);

    for (const { lane, r, dot } of resolved) {
      const colour = c[r.target.note.accidental];
      if (r.waiting) this._countIn(ctx, time, r.waiting, colour, dot, lane.lead ? 1 : LANE_FADE);
      this._dot(ctx, {
        x: dot.x, y: dot.y, env: r.env, colour,
        hollow: !r.sounding,
        badge: solo ? '' : lane.badge,
        scale: lane.lead ? 1 : 0.86,
        fade: lane.lead ? 1 : LANE_FADE,
      });
    }
  }

  /** Ripples: expanding where a voice comes in, closing where it lets go. */
  _marks(lane, r, time, now, c) {
    const { state, points } = lane;
    if (r.index === state.lastNote) return;

    const entered = r.index >= 0 && time < points[r.index].note.end;
    if (entered) {
      const p = points[r.index];
      this.ripples.push({ x: p.x, y: p.y, t0: now, colour: c[p.note.accidental], dir: 1, fade: lane.lead ? 1 : LANE_FADE });
    } else if (state.lastNote >= 0 && points[state.lastNote]) {
      // Past the end of a note with a real gap after it: a release worth marking.
      const p = points[state.lastNote];
      const next = points[state.lastNote + 1];
      if (!next || next.note.start - p.note.end >= REST_BREATH) {
        this.ripples.push({ x: p.x, y: p.y, t0: now, colour: c[p.note.accidental], dir: -1, fade: lane.lead ? 1 : LANE_FADE });
      }
    }
    state.lastNote = r.index;
  }

  _grid(ctx, band, c) {
    const { lo, hi } = this.range;
    ctx.save();
    ctx.strokeStyle = c.faint;
    ctx.lineWidth = 1;
    for (let m = Math.ceil(lo / 12) * 12 + this.tonic; m <= hi; m += 12) {
      if (m < lo) continue;
      const y = Math.round(this.yFor(m, band)) + .5;
      ctx.beginPath();
      ctx.moveTo(this.rect.width * 0.06, y);
      ctx.lineTo(this.rect.width * 0.94, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _contour(ctx, points, idx, c, fade) {
    if (points.length < 2) return;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.strokeStyle = c.faint;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();

    // The stretch still to come reads a touch brighter — that is the "next notes".
    const from = Math.max(0, idx);
    const upcoming = points.slice(from, from + 7);
    if (upcoming.length > 1 && Math.abs(upcoming[0].x - upcoming[upcoming.length - 1].x) > 1) {
      const grad = ctx.createLinearGradient(upcoming[0].x, 0, upcoming[upcoming.length - 1].x, 0);
      grad.addColorStop(0, c.soft);
      grad.addColorStop(1, c.faint);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      upcoming.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.restore();
  }

  _markers(ctx, points, idx, c, fade) {
    ctx.save();
    points.forEach((p, i) => {
      const ahead = i - idx;
      let a;
      if (ahead < 0) a = 0.14;
      else if (ahead === 0) a = 0.0;               // the dot occupies this one
      else a = clamp(0.62 - (ahead - 1) * 0.075, 0.12, 0.62);
      if (a <= 0.005) return;
      const altered = p.note.accidental !== 'natural';
      ctx.globalAlpha = a * this.alpha * fade;
      ctx.fillStyle = altered ? c[p.note.accidental] : c.ink;
      ctx.beginPath();
      ctx.arc(p.x, p.y, altered ? 3.1 : 2.4, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  _ripples(ctx, now) {
    ctx.save();
    this.ripples = this.ripples.filter(r => now - r.t0 < RIPPLE_LIFE);
    for (const r of this.ripples) {
      const t = (now - r.t0) / RIPPLE_LIFE;
      const grow = easeOutCubic(t);
      const radius = r.dir < 0
        ? BASE_RADIUS * (3.4 - grow * 2.6)          // closing in on the note it left
        : BASE_RADIUS * (1 + grow * 2.6);
      ctx.globalAlpha = (1 - t) * 0.42 * this.alpha * (r.fade ?? 1);
      ctx.strokeStyle = r.colour;
      ctx.lineWidth = 1.4 * (1 - t) + 0.4;
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(1, radius), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The phrase after this one, while there is still time to prepare it. */
  _ahead(ctx, { lane, dot }, time, c) {
    const sketch = lane.ahead;
    if (!sketch) return;
    const until = sketch.start - time;
    if (until <= 0 || until > AHEAD_WINDOW) return;

    const near = easeOutCubic(clamp(1 - until / AHEAD_WINDOW, 0, 1));
    const target = sketch.points[0];
    const colour = c[target.note.accidental];
    ctx.save();

    // Where you are now, to where you have to be.
    ctx.globalAlpha = 0.34 * near * this.alpha;
    ctx.strokeStyle = c.soft;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(dot.x, dot.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // The shape that follows the entry.
    if (sketch.points.length > 1) {
      ctx.globalAlpha = 0.5 * near * this.alpha;
      ctx.strokeStyle = c.faint;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      sketch.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();

      ctx.globalAlpha = 0.42 * near * this.alpha;
      ctx.fillStyle = c.ink;
      for (const p of sketch.points.slice(1)) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // The note you have to find.
    ctx.globalAlpha = 0.85 * near * this.alpha;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(target.x, target.y, BASE_RADIUS * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // And how many beats you have to find it in.
    this._countIn(ctx, time, { from: sketch.start - sketch.lead, to: sketch.start, note: target.note },
      colour, target, near);
  }

  /**
   * The count-in: one mark per beat before an entry, going out left to right as
   * the beats pass — what a conductor gives you, and countable at a glance. It
   * is deliberately not a sweeping ring: a circle filling itself reads as a
   * machine thinking, which is the last thing to say to someone about to sing.
   */
  _countIn(ctx, time, span, colour, at, fade) {
    // The beats are the score's, not the gap's. Counting by dividing the wait
    // into equal parts only lands on the beat by luck — a rest that begins
    // off-beat would have the whole count sitting between the beats, which is
    // worse than no count at all. So the ticks are laid back from the entry, one
    // beat apart in the tune's own tempo, and the pulse falls where the beat is.
    const beat = beatSeconds(span.note);
    if (!beat) return;
    const room = span.to - span.from;
    if (room < beat * 0.9) return;

    // On the score's beats, not on offsets from the entry: a singer who comes in
    // on an upbeat needs to see where the beat *is*, and come in between two of
    // them. So the marks sit on whole quarter-notes of the piece, and the last
    // one falls before the entry rather than on it.
    const times = [];
    const firstBeat = Math.floor(span.note.q - 1e-6);
    for (let k = 0; k < COUNT_IN_MAX; k++) {
      const q = firstBeat - k;
      const when = span.to - (span.note.q - q) * beat;
      if (when < span.from - 1e-6) break;
      times.unshift(when);
    }
    if (!times.length) return;

    // Which beat is sounding, and how far through it we are.
    let current = -1;
    for (let i = 0; i < times.length; i++) if (time >= times[i]) current = i;
    const since = current < 0 ? Infinity : (time - times[current]) / beat;
    const pulse = current < 0 ? 0 : Math.pow(Math.max(0, 1 - since), 2.6);

    const gap = 12;
    const above = at.y - BASE_RADIUS * 2.8;
    const y = above < 16 ? at.y + BASE_RADIUS * 2.8 : above;
    const x0 = at.x - ((times.length - 1) * gap) / 2;

    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineCap = 'round';
    for (let i = 0; i < times.length; i++) {
      const spent = i < current;
      const beating = i === current;
      const half = spent ? 1.7 : 5.2 * (beating ? 1 + 0.95 * pulse : 1);
      ctx.globalAlpha = (spent ? 0.12 : beating ? 0.45 + 0.55 * pulse : 0.66) * this.alpha * fade;
      ctx.lineWidth = spent ? 1 : beating ? 2.2 + 1.8 * pulse : 2;
      ctx.shadowColor = colour;
      ctx.shadowBlur = beating ? 18 * pulse * this.colours.glow : 0;
      ctx.beginPath();
      ctx.moveTo(x0 + i * gap, y - half);
      ctx.lineTo(x0 + i * gap, y + half);
      ctx.stroke();
    }
    ctx.restore();
  }

  _dot(ctx, { x, y, env, colour, hollow, badge, scale, fade }) {
    const r = BASE_RADIUS * scale * (badge ? 1.08 : 1) * (0.78 + 0.52 * env);
    ctx.save();
    ctx.globalAlpha = this.alpha * fade * (hollow ? 0.72 : 1);

    if (hollow) {
      // Not sounding: an outline holds the place without claiming the note.
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.82, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.shadowColor = colour;
      ctx.shadowBlur = (14 + 34 * env) * this.colours.glow * (fade < 1 ? 0.5 : 1);
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (!badge) {
        // A second pass tightens the core so the glow does not wash the dot out.
        ctx.globalAlpha = this.alpha * fade * (0.55 + 0.45 * env);
        ctx.beginPath();
        ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (badge) {
      const size = Math.max(8, Math.round(r * (badge.length > 2 ? 0.72 : 0.95)));
      ctx.globalAlpha = this.alpha * fade * (hollow ? 0.8 : 1);
      ctx.fillStyle = hollow ? colour : this.colours.bg;
      ctx.font = `600 ${size}px ${this.colours.sans}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badge, x, y + size * 0.06);
    }
    ctx.restore();
  }
}

/** Would any of it fall outside the pitch band? */
function outsideBand(points, band) {
  return points.some(p => p.y < band.top + 4 || p.y > band.bottom - 4);
}

/**
 * Where a voice is at time `t`: the note it is on, how hard that note is
 * sounding, and — if it is between notes — the wait it is sitting in.
 */
function resolve(lane, time, now) {
  const { points } = lane;
  let index = -1;
  for (let i = 0; i < points.length; i++) {
    if (time >= points[i].note.start) index = i; else break;
  }

  if (index < 0) {
    const first = points[0].note;
    return {
      index, target: points[0], sounding: false,
      env: 0.12 + 0.05 * Math.sin(now * 3.4),
      waiting: { from: first.start - 2.4, to: first.start, note: first },
    };
  }

  const p = points[index];
  if (time < p.note.end) {
    return { index, target: p, sounding: true, env: envelope(time - p.note.start, p.note.end - p.note.start), waiting: null };
  }

  // In a rest: travel ahead to the next note and breathe there.
  const next = points[index + 1];
  return {
    index,
    target: next || p,
    sounding: false,
    env: next ? 0.11 + 0.05 * Math.sin(now * 3.4) : envelope(time - p.note.start, p.note.end - p.note.start),
    waiting: next ? { from: p.note.end, to: next.note.start, note: next.note } : null,
  };
}

/** The tune's own tempo where this note sits, read off the note itself. */
const beatsPerSecond = note => note.qdur / Math.max(0.05, note.end - note.start);

/** How long one beat lasts here — a quarter note, in seconds. */
function beatSeconds(note) {
  if (!note?.qdur) return 0;
  const seconds = (note.end - note.start) / note.qdur;
  return seconds > 0.05 && seconds < 4 ? seconds : 0;
}

/** One scale for everyone drawn, so heights can be compared between voices. */
function unionRange(voices) {
  let lo = Infinity, hi = -Infinity;
  for (const v of voices) {
    if (v.range.min < lo) lo = v.range.min;
    if (v.range.max > hi) hi = v.range.max;
  }
  if (!isFinite(lo)) return null;
  const span = Math.max(10, hi - lo + 4);       // floor the range so narrow tunes still move
  const centre = (lo + hi) / 2;
  return { lo: centre - span / 2, hi: centre + span / 2, min: lo, max: hi };
}

function readColours() {
  const s = getComputedStyle(document.documentElement);
  const v = name => s.getPropertyValue(name).trim();
  return {
    bg: v('--bg'),
    sans: v('--sans') || 'sans-serif',
    ink: v('--ink'),
    soft: v('--ink-soft'),
    faint: v('--ink-faint'),
    natural: v('--ink'),
    sharp: v('--sharp'),
    flat: v('--flat'),
    glow: parseFloat(v('--glow')) || 0.5,
  };
}
