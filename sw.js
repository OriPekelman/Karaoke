/**
 * Offline.
 *
 * The app itself is a dozen small files, so they are taken at install time and
 * served from the cache afterwards — Karaoke opens with no network at all. The
 * songs are not here: those live in IndexedDB, put there by the store when you
 * open one, because a score is data the app owns rather than part of the app.
 *
 * Everything is network-first with a short fuse, falling back to the cache.
 * Cache-first would load a shade faster, and it is what most guides suggest, but
 * it means an edited file keeps serving the old copy for one more reload — a
 * trap that costs more in confusion than the milliseconds are worth. The fuse
 * bounds the other cost: on a flaky connection we wait TIMEOUT and then answer
 * from the cache rather than hanging.
 *
 * Bump SHELL when the file list changes; the version string is what evicts the
 * old cache on activate.
 */

const VERSION = 'karaoke-v7';
const TIMEOUT = 2500;
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/instrument.js',
  'js/chords.js',
  'js/align.js',
  'js/dom.js',
  'js/language.js',
  'js/library.js',
  'js/load.js',
  'js/lyrics.js',
  'js/musescore.js',
  'js/midi.js',
  'js/musicxml.js',
  'js/score.js',
  'js/sources.js',
  'js/stage.js',
  'js/store.js',
  'js/synth.js',
  'js/transport.js',
  'js/util.js',
  'js/zip.js',
  'manifest.webmanifest',
  'assets/icon.svg',
  // The demos come too: a fresh install that goes offline should still have
  // something to sing. Your own songs are not here — they arrive in the store
  // the first time you open them.
  'assets/library.json',
  'assets/ode-to-joy-multilingual.musicxml',
  'assets/au-clair-de-la-lune.musicxml',
  'assets/amazing-grace.musicxml',
  'assets/greensleeves.musicxml',
  'assets/frere-jacques-round.musicxml',
  'assets/solfege-ladder.musicxml',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One missing file must not fail the whole install.
    await Promise.all(SHELL.map(url => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Never cache the API: it answers questions about the world as it is now.
  if (sameOrigin && url.pathname.startsWith('/api/')) return;

  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await withTimeout(fetch(request), TIMEOUT);
    // Opaque cross-origin responses are cached as-is; they still replay offline.
    if (res.ok || res.type === 'opaque') cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    return new Response('offline, and this is not held', { status: 504 });
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), ms)),
  ]);
}
