/**
 * Turn a score spec into a MusicXML file the player can load.
 *
 *   node tools/make-score.mjs tools/example-song.mjs
 *   node tools/make-score.mjs my-song.mjs assets/my-song.musicxml
 *
 * The spec module must default-export one score spec — see tools/example-song.mjs
 * for the shape, and tools/musicxml-writer.mjs for the syntax of notes and
 * syllables. This is the quickest route to a multi-language score if you are
 * transcribing by hand; if you already have the tune in MuseScore, adding verses
 * there and exporting MusicXML is quicker still.
 */

import { writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMusicXML, validate } from './musicxml-writer.mjs';

const [specPath, outPath] = process.argv.slice(2);
if (!specPath) {
  console.error('usage: node tools/make-score.mjs <spec.mjs> [out.musicxml]');
  process.exit(1);
}

const spec = (await import(pathToFileURL(resolve(specPath)).href)).default;
const name = basename(specPath).replace(/\.mjs$/, '');
const notes = validate(spec, name);
const target = resolve(outPath || `assets/${name}.musicxml`);

writeFileSync(target, buildMusicXML(spec));
console.log(`${target}\n  ${notes} notes · ${spec.tracks.length} language track(s): ${spec.tracks.map(t => t.label).join(', ')}`);
