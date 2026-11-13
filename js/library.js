/**
 * The setlist.
 *
 * Entries come from a manifest (assets/library.json) and from files dropped on
 * the window, and look the same either way — a label and something that resolves
 * to a score. A backend would replace `fromManifest` and nothing else.
 */

import { loadFromUrl, loadFromFile, loadFromBytes } from './load.js';
import { getScore, saveScore, listScores } from './store.js';
import { buildScore } from './score.js';

const MANIFEST = 'assets/library.json';
const KEEP_PARSED = 6;      // scores held in memory; a big one is a few hundred KB

/**
 * A song is read once. Parsing a score is the only work in this app big enough
 * to be felt — tens of milliseconds, and a second for an orchestral .mscz — so
 * the result is kept, and `open()` on a song already read resolves without
 * touching the main thread again. Scores are not mutated after they are built,
 * so handing the same one out twice is safe.
 */
let readSeq = 0;
const clampIndex = (i, length) => Math.max(0, Math.min(length, i));

function memoise(song) {
  song.score = null;
  song.reading = null;
  song.readAt = 0;
  song.open = () => {
    if (song.score) return Promise.resolve(song.score);
    if (!song.reading) {
      song.reading = song.read()
        .then(score => { song.score = score; song.readAt = ++readSeq; song.reading = null; return score; })
        .catch(err => { song.reading = null; throw err; });
    }
    return song.reading;
  };
  return song;
}

/**
 * Read one manifest, then any manifests it includes. An included manifest that
 * is missing or malformed is skipped rather than fatal — a personal library
 * that does not exist yet should not take the shipped one down with it.
 */
async function readManifest(url, depth) {
  const base = new URL(url, location.href);
  const res = await fetch(base);
  if (!res.ok) throw new Error(`no library at ${url} (${res.status})`);
  const data = await res.json();

  const songs = (data.songs ?? []).filter(e => e && e.file).map(entry => {
    const href = new URL(entry.file, base).href;
    return memoise({
      title: entry.title || entry.file.split('/').pop(),
      artist: entry.artist || '',
      languages: entry.languages || [],
      source: href,
      curated: true,
      read: () => loadFromUrl(href),
    });
  });

  if (depth > 0) {
    for (const include of data.include ?? []) {
      try {
        songs.push(...await readManifest(new URL(include, base).href, depth - 1));
      } catch {
        // A personal library that is absent is the normal case, not an error.
      }
    }
  }
  return songs;
}

export class Library {
  constructor() {
    this.songs = [];
    this.index = -1;
  }

  get current() { return this.songs[this.index] ?? null; }

  async loadManifest(url = MANIFEST) {
    this.songs = await readManifest(url, 1);
    if (!this.songs.length) throw new Error(`no songs in ${url}`);
    return this.songs;
  }

  /**
   * A song found through a source. It is read from the offline store first and
   * from the network only if it is not there — and once read, it is kept, so
   * anything you have sung once you can sing again on a train. The built score
   * is kept beside the file, so the second opening costs nothing at all.
   */
  addRemote(entry) {
    const existing = this.songs.findIndex(s => s.source === entry.url);
    if (existing >= 0) return existing;

    const name = entry.url.split('/').pop() || `${entry.title}.${entry.format || 'musicxml'}`;
    const song = memoise({
      title: entry.title,
      artist: [entry.artist, entry.set].filter(Boolean).join(' · '),
      languages: [],
      source: entry.url,
      curated: true,
      remote: entry,
      saved: !!entry.saved,
      read: async () => {
        const held = await getScore(entry.url).catch(() => null);
        if (held?.built) { song.saved = true; return held.built; }
        if (held?.bytes) { song.saved = true; return loadFromBytes(name, held.bytes); }

        // A server that has already read the file hands over note streams
        // instead of a score to parse. Building lines from them is cheap and
        // stays here, so there is only ever one implementation of that.
        if (entry.parsedUrl) {
          const res = await fetch(entry.parsedUrl);
          if (!res.ok) throw new Error(`could not read ${entry.title} (${res.status})`);
          const { parsed } = await res.json();
          const score = buildScore(parsed);
          saveScore(entry.url, {
            bytes: null, built: score, name,
            title: entry.title, artist: song.artist, source: entry.sourceId || '',
          }).then(() => { song.saved = true; }).catch(() => {});
          return score;
        }

        const res = await fetch(entry.url);
        if (!res.ok) throw new Error(`could not fetch ${entry.title} (${res.status})`);
        const bytes = await res.arrayBuffer();
        const score = await loadFromBytes(name, bytes);
        saveScore(entry.url, {
          bytes, built: score, name,
          title: entry.title, artist: song.artist, source: entry.sourceId || '',
        }).then(() => { song.saved = true; }).catch(() => {});
        return score;
      },
    });

    this.songs.push(song);
    return this.songs.length - 1;
  }

