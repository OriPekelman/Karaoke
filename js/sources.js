/**
 * Where songs come from, besides your own folder.
 *
 * A source answers one question — what have you got that matches this? — and
 * hands back entries the setlist can open, because they carry a URL and the app
 * already knows how to load a URL. That is the whole interface:
 *
 *   { id, label, licence, note, search(query) → [entry] }
 *   entry = { id, title, artist, set, url, format, licence, link, sourceId }
 *
 * The first source needs no server at all. OpenScore's Lieder corpus is a CC0
 * mirror of 1,356 19th-century songs, published on GitHub with both .mxl and
 * .mscz per song *and* its own index — and raw.githubusercontent.com sends
 * `access-control-allow-origin: *`, so the browser may read all of it directly.
 * The index is 300KB of TSV, which is small enough to search in the page and
 * worth keeping, so search works with the network off too.
 *
 * A source that the browser cannot reach — anything without CORS — is the same
 * interface with a fetch to our own server behind it. That is the only thing the
 * server is needed for.
 */

import { getCached, setCached } from './store.js';

const RAW = 'https://raw.githubusercontent.com/OpenScore/Lieder/main';
const TREE = 'https://api.github.com/repos/OpenScore/Lieder/git/trees/main?recursive=1';
const EWLD_RAW = 'https://raw.githubusercontent.com/00sapo/OpenEWLD/master';
const EWLD_TREE = 'https://api.github.com/repos/00sapo/OpenEWLD/git/trees/master?recursive=1';
const INDEX_MAX_AGE = 30 * 24 * 3600;   // a corpus that grows by the month

/**
 * What kind of song this is — asked twice, for two different reasons.
 *
 * The finder uses it to let a search for "Mondnacht" not be crowded out by
 * songbook entries, and the soundtrack search uses it to decide what to ask
 * YouTube for: the same title wants "piano accompaniment" if it is a Lied and
 * "karaoke" if it is not, and asking the wrong way returns a page of things you
 * cannot sing over. A source that knows says so; anything else is guessed from
 * the words, which is unreliable in the way that guessing is and good enough
 * for choosing between two search phrasings.
 */
export const STYLES = ['classical', 'jazz', 'pop', 'folk'];

const CLASSICAL_WORDS = /\b(schubert|schumann|brahms|wolf|faure|debussy|mahler|strauss|mendelssohn|beethoven|mozart|haydn|purcell|handel|bach|dowland|liszt|grieg|sibelius|rachmaninoff|duparc|poulenc|britten|vaughan|lieder|liederkreis|op\.?\s*\d|d\.?\s*\d{3}|bwv|k\.?\s*\d{3}|sonata|symphony|quartet|mass|requiem|cantata)\b/;
const JAZZ_WORDS = /\b(jazz|swing|bossa|blues|standard|gershwin|porter|ellington|monk|coltrane|evans|bebop|berlin|kern|arlen|rodgers|hart|carmichael)\b/;
const FOLK_WORDS = /\b(traditional|trad|folk|carol|hymn|spiritual|shanty|noel|christmas)\b/;

export function guessStyle(text) {
  const t = fold(String(text || ''));
  if (FOLK_WORDS.test(t)) return 'folk';
  if (CLASSICAL_WORDS.test(t)) return 'classical';
  if (JAZZ_WORDS.test(t)) return 'jazz';
  return 'pop';
}

/** Fold accents and case, so "muller" finds "Müller" and "faure" finds "Fauré". */
const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const words = s => s.replace(/_/g, ' ').trim();

