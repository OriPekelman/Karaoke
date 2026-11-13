/**
 * The words.
 *
 * Two things are peers here. Every language is a peer: the same line is shown in
 * all of them, at the same size, and each one highlights its own syllable as the
 * music passes — so whichever line you read, you can sing. And every singer is a
 * peer: in a duet or a round each voice gets a row, labelled, moving on its own
 * clock, because they are not on the same line at the same moment. A voice that
 * is resting fades back rather than leaving, so you can see your entry coming.
 *
 * The lead row is simply the one on top — your part, in your language, the row
 * the dot sits above. Rows change line independently; only the lead row's change
 * moves the dot, which is why it alone reports back for layout.
 *
 * This view also owns horizontal geometry — the canvas asks it where the lead
 * line's syllables actually landed.
 */

import { el } from './util.js';
import { lineIndexAt, trackFor } from './score.js';

const SWAP_MS = 190;

export class LyricView {
  constructor({ root, stackEl, nextEl }) {
    this.root = root;
    this.stackEl = stackEl;
    this.nextEl = nextEl;
    this.score = null;
    this.voiceIndex = 0;
    this.trackIndex = 0;
    this.rows = [];
    this._t = 0;
    this.chordStyle = '';         // '', 'letters' or 'latin'
    this.onLayout = () => {};
  }

  get voice() { return this.score?.voices[this.voiceIndex] ?? null; }
  /** The lead row's language — what the dot, and the next-line preview, follow. */
  get track() { return this.rows[0]?.track ?? null; }
  get line() { return this.rows[0]?.line ?? null; }
  get lineIndex() { return this.rows[0]?.lineIndex ?? -1; }

  setScore(score, { voice = 0, track = 0 } = {}) {
    this.score = score;
    this.voiceIndex = voice;
    this.trackIndex = track;
    this._t = 0;
    this._rebuild();
  }

  setVoice(index) {
    if (!this.score || index === this.voiceIndex) return;
    this.voiceIndex = index;
    this._rebuild();
  }

  /** Show chords as letters, as solfège, or not at all. */
  setChordStyle(style) {
    if (style === this.chordStyle) return;
    this.chordStyle = style;
    this._rebuild();
  }

  setTrack(index) {
    if (!this.score || index === this.trackIndex) return;
    this.trackIndex = index;
    this._rebuild();
  }

  /**
   * The rows, top first: your voice, then the others in score order. With only
   * one singer the languages themselves become the rows, as they always have.
   */
  _plan() {
    const { voices, tracks } = this.score;
    const voice = voices[this.voiceIndex];
    const key = tracks[this.trackIndex]?.key;

    if (voices.length > 1) {
      const rest = voices.filter((_, i) => i !== this.voiceIndex);
      return [voice, ...rest].map(v => {
        const track = trackFor(v, key);
        // A part that has no verse in the chosen language sings the one it has,
        // and says so — otherwise the row silently disagrees with the button.
        const odd = tracks.length > 1 && track.key !== key;
        return { voice: v, track, label: odd ? `${v.label} · ${track.label}` : v.label };
      });
    }
    const lead = trackFor(voice, key);
    // Stanzas are sung one after another, so only the one you are on is shown;
    // L moves between them. Languages are alternatives for the same music and
    // stack as peers, which is what makes a multilingual room able to sing.
    if (!this.score.alternatives) return [{ voice, track: lead, label: lead.label }];
    return [lead, ...voice.tracks.filter(t => t !== lead)]
      .map(t => ({ voice, track: t, label: t.label }));
  }

  _rebuild() {
    for (const row of this.rows) clearTimeout(row.timer);
    const plan = this._plan();
    const single = plan.length === 1;

    this.rows = plan.map((entry, i) => {
      const node = el('div', `lyric${i === 0 ? ' lead' : ''}`);
      node.dir = entry.track.dir;
      if (!single) node.append(el('span', 'tag', entry.label));
      const textEl = el('span', 'text');
      node.append(textEl);
      return { ...entry, node, textEl, lead: i === 0, lineIndex: -1, pending: -1, timer: null, spans: [], active: -2 };
    });

    this.stackEl.replaceChildren(...this.rows.map(r => r.node));
    this.nextEl.dir = this.rows[0].track.dir;
    this.nextEl.replaceChildren();
    this.root.dataset.tracks = String(this.rows.length);
    this.root.dataset.rows = this.score.voices.length > 1 ? 'voices' : 'languages';
    this.root.classList.remove('swapping');
    this.showAt(this._t, { animate: false });
  }

  /** Put every row on the line its own voice is singing at time `t`. */
  showAt(t, { animate = true } = {}) {
    if (!this.score) return;
    this._t = t;
    for (const row of this.rows) this._advance(row, lineIndexAt(row.track, t), animate);
  }

