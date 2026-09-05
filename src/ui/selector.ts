import { Element } from '../types';
import { CliError, SelectorNotFoundError, AmbiguousSelectorError } from '../errors';
import { formatInline } from './format';

// Selector grammar (shell-safe, explicit):
//   @value / id:value   resource-id
//   text:value          visible text (falls back to desc if not found)
//   desc:value          content-desc / accessibility label
//   class:value         simplified type or full class
//   value               bare string == text:value
//
// Matching AUTO-HEALS: it is always case-insensitive and tries progressively
// looser tiers, stopping at the first that yields a match — so an exact match
// always wins, but a casing / whitespace / partial mismatch still resolves
// instead of failing outright:
//   1. exact      — case-insensitive, trimmed
//   2. partial    — case-insensitive substring
//   3. normalized — ignore case + all punctuation / whitespace / emoji
// `text:sign up`, `text:SIGN UP`, and `text:signup` all find a "Sign up" button.
// For text: selectors, if no text matches are found, it also tries desc with the
// same matching tiers. --contains forces substring (skips the exact tier);
// --index N picks the Nth. Ambiguity is never auto-resolved: if the winning tier
// has >1 match, an action reports the candidates and asks you to refine —
// it never targets a guess.
//
// State modifiers narrow the pool to elements carrying (or not carrying) an a11y
// attribute — --enabled / --selected / --checked / --focused and their --not-
// forms. They may be written as flags OR appended to the selector string itself
// (`id:btn --not-selected`), which is what lets a control node's selector carry
// them; see splitStateModifiers.

export type SelectorKind = 'id' | 'text' | 'desc' | 'class';
export type MatchTier = 'exact' | 'partial' | 'normalized';

/**
 * The element state a selector can require. Each is TRI-STATE on a Selector:
 * unset = don't care, `true` = must be, `false` = must NOT be.
 *
 * The negative half is not symmetry for its own sake. A segmented control whose
 * options share one handler *flips* on any tap, so "tap it unless it is already
 * selected" is the only safe way to land on a known option — and a plan that
 * cannot say that taps blind, completes either way, and passes having exercised
 * the opposite mode.
 */
export const STATE_ATTRS = ['enabled', 'selected', 'checked', 'focused'] as const;
export type StateAttr = (typeof STATE_ATTRS)[number];
export type StateFilter = Partial<Record<StateAttr, boolean>>;

export interface Selector {
  kind: SelectorKind;
  value: string;
  contains: boolean;
  index?: number;
  /** Only match elements the UI currently considers actionable. A submit button that is
   *  greyed out until the form is valid is PRESENT long before it is usable, so a plain
   *  presence match taps a dead control and the flow silently does nothing. Combined with
   *  auto-wait this becomes "wait until it is actually pressable". */
  enabled?: boolean;
  /** Current option of a segmented control / tab bar / mode picker. */
  selected?: boolean;
  /** Checkbox / switch / radio state. */
  checked?: boolean;
  /** Currently holds input focus. */
  focused?: boolean;
  /** The selector exactly as written, modifiers included — what error messages, heal
   *  notes and the run report echo back. `value` is the stripped, matchable part. */
  raw: string;
}

export type SelectorOptions = { contains?: boolean; index?: number } & StateFilter;

export interface MatchResult {
  matches: Element[];
  tier: MatchTier | null; // null when there are no matches
}

/** Trailing ` --selected` / ` --not-checked` / … on a selector STRING. */
const STATE_MODIFIER = new RegExp(`\\s+--(not-)?(${STATE_ATTRS.join('|')})\\s*$`, 'i');

/**
 * Peel state modifiers off the END of a selector string.
 *
 * Flags normally arrive as flags, but a control node's selector has nowhere to put
 * one: `if-present` / `when` / `repeat` / `while-present` / `read` all hold a bare
 * `selector: string` (and `swipe --on` is a flag value). Guards are exactly where
 * "tap it only if it is not already selected" needs to be expressed, so the string
 * itself carries them and every caller converges on this one parser:
 *
 *     if-present "id:mode_video --not-selected" { tap id:mode_video }
 *
 * Only these modifiers, only at the end, and only after whitespace — so `text:--selected`
 * and `text:a --selected b` are still plain values. A `text:` value that genuinely ENDS
 * in " --selected" would be misread; use `--contains` on a shorter substring if you ever
 * meet one. Note the engine interpolates `{{ctx.…}}` before parsing, so a value captured
 * by `read` could in principle end in a modifier — end-anchoring plus the required space
 * is what keeps that from being a practical concern.
 */
function splitStateModifiers(raw: string): { rest: string; state: StateFilter } {
  const state: StateFilter = {};
  let rest = raw;
  for (;;) {
    const m = STATE_MODIFIER.exec(rest);
    if (!m) return { rest, state };
    const attr = m[2].toLowerCase() as StateAttr;
    const want = !m[1];
    if (state[attr] !== undefined && state[attr] !== want) {
      throw new CliError(`Selector '${raw}' asks for both --${attr} and --not-${attr}.`, 2);
    }
    state[attr] = want;
    rest = rest.slice(0, m.index);
  }
}

export function parseSelector(raw: string, opts: SelectorOptions = {}): Selector {
  const { rest, state } = splitStateModifiers(raw);

  let kind: SelectorKind = 'text';
  let value = rest;

  if (rest.startsWith('@')) {
    kind = 'id';
    value = rest.slice(1);
  } else {
    const m = /^(id|text|desc|class):([\s\S]*)$/.exec(rest);
    if (m) {
      kind = m[1] as SelectorKind;
      value = m[2];
    }
  }

  if (!value) throw new CliError(`Empty selector value in '${raw}'`, 2);
  const sel: Selector = { kind, value, contains: !!opts.contains, index: opts.index, raw };
  for (const attr of STATE_ATTRS) {
    // An explicit flag beats one embedded in the string; absent means absent, not false.
    const want = opts[attr] !== undefined ? opts[attr] : state[attr];
    if (want !== undefined) sel[attr] = want;
  }
  return sel;
}

