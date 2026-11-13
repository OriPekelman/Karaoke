/**
 * Just enough XML for the readers, where there is no DOMParser.
 *
 * This is not a DOM. It is the handful of things `js/musicxml.js`,
 * `js/musescore.js` and `js/load.js` actually touch — `children`, `nodeName`,
 * `textContent`, `getAttribute`, `hasAttribute`, `getElementsByTagName`, and a
 * `querySelector` that only understands a bare tag name — implemented over a
 * single pass of the text. Writing it costs about a hundred lines and keeps this
 * project's best property: no dependencies, and nothing to install.
 *
 * It is checked the only way that means anything: the server parses a score and
 * compares the result, field for field, against what the browser makes of the
 * same file.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

class Element {
  constructor(nodeName) {
    this.nodeName = nodeName;
    this.tagName = nodeName;
    this.attributes = new Map();
    this.children = [];      // elements only, which is all the readers walk
    this.nodes = [];         // elements and strings, in order, for textContent
    this.parentNode = null;
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }

  get textContent() {
    let out = '';
    for (const node of this.nodes) out += typeof node === 'string' ? node : node.textContent;
    return out;
  }

  getElementsByTagName(name) {
    const out = [];
    const walk = el => {
      for (const child of el.children) {
        if (name === '*' || child.nodeName === name) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  /** Only a bare tag name — that is all the readers ask for. */
  querySelector(selector) {
    return this.getElementsByTagName(selector)[0] ?? null;
  }
}

class Document extends Element {
  constructor() {
    super('#document');
    this.documentElement = null;
  }
}

const NAME = /[^\s/>]+/y;
const ATTR = /\s*([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/y;

/**
 * One pass, no recursion: push on an open tag, pop on a close tag. Anything that
 * is not an element or text — comments, the XML declaration, the doctype — is
 * skipped whole, and CDATA becomes literal text.
 */
export function parseXML(text) {
  const doc = new Document();
  const stack = [doc];
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(stack[stack.length - 1], text.slice(i));
      break;
    }
    if (lt > i) addText(stack[stack.length - 1], text.slice(i, lt));

    // <!-- comment -->, <![CDATA[...]]>, <!DOCTYPE ...>, <?xml ...?>
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const body = text.slice(lt + 9, end < 0 ? text.length : end);
      stack[stack.length - 1].nodes.push(body);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      i = skipDoctype(text, lt);
      continue;
    }

    if (text[lt + 1] === '/') {                       // closing tag
      const end = text.indexOf('>', lt);
      const name = text.slice(lt + 2, end < 0 ? text.length : end).trim();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].nodeName === name) { stack.length = s; break; }
      }
      i = end < 0 ? text.length : end + 1;
      continue;
    }

    // opening tag
    NAME.lastIndex = lt + 1;
    const nameMatch = NAME.exec(text);
    if (!nameMatch) { i = lt + 1; continue; }
    const el = new Element(nameMatch[0]);

    let at = NAME.lastIndex;
    for (;;) {
      ATTR.lastIndex = at;
      const attr = ATTR.exec(text);
      if (!attr) break;
      el.attributes.set(attr[1], decodeEntities(attr[3] ?? attr[4] ?? ''));
      at = ATTR.lastIndex;
    }

    const close = text.indexOf('>', at);
    const selfClosing = close > 0 && text[close - 1] === '/';
    const parent = stack[stack.length - 1];
    el.parentNode = parent === doc ? null : parent;
    parent.children.push(el);
    parent.nodes.push(el);
    if (parent === doc && !doc.documentElement) doc.documentElement = el;
    if (!selfClosing) stack.push(el);
    i = close < 0 ? text.length : close + 1;
  }

  if (!doc.documentElement) throw new Error('file is not well-formed XML');
  return doc;
}

function addText(parent, raw) {
  if (!raw || parent.nodeName === '#document') return;   // whitespace between top-level nodes
  parent.nodes.push(decodeEntities(raw));
}

/** A doctype may carry an internal subset in brackets; step over the lot. */
function skipDoctype(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  return text.length;
}