  /** Everything saved on this machine, so a found song survives a reload. */
  async restoreSaved() {
    const saved = await listScores().catch(() => []);
    let added = 0;
    for (const record of saved) {
      const [artist, set] = (record.artist || '').split(' · ');
      const before = this.songs.length;
      this.addRemote({
        url: record.url, title: record.title || record.name, artist: artist || '',
        set: set || '', sourceId: record.source, saved: true,
      });
      if (this.songs.length > before) added++;
    }
    return added;
  }

  /** Append dropped files; returns the index of the first one added. */
  add(files) {
    const first = this.songs.length;
    for (const file of files) {
      this.songs.push(memoise({
        title: file.name.replace(/\.[^.]+$/, ''),
        artist: 'dropped',
        languages: [],
        source: file.name,
        read: () => loadFromFile(file),
      }));
    }
    return this.songs.length > first ? first : -1;
  }

  /**
   * Read a song ahead of being asked for it, and forget the oldest once too
   * many are held. Callers decide when this is safe — never while singing.
   */
  async warm(index) {
    const song = this.songs[(index + this.songs.length) % Math.max(1, this.songs.length)];
    if (!song || song.score || song.reading) return null;
    try { await song.open(); } catch { return null; }

    const held = this.songs.filter(s => s.score && s !== this.current)
      .sort((a, b) => a.readAt - b.readAt);
    for (const stale of held.slice(0, Math.max(0, held.length - KEEP_PARSED))) stale.score = null;
    return song;
  }

  /**
   * Put a song somewhere else in the running order. The index follows the song
   * that is loaded rather than the position it used to occupy — moving the third
   * song must not silently change which one is playing.
   */
  move(from, to) {
    if (from === to || from < 0 || from >= this.songs.length) return false;
    const playing = this.current;
    const [song] = this.songs.splice(from, 1);
    this.songs.splice(clampIndex(to, this.songs.length), 0, song);
    this.index = playing ? this.songs.indexOf(playing) : this.index;
    return true;
  }

  /** Take a song out. What is on stage stays on stage; only the list changes. */
  remove(index) {
    if (index < 0 || index >= this.songs.length) return null;
    const playing = this.current;
    const [gone] = this.songs.splice(index, 1);
    this.index = gone === playing
      ? Math.min(index, this.songs.length - 1)   // the neighbour takes its place
      : this.songs.indexOf(playing);
    return gone;
  }

  label(song) {
    const langs = song.languages.length > 1 ? ` · ${song.languages.length} languages` : '';
    const kept = song.remote ? (song.saved ? ' ⤓' : ' ·') : '';
    return `${song.title}${langs}${kept}`;
  }

  /** Resolve a song by index and remember it as current. */
  select(index) {
    if (index < 0 || index >= this.songs.length) return null;
    this.index = index;
    return this.songs[index];
  }

  step(delta) {
    if (!this.songs.length) return null;
    return this.select((this.index + delta + this.songs.length) % this.songs.length);
  }
}