function parseTSV(text) {
  const [head, ...lines] = text.split('\n').filter(Boolean);
  const cols = head.split('\t');
  return lines.map(line => {
    const cells = line.split('\t');
    const row = {};
    cols.forEach((c, i) => { row[c] = cells[i] ?? ''; });
    return row;
  });
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

/**
 * The corpus index.
 *
 * Paths come from the repository's own file tree and nothing else. The corpus
 * ships two tempting shortcuts — `data/scores.tsv` and `data/corpus_conversion
 * .json` — and both disagree with the repository about 17% of paths, which they
 * write zero-padded ("05_Mondnacht") where the directory is not ("5_Mondnacht");
 * de-padding rescues 228 of those and still leaves 52 wrong, and the tree holds
 * 1,462 scores against their 1,356. So the tree decides where a file is, and the
 * tables are consulted only for how to spell a name.
 *
 * That costs one 3MB read, which is why it happens when the finder is first
 * opened rather than at startup, and is then kept for a month.
 */
async function loadIndex(onProgress = () => {}) {
  const cached = await getCached('openscore:index', INDEX_MAX_AGE).catch(() => null);
  if (cached) return cached;

  onProgress('reading the corpus…');
  const [tree, scores, composers] = await Promise.all([
    fetch(TREE).then(r => { if (!r.ok) throw new Error(`tree → ${r.status}`); return r.json(); }),
    fetchText(`${RAW}/data/scores.tsv`).then(parseTSV).catch(() => []),
    fetchText(`${RAW}/data/composers.tsv`).then(parseTSV).catch(() => []),
  ]);

  const titles = new Map(scores.map(r => [r.id, r]));
  const names = new Map(composers.map(c => [c.path, c.name]));

  const rows = [];
  for (const entry of tree.tree ?? []) {
    const match = /^scores\/(.+)\/lc(\d+)\.mxl$/.exec(entry.path);
    if (!match) continue;
    const [, dir, id] = match;
    const [composerPath, setPath, songPath] = dir.split('/');
    const listed = titles.get(id);
    const artist = names.get(composerPath) || words(composerPath);
    const set = setPath && setPath !== '_' ? words(setPath) : '';
    const title = listed?.name || words(songPath || '').replace(/^\d+[_\s]/, '');
    rows.push({
      id, title, artist, set,
      path: entry.path,
      link: listed?.link || '',
      key: fold([title, artist, set].join(' ')),
    });
  }
  if (!rows.length) throw new Error('the corpus listing came back empty');

  await setCached('openscore:index', rows).catch(() => {});
  return rows;
}

export const openscore = {
  id: 'openscore',
  label: 'OpenScore Lieder',
  licence: 'CC0',
  note: '1,356 songs · public domain · no server',

  /** Songs whose title, composer or set contain every word of the query. */
  async search(query, { limit = 60, onProgress } = {}) {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const rows = await loadIndex(onProgress);

    const hits = [];
    for (const row of rows) {
      let score = 0;
      let all = true;
      for (const term of terms) {
        const at = row.key.indexOf(term);
        if (at < 0) { all = false; break; }
        // A word that starts a field is a better match than one buried in it.
        score += at === 0 || row.key[at - 1] === ' ' ? 3 : 1;
      }
      if (!all) continue;
      if (fold(row.title).startsWith(terms[0])) score += 4;
      hits.push({ row, score });
    }

    hits.sort((a, b) => b.score - a.score || a.row.artist.localeCompare(b.row.artist) || a.row.title.localeCompare(b.row.title));
    return hits.slice(0, limit).map(({ row }) => ({
      id: `openscore:${row.id}`,
      title: row.title,
      artist: row.artist,
      set: row.set,
      url: `${RAW}/${encodeURI(row.path)}`,
      format: 'mxl',
      licence: 'CC0',
      link: row.link,
      style: 'classical',
      sourceId: 'openscore',
    }));
  },

  /** Warm the index so the first search is instant and works offline after. */
  prime(onProgress) { return loadIndex(onProgress).then(rows => rows.length).catch(() => 0); },
};

/**
 * The songbook: OpenEWLD.
 *
 * The Lieder corpus is one room of the house and it is all nineteenth-century
 * art song. This is the other room — 502 lead sheets of the popular repertoire,
 * melody with its words and its chord symbols, which is what a standard is
 * actually written down as. It is the public-domain half of the Enhanced
 * Wikifonia Leadsheet Dataset, so it stops around 1930: Gershwin, Kern,
 * Youmans, Carmichael, and the traditional songs and carols that sit alongside
 * them. Anything newer than that is not free to redistribute, and arrives by
 * the importer in tools/ instead, out of a copy you already have.
 *
 * It is on GitHub, so it costs no server, the same as the Lieder.
 */

/** Composer folders name everyone at once: `Fabian_Andre-Gus_Kahn-Wilbur_Schwandt`.
 *  Hyphens separate people, except when they are part of a name — Rimsky-Korsakov,
 *  Baring-Gould. A fragment with no space of its own belongs to the name before it. */
function splitNames(dir) {
  const parts = words(dir).split('-');
  const people = [];
  for (const part of parts) {
    if (people.length && !part.includes(' ')) people[people.length - 1] += `-${part}`;
    else people.push(part);
  }
  return people.join(', ');
}

async function loadSongbook(onProgress = () => {}) {
  const cached = await getCached('openewld:index', INDEX_MAX_AGE).catch(() => null);
  if (cached) return cached;

  onProgress('reading the songbook…');
  const tree = await fetch(EWLD_TREE).then(r => {
    if (!r.ok) throw new Error(`songbook tree → ${r.status}`);
    return r.json();
  });

  const rows = [];
  for (const entry of tree.tree ?? []) {
    const match = /^dataset\/([^/]+)\/[^/]+\/([^/]+)\.mxl$/.exec(entry.path);
    if (!match) continue;
    const [, composerDir, file] = match;
    if (file.startsWith('._')) continue;          // macOS resource forks, in the repo
    const traditional = composerDir === '[Traditional]';
    const title = words(file);
    const artist = traditional ? 'Traditional' : splitNames(composerDir);
    rows.push({
      title, artist,
      path: entry.path,
      style: traditional ? 'folk' : guessStyle(`${title} ${artist}`) === 'folk' ? 'folk' : 'jazz',
      key: fold(`${title} ${artist}`),
    });
  }
  if (!rows.length) throw new Error('the songbook listing came back empty');

  await setCached('openewld:index', rows).catch(() => {});
  return rows;
}

export const openewld = {
  id: 'openewld',
  label: 'OpenEWLD songbook',
  licence: 'public domain',
  note: '502 standards · melody, words and chords · no server',

  async search(query, { limit = 40, onProgress } = {}) {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const rows = await loadSongbook(onProgress);

    const hits = [];
    for (const row of rows) {
      let score = 0;
      let all = true;
      for (const term of terms) {
        const at = row.key.indexOf(term);
        if (at < 0) { all = false; break; }
        score += at === 0 || row.key[at - 1] === ' ' ? 3 : 1;
      }
      if (!all) continue;
      if (fold(row.title).startsWith(terms[0])) score += 4;
      hits.push({ row, score });
    }

    hits.sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title));
    return hits.slice(0, limit).map(({ row }) => ({
      id: `openewld:${row.path}`,
      title: row.title,
      artist: row.artist,
      set: '',
      url: `${EWLD_RAW}/${encodeURI(row.path)}`,
      format: 'mxl',
      licence: 'public domain',
      style: row.style,
      sourceId: 'openewld',
    }));
  },

  prime(onProgress) { return loadSongbook(onProgress).then(rows => rows.length).catch(() => 0); },
};

