/**
 * The server, and what it is actually for.
 *
 * The app needs no server: it plays local files, and it searches and fetches
 * OpenScore's corpus straight from GitHub, which allows it. A server earns its
 * keep by doing the three things a page cannot.
 *
 *   /api/fetch   Reach a score the browser is not allowed to reach. Most of the
 *                web's sheet music sends no CORS header, so a URL that works
 *                when you click it fails when the page asks for it. This is an
 *                allow-listed proxy, not an open one, and it keeps a copy.
 *
 *   /api/score   Read the file *here*, and hand back the note streams. The
 *                readers in js/ run unchanged on this side — the only thing they
 *                needed was an XML parser, which server/minidom.mjs supplies —
 *                so parsing a large orchestral score stops costing the singer
 *                two thirds of a second on their phone.
 *
 *   /api/search  Look through a folder of scores on this machine: your own
 *                MuseScore library, or a corpus you have downloaded.
 *
 *   /api/separate  Take the singer out of a recording, so a playback that
 *                already has vocals can still be sung over. Shells out to
 *                python-audio-separator, if the operator has installed it.
 *
 * It does not scrape CPDL. ChoralWiki is behind a Cloudflare challenge that
 * refuses every non-browser client, and getting round that would mean driving a
 * headless browser against their defences. That is their answer, and it is no.
 *
 *   node server/karaoke.mjs --port 8090 --corpus ~/Documents/MuseScore3/Scores
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readdir as readDir } from 'node:fs/promises';
import { extname, join, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setXMLParser } from '../js/dom.js';
import { parseXML } from './minidom.mjs';
setXMLParser(parseXML);                       // before anything imports a reader

const { loadFromBytes } = await import('../js/load.js');

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const expandHome = p => (p.startsWith('~') ? join(process.env.HOME ?? '', p.slice(1)) : p);
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 8090);
const HOST = args.host ?? '127.0.0.1';
const CORPUS = args.corpus ? resolve(expandHome(args.corpus)) : null;
const CACHE = resolve(expandHome(args.cache ?? join(ROOT, '.cache')));
const ALLOW_DOWNLOAD = args['allow-download'] === true || args['allow-download'] === 'true';
const SCORE_EXT = /\.(mxl|musicxml|xml|mscz|mscx)$/i;
const isYouTube = host => host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');

// Where vocals are separated, and with what. Separation is the one genuinely
// heavy thing this server can be asked for, so by default it is sent to a GPU
// box on the tailnet — the hosts named here, first that answers — and runs
// there over a single ssh: audio in on stdin, instrumental back on stdout,
// nothing installed but the same CLI. `--separator-host <host>` pins one;
// `--separator-host local` keeps it here.
//
// The model differs by where it runs, and that is a measurement, not taste:
// audio-separator's default (BS-Roformer, the current best) ran on an M2 Air
// at 18s per chunk until memory pressure hit and then at ten *minutes* per
// chunk — so locally the MDX-Net ONNX model is used instead, which runs
// through CoreML in well under real time. A GPU box gets the good one.
// `--separator-model <file>` overrides both.
const SEP_HOSTS = typeof args['separator-host'] === 'string'
  ? [args['separator-host']]
  : ['gx10', 'evo', 'local'];
const SEP_MODEL = typeof args['separator-model'] === 'string' ? args['separator-model'] : null;
const SEP_MODEL_LOCAL = SEP_MODEL ?? 'UVR-MDX-NET-Inst_HQ_3.onnx';
const SEP_MODEL_REMOTE = SEP_MODEL ?? '';    // empty = audio-separator's default

// The PO-token helper: where to find it, and where it listens. See ensurePot().
const POT_PORT = Number(args['pot-port'] ?? 4416);
const POT_URL = `http://127.0.0.1:${POT_PORT}`;
const POT_SCRIPT = resolve(expandHome(args['pot-server'] ?? '~/bgutil-ytdlp-pot-provider/server/build/main.js'));

// An open proxy is a liability. Only these hosts, plus whatever the operator adds.
const ALLOWED = new Set([
  'raw.githubusercontent.com',
  'api.github.com',
  'github.com',
  ...String(args.allow ?? '').split(',').map(h => h.trim()).filter(Boolean),
]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      cors(res);
      if (req.method === 'OPTIONS') return send(res, 204, '');
      return await api(url, req, res);
    }
    return await serveStatic(url, res);
  } catch (err) {
    console.error(`${url.pathname}: ${err.message}`);
    return json(res, 500, { error: err.message });
  }
});

/** The knobs the soundtrack routes share: how long the score is, and its style. */
function searchOpts(url) {
  const seconds = Number(url.searchParams.get('duration'));
  return {
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
    style: url.searchParams.get('style') ?? undefined,
    limit: Math.min(Number(url.searchParams.get('limit') ?? 10) || 10, 30),
  };
}

