/**
 * Lining a recording up with the score.
 *
 * You drop a cover of the song on the window. It is in another key, at another
 * tempo, and it starts after however many seconds of introduction the performer
 * felt like — so the words on screen mean nothing until the two are matched.
 * This does the matching, from the audio itself.
 *
 * The method is the standard one and it is standard because it works: reduce
 * both sides to **chroma** — twelve numbers per frame saying how much of each
 * pitch class is sounding — and find the cheapest path that pairs one sequence
 * with the other, allowing it to stretch. Chroma ignores octave and timbre, so a
 * piano roll and a rock band playing the same harmony look alike, and a cover
 * sung an octave down still matches. Transposition is handled by trying all
 * twelve rotations and keeping the best.
 *
 * What comes back is an offset and a tempo ratio, plus how much of the path
 * actually supported them. It is deliberately *not* a free-form warp: a warp
 * that follows every rubato also follows every mistake, and a wrong warp is
 * worse than an honest "these do not match".
 */

const RATE = 11025;        // plenty for chroma, and a quarter of the samples to chew
const WINDOW = 4096;       // ~372ms — long enough to resolve a bass note
const HOP = 0.2;           // seconds between frames
const BAND_FRAMES = 40;    // how far a performance may wander from its tempo: ±8s
// Tempos worth testing. A cover is rarely outside this, and a match claiming to
// be outside it is nearly always a match that is not there at all.
const SCAN_RATES = [0.78, 0.84, 0.9, 0.94, 0.97, 1, 1.03, 1.06, 1.12, 1.2, 1.3];
const A4 = 440;

/**
 * Give the page a chance to breathe, but only when we have actually been busy.
 * Yielding on a fixed count costs a whole timer tick each time — and in a
 * background tab a timer tick is a second — so it is done by the clock.
 */
function breathing() {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < 50) return;
    await new Promise(r => setTimeout(r));
    last = performance.now();
  };
}

// ── the tiny bit of signal processing this needs ─────────────────────

/** In-place iterative radix-2 FFT. Real and imaginary parts arrive separately. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Which chroma bin each FFT bin belongs to, worked out once. */
function chromaMap(size, rate) {
  const map = new Int8Array(size / 2).fill(-1);
  for (let bin = 1; bin < size / 2; bin++) {
    const freq = bin * rate / size;
    if (freq < 55 || freq > 2200) continue;                 // A1 to C#7: where the notes are
    const midi = 69 + 12 * Math.log2(freq / A4);
    map[bin] = ((Math.round(midi) % 12) + 12) % 12;
  }
  return map;
}

const hann = size => Float32Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));

/** Chroma frames of a recording, at HOP-second intervals. */
async function audioChroma(buffer, onProgress) {
  // One channel, and a quarter of the sample rate: chroma needs neither stereo
  // nor 44kHz, and this is a quarter of the arithmetic.
  const ratio = buffer.sampleRate / RATE;
  const length = Math.floor(buffer.length / ratio);
  const mono = new Float32Array(length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[Math.floor(i * ratio)] / buffer.numberOfChannels;
  }

  const window = hann(WINDOW);
  const map = chromaMap(WINDOW, RATE);
  const step = Math.round(HOP * RATE);
  const frames = [];
  const re = new Float32Array(WINDOW);
  const im = new Float32Array(WINDOW);
  const breathe = breathing();

  for (let start = 0; start + WINDOW <= mono.length; start += step) {
    for (let i = 0; i < WINDOW; i++) { re[i] = mono[start + i] * window[i]; im[i] = 0; }
    fft(re, im);
    const chroma = new Float32Array(12);
    for (let bin = 1; bin < WINDOW / 2; bin++) {
      const pc = map[bin];
      if (pc < 0) continue;
      chroma[pc] += Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
    }
    frames.push(normalise(chroma));
    // This runs while someone is waiting, not while they are singing — but the
    // page should still answer while it does.
    onProgress?.(0.4 * start / mono.length);
    await breathe();
  }
  return frames;
}

