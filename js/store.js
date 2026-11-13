/**
 * What the app keeps.
 *
 * Two things are worth holding on to: the score files themselves, so a song you
 * have opened can be sung again with no network, and the indexes a source
 * searches, so search works on a train. Both live in IndexedDB rather than
 * localStorage — one score is bigger than localStorage's whole budget, and these
 * are bytes, not strings.
 *
 * A saved song keeps two forms. The original file is the truth and survives any
 * change to the reader; the built score beside it is what the app actually plays,
 * so reopening skips parsing entirely — which is the difference between 650ms and
 * nothing at all on a large score. If the reader changes, the built form is
 * stale and dropped: `BUILD` is the version to bump when it does.
 */

const DB = 'karaoke';
const VERSION = 1;
const FILES = 'files';
const KV = 'kv';
// Bump when the parsers or the built shape change. A score built by an older
// reader is dropped and read again from the bytes beside it, which is cheap.
//   2: lyric lines classified as languages or stanzas — adds `alternatives`,
//      renames tracks; without this a stored score would stack verses for ever.
//   3: the language guess now rejoins hyphenated syllables before reading them,
//      which is what lets it tell Italian from German at all.
const BUILD = 3;
const CAP_BYTES = 250 * 1024 * 1024;    // how much of the disk a setlist may take

let opening = null;

function db() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(FILES)) {
        const files = d.createObjectStore(FILES, { keyPath: 'url' });
        files.createIndex('usedAt', 'usedAt');
      }
      if (!d.objectStoreNames.contains(KV)) d.createObjectStore(KV, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(err => { opening = null; throw err; });
  return opening;
}

/** IndexedDB is available but unusable in some private modes; never fatal. */
export async function ready() {
  try { await db(); return true; } catch { return false; }
}

function run(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

// ── saved scores ─────────────────────────────────────────────────────

/**
 * Keep a score. `built` is optional: without it the file is still enough to
 * play from, just not for free.
 */
export async function saveScore(url, { bytes, built = null, title = '', artist = '', name = '', source = '', pinned = false }) {
  const record = {
    url, bytes, title, artist, name, source, pinned,
    built: built ? { build: BUILD, score: built } : null,
    bytesLength: bytes?.byteLength ?? 0,
    savedAt: Date.now(),
    usedAt: Date.now(),
  };
  await run(FILES, 'readwrite', s => s.put(record));
  await evict();
  return record;
}

/** A saved score, with its built form only if the reader has not moved on. */
export async function getScore(url) {
  const record = await run(FILES, 'readonly', s => s.get(url));
  if (!record) return null;
  run(FILES, 'readwrite', s => s.put({ ...record, usedAt: Date.now() })).catch(() => {});
  return { ...record, built: record.built?.build === BUILD ? record.built.score : null };
}

export async function forget(url) {
  await run(FILES, 'readwrite', s => s.delete(url));
}

/** Everything saved, most recently used first — without the bytes. */
export async function listScores() {
  const all = await run(FILES, 'readonly', s => s.getAll());
  return (all ?? [])
    .map(({ bytes, built, ...rest }) => ({ ...rest, hasBuilt: built?.build === BUILD }))
    .sort((a, b) => b.usedAt - a.usedAt);
}

export async function usage() {
  const all = await listScores();
  return { count: all.length, bytes: all.reduce((n, r) => n + (r.bytesLength || 0), 0), cap: CAP_BYTES };
}

/** Oldest unpinned scores go first once the cap is passed. */
async function evict() {
  const all = await run(FILES, 'readonly', s => s.getAll());
  let total = (all ?? []).reduce((n, r) => n + (r.bytesLength || 0), 0);
  if (total <= CAP_BYTES) return;
  const candidates = (all ?? []).filter(r => !r.pinned).sort((a, b) => a.usedAt - b.usedAt);
  for (const record of candidates) {
    if (total <= CAP_BYTES) break;
    await run(FILES, 'readwrite', s => s.delete(record.url));
    total -= record.bytesLength || 0;
  }
}

// ── cached source indexes ────────────────────────────────────────────

/** Read a cached value, if it is there and not older than `maxAge` seconds. */
export async function getCached(key, maxAge = Infinity) {
  const row = await run(KV, 'readonly', s => s.get(key));
  if (!row) return null;
  if (maxAge !== Infinity && Date.now() - row.at > maxAge * 1000) return null;
  return row.value;
}

export async function setCached(key, value) {
  await run(KV, 'readwrite', s => s.put({ key, value, at: Date.now() }));
  return value;
}
