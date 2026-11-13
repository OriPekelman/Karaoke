/**
 * One entry point for getting a score into the app, whatever shape it arrives in.
 * When a backend appears, `loadFromUrl` is the seam: point it at an API route.
 */

import { readZip, entryText } from './zip.js';
import { parseXML } from './dom.js';
import { parseMusicXML } from './musicxml.js';
import { parseMuseScore } from './musescore.js';
import { parseMidi } from './midi.js';
import { buildScore } from './score.js';

export const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|opus|flac|webm)$/i;

export async function loadFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch ${url} (${res.status})`);
  const name = url.split('/').pop() || 'score';
  return decode(name, await res.arrayBuffer());
}

export async function loadFromFile(file) {
  return decode(file.name, await file.arrayBuffer());
}

/** For bytes you already hold — read back out of the offline store, say. */
export async function loadFromBytes(name, buffer) {
  return decode(name, buffer);
}

async function decode(name, buffer) {
  const lower = name.toLowerCase();

  if (lower.endsWith('.mxl')) return buildScore(parseMusicXML(await pickFromZip(buffer, 'musicxml')));
  if (lower.endsWith('.mscz')) return buildScore(parseMuseScore(await pickFromZip(buffer, 'musescore')));
  if (/\.(kar|mid|midi)$/.test(lower) || startsWith(buffer, 'MThd')) return buildScore(parseMidi(buffer));

  const text = new TextDecoder().decode(buffer);
  if (lower.endsWith('.mscx')) return buildScore(parseMuseScore(text));
  if (lower.endsWith('.musicxml') || lower.endsWith('.xml')) return buildScore(parseMusicXML(text));

  // Unknown extension: sniff it.
  if (/<museScore/i.test(text)) return buildScore(parseMuseScore(text));
  if (/<score-partwise|<score-timewise/i.test(text)) return buildScore(parseMusicXML(text));
  if (buffer.byteLength > 4 && new Uint8Array(buffer)[0] === 0x50) {
    // Looks like a zip — try both containers.
    try { return buildScore(parseMusicXML(await pickFromZip(buffer, 'musicxml'))); } catch { /* fall through */ }
    return buildScore(parseMuseScore(await pickFromZip(buffer, 'musescore')));
  }
  throw new Error(`${name}: not a MusicXML, MuseScore or MIDI file`);
}

/** The first bytes, as ASCII — enough to know a MIDI file when we see one. */
function startsWith(buffer, signature) {
  if (buffer.byteLength < signature.length) return false;
  const head = new Uint8Array(buffer, 0, signature.length);
  return [...signature].every((c, i) => head[i] === c.charCodeAt(0));
}

async function pickFromZip(buffer, kind) {
  const entries = readZip(buffer);

  if (kind === 'musicxml') {
    // The container manifest names the real score; fall back to a scan.
    const container = entries.find(e => e.name === 'META-INF/container.xml');
    if (container) {
      const doc = parseXML(await entryText(container));
      const path = doc.querySelector('rootfile')?.getAttribute('full-path');
      const hit = path && entries.find(e => e.name === path);
      if (hit) return entryText(hit);
    }
    const guess = entries.find(e => !e.name.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(e.name));
    if (guess) return entryText(guess);
    throw new Error('no score found inside the .mxl archive');
  }

  const mscx = entries.find(e => /\.mscx$/i.test(e.name) && !e.name.startsWith('META-INF/'));
  if (!mscx) throw new Error('no .mscx found inside the .mscz archive');
  return entryText(mscx);
}
