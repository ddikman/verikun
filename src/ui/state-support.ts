import { Platform } from '../types';
import { CliError } from '../errors';
import { Selector, STATE_ATTRS, StateAttr } from './selector';
import { IOS_UNREPORTED_STATE } from './ios-parse';

// Which state attributes a platform's accessibility backend can actually answer for.
//
// A state modifier narrows the candidate pool, so one the platform never populates does
// not fail — it matches NOTHING, quietly, after burning the full auto-wait window, and
// then reports "No element matched selector", which is a claim about the screen that
// isn't true. That is the same false-signal failure mode `--selected` was added to fix,
// so it is refused here instead: an unsupported modifier is an environment error (exit
// 3), the way `clearApp` and `currentApp` already refuse on iOS rather than pretending.
//
// This is a capability table, not device I/O — the per-platform truth lives with the
// parser that hard-codes the value (see IOS_UNREPORTED_STATE), so the two cannot drift.

const UNREPORTED: Record<Platform, readonly StateAttr[]> = {
  android: [], // uiautomator dumps all four as real node attributes
  ios: IOS_UNREPORTED_STATE,
};

/** State attributes this selector pins that the platform cannot report. */
export function unsupportedStateAttrs(sel: Selector, platform: Platform): StateAttr[] {
  const blind = UNREPORTED[platform];
  if (blind.length === 0) return [];
  return STATE_ATTRS.filter((attr) => sel[attr] !== undefined && blind.includes(attr));
}

/** Throw unless every state modifier on `sel` means something on `platform`. */
export function assertStateSupported(sel: Selector, platform: Platform): void {
  const bad = unsupportedStateAttrs(sel, platform);
  if (bad.length === 0) return;
  // Name both polarities: --not-selected is refused for the same reason as --selected,
  // and echoing only the attribute reads as though the wrong flag was typed.
  const named = bad.map((a) => `--${a}/--not-${a}`).join(' and ');
  throw new CliError(
    `${named} cannot be used on ${platform}: its accessibility backend does not report ` +
      `${bad.join(' or ')}, so the selector could only ever match nothing. ` +
      `Match on ${platform === 'ios' ? '@id, text or --enabled/--checked' : 'another attribute'} instead.`,
    3,
  );
}