async function api(url, req, res) {
  const route = url.pathname.slice(5);

  if (route === 'health') {
    // The app reads health behind a 1.2s fuse, and the separator probe may be
    // ssh-ing to machines that are asleep. Race it: answer with whatever is
    // known now, and let the probe finish in its own time for the next ask.
    const sep = await Promise.race([ensureSeparator(), delay(300).then(() => sepState)]);
    return json(res, 200, {
      ok: true,
      corpus: CORPUS ? { path: CORPUS, songs: (await corpusIndex()).length } : null,
      allowed: [...ALLOWED],
      capabilities: [
        'fetch', 'score', 'search',
        ...(sep.ok ? ['separate'] : []),
        ...(ALLOW_DOWNLOAD ? ['audio', 'youtube-search', 'soundtrack'] : []),
      ],
      // Whether the awkward half of YouTube downloading is in place, so the app
      // can say something truer than "could not load soundtrack".
      potoken: ALLOW_DOWNLOAD ? potState : null,
      separator: sep,
    });
  }

  if (route === 'search') {
    const q = (url.searchParams.get('q') ?? '').trim();
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 40), 200);
    return json(res, 200, { query: q, results: await searchCorpus(q, limit) });
  }

  if (route === 'fetch') {
    const target = url.searchParams.get('url');
    const { bytes, type } = await fetchScore(target);
    res.setHeader('content-type', type);
    return send(res, 200, Buffer.from(bytes));
  }

  if (route === 'audio') {
    // A testing affordance, off unless the operator asked for it: fetch the
    // audio of a video and hand it back, so alignment can be tried against a
    // real performance instead of a rendering of the score itself. It shells out
    // to yt-dlp, which is not bundled and not installed by this — and pulling
    // media down is against most video hosts' terms, so the switch is yours to
    // throw, on your own machine, for your own files.
    if (!ALLOW_DOWNLOAD) {
      return json(res, 403, { error: 'start the server with --allow-download to use /api/audio' });
    }
    const target = url.searchParams.get('url');
    try { youtubeUrl(target); } catch (err) { return json(res, 400, { error: err.message }); }
    const { bytes, type, name } = await downloadAudio(target);
    res.setHeader('content-type', type);
    res.setHeader('x-audio-name', encodeURIComponent(name));
    return send(res, 200, bytes);
  }

  if (route === 'separate') {
    // Remove the singer from a recording, so a playback that already has
    // vocals — a cover, the original record, most of what a search actually
    // returns — can still be sung over. The audio arrives as the request body
    // because the app already holds the bytes, wherever they came from: a
    // dropped file, a YouTube download, either way the server need not know.
    // Timing is preserved by separation, so the client keeps its alignment.
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'POST the audio bytes to /api/separate' });
    }
    const sep = await ensureSeparator();
    if (!sep.ok) return json(res, 501, { error: sep.why });
    let name = 'track.mp3';
    try { name = decodeURIComponent(req.headers['x-audio-name'] ?? '') || name; } catch { /* keep the default */ }
    const bytes = await readBody(req, 200 << 20);
    if (!bytes.length) return json(res, 400, { error: 'send the audio as the request body' });
    const out = await separateInstrumental(bytes, name);
    res.setHeader('content-type', 'audio/mpeg');
    res.setHeader('x-audio-name', encodeURIComponent(out.name));
    return send(res, 200, out.bytes);
  }

  if (route === 'youtube-search') {
    if (!ALLOW_DOWNLOAD) {
      return json(res, 403, { error: 'start the server with --allow-download to search YouTube soundtracks' });
    }
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) return json(res, 400, { error: 'q is required' });
    const results = await searchYouTube(query, searchOpts(url));
    return json(res, 200, { query, results });
  }

  if (route === 'soundtrack') {
    // Search and load in one move: the singer wants a soundtrack, not a
    // shortlist. Candidates are tried in rank order, so a video that turns out
    // to be undownloadable costs a retry rather than the whole attempt.
    if (!ALLOW_DOWNLOAD) {
      return json(res, 403, { error: 'start the server with --allow-download to load soundtracks' });
    }
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) return json(res, 400, { error: 'q is required' });

    // `skip` is how the app says "that one was wrong, give me the next". The
    // ranking is stable, so the same search yields the same order; the answer
    // reports which rank it actually used, because a candidate that would not
    // download is passed over here and the app must not ask for it again.
    const skip = Math.max(0, Math.min(Number(url.searchParams.get('skip')) || 0, 20));
    const ranked = await searchYouTube(query, searchOpts(url));
    if (!ranked.length) return json(res, 404, { error: `nothing on YouTube matches "${query}"` });
    if (skip >= ranked.length) {
      return json(res, 404, { error: `no further matches for "${query}" after the first ${skip}` });
    }

    const tried = [];
    for (let i = skip; i < Math.min(ranked.length, skip + 3); i++) {
      const hit = ranked[i];
      try {
        const { bytes, type, name } = await downloadAudio(hit.url);
        res.setHeader('content-type', type);
        res.setHeader('x-audio-name', encodeURIComponent(name));
        res.setHeader('x-audio-title', encodeURIComponent(hit.title));
        res.setHeader('x-audio-channel', encodeURIComponent(hit.channel));
        res.setHeader('x-audio-url', hit.url);
        res.setHeader('x-audio-index', String(i));
        return send(res, 200, bytes);
      } catch (err) {
        tried.push(`${hit.title}: ${err.message}`);
      }
    }
    return json(res, 502, { error: `could not download any of ${tried.length} matches`, tried });
  }

  if (route === 'file') {
    const { bytes, type } = await corpusFile(url.searchParams.get('path'));
    res.setHeader('content-type', type);
    return send(res, 200, bytes);
  }

  if (route === 'score') {
    // Pre-processing: the note streams, not the file. The client runs the same
    // buildScore() it always does — that part is cheap, and keeping it there
    // means one implementation of how a score becomes lines.
    const target = url.searchParams.get('url');
    const path = url.searchParams.get('path');
    const { bytes, name } = target ? await fetchScore(target) : await corpusFile(path);
    const parsed = await parseOnly(name, bytes);
    return json(res, 200, { format: 'karaoke-parsed-v1', parsed });
  }

  return json(res, 404, { error: `no such endpoint: ${route}` });
}

