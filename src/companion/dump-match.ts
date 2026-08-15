/**
 * Does the companion's dump agree with the platform's own?
 *
 * This is the standard `calibrate()` holds the companion to before trusting a single one of
 * its reads. It used to be plain string equality, and that is still the fast path — but
 * equality turned out to be stricter than the property it was standing in for, and strictly
 * enough to reject a companion that was right.
 *
 * The property that actually matters is TAP SAFETY: verikun taps the centre of a node the
 * dump reported, so every node the companion serves must be one the platform would have
 * served, with the same bounds. Byte equality implies that. It also demands something extra
 * and unrelated — that the companion reproduce every node the platform emitted, including
 * decor nobody can touch — and that is what broke.
 *
 * MEASURED (issue #79). Asking the accessibility layer for window information is what stops
 * a long-lived connection serving a stale window, but it also makes Android clamp node
 * bounds to the app window rather than the display. On a Pixel 6 emulator (Android 14) that
 * drops exactly one node from the dump, `android:id/navigationBarBackground` at
 * [0,2274][1080,2400] — not clickable, not focusable, and below every pixel the app owns.
 * Every other node, root included, stayed byte-identical. Equality still said no, so the
 * companion was benched and reads went from ~165ms to ~33s.
 *
 * So the rule is a subsequence with two guards:
 *
 *   1. every companion node is byte-identical to a platform node, in document order — this
 *      is the tap-safety property, and it is not weakened at all;
 *   2. every platform node the companion lacks is a LEAF and is neither clickable nor
 *      focusable — so the companion can never quietly drop something tappable, nor a
 *      container whose absence would re-nest the nodes under it.
 *
 * Guard 2 is deliberately stricter than the measurement requires: an unmatched container
 * would still leave its children matchable, but the shapes that produces have not been seen
 * on a real device, and the cost of refusing one is a slow read rather than a wrong tap.
 *
 * What this does NOT still guarantee is that a non-interactive leaf's bounds agree — such a
 * node can differ and be treated as missing. That is the deliberate give: it cannot move a
 * tap, because nothing reads it.
 */

export interface DumpMatch {
  agree: boolean;
  /** Why not, for the stand-down message. Absent when they agree. */
  reason?: string;
}

interface Node {
  /** The raw `<node …>` tag text, compared verbatim so "byte-identical" stays literal. */
  raw: string;
  leaf: boolean;
  interactive: boolean;
}

const NODE_TAG = /<node\b[^>]*?\/?>/g;
// A leading \s so `long-clickable="true"` cannot be read as `clickable="true"`.
const CLICKABLE = /\sclickable="true"/;
const FOCUSABLE = /\sfocusable="true"/;

function nodes(xml: string): Node[] {
  const out: Node[] = [];
  for (const m of xml.matchAll(NODE_TAG)) {
    const raw = m[0];
    out.push({
      raw,
      leaf: raw.endsWith('/>'),
      interactive: CLICKABLE.test(raw) || FOCUSABLE.test(raw),
    });
  }
  return out;
}

/** The `<hierarchy …>` element itself — its `rotation` is part of the contract. */
function header(xml: string): string {
  return /<hierarchy\b[^>]*>/.exec(xml)?.[0] ?? '';
}

export function dumpsAgree(stock: string, companion: string): DumpMatch {
  const a = stock.trim();
  const b = companion.trim();
  if (a === b) return { agree: true };

  if (header(a) !== header(b)) {
    return { agree: false, reason: 'the hierarchy header differs (rotation changed mid-capture?)' };
  }

  const stockNodes = nodes(a);
  const compNodes = nodes(b);

  let i = 0; // stock
  for (const want of compNodes) {
    // Skip platform nodes the companion did not emit, proving each is droppable as we go.
    while (i < stockNodes.length && stockNodes[i].raw !== want.raw) {
      const skipped = stockNodes[i];
      if (skipped.interactive) {
        return { agree: false, reason: 'the companion is missing a node the platform reports as tappable' };
      }
      if (!skipped.leaf) {
        return { agree: false, reason: 'the companion is missing a container the platform reports' };
      }
      i++;
    }
    if (i === stockNodes.length) {
      return { agree: false, reason: 'the companion reports a node the platform does not' };
    }
    i++; // consume the match
  }

  // Anything left over in the platform's dump must clear the same bar.
  for (; i < stockNodes.length; i++) {
    if (stockNodes[i].interactive) {
      return { agree: false, reason: 'the companion is missing a node the platform reports as tappable' };
    }
    if (!stockNodes[i].leaf) {
      return { agree: false, reason: 'the companion is missing a container the platform reports' };
    }
  }

  return { agree: true };
}