/** The same twelve numbers, from the score's own notes. */
function scoreChroma(notes, duration) {
  const count = Math.ceil(duration / HOP) + 1;
  const frames = Array.from({ length: count }, () => new Float32Array(12));
  for (const note of notes) {
    const from = Math.max(0, Math.floor(note.start / HOP));
    const to = Math.min(count - 1, Math.ceil(note.end / HOP));
    const pc = ((note.midi % 12) + 12) % 12;
    // Lower notes carry the harmony a listener hears; weight them a little more.
    const weight = note.midi < 60 ? 1.3 : 1;
    for (let f = from; f <= to; f++) frames[f][pc] += weight;
  }
  return frames.map(normalise);
}

function normalise(vector) {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm > 1e-9) for (let i = 0; i < 12; i++) vector[i] /= norm;
  return vector;
}

const rotate = (chroma, by) => {
  const out = new Float32Array(12);
  for (let i = 0; i < 12; i++) out[i] = chroma[(i + by + 12) % 12];
  return out;
};

/** The average colour of each side, compared at all twelve rotations. */
function rankTranspositions(audio, written) {
  const profile = frames => {
    const sum = new Float32Array(12);
    for (const f of frames) for (let i = 0; i < 12; i++) sum[i] += f[i];
    return normalise(sum);
  };
  const a = profile(audio);
  const b = profile(written);
  return Array.from({ length: 12 }, (_, by) => {
    let score = 0;
    for (let i = 0; i < 12; i++) score += b[i] * a[(i + by) % 12];
    return { by, score };
  }).sort((x, y) => y.score - x.score).map(x => x.by);
}

// ── the matching ─────────────────────────────────────────────────────

/**
 * Where does the score sit in the recording, roughly?
 *
 * Before warping anything, slide the score along the recording at a handful of
 * plausible tempos and see which placement agrees best. This is the step that
 * was missing: a warp free to begin and end anywhere will, when the two do not
 * match, quietly find it cheaper to race through the whole score against thirty
 * seconds of audio — and report a tempo five times the truth. A coarse scan
 * cannot do that, because a fixed tempo is exactly what it is testing.
 *
 * It also answers a question worth asking on its own: is there a peak at all?
 * A real match stands well above the average placement. Nothing standing out
 * means the recording is not of this music, and no amount of warping will make
 * it so.
 */
function coarseScan(written, audio, keys) {
  const STRIDE = 4;                       // every fourth score frame is plenty here
  let best = { similarity: -1 };
  let total = 0, tried = 0;

  for (const by of keys) {
    const shifted = by === 0 ? audio : audio.map(c => rotate(c, by));
    for (const rate of SCAN_RATES) {
      for (let offset = 0; offset < audio.length; offset++) {
        let sum = 0, n = 0;
        for (let i = 0; i < written.length; i += STRIDE) {
          const j = Math.round(offset + i * rate);
          if (j >= shifted.length) break;
          const w = written[i], a = shifted[j];
          sum += w[0] * a[0] + w[1] * a[1] + w[2] * a[2] + w[3] * a[3]
               + w[4] * a[4] + w[5] * a[5] + w[6] * a[6] + w[7] * a[7]
               + w[8] * a[8] + w[9] * a[9] + w[10] * a[10] + w[11] * a[11];
          n++;
        }
        if (n < written.length / (STRIDE * 2)) continue;    // too little overlap to judge
        const similarity = sum / n;
        total += similarity; tried++;
        if (similarity > best.similarity) best = { similarity, by, rate, offset };
      }
    }
  }
  return { ...best, mean: tried ? total / tried : 0 };
}

/**
 * Dynamic time warping, in a band around the line the scan found.
 *
 * The band is doing two jobs. It makes this cheap — a few thousand cells per
 * score frame instead of the whole recording — and it keeps the path honest:
 * a performance wanders around its written tempo by seconds, not by minutes, so
 * a path that would have to leave the band is a path that has lost the music.
 */