// ── reading scores here ──────────────────────────────────────────────

/**
 * The readers hand back a built score; the wire wants only the parse, because
 * building is cheap and the built form has shared note objects that JSON would
 * silently duplicate. So parse, then keep what the client needs to build.
 */
async function parseOnly(name, bytes) {
  const score = await loadFromBytes(name, bytes.buffer ? toArrayBuffer(bytes) : bytes);
  return {
    title: score.title,
    composer: score.composer,
    source: score.source,
    duration: score.duration,
    tracks: score.tracks.map(({ key, label, order }) => ({ key, label, order })),
    voices: score.voices.map(v => ({ key: v.key, label: v.label, order: v.order, notes: v.notes })),
  };
}

const toArrayBuffer = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

async function fetchScore(target) {
  if (!target) throw new Error('url is required');
  const parsed = new URL(target);
  if (!ALLOWED.has(parsed.hostname)) {
    throw new Error(`${parsed.hostname} is not on this server's allow-list`);
  }

  const key = createHash('sha256').update(target).digest('hex').slice(0, 32) + extname(parsed.pathname);
  const cached = join(CACHE, key);
  try {
    return { bytes: await readFile(cached), name: basename(parsed.pathname), type: typeFor(parsed.pathname) };
  } catch { /* not held yet */ }

  const res = await fetch(target, { headers: { 'user-agent': 'karaoke/1.0 (+score fetcher)' } });
  if (!res.ok) throw new Error(`${target} → ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(CACHE, { recursive: true }).catch(() => {});
  await writeFile(cached, bytes).catch(() => {});
  return { bytes, name: basename(parsed.pathname), type: typeFor(parsed.pathname) };
}

/**
 * ── What it now takes to get the audio ───────────────────────────────
 *
 * `yt-dlp <url>` used to be the whole story. It is not, and the failure it
 * produces — "unable to download video data: HTTP Error 403: Forbidden" —
 * names none of the three things that are actually missing:
 *
 *   A JavaScript runtime. The media URL is signed by a parameter that only
 *     the player's own JS knows how to compute, so yt-dlp has to run that JS.
 *     With no runtime it quietly drops to a client that needs no signature,
 *     and those are exactly the ones being withdrawn. We are a node process,
 *     so the runtime is process.execPath: it cannot be missing.
 *
 *   A PO token. The clients that still hand out a direct URL want a proof of
 *     origin with it. bgutil-ytdlp-pot-provider mints them, but only as a
 *     daemon — its one-shot script mode fails on the integrity token often
 *     enough to be no use. So this server starts the daemon and holds it,
 *     rather than making the operator remember a second process.
 *
 *   The right client. Even with both of the above, the default chain lands on
 *     web_safari, which YouTube has moved to SABR streaming and which
 *     therefore publishes no URL at all; yt-dlp falls back to android_vr and
 *     that is what 403s. `tv_simply` still serves plain HTTPS formats.
 *
 * Hence: a runtime we own, a daemon we start, and a ladder of clients rather
 * than a single attempt. The ladder matters because which client works is a
 * property of the video and of the week, not of the installation.
 */

const CLIENT_LADDER = ['tv_simply', 'default', 'web_safari', 'android_vr', 'mweb'];

/** Node is running this file, so it is the one runtime guaranteed present. */
const jsRuntime = () => ['--js-runtimes', `node:${process.execPath}`];

let potState = { ok: false, why: 'not started yet' };
let potChild = null;
let potStarting = null;

const delay = ms => new Promise(ok => setTimeout(ok, ms));

async function potAlive(ms = 1500) {
  try {
    const res = await fetch(`${POT_URL}/ping`, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch { return false; }
}

/**
 * Start the PO-token daemon if it is not already up, once, and remember the
 * answer. A missing helper is reported, not thrown: everything else the server
 * does still works, and the operator gets told what to install.
 */
function ensurePot() {
  if (potStarting) return potStarting;
  potStarting = (async () => {
    if (await potAlive()) return (potState = { ok: true, why: 'already running' });
    try { await stat(POT_SCRIPT); } catch {
      return (potState = { ok: false, why: `no PO-token helper at ${POT_SCRIPT}` });
    }
    potChild = spawn(process.execPath, [POT_SCRIPT, '--port', String(POT_PORT)], { stdio: 'ignore' });
    potChild.on('exit', () => { potChild = null; });
    potChild.on('error', () => { potChild = null; });
    for (let i = 0; i < 40; i++) {
      await delay(250);
      if (await potAlive(800)) return (potState = { ok: true, why: 'started by this server' });
    }
    return (potState = { ok: false, why: 'the PO-token helper did not come up' });
  })();
  return potStarting;
}

// Don't leave the helper running after the thing that started it has gone.
for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (potChild) { try { potChild.kill(); } catch { /* already gone */ } }
    if (signal !== 'exit') process.exit(0);
  });
}

/**
 * Pull the audio out of a video, once, and keep it.
 *
 * This exists so alignment can be tried against a real performance — played by
 * real people, at their own tempo, in their own key — rather than against audio
 * rendered from the same score, which is a much friendlier signal than the real
 * thing and will flatter the algorithm.
 */
async function downloadAudio(target) {
  youtubeUrl(target);                         // keep this safe if called elsewhere
  const key = createHash('sha256').update(target).digest('hex').slice(0, 32);
  const dir = join(CACHE, 'audio');

  await mkdir(dir, { recursive: true });
  const held = (await readDir(dir).catch(() => [])).find(f => f.startsWith(key));
  if (held) return { bytes: await readFile(join(dir, held)), type: 'audio/mpeg', name: held };

  await ensurePot();

  const failures = [];
  for (const client of CLIENT_LADDER) {
    try {
      await run('yt-dlp', [
        ...jsRuntime(),
        ...(client === 'default' ? [] : ['--extractor-args', `youtube:player_client=${client}`]),
        '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '5',
        '--no-playlist', '--no-progress', '--quiet', '--no-warnings',
        '-o', join(dir, `${key}.%(ext)s`), target,
      ]);
    } catch (err) {
      failures.push(`${client}: ${err.message.replace(/^yt-dlp: /, '')}`);
      continue;
    }
    const file = (await readDir(dir)).find(f => f.startsWith(key));
    if (file) return { bytes: await readFile(join(dir, file)), type: 'audio/mpeg', name: file };
    failures.push(`${client}: produced nothing`);
  }
  throw new Error(potState.ok
    ? `every client failed — ${failures[0]}`
    : `every client failed and the PO-token helper is not available (${potState.why}) — ${failures[0]}`);
}

// ── taking the singer out of a recording ─────────────────────────────

/**
 * python-audio-separator (the engine under Ultimate Vocal Remover) splits a
 * mix into vocals and instrumental. It is not bundled and not installed by
 * this server — like yt-dlp, it is shelled out to if the operator has it:
 *
 *   uv tool install "audio-separator[cpu]" --with audioread
 *
 * (--with audioread because the package forgets to declare that dependency.)
 * `--separator-model <file>` picks the model; `audio-separator --list_models`
 * names them, and the defaults are chosen above. The first separation
 * downloads the model into the cache of whichever machine runs it.
 *
 * The probe walks SEP_HOSTS and takes the first place that has the CLI. It is
 * re-asked every few minutes rather than once, because the answer changes: the
 * GPU box that was asleep when this server started deserves to be found when
 * it wakes, and the laptop that left the house deserves to stop being lied
 * about. Nothing heavier than `which` runs until someone actually asks.
 */
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4'];
const SEP_PROBE_TTL = 5 * 60 * 1000;
let sepState = { ok: false, why: 'not probed yet' };
let sepProbe = null;
let sepProbedAt = 0;

function ensureSeparator() {
  if (!sepProbe || Date.now() - sepProbedAt > SEP_PROBE_TTL) {
    sepProbedAt = Date.now();
    sepProbe = probeSeparator().then(state => (sepState = state));
  }
  return sepProbe;
}

async function probeSeparator() {
  const misses = [];
  for (const host of SEP_HOSTS) {
    try {
      if (host === 'local') await run('which', ['audio-separator']);
      else await run('ssh', [...SSH, host, 'PATH=$HOME/.local/bin:$PATH command -v audio-separator']);
      return { ok: true, host, model: (host === 'local' ? SEP_MODEL_LOCAL : SEP_MODEL_REMOTE) || 'default' };
    } catch (err) {
      misses.push(`${host}: ${err.message.replace(/^(ssh|which): /, '')}`);
    }
  }
  return { ok: false, why: `no separator anywhere — ${misses.join('; ')} — uv tool install "audio-separator[cpu]" --with audioread, here or on a listed host` };
}

/** Separations run one at a time: each one wants all the memory there is. */
let sepQueue = Promise.resolve();

function separateInstrumental(bytes, name) {
  const job = sepQueue.catch(() => {}).then(() => runSeparation(bytes, name));
  sepQueue = job;
  return job;
}

const SEP_TIMEOUT = 30 * 60 * 1000;

async function runSeparation(bytes, name) {
  const sep = await ensureSeparator();
  if (!sep.ok) throw new Error(sep.why);

  // Keyed on content, not origin: the same recording separated twice is free,
  // however it arrived. The model is part of the key, because a better model
  // should be allowed to replace a worse answer — and which model ran depends
  // on where, so the resolved name goes in, not the flag.
  const model = sep.host === 'local' ? SEP_MODEL_LOCAL : SEP_MODEL_REMOTE;
  const key = createHash('sha256').update(model || 'default').update(bytes).digest('hex').slice(0, 32);
  const outName = `${basename(name).replace(/\.[^.]*$/, '')} · instrumental.mp3`;
  const dir = join(CACHE, 'instrumental');
  await mkdir(dir, { recursive: true });
  const cached = join(dir, `${key}.mp3`);
  try { return { bytes: await readFile(cached), name: outName }; } catch { /* not held yet */ }

  const ext = extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.mp3';
  const out = sep.host === 'local'
    ? await separateHere(bytes, ext, model)
    : await separateOn(sep.host, bytes, ext, model).catch(err => {
        // A host that failed a job should not be trusted for the next one on
        // the strength of a five-minute-old `which`. Forget it; re-probe.
        sepProbe = null;
        throw new Error(`${sep.host}: ${err.message.replace(/^ssh: /, '')}`);
      });
  await writeFile(cached, out).catch(() => {});
  return { bytes: out, name: outName };
}

async function separateHere(bytes, ext, model) {
  const work = join(CACHE, 'instrumental', `job-${Date.now().toString(36)}`);
  await mkdir(work, { recursive: true });
  const input = join(work, `input${ext}`);
  await writeFile(input, bytes);
  try {
    await run('audio-separator', [
      input,
      ...(model ? ['--model_filename', model] : []),
      '--single_stem', 'Instrumental',
      '--output_format', 'MP3',
      '--output_dir', work,
      '--model_file_dir', join(CACHE, 'models'),
      '--log_level', 'warning',
    ], { timeout: SEP_TIMEOUT });
    const made = (await readDir(work)).find(f => f !== basename(input) && /\.mp3$/i.test(f));
    if (!made) throw new Error('audio-separator finished but produced no instrumental');
    return await readFile(join(work, made));
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The same job on another machine, in one ssh: the audio goes down stdin, the
 * instrumental comes back on stdout, and the far side keeps nothing but its
 * model cache. No scp, no daemon, no open port — the ssh trust that already
 * drives the fleet is the whole transport. audio-separator logs to stdout, so
 * the script sends its chatter to stderr to keep the audio stream clean.
 */
async function separateOn(host, bytes, ext, model) {
  const script = `
    set -e
    export PATH="$HOME/.local/bin:$PATH"
    d=$(mktemp -d)
    trap 'rm -rf "$d"' EXIT
    cat > "$d/input${ext}"
    audio-separator "$d/input${ext}" ${model ? `--model_filename '${model}'` : ''} \
      --single_stem Instrumental --output_format MP3 --output_dir "$d" \
      --model_file_dir "$HOME/.cache/audio-separator-models" --log_level warning 1>&2
    out=$(find "$d" -name '*.mp3' ! -name "input${ext}" | head -1)
    test -n "$out" && cat "$out"
  `;
  const made = await runPiped('ssh', [...SSH, host, script], bytes, { timeout: SEP_TIMEOUT });
  if (!made.length) throw new Error(`${host} finished but sent no instrumental back`);
  return made;
}

/** Like run(), but with bytes in and bytes out rather than text. */
function runPiped(command, argv, input, { timeout = 180000 } = {}) {
  return new Promise((ok, fail) => {
    const path = `${process.env.PATH}:${join(process.env.HOME ?? '', '.local/bin')}:/opt/homebrew/bin`;
    const child = spawn(command, argv, { env: { ...process.env, PATH: path } });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${command}: gave up after ${Math.round(timeout / 60000)} minutes`));
    }, timeout);
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('error', e => { clearTimeout(timer); fail(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return ok(Buffer.concat(out));
      const said = Buffer.concat(err).toString().split('\n').filter(Boolean).pop();
      fail(new Error(`${command}: ${said ?? `exit ${code}`}`));
    });
    child.stdin.on('error', () => { /* the far side may close first */ });
    child.stdin.end(input);
  });
}

