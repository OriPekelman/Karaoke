/**
 * The clock. Everything on screen and in the synth reads song time from here,
 * and song time comes from the audio clock — not rAF — so the dot and the
 * guide tone can never drift apart.
 */

export class Transport {
  constructor(ctx) {
    this.ctx = ctx;
    this.playing = false;
    this.rate = 1;
    this.leadIn = 1.8;     // seconds of count-in before the first note
    this._origin = 0;      // context time at which song time was 0
    this._paused = 0;      // song time while stopped
    this.duration = 0;
    this.onSeek = () => {};
    this.onIdle = () => {};   // nobody is singing: a safe moment for slow work
  }

  get time() {
    if (!this.playing) return this._paused;
    return (this.ctx.currentTime - this._origin) * this.rate;
  }

  /** Context time at which a given song time occurs (past or future). */
  contextTimeFor(songTime) {
    return this._origin + songTime / this.rate;
  }

  play() {
    if (this.playing) return;
    let t = this._paused;
    if (t >= this.duration - 0.01) t = -this.leadIn;
    this._origin = this.ctx.currentTime - t / this.rate;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this._paused = this.time;
    this.playing = false;
    this.onIdle();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(songTime) {
    const t = Math.max(-this.leadIn, Math.min(this.duration + 0.5, songTime));
    if (this.playing) this._origin = this.ctx.currentTime - t / this.rate;
    else this._paused = t;
    this.onSeek(t);
  }

  restart() { this.seek(-this.leadIn); }

  setRate(rate) {
    const now = this.time;
    this.rate = rate;
    if (this.playing) this._origin = this.ctx.currentTime - now / this.rate;
    this.onSeek(now);
  }
}
