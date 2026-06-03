import { Bounds, Element } from '../types';

// Parses uiautomator XML (from `adb shell uiautomator dump`) into normalized
// Element[]. We hand-roll a tiny tag scanner rather than pulling in an XML
// dependency: uiautomator output is regular and entity-escaped, so a
// quote-aware scan + attribute regex is robust for this specific format.

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Values are double-quoted and any literal '"' is escaped to &quot;, so [^"]*
  // safely captures the whole value.
  const re = /([\w:.-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagBody))) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

function simpleType(cls: string): string {
  if (!cls) return 'View';
  const parts = cls.split('.');
  return parts[parts.length - 1] || cls;
}

function parseBounds(s: string | undefined): Bounds {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s ?? '');
  if (!m) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] };
}

const asBool = (v: string | undefined): boolean => v === 'true';

function buildElement(a: Record<string, string>, depth: number): Element {
  const cls = a['class'] ?? '';
  const id = a['resource-id'] ?? '';
  const bounds = parseBounds(a['bounds']);
  return {
    index: -1,
    class: cls,
    type: simpleType(cls),
    id,
    idShort: id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id,
    text: a['text'] ?? '',
    desc: a['content-desc'] ?? '',
    bounds,
    center: {
      x: Math.floor((bounds.x1 + bounds.x2) / 2),
      y: Math.floor((bounds.y1 + bounds.y2) / 2),
    },
    depth,
    clickable: asBool(a['clickable']),
    longClickable: asBool(a['long-clickable']),
    checkable: asBool(a['checkable']),
    checked: asBool(a['checked']),
    focusable: asBool(a['focusable']),
    focused: asBool(a['focused']),
    scrollable: asBool(a['scrollable']),
    enabled: a['enabled'] === undefined ? true : asBool(a['enabled']),
    selected: asBool(a['selected']),
    password: asBool(a['password']),
  };
}

/**
 * "Interesting" = something an agent can act on or read. Pure layout containers
 * (no text/id/desc and not interactive) are dropped to keep snapshots compact.
 */
export function isInteresting(el: Element): boolean {
  const w = el.bounds.x2 - el.bounds.x1;
  const h = el.bounds.y2 - el.bounds.y1;
  if (w <= 0 || h <= 0) return false; // not visible / not tappable
  if (el.text.trim()) return true;
  if (el.desc.trim()) return true;
  if (el.id) return true;
  if (el.clickable || el.checkable || el.scrollable || el.longClickable) return true;
  if (/EditText|AutoComplete|TextField|Edit$/.test(el.class)) return true;
  return false;
}

export function parseHierarchy(xml: string, opts: { all?: boolean } = {}): Element[] {
  const all: Element[] = [];
  const n = xml.length;
  let i = 0;
  let depth = 0;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;

    // Find the matching '>' that is not inside a quoted attribute value.
    let j = lt + 1;
    let inQuote = false;
    while (j < n) {
      const c = xml[j];
      if (c === '"') inQuote = !inQuote;
      else if (c === '>' && !inQuote) break;
      j++;
    }
    if (j >= n) break;

    const tag = xml.slice(lt + 1, j);
    i = j + 1;

    if (tag[0] === '?' || tag[0] === '!') continue; // <?xml ...?> / comments
    if (tag[0] === '/') {
      const closeName = tag.slice(1).trim();
      if (closeName === 'node') depth = Math.max(0, depth - 1);
      continue;
    }

    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);

    if (name === 'node') {
      all.push(buildElement(parseAttrs(body), depth));
      if (!selfClosing) depth++;
    }
  }

  const result = opts.all ? all : all.filter(isInteresting);
  result.forEach((el, idx) => {
    el.index = idx;
  });
  return result;
}
