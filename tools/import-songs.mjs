/**
 * Put a pile of scores into the corpus the server searches.
 *
 * The two catalogues the app reaches on its own stop where copyright starts:
 * OpenScore's Lieder are nineteenth-century, and OpenEWLD's lead sheets are the
 * public-domain half of Wikifonia, which runs out around 1930. Everything since
 * then exists, and is not free to redistribute, so it cannot be shipped — but a
 * copy you already have is a copy you already have. This puts one where the
 * server can find it.
 *
 *   node tools/import-songs.mjs ~/Downloads/Wikifonia.zip --corpus ~/Documents/MuseScore3/Scores
 *   node tools/import-songs.mjs ~/Downloads/scores --collection "From MuseScore" --style pop
 *   node tools/import-songs.mjs ~/Downloads/Wikifonia.zip --corpus ~/Scores --dry-run
 *
 * The source may be a .zip or a folder. Names are read the way Wikifonia writes
 * them — `Artist - Title.mxl` — because the corpus indexer takes the artist from
 * the folder a score sits in and the title from its filename, so the import is
 * what decides whether searching for a composer finds anything.
 *
 * A collection may declare what kind of music it holds, in a `.karaoke-style`
 * file the server reads. That is what puts imported songs under the right chip
 * in the finder, and what decides whether their soundtrack is looked for as a
 * "karaoke" or as a "piano accompaniment".
 */

import { readdir, mkdir, stat, copyFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve, extname, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const SCORE_EXT = /\.(mxl|musicxml|xml|mscz|mscx|kar|mid|midi)$/i;
const STYLES = ['classical', 'jazz', 'pop', 'folk'];

const args = parseArgs(process.argv.slice(2));
const expandHome = p => (p?.startsWith('~') ? join(process.env.HOME ?? '', p.slice(1)) : p);

const source = args._[0] ? resolve(expandHome(args._[0])) : null;
const corpus = resolve(expandHome(args.corpus ?? '~/Documents/MuseScore3/Scores'));
const collection = String(args.collection ?? '').trim() || null;
const style = args.style ? String(args.style).toLowerCase() : null;
const limit = Number(args.limit) || Infinity;
const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';

if (!source) {
  console.error('usage: node tools/import-songs.mjs <folder-or-zip> [--corpus <folder>] [--collection <name>] [--style classical|jazz|pop|folk] [--limit N] [--dry-run]');
  process.exit(1);
}
if (style && !STYLES.includes(style)) {
  console.error(`--style must be one of ${STYLES.join(', ')}`);
  process.exit(1);
}

const run = (cmd, argv) => new Promise((ok, fail) =>
  execFile(cmd, argv, { maxBuffer: 1 << 28 }, (err, out) => (err ? fail(err) : ok(out))));

/** A zip is unpacked somewhere temporary and thrown away after. */
async function sourceFolder() {
  const info = await stat(source).catch(() => null);
  if (!info) throw new Error(`${source} is not there`);
  if (info.isDirectory()) return { dir: source, temp: null };
  if (!/\.zip$/i.test(source)) throw new Error(`${source} is neither a folder nor a .zip`);

  const temp = join(tmpdir(), `karaoke-import-${Date.now()}`);
  await mkdir(temp, { recursive: true });
  console.log(`unpacking ${basename(source)}…`);
  await run('unzip', ['-q', '-o', source, '-d', temp]);
  return { dir: temp, temp };
}

async function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;      // dotfiles, and macOS `._` forks
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, depth + 1);
    else if (SCORE_EXT.test(entry.name)) yield full;
  }
}

/**
 * Who wrote it and what it is called.
 *
 * Wikifonia writes both into the filename with a hyphen between, and a hyphen is
 * also an ordinary thing to have in a title, so only the first one counts. A file
 * that says nothing about its composer keeps the folder it came in as the artist,
 * which is how a folder-per-album export already reads.
 */
function nameOf(file, root) {
  const stem = basename(file, extname(file));
  const parent = basename(dirname(file));
  const split = stem.indexOf(' - ');
  if (split > 0) {
    return { artist: stem.slice(0, split).trim(), title: stem.slice(split + 3).trim() };
  }
  const folder = dirname(file) === root ? '' : parent.replace(/_+/g, ' ').trim();
  return { artist: folder, title: stem.replace(/_+/g, ' ').trim() };
}

/** Filenames are written, not parsed, so anything a path cannot hold goes. */
const safe = s => s.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Unknown';

async function main() {
  const { dir, temp } = await sourceFolder();
  const into = collection ? join(corpus, safe(collection)) : corpus;

  const files = [];
  for await (const file of walk(dir)) {
    files.push(file);
    if (files.length >= limit) break;
  }
  console.log(`${files.length} score${files.length === 1 ? '' : 's'} found in ${dir}`);
  if (!files.length) { if (temp) await rm(temp, { recursive: true, force: true }); return; }

  let written = 0, skipped = 0;
  const seen = new Set();
  for (const file of files) {
    const { artist, title } = nameOf(file, dir);
    const target = join(into, safe(artist || 'Unknown'), `${safe(title)}${extname(file).toLowerCase()}`);

    // Two files that reduce to one name would overwrite each other; keep both.
    let unique = target;
    for (let n = 2; seen.has(unique); n++) {
      unique = target.replace(/(\.[^.]+)$/, ` (${n})$1`);
    }
    seen.add(unique);

    if (dryRun) {
      if (written < 12) console.log(`  ${artist || '—'} · ${title}`);
      written++;
      continue;
    }
    try {
      await mkdir(dirname(unique), { recursive: true });
      await copyFile(file, unique);
      written++;
    } catch (err) {
      skipped++;
      if (skipped < 5) console.warn(`  skipped ${basename(file)}: ${err.message}`);
    }
  }

  if (!dryRun && style) {
    await writeFile(join(into, '.karaoke-style'), `${style}\n`).catch(() => {});
  }
  if (temp) await rm(temp, { recursive: true, force: true });

  console.log(dryRun
    ? `dry run: ${written} would be written under ${into}`
    : `${written} written under ${into}${skipped ? `, ${skipped} skipped` : ''}${style ? `, tagged ${style}` : ''}`);
  if (!dryRun) console.log('restart the server (or it will keep its old index) and they are searchable.');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=');
    out[key] = inline ?? (argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true);
  }
  return out;
}

main().catch(err => { console.error(err.message); process.exit(1); });