/** The request body, whole, with a ceiling — audio, not an upload service. */
function readBody(req, limit) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { fail(new Error('that file is too large to separate')); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

function youtubeUrl(target) {
  if (!target) throw new Error('url is required');
  let video;
  try { video = new URL(target); } catch { throw new Error('url must be a valid YouTube URL'); }
  if (!/^https?:$/.test(video.protocol) || !isYouTube(video.hostname.toLowerCase())) {
    throw new Error('only youtube.com and youtu.be URLs are supported');
  }
  return video;
}

// ── choosing which video is the accompaniment ────────────────────────

/**
 * A search for "Winterreise Schubert" returns lectures, masterclasses and a
 * documentary before it returns anything you can sing over. Ranking is what
 * turns a list of videos into a list of soundtracks, and it is done here rather
 * than in the page because the same judgement serves the automatic pick.
 */
const WANTED = /\b(karaoke|backing[\s-]?track|instrumental|accompaniment|acc?omp|play[\s-]?along|sing[\s-]?along|minus[\s-]?one|playback|piano\s+accompaniment|rehearsal)\b/i;
const REJECTED = /\b(reaction|tutorial|lesson|how\s+to|masterclass|analysis|interview|documentary|review|behind\s+the\s+scenes|trailer|teaser|lyrics?\s+video|live\s+stream|full\s+album|compilation|#shorts)\b/i;
const VOCALS = /\b(cover|sung|sings|singing|vocal|performance|recital|live\s+at|feat\.?)\b/i;

/**
 * Higher is better. Three things decide it: whether the title says it is an
 * accompaniment, whether it says it is something else entirely, and whether it
 * lasts about as long as the score does.
 */
function rankHit(hit, wantSeconds) {
  let score = 0;
  const title = `${hit.title} ${hit.channel}`;

  if (WANTED.test(title)) score += 10;
  if (REJECTED.test(title)) score -= 14;
  if (VOCALS.test(title) && !WANTED.test(title)) score -= 4;

  const secs = hit.duration;
  if (Number.isFinite(secs)) {
    if (secs < 45) score -= 12;                       // a clip, not a track
    else if (secs > 20 * 60) score -= 10;             // a compilation
    if (Number.isFinite(wantSeconds) && wantSeconds > 20) {
      // Within a fifth of the score's own length is a strong signal; the score
      // may be one song out of a cycle, so being shorter is not fatal.
      const ratio = secs / wantSeconds;
      if (ratio > 0.8 && ratio < 1.25) score += 8;
      else if (ratio > 0.5 && ratio < 2) score += 3;
      else score -= 4;
    }
  }
  return score;
}

/**
 * Ask more than once. One phrasing finds one corner of YouTube: "karaoke" finds
 * the pop machine, "backing track" finds the jazz one, "piano accompaniment"
 * finds the art-song one, and the bare title finds whatever else exists. The
 * variants run together and the results are merged, so a song that only one
 * phrasing knows about is still found.
 */
function queryVariants(query, style) {
  const base = query.replace(/\s+/g, ' ').trim().slice(0, 200);
  const byStyle = {
    classical: ['piano accompaniment', 'accompaniment only'],
    jazz: ['backing track', 'play along'],
    pop: ['karaoke', 'instrumental'],
  };
  const tails = byStyle[style] ?? ['karaoke', 'backing track', 'instrumental'];
  return [...new Set([`${base} ${tails[0]}`, `${base} ${tails[1]}`, base])];
}

async function searchOnce(term, count) {
  const stdout = await run('yt-dlp', [
    '--flat-playlist', '--dump-single-json', '--no-warnings', '--no-playlist',
    `ytsearch${count}:${term.slice(0, 240)}`,
  ]);
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error('yt-dlp returned an unreadable search response'); }
  return (Array.isArray(data.entries) ? data.entries : []).flatMap(entry => {
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return [];
    return [{
      id,
      title: String(entry.title || 'Untitled'),
      channel: String(entry.channel || entry.uploader || ''),
      duration: Number.isFinite(entry.duration) ? entry.duration : null,
      url: `https://www.youtube.com/watch?v=${id}`,
    }];
  });
}

/**
 * The last few rankings, so that asking for "the next one" means something.
 *
 * YouTube does not return the same order twice, and half the candidates tie on
 * score, so re-searching for each rejected track would reshuffle the list under
 * the app and hand back what it had just refused. Ranking once and remembering
 * it for a few minutes is what makes `skip` a position rather than a guess.
 */
const rankings = new Map();
const RANKING_TTL = 10 * 60 * 1000;

function rememberRanking(key, results) {
  rankings.set(key, { at: Date.now(), results });
  for (const [k, v] of rankings) if (Date.now() - v.at > RANKING_TTL) rankings.delete(k);
  return results;
}

/**
 * Search metadata only — no media is fetched until something chooses a hit.
 * A variant that fails is dropped rather than failing the search: three ways of
 * asking means two of them can go wrong and there is still an answer.
 */
async function searchYouTube(query, { duration, style, limit = 10 } = {}) {
  const key = `${query}|${duration}|${style}|${limit}`;
  const held = rankings.get(key);
  if (held && Date.now() - held.at < RANKING_TTL) return held.results;

  const variants = queryVariants(query, style);
  const rounds = await Promise.all(
    variants.map(term => searchOnce(term, 8).catch(() => [])),
  );
  if (rounds.every(r => !r.length)) {
    // All three empty means the search itself is broken, not that the song is
    // unknown — say so rather than reporting "no tracks found".
    await searchOnce(variants[0], 5);         // let the real error surface
    return [];
  }

  const byId = new Map();
  for (const hit of rounds.flat()) if (!byId.has(hit.id)) byId.set(hit.id, hit);

  // Sort is stable, so candidates that tie on score keep the order YouTube gave
  // them — which is the only relevance signal left once scoring has run out.
  const ranked = [...byId.values()]
    .map(hit => ({ ...hit, score: rankHit(hit, duration) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return rememberRanking(key, ranked);
}

function run(command, argv, { timeout = 180000 } = {}) {
  return new Promise((ok, fail) => {
    // yt-dlp is often installed per-user rather than on the system path.
    const path = `${process.env.PATH}:${join(process.env.HOME ?? '', '.local/bin')}:/opt/homebrew/bin`;
    execFile(command, argv, { env: { ...process.env, PATH: path }, timeout, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        if (err) fail(new Error(`${command}: ${(stderr || err.message).split('\n').filter(Boolean).pop() ?? err.message}`));
        else ok(stdout);
      });
  });
}

// ── a folder of scores on this machine ───────────────────────────────

let indexed = null;

async function corpusIndex() {
  if (!CORPUS) return [];
  if (indexed) return indexed;
  const found = [];
  // A folder may say what kind of music it holds, in a `.karaoke-style` file the
  // importer writes. Nothing else knows: a file on this machine carries no
  // catalogue, and guessing from the title is what the app falls back to.
  const walk = async (dir, depth, style) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const declared = await readFile(join(dir, '.karaoke-style'), 'utf8').catch(() => null);
    const here = declared?.trim() || style;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1, here);
      else if (SCORE_EXT.test(entry.name)) {
        const info = await stat(full).catch(() => null);
        found.push({
          path: full.slice(CORPUS.length + 1),
          title: entry.name.replace(SCORE_EXT, '').replace(/[_]+/g, ' ').trim(),
          artist: dir === CORPUS ? '' : basename(dir).replace(/[_]+/g, ' '),
          style: here || '',
          bytes: info?.size ?? 0,
        });
      }
    }
  };
  await walk(CORPUS, 0, '');
  indexed = found.sort((a, b) => a.title.localeCompare(b.title));
  return indexed;
}

const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function searchCorpus(query, limit) {
  const rows = await corpusIndex();
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const hits = terms.length
    ? rows.filter(r => { const key = fold(`${r.title} ${r.artist} ${r.path}`); return terms.every(t => key.includes(t)); })
    : rows;
  return hits.slice(0, limit).map(r => ({
    id: `local:${r.path}`,
    title: r.title,
    artist: r.artist,
    set: '',
    url: `/api/file?path=${encodeURIComponent(r.path)}`,
    parsedUrl: `/api/score?path=${encodeURIComponent(r.path)}`,
    format: extname(r.path).slice(1),
    licence: 'local file',
    ...(r.style ? { style: r.style } : {}),
    sourceId: 'local',
  }));
}

/** A path is only ever read from inside the corpus folder. */
async function corpusFile(rel) {
  if (!CORPUS) throw new Error('this server was started without --corpus');
  if (!rel) throw new Error('path is required');
  const full = resolve(CORPUS, rel);
  if (full !== CORPUS && !full.startsWith(CORPUS + sep)) throw new Error('path is outside the corpus');
  return { bytes: await readFile(full), name: basename(full), type: typeFor(full) };
}

// ── the app itself, so one command runs everything ───────────────────

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
  '.musicxml': 'application/vnd.recordare.musicxml+xml', '.xml': 'application/xml',
  '.mxl': 'application/vnd.recordare.musicxml', '.mscz': 'application/octet-stream',
  '.mscx': 'application/xml',
};
const typeFor = path => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