function warpPath(a, b, { offset, rate }) {
  const n = a.length, m = b.length;
  if (!n || !m) return { path: [], cost: Infinity };
  const width = 2 * BAND_FRAMES + 1;
  const INF = 1e18;
  const DIAG = 1, UP = 2, LEFT = 3;
  const cost = new Float64Array(n * width).fill(INF);
  const from = new Uint8Array(n * width);
  const lowOf = i => Math.round(offset + i * rate) - BAND_FRAMES;

  for (let i = 0; i < n; i++) {
    const low = lowOf(i), prevLow = i > 0 ? lowOf(i - 1) : 0;
    for (let k = 0; k < width; k++) {
      const j = low + k;
      if (j < 0 || j >= m) continue;
      let similarity = 0;
      for (let d = 0; d < 12; d++) similarity += a[i][d] * b[j][d];
      const local = 1 - similarity;
      if (i === 0) { cost[i * width + k] = local; from[i * width + k] = LEFT; continue; }

      const upK = j - prevLow, diagK = j - 1 - prevLow;
      const up = upK >= 0 && upK < width ? cost[(i - 1) * width + upK] : INF;
      const diag = diagK >= 0 && diagK < width ? cost[(i - 1) * width + diagK] : INF;
      const left = k > 0 ? cost[i * width + k - 1] : INF;
      let bestStep = diag, dir = DIAG;
      if (up < bestStep) { bestStep = up; dir = UP; }
      if (left < bestStep) { bestStep = left; dir = LEFT; }
      if (bestStep >= INF) continue;
      cost[i * width + k] = local + bestStep;
      from[i * width + k] = dir;
    }
  }

  // End wherever the last score frame is cheapest, within the band.
  let endK = -1;
  for (let k = 0; k < width; k++) {
    if (cost[(n - 1) * width + k] >= INF) continue;
    if (endK < 0 || cost[(n - 1) * width + k] < cost[(n - 1) * width + endK]) endK = k;
  }
  if (endK < 0) return { path: [], cost: Infinity };

  const path = [];
  let i = n - 1, k = endK;
  while (i > 0) {
    path.push([i, lowOf(i) + k]);
    const dir = from[i * width + k];
    const j = lowOf(i) + k;
    if (dir === DIAG) { k = j - 1 - lowOf(i - 1); i--; }
    else if (dir === UP) { k = j - lowOf(i - 1); i--; }
    else if (k > 0) k--;
    else { k = j - lowOf(i - 1); i--; }
    if (k < 0 || k >= width) break;
  }
  path.push([Math.max(0, i), lowOf(Math.max(0, i)) + Math.max(0, k)]);
  path.reverse();
  return { path, cost: cost[(n - 1) * width + endK] / n };
}

/**
 * A straight line through the path: score time ≈ (audio time − offset) × rate.
 * Least squares over the middle of the path, because the ends are where a
 * warping path pins itself to the corners whether it belongs there or not.
 */
function fitLine(path) {
  const trimmed = path.slice(Math.floor(path.length * 0.1), Math.ceil(path.length * 0.9));
  if (trimmed.length < 8) return null;

  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [i, j] of trimmed) {
    const x = j * HOP, y = i * HOP;                       // audio time, score time
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = trimmed.length;
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  let error = 0;
  for (const [i, j] of trimmed) {
    const predicted = slope * (j * HOP) + intercept;
    error += Math.abs(predicted - i * HOP);
  }
  return { slope, intercept, drift: error / n };
}

/**
 * Match a recording to a score.
 *
 * Returns the offset to give the player, the tempo ratio to sing at, how many
 * semitones the recording is transposed, and a confidence — which is the thing
 * to look at first, because a bad match should be refused rather than applied.
 */
