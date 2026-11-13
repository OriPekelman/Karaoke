export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential approach. tau = time to close ~63% of the gap. */
export const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

export const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
export const easeInOutQuad = t => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * Amplitude envelope of a single note, used for the pulse of the dot.
 * The dot never jumps — this is what gives it attack and fade instead.
 */
export function envelope(dt, dur) {
  if (dt < 0) return 0;
  const A = Math.min(0.055, dur * 0.22);
  const D = Math.min(0.16, dur * 0.35);
  const S = 0.62;
  const fadeFrom = Math.max(A + D, dur - Math.min(0.24, dur * 0.42));
  if (dt <= A) return easeOutCubic(dt / A);
  if (dt <= A + D) return 1 - (1 - S) * easeInOutQuad((dt - A) / D);
  if (dt <= fadeFrom) return S;
  if (dt <= dur) return S * (1 - 0.5 * ((dt - fadeFrom) / Math.max(1e-4, dur - fadeFrom)));
  return Math.max(0, S * 0.3 * (1 - (dt - dur) / 0.2));
}