async function serveStatic(url, res) {
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
  const full = resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return send(res, 403, 'no');
  try {
    const bytes = await readFile(full);
    res.setHeader('content-type', typeFor(full));
    res.setHeader('cache-control', 'no-store');
    return send(res, 200, bytes);
  } catch {
    return send(res, 404, 'not found');
  }
}

// ── plumbing ─────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-audio-name');
  // Without this a cross-origin page can get the audio but not its name.
  res.setHeader('access-control-expose-headers',
    'x-audio-name, x-audio-title, x-audio-channel, x-audio-url, x-audio-index');
}
function json(res, status, body) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  send(res, status, JSON.stringify(body));
}
function send(res, status, body) {
  res.writeHead(status);
  res.end(body);
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=');
    out[key] = inline ?? (argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true);
  }
  return out;
}

server.listen(PORT, HOST, async () => {
  console.log(`karaoke server → http://${HOST}:${PORT}`);
  console.log(`  app        ${ROOT}`);
  console.log(`  proxying   ${[...ALLOWED].join(', ')}`);
  if (ALLOW_DOWNLOAD) {
    console.log('  /api/audio  ON — yt-dlp will be called for testing');
    // Start the PO-token helper now rather than on the first download, so the
    // first soundtrack is not the one that pays for it.
    const pot = await ensurePot();
    console.log(pot.ok
      ? `  po-token   ${POT_URL} (${pot.why})`
      : `  po-token   unavailable — ${pot.why}\n             downloads will 403 on many videos; see README`);
  }
  const sep = await ensureSeparator();
  console.log(sep.ok
    ? `  separator  /api/separate removes vocals on ${sep.host} (model: ${sep.model})`
    : `  separator  none — ${sep.why}`);
  if (CORPUS) console.log(`  corpus     ${CORPUS} (${(await corpusIndex()).length} scores)`);
  else console.log('  corpus     none — pass --corpus <folder> to search your own scores');
});
