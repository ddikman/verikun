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

export type SelectorKind = 'id' | 'text' | 'desc' | 'class';
export type MatchTier = 'exact' | 'partial' | 'normalized';

export interface Selector {
  kind: SelectorKind;
  value: string;
  contains: boolean;
  index?: number;
  raw: string;
}

export interface MatchResult {
  matches: Element[];
  tier: MatchTier | null; // null when there are no matches
}

export function parseSelector(
  raw: string,
  opts: { contains?: boolean; index?: number } = {},
): Selector {
  let kind: SelectorKind = 'text';
  let value = raw;

  if (raw.startsWith('@')) {
    kind = 'id';
    value = raw.slice(1);
  } else {
    const m = /^(id|text|desc|class):([\s\S]*)$/.exec(raw);
    if (m) {
      kind = m[1] as SelectorKind;
      value = m[2];
    }
  }

  if (!value) throw new CliError(`Empty selector value in '${raw}'`, 2);
  return { kind, value, contains: !!opts.contains, index: opts.index, raw };
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

export function matchElements(elements: Element[], sel: Selector): MatchResult {
  for (const { tier, test } of tiers(sel)) {
    const found = elements.filter(test);
    if (found.length === 0) continue;
    if (sel.index !== undefined) {
      const picked = found[sel.index];
      return picked ? { matches: [picked], tier } : { matches: [], tier: null };
    }
    return { matches: found, tier };
  }

  // For text: selectors, if no text matches found, fall back to desc
  if (sel.kind === 'text') {
    const descSel = { ...sel, kind: 'desc' as const };
    for (const { tier, test } of tiers(descSel)) {
      const found = elements.filter(test);
      if (found.length === 0) continue;
      if (sel.index !== undefined) {
        const picked = found[sel.index];
        return picked ? { matches: [picked], tier } : { matches: [], tier: null };
      }
      return { matches: found, tier };
    }
  }

  return { matches: [], tier: null };
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
