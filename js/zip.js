/**
 * Minimal ZIP reader — enough for compressed MusicXML (.mxl) and MuseScore (.mscz),
 * which are both just zip containers. Inflate is delegated to the platform's
 * DecompressionStream, so there is no bundled decompressor.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;

export function readZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // End of central directory: scan backwards over the (max 64k) trailing comment.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');

  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const entries = [];

  for (let i = 0; i < count && off + 46 <= bytes.length; i++) {
    if (view.getUint32(off, true) !== SIG_CEN) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));

    // The local header repeats the name/extra with possibly different lengths.
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;

    entries.push({ name, method, data: bytes.subarray(start, start + compSize) });
    off += 46 + nameLen + extraLen + commentLen;
  }

  if (!entries.length) throw new Error('zip archive is empty');
  return entries;
}

export async function entryText(entry) {
  if (entry.method === 0) return new TextDecoder().decode(entry.data);
  if (entry.method !== 8) throw new Error(`unsupported zip compression (${entry.method})`);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot inflate zip files — use the uncompressed .musicxml export');
  }
  const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}