export async function alignAudio(buffer, score, { onProgress } = {}) {
  const notes = [...(score.accompaniment?.notes ?? []), ...score.voices.flatMap(v => v.notes)];
  if (!notes.length) throw new Error('this score has no notes to match against');

  const audio = await audioChroma(buffer, onProgress);
  if (audio.length < 10) throw new Error('that recording is too short to match');
  const written = scoreChroma(notes, score.duration);

  // Which key, roughly, from the average colour of each side — then where and at
  // what tempo, by sliding one along the other. Only then is anything warped.
  onProgress?.(0.45);
  const keys = rankTranspositions(audio, written).slice(0, 4);
  const scan = coarseScan(written, audio, keys);
  onProgress?.(0.8);
  await new Promise(r => setTimeout(r));

  const peak = scan.mean > 0 ? scan.similarity / scan.mean : 0;
  if (!(scan.similarity > 0) || peak < 1.15) {
    return refusal({ reason: 'nothing in that recording stands out as this music', peak, audio, written });
  }

  const shifted = scan.by === 0 ? audio : audio.map(c => rotate(c, scan.by));
  const { path, cost } = warpPath(written, shifted, { offset: scan.offset, rate: scan.rate });
  const line = path.length ? fitLine(path) : null;
  if (!line) return refusal({ reason: 'the recording drifts too far from the score to follow', peak, audio, written });

  const { slope, intercept, drift } = line;
  return {
    // Where score time zero falls in the recording.
    offset: -intercept / slope,
    // Score-seconds per second of recording: the speed to run the score at so
    // the recording can be left alone. Below 1 means the cover is the slower.
    rate: slope,
    // A rotation of +n on the audio means the audio sounds n semitones above.
    transpose: scan.by > 6 ? scan.by - 12 : scan.by,
    drift,
    cost,
    peak,
    // How much of the recording the score accounts for. A performance of this
    // music runs alongside most of it; a short score that merely fits *somewhere*
    // inside a long recording has found a coincidence, not the song.
    coverage: Math.min(1, (score.duration / slope) / (buffer.length / buffer.sampleRate)),
    confidence: confidenceOf({
      cost, drift, rate: slope, peak, duration: score.duration,
      coverage: Math.min(1, (score.duration / slope) / (buffer.length / buffer.sampleRate)),
    }),
    frames: { audio: audio.length, score: written.length },
  };
}

/** An honest nothing: the numbers that led to it, and a confidence of zero. */
function refusal({ reason, peak, audio, written }) {
  return {
    offset: 0, rate: 1, transpose: 0, drift: Infinity, cost: Infinity,
    peak, coverage: 0, confidence: 0, reason,
    frames: { audio: audio.length, score: written.length },
  };
}

/**
 * How much to believe a match — measured, not guessed.
 *
 * Matching the demos against recordings of *other songs* is what set these:
 * a true match came back at cost 0.10 with the path lying within 0.08s of a
 * straight line, while the wrong song came back at cost 0.29 with 3–4s of
 * wander and a "tempo" of seven times the score. So cost alone is a weak test
 * and the other two are strong ones:
 *
 *   · **straightness** — a performance of this music tracks it steadily; a
 *     coincidental match wanders, and wandering scales with the piece's length.
 *   · **plausibility** — nobody covers a song at eight times its tempo. A ratio
 *     outside half to double speed means the path found something that is not
 *     this song, whatever its cost said.
 */
function confidenceOf({ cost, drift, rate, peak, duration, coverage }) {
  if (!(rate >= 0.5 && rate <= 2)) return 0;
  const straight = Math.max(0, 1 - drift / Math.max(1.5, duration * 0.03));
  // Cost is scaled for real audio, not for renderings of the score itself: a
  // produced record against a piano arrangement sits near 0.41 when it is a
  // perfect match, because drums and voices are not in the arrangement at all.
  const fit = Math.max(0, Math.min(1, (0.55 - cost) / 0.35));
  const stands = Math.max(0, Math.min(1, (peak - 1.12) / 0.25));
  const spans = Math.max(0, Math.min(1, (coverage - 0.25) / 0.35));
  return Math.max(0, Math.min(1, fit * straight * stands * spans));
}
