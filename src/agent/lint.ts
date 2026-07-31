// Compile-fidelity lint: does the plan the model produced still say what the prose said?
//
// The model is a compiler, and this is the compiler's own sanity check. It exists because
// compilation is NONDETERMINISTIC in a way that is invisible until a run fails, and two
// failure modes showed up repeatedly against a real suite:
//
//   1. An explicit directive silently vanishes. The same prose ("Launch the app WITH ITS
//      DATA CLEARED so it starts logged-out") compiled to `launch <pkg> --clear` on one
//      run and plain `launch <pkg>` on the next. The plan looked fine and the test failed
//      several steps later, on a screen that only appears when you are already logged in.
//   2. Conditional prose compiles to an unconditional step. "IF a Continue button appears,
//      tap it" becomes `wait` + `tap`, which FAILS on every run where the app skips it.
//
// Both are cheap to detect and cheap to fix: hand the finding back to the model and let it
// compile once more. That is far better than the alternative, which is a plan that is
// quietly wrong and burns a device run to say so.
//
// Deliberately CONSERVATIVE — a false positive costs a wasted recompile, so every rule
// requires a fairly unambiguous phrase and checks for a specific structural counterpart.
// It never edits the plan; the model gets the feedback and stays the author.

import { Plan, PlanNode, isControlNode, bodiesOf } from './ir';

export interface LintFinding {
  /** Shown to the model verbatim as the reason for the recompile. */
  message: string;
}

/** Walk every node in the plan, including control-node bodies. */
function* walk(nodes: PlanNode[]): Generator<PlanNode> {
  for (const n of nodes) {
    yield n;
    if (isControlNode(n)) for (const body of bodiesOf(n)) yield* walk(body);
  }
}

const hasControlNode = (plan: Plan): boolean => {
  for (const n of walk(plan.steps)) if (isControlNode(n)) return true;
  return false;
};

const hasLeafWithFlag = (plan: Plan, command: string, flag: string): boolean => {
  for (const n of walk(plan.steps)) {
    if (n.type === 'command' && n.command === command && n.flags.some((f) => f.name === flag)) return true;
  }
  return false;
};

/** Phrases that state the app must start from a clean slate. Kept tight on purpose:
 *  "clear" alone is far too common (clearing a text field, a clear button). */
const FRESH_START_RE =
  /\b(data cleared|cleared data|clear its data|with its data cleared|freshly installed|logged[- ]out|logged out|clean state|from scratch)\b/i;

/** Phrases that make a step conditional. These are the ones that produced an
 *  unconditional step in practice; vaguer hedges ("should", "normally") are excluded. */
const CONDITIONAL_RE = /\b(if (?:a|an|the|any)\b|may appear|might appear|sometimes|optionally|if present|if shown|if it appears|dismiss any)\b/i;

/**
 * Check a compiled plan against the prose it came from.
 *
 * @param nl   the natural-language test, verbatim
 * @param plan the plan the model just produced
 * @returns findings; empty means the plan is consistent with the prose
 */
export function lintPlan(nl: string, plan: Plan): LintFinding[] {
  const findings: LintFinding[] = [];

  if (FRESH_START_RE.test(nl) && !hasLeafWithFlag(plan, 'launch', 'clear')) {
    findings.push({
      message:
        'The test says the app must start from cleared data / logged out, but no step launches it with --clear. ' +
        'Emit `launch <package> --clear` so the run does not inherit the previous run\'s session.',
    });
  }

  if (CONDITIONAL_RE.test(nl) && !hasControlNode(plan)) {
    findings.push({
      message:
        'The test describes something that may or may not appear ("if ...", "may appear", "dismiss any ..."), ' +
        'but the plan has no if-present/when node — every step is unconditional. An unconditional step for ' +
        'optional UI fails on every run where that UI does not show. Put the optional part behind if-present ' +
        '(skip when absent), or behind when (when the screen is one of several known kinds).',
    });
  }

  return findings;
}