  _advance(row, index, animate) {
    if (index < 0 || index === row.lineIndex || index === row.pending) return;

    const swap = () => {
      row.pending = -1;
      row.lineIndex = index;
      row.line = row.track.lines[index];
      row.spans = [];
      row.active = -2;
      row.textEl.replaceChildren(...this._build(row.line, row.spans, row.lead && !!this.chordStyle));
      row.node.classList.remove('swapping');
      if (row.lead) {
        this.nextEl.replaceChildren(...this._build(row.track.lines[index + 1], []));
        this.root.classList.remove('swapping');
      }
      // Any row that changes line has moved its syllables, and the canvas draws
      // over all of them — so every swap asks for geometry, not just the lead's.
      this.onLayout(row.voice.key);
    };

    clearTimeout(row.timer);
    if (!animate || row.lineIndex < 0) { swap(); return; }
    row.pending = index;
    row.node.classList.add('swapping');
    // The dot fades with the line it rides, and only with that one.
    if (row.lead) this.root.classList.add('swapping');
    row.timer = setTimeout(swap, SWAP_MS);
  }

  _build(line, spans, withChords = false) {
    if (!line || !line.syllables.length) return [];
    const nodes = [];
    let word = null;
    const chords = withChords ? this._chordsIn(line) : [];

    line.syllables.forEach((syl, i) => {
      if (!word) {
        word = el('span', 'word');
        if (nodes.length) nodes.push(document.createTextNode(' '));
        nodes.push(word);
      }
      const alt = syl.accidental !== 'natural' ? ' alt-' + syl.accidental : '';
      const span = el('span', 'syl' + alt, syl.text);

      // Lead-sheet placement: the chord sits over the syllable it changes on,
      // which is the only position a guitarist can read while singing.
      // A chord belongs to the syllable it changes on. After the last syllable
      // the line is over, so anything later is left for the line that follows
      // rather than stacked onto the final word.
      const next = line.syllables[i + 1];
      const limit = next ? next.start - 0.01 : syl.end;
      const due = chords.filter(c => c.start < limit);
      if (due.length) {
        chords.splice(0, due.length);
        span.append(el('span', 'chord', due.map(c => c[this.chordStyle]).join(' ')));
      }

      word.append(span);
      spans.push({ span, syl });

      if (syl.hyphenAfter && i < line.syllables.length - 1) word.append(el('span', 'hy', '‑'));
      else word = null;
    });
    return nodes;
  }

  /**
   * Advance the highlight in every row at once. Each row keeps its own syllable
   * division — and, when there are several singers, its own place in the piece —
   * so each is resolved against the clock separately.
   */
  setActiveAt(t) {
    this._t = t;
    const many = this.score && this.score.voices.length > 1;

    for (const row of this.rows) {
      if (many) row.node.classList.toggle('resting', !singingAt(row.line, t));

      let active = -1;
      for (const s of row.line?.syllables ?? []) {
        if (t >= s.start) active = s.index; else break;
      }
      if (active === row.active) continue;
      row.active = active;
      for (const { span, syl } of row.spans) {
        const state = syl.index < active ? 'past' : syl.index === active ? 'active' : 'ahead';
        const alt = syl.accidental !== 'natural' ? ' alt-' + syl.accidental : '';
        span.className = `syl ${state}${alt}`;
      }
    }
  }

  /**
   * The chords that change during this line. The last chord written before the
   * line began comes too — that is the one you are already holding, and a line
   * that starts mid-chord would otherwise show nothing at all.
   */
  _chordsIn(line) {
    const all = this.score?.chords ?? [];
    if (!all.length || !line?.syllables?.length) return [];
    const from = line.syllables[0].start;
    const before = all.filter(c => c.start <= from + 0.01).at(-1);
    const inside = all.filter(c => c.start > from + 0.01 && c.start < line.end);
    return [...(before ? [before] : []), ...inside];
  }

  /**
   * What the canvas needs to draw over the words: for every row, in the order
   * they are stacked, the voice, the line it is on, the line it will be on, and
   * where each of its syllables actually landed in canvas-local pixels.
   */
  geometry(originRect) {
    return this.rows.map(row => ({
      voice: row.voice,
      lead: row.lead,
      line: row.line ?? null,
      nextLine: row.lineIndex >= 0 ? row.track.lines[row.lineIndex + 1] ?? null : null,
      rects: measureSpans(row.spans, originRect),
    }));
  }
}

function measureSpans(spans, originRect) {
  const out = new Map();
  for (const { span, syl } of spans) {
    const r = span.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    out.set(syl.index, {
      left: r.left - originRect.left,
      right: r.right - originRect.left,
      centre: (r.left + r.right) / 2 - originRect.left,
    });
  }
  return out;
}

/** A voice counts as singing a touch before and after, so rows do not blink. */
function singingAt(line, t) {
  return !!line && t >= line.start - 0.25 && t <= line.end + 0.25;
}
