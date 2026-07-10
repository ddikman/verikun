import { Bounds, Element } from '../types';

// Parses `idb ui describe-all --json` output into the same normalized Element[]
// the Android XML parser produces, so the selector / format / command layers stay
// platform-agnostic. idb returns a FLAT list of accessibility elements (no parent
// nesting), each an object with fields like frame / AXUniqueId / AXLabel / AXValue /
// type / role / help. Because the list is flat, `depth` is always 0 — there is no
// tree to indent for `--tree`.
//
// iOS accessibility has no direct analog for some Android booleans (clickable,
// scrollable, checkable), so we DERIVE them from the element `type`. These are
// best-effort heuristics; matching still works off text / id regardless.

interface RawFrame {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface RawElement {
  frame?: RawFrame;
  AXFrame?: string;
  AXUniqueId?: string | null;
  AXLabel?: string | null;
  AXValue?: string | null;
  title?: string | null;
  help?: string | null;
  role?: string | null;
  role_description?: string | null;
  type?: string | null;
  subrole?: string | null;
  enabled?: unknown;
  custom_actions?: unknown;
  [k: string]: unknown;
}

// XCUIElementType names (idb `type`) that are meaningful tap targets — used to
// derive `clickable`, which iOS accessibility does not expose as a flag.
const TAPPABLE_TYPES = new Set([
  'Button', 'Cell', 'Link', 'MenuItem', 'MenuButton', 'PopUpButton', 'CheckBox',
  'RadioButton', 'Switch', 'Toggle', 'SegmentedControl', 'Tab', 'Key', 'Stepper',
  'Icon', 'SearchField', 'TextField', 'SecureTextField', 'DatePicker',
]);
const SCROLLABLE_TYPES = new Set(['ScrollView', 'Table', 'TableView', 'CollectionView', 'WebView']);
const CHECKABLE_TYPES = new Set(['Switch', 'Toggle', 'CheckBox', 'RadioButton']);
const TEXT_INPUT_TYPES = new Set(['TextField', 'SecureTextField', 'SearchField', 'TextView']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function isTrue(v: unknown): boolean {
  if (v === true) return true;
  const s = str(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

function stripAx(role: string): string {
  return role.startsWith('AX') ? role.slice(2) : role;
}

function parseFrame(raw: RawElement): Bounds {
  const f = raw.frame;
  if (
    f &&
    typeof f.x === 'number' &&
    typeof f.y === 'number' &&
    typeof f.width === 'number' &&
    typeof f.height === 'number'
  ) {
    return {
      x1: Math.round(f.x),
      y1: Math.round(f.y),
      x2: Math.round(f.x + f.width),
      y2: Math.round(f.y + f.height),
    };
  }
  // Fallback: AXFrame is a string like "{{x, y}, {w, h}}".
  const m = /\{\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\},\s*\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\}\}/.exec(str(raw.AXFrame));
  if (m) {
    const x = parseFloat(m[1]);
    const y = parseFloat(m[2]);
    const w = parseFloat(m[3]);
    const h = parseFloat(m[4]);
    return { x1: Math.round(x), y1: Math.round(y), x2: Math.round(x + w), y2: Math.round(y + h) };
  }
  return { x1: 0, y1: 0, x2: 0, y2: 0 };
}

function buildElement(raw: RawElement): Element {
  const bounds = parseFrame(raw);
  const id = str(raw.AXUniqueId);
  const type = str(raw.type) || stripAx(str(raw.role)) || 'Other';
  const cls = str(raw.role) || type;
  // iOS conflates "visible text" and "content-desc" into accessibilityLabel; a
  // filled text field surfaces its contents as AXValue. Prefer the label, then a
  // title, then the value, as the identifying text. `help` (accessibilityHint) is
  // the closest analog to Android's content-desc, so it becomes `desc`.
  const text = str(raw.AXLabel) || str(raw.title) || str(raw.AXValue);
  const checkable = CHECKABLE_TYPES.has(type);
  const clickable =
    TAPPABLE_TYPES.has(type) || (Array.isArray(raw.custom_actions) && raw.custom_actions.length > 0);
  return {
    index: -1,
    class: cls,
    type,
    id,
    idShort: id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id,
    text,
    desc: str(raw.help),
    bounds,
    center: {
      x: Math.floor((bounds.x1 + bounds.x2) / 2),
      y: Math.floor((bounds.y1 + bounds.y2) / 2),
    },
    depth: 0,
    clickable,
    longClickable: false,
    checkable,
    checked: checkable && isTrue(raw.AXValue),
    focusable: false,
    focused: false,
    scrollable: SCROLLABLE_TYPES.has(type),
    enabled: raw.enabled === undefined ? true : isTrue(raw.enabled),
    selected: false,
    password: type === 'SecureTextField',
  };
}

/**
 * "Interesting" = something an agent can act on or read. Mirrors the Android
 * filter's intent (drop pure layout containers) with iOS predicates.
 */
export function isInteresting(el: Element): boolean {
  const w = el.bounds.x2 - el.bounds.x1;
  const h = el.bounds.y2 - el.bounds.y1;
  if (w <= 0 || h <= 0) return false; // not visible / not tappable
  if (el.text.trim()) return true;
  if (el.desc.trim()) return true;
  if (el.id) return true;
  if (el.clickable || el.checkable || el.scrollable) return true;
  if (TEXT_INPUT_TYPES.has(el.type)) return true;
  return false;
}

export function parseIosHierarchy(jsonText: string, opts: { all?: boolean } = {}): Element[] {
  const all = parseIdbJson(jsonText).map(buildElement);
  const result = opts.all ? all : all.filter(isInteresting);
  result.forEach((el, idx) => {
    el.index = idx;
  });
  return result;
}

/** idb `--json` emits a JSON array; tolerate NDJSON (one object per line) too. */
function parseIdbJson(text: string): RawElement[] {
  const t = text.trim();
  if (!t) return [];
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed as RawElement[];
    if (parsed && typeof parsed === 'object') return [parsed as RawElement];
  } catch {
    /* fall through to NDJSON */
  }
  const out: RawElement[] = [];
  for (const line of t.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') out.push(o as RawElement);
    } catch {
      /* skip a malformed line rather than fail the whole dump */
    }
  }
  return out;
}