/**
 * A server, if one is there. It is asked once, quietly, and never again if it
 * does not answer — the app is not supposed to need it. What it adds is the
 * scores on that machine, and results that carry a `parsedUrl`: the note streams
 * read on the server instead of on the phone.
 */
let serverProbe = null;

/**
 * Where the API lives. Same origin by default — the server serves the app too,
 * so opening its port is enough. When the app is served by something simpler on
 * another port, `karaoke.useServer('http://localhost:8090')` records the base
 * and it is remembered; the server allows the cross-origin call.
 */
const API_KEY = 'karaoke:api';
export const apiBase = () => {
  try { return localStorage.getItem(API_KEY) || ''; } catch { return ''; }
};
export function useServer(base) {
  try {
    if (base) localStorage.setItem(API_KEY, base.replace(/\/$/, ''));
    else localStorage.removeItem(API_KEY);
  } catch { /* private mode: this session only */ }
  serverProbe = null;
  return askServer();
}

function askServer() {
  if (!serverProbe) {
    serverProbe = (async () => {
      const stop = AbortSignal.timeout ? AbortSignal.timeout(1200) : undefined;
      try {
        const res = await fetch(`${apiBase()}/api/health`, { signal: stop });
        return res.ok ? await res.json() : null;
      } catch { return null; }
    })();
  }
  return serverProbe;
}

export const localServer = {
  id: 'local',
  label: 'This machine',
  licence: 'your own files',
  note: 'the scores in the folder the server was pointed at',

  async search(query, { limit = 40 } = {}) {
    const health = await askServer();
    if (!health?.corpus) return [];
    const base = apiBase();
    const res = await fetch(`${base}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) return [];
    const { results = [] } = await res.json();
    // The server answers in its own terms; make the URLs absolute from here.
    return results.map(r => ({
      ...r,
      url: r.url?.startsWith('/') ? base + r.url : r.url,
      parsedUrl: r.parsedUrl?.startsWith('/') ? base + r.parsedUrl : r.parsedUrl,
    }));
  },
};

export const sources = [openscore, openewld, localServer];

/** Whether a server is answering, for anything that wants to know. */
export const serverHealth = askServer;

/** Ask every source at once; a source that fails is skipped, not fatal. */
export async function searchAll(query, opts) {
  const answers = await Promise.all(
    sources.map(s => s.search(query, opts).catch(err => { console.warn(`${s.id}: ${err.message}`); return []; })),
  );
  return answers.flat();
}