/** Keep only elements whose state matches every attribute the selector pins.
 *
 *  Each predicate is exactly the one a11y attribute and nothing else — `--enabled` is
 *  `enabled`, matching what Maestro's `enabled: true` means. An earlier version also
 *  required `clickable || longClickable`, reasoning that a disabled Button might report
 *  clickable=false. That was speculation and it was wrong in the direction that hurts:
 *  plenty of legitimate tap targets are CONTAINERS whose own clickable flag is false (the
 *  tappable child is inside), so the extra conjunct filtered out real elements and turned
 *  `--enabled` into a source of phantom "not found" misses — which then burned model
 *  repairs. Prefer under-filtering here: a tap on a present-but-odd element fails loudly,
 *  whereas a selector that silently matches nothing looks like app drift and sends the
 *  heal loop chasing it. Same rule for any attribute added to STATE_ATTRS — do not
 *  strengthen a predicate with a conjunct the platform reports unreliably (`--not-checked`
 *  deliberately does NOT also require `checkable`). */
function filterByState(elements: Element[], sel: Selector): Element[] {
  const pinned = STATE_ATTRS.filter((attr) => sel[attr] !== undefined);
  if (pinned.length === 0) return elements;
  return elements.filter((el) => pinned.every((attr) => el[attr] === sel[attr]));
}

const norm = (s: string) => s.trim().toLowerCase();
const strip = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

interface Matcher {
  tier: MatchTier;
  test: (el: Element) => boolean;
}

/** The ordered match tiers for a selector. First tier with a hit wins. */
function tiers(sel: Selector): Matcher[] {
  const nv = norm(sel.value);
  const sv = strip(sel.value);

  // exact -> partial -> normalized over a single text-like field.
  const textField = (get: (el: Element) => string): Matcher[] => [
    { tier: 'exact', test: (el) => norm(get(el)) === nv },
    { tier: 'partial', test: (el) => nv.length > 0 && norm(get(el)).includes(nv) },
    { tier: 'normalized', test: (el) => sv.length > 0 && strip(get(el)).includes(sv) },
  ];

  let list: Matcher[];
  switch (sel.kind) {
    case 'id':
      list = [
        {
          tier: 'exact',
          test: (el) => norm(el.idShort) === nv || norm(el.id) === nv || norm(el.id).endsWith('/' + nv),
        },
        {
          tier: 'partial',
          test: (el) => nv.length > 0 && (norm(el.idShort).includes(nv) || norm(el.id).includes(nv)),
        },
        {
          tier: 'normalized',
          test: (el) => sv.length > 0 && (strip(el.idShort).includes(sv) || strip(el.id).includes(sv)),
        },
      ];
      break;
    case 'class':
      list = [
        {
          tier: 'exact',
          test: (el) => norm(el.type) === nv || norm(el.class) === nv || norm(el.class).endsWith('.' + nv),
        },
        {
          tier: 'partial',
          test: (el) => nv.length > 0 && (norm(el.type).includes(nv) || norm(el.class).includes(nv)),
        },
      ];
      break;
    case 'desc':
      list = textField((el) => el.desc);
      break;
    case 'text':
    default:
      list = textField((el) => el.text);
      break;
  }

  // --contains forces substring matching: drop the exact-only tier.
  return sel.contains ? list.filter((t) => t.tier !== 'exact') : list;
}

/**
 * Walk the tier ladder: the first tier with any hit wins. Null when no tier hit at all —
 * distinct from an out-of-range `--index` on a tier that DID hit, which is a definite
 * (empty) result and must not fall through to the next ladder.
 */
function matchLadder(elements: Element[], sel: Selector): MatchResult | null {
  for (const { tier, test } of tiers(sel)) {
    const found = elements.filter(test);
    if (found.length === 0) continue;
    if (sel.index !== undefined) {
      const picked = found[sel.index];
      return picked ? { matches: [picked], tier } : { matches: [], tier: null };
    }
    return { matches: found, tier };
  }
  return null;
}

export function matchElements(elements: Element[], sel: Selector): MatchResult {
  // Applied BEFORE the tier ladder, not after: filtering the candidate pool keeps a
  // disabled exact match from shadowing an enabled partial one.
  elements = filterByState(elements, sel);
  return (
    matchLadder(elements, sel) ??
    // For text: selectors, if no text matches found, fall back to desc
    (sel.kind === 'text' ? matchLadder(elements, { ...sel, kind: 'desc' as const }) : null) ?? {
      matches: [],
      tier: null,
    }
  );
}

/** Resolve to exactly one element (with the tier it matched), or throw. */
export function resolveOne(
  elements: Element[],
  sel: Selector,
): { element: Element; tier: MatchTier } {
  const { matches, tier } = matchElements(elements, sel);
  if (matches.length === 0) {
    throw new SelectorNotFoundError(
      `No element matched selector '${sel.raw}'. Run \`verikun ui\` to inspect the current screen.`,
    );
  }
  if (matches.length > 1) {
    const list = matches.map((m) => '  ' + formatInline(m)).join('\n');
    throw new AmbiguousSelectorError(
      `Selector '${sel.raw}' matched ${matches.length} elements; refine it or add --index N:\n${list}`,
      matches,
    );
  }
  return { element: matches[0], tier: tier as MatchTier };
}
