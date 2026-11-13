/**
 * One seam so the readers can run outside a browser.
 *
 * `js/musicxml.js` and `js/musescore.js` are otherwise environment-neutral —
 * they walk a tree and do arithmetic — and the only thing they need from a
 * browser is a way to turn text into that tree. In a page that is DOMParser; on
 * a server it is whatever `setXMLParser` was handed. Everything else about them
 * stays identical, so a score parses the same on both sides.
 */

let impl = typeof DOMParser === 'undefined'
  ? null
  : text => new DOMParser().parseFromString(text, 'application/xml');

/** Teach this module how to read XML where there is no DOMParser. */
export function setXMLParser(fn) { impl = fn; }

export function parseXML(text) {
  if (!impl) throw new Error('no XML parser here — call setXMLParser() first');
  return impl(text);
}
