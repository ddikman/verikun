// Compile-fidelity lint: does the plan the model produced still say what the prose said?
//
// The model is a compiler, and this is the compiler's own sanity check. It exists because
// compilation is NONDETERMINISTIC in a way that is invisible until a run fails, and three
// failure modes showed up repeatedly against a real suite:
//
//   1. An explicit directive silently vanishes. The same prose ("Launch the app WITH ITS
//      DATA CLEARED so it starts logged-out") compiled to `launch <pkg> --clear` on one
//      run and plain `launch <pkg>` on the next. The plan looked fine and the test failed
//      several steps later, on a screen that only appears when you are already logged in.
//   2. Conditional prose compiles to an unconditional step. "IF a Continue button appears,
//      tap it" becomes `wait` + `tap`, which FAILS on every run where the app skips it.
//   3. Only a PREFIX of the test compiles at all (issue #127). An ~85-step test compiled to
//      13 and stopped right after the shared sign-in preamble — never reaching the feature
//      the test exists to exercise, never running its closing assertion. That plan PASSES:
//      it fails nothing because it asserts nothing, it is cached as green, and it replays
//      against later builds. A test exercising none of its subject reporting success is the
//      worst failure mode a testing tool has, which is why the two rules that detect it are
//      the only FATAL findings here.
//
// 1 and 2 are cheap to detect and cheap to fix: hand the finding back to the model and let
// it compile once more. That is far better than the alternative, which is a plan that is
// quietly wrong and burns a device run to say so. 3 gets the same guided recompile, but a
// plan that STILL does not cover its test must never run — see `fatal` below.
//
// Deliberately CONSERVATIVE — a non-fatal false positive costs a wasted recompile, so every
// rule requires a fairly unambiguous phrase and checks for a specific structural counterpart.
// It never edits the plan; the model gets the feedback and stays the author.

import { Plan, PlanNode, isControlNode, bodiesOf } from './ir';

export interface LintFinding {
  /** Shown to the model verbatim as the reason for the recompile. */
  message: string;
  /**
   * The plan does not COVER the test — running it would report a pass for work it never
   * did. The caller still buys one guided recompile (this is a finding like any other),
   * but a plan that trips a fatal rule twice must be rejected rather than run or cached.
   */
  fatal?: boolean;
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

// --- coverage: did the whole test compile, or only its beginning? -----------
//
// Two rules, deliberately measuring different things, because the reported truncations
// clear one check each. A plan that stops after a LONG shared preamble is not obviously
// short (rule A can miss it) but never mentions anything the test's closing steps name
// (rule B catches it). A plan that is a bare stub names nothing at all, so rule B has no
// anchor to miss (rule A catches it).

/** `VERIKUN_NO_COMPILE_CHECK=1` restores the pre-#127 behaviour exactly: no coverage rule
 *  fires, so nothing is rejected and nothing is withheld from the cache. Same bisection
 *  contract as `VERIKUN_NO_PLAN_LOCK` / `VERIKUN_NO_CLAIM`. */
export function coverageChecksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.VERIKUN_NO_COMPILE_CHECK ?? '').trim().toLowerCase();
  return v === '' || v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/** An ORDERED list item — `1.` / `2)`. Unordered `-`/`*` bullets are deliberately NOT an
 *  instruction marker: in this project's prose style they carry explanation far more often
 *  than steps, and counting them would inflate the expectation and manufacture a rejection. */
const ORDERED_ITEM_RE = /^\s*\d+[.)]\s+/;

const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Verbs that open an instruction. A CLOSED set, and a tight one — every entry here raises
 * the expected plan size, so a loose entry costs a false rejection while a missing one only
 * costs detection. The floor below is generous enough to absorb the resulting undercount.
 */
const IMPERATIVES: ReadonlySet<string> = new Set([
  'tap', 'press', 'click', 'type', 'enter', 'fill',
  'launch', 'open', 'start', 'restart', 'relaunch', 'stop', 'close',
  'confirm', 'verify', 'assert', 'check', 'ensure',
  'swipe', 'scroll', 'drag',
  'wait', 'screenshot',
  'dismiss', 'select', 'choose', 'toggle', 'navigate', 'repeat', 'go', 'return',
]);

/**
 * The lines of `nl` that state an instruction: an ordered-list item, or a line opening with
 * an imperative. Returns the line text (list marker stripped) so a caller can look for what
 * the instruction NAMES, not just count it.
 *
 * Biased to UNDERCOUNT — several sentences on one line count once, and prose that phrases a
 * step without a leading imperative is missed entirely. That direction is deliberate: an
 * undercount only weakens detection, while an overcount would reject a correct plan.
 *
 * Exported solely so the unit suite can reach it.
 */
export function instructionLines(nl: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of nl.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    if (FENCE_RE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const ordered = ORDERED_ITEM_RE.test(raw);
    const body = (ordered ? raw.replace(ORDERED_ITEM_RE, '') : raw).trim();
    if (!body) continue;
    if (ordered || IMPERATIVES.has((/^([A-Za-z]+)/.exec(body)?.[1] ?? '').toLowerCase())) out.push(body);
  }
  return out;
}

/** How many instructions the prose states, as best a closed verb set can tell.
 *  Exported solely so the unit suite can reach it. */
export function instructionUnits(nl: string): number {
  return instructionLines(nl).length;
}

/**
 * Steps the plan actually performs.
 *
 * Counts EVERY node, not `plan.steps.length` — that is top-level only, so a `repeat` whose
 * body holds ten leaves reads as 1. Excludes `screenshot`, which the grammar tells the model
 * to insert liberally as review evidence: it is compiler-added padding, not test content, and
 * counting it would let a screenshot-heavy stub clear the floor.
 *
 * Exported solely so the unit suite can reach it.
 */
export function actionNodes(plan: Plan): number {
  let n = 0;
  for (const node of walk(plan.steps)) {
    if (node.type === 'command' && node.command === 'screenshot') continue;
    n++;
  }
  return n;
}

/** Below this many instructions the ratio means nothing — a three-line test legitimately
 *  compiles to one or two steps. */
const MIN_UNITS = 6;

/**
 * The plan must have at least this fraction of the prose's instruction count.
 *
 * Calibrated against the measurements in issue #127: the truncations ran ~85% short (a ratio
 * near 0.15) while the widest ordinary variation between runs of the same PASSING test was
 * ~20%. A healthy plan normally sits at or above 1.0, since control nodes count themselves
 * AND their bodies and a single "dismiss whichever of these screens is showing" expands to
 * several nodes. 0.35 therefore sits far below every normal compile and far above every
 * truncation seen — and it has to, because `instructionUnits` undercounts.
 */
const COVERAGE_FLOOR = 0.35;

/** How far back from the end rule B may look for an instruction that NAMES something, and
 *  how many such instructions it then judges.
 *
 *  Two, not five, and anchored at the very end: a wider window reaches back into prose the
 *  truncated prefix still covers, and one match there satisfies the rule while the actual
 *  tail is missing — which is exactly the case this is for. Two rather than one, so a single
 *  final instruction the compiler spelled unrecognisably cannot reject a good plan. */
const TAIL_SCAN_LINES = 6;
const TAIL_ANCHORED_LINES = 2;

/** A quoted or backticked token — how test prose names the thing a step acts on. */
const ANCHOR_RE = /`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”/g;

/** A selector's kind prefix, stripped before comparing: the prose writes `vk_spinner` and
 *  the plan may write `id:spinner`, `@spinner` or `text:Spinner` for the same element. */
const SELECTOR_KIND_RE = /^\s*(?:@|(?:id|text|desc|class|resource-id)\s*:)/i;

const normToken = (s: string): string => s.replace(SELECTOR_KIND_RE, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Identifiers the test's CLOSING instructions name. Truncation drops the end of the prose,
 * so these are exactly what a truncated plan cannot mention.
 *
 * Walks backwards from the last instruction, collecting from the last two that name anything
 * at all — an instruction with nothing quoted or backticked in it gives the plan nothing to
 * match, so it is skipped rather than counted as a miss. Empty means "no opinion".
 *
 * Exported solely so the unit suite can reach it.
 */
export function tailAnchors(nl: string, plan: Plan): string[] {
  const pkg = normToken(plan.package ?? '');
  const lines = instructionLines(nl);
  const start = Math.max(0, lines.length - TAIL_SCAN_LINES);
  const out: string[] = [];
  let anchored = 0;
  for (let i = lines.length - 1; i >= start && anchored < TAIL_ANCHORED_LINES; i--) {
    const found: string[] = [];
    for (const m of lines[i].matchAll(ANCHOR_RE)) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      // A path or a shell line is documentation, not an element the plan can name.
      if (!raw || raw.includes('/') || /^vk\s/i.test(raw)) continue;
      const norm = normToken(raw);
      // The package is already named by `launch`, so it is in EVERY plan there is; counting
      // it as coverage would make the rule vacuous for any test that ends by naming its app.
      if (norm.length < 3 || (pkg && pkg.includes(norm))) continue;
      if (!found.includes(raw)) found.push(raw);
    }
    if (found.length === 0) continue;
    anchored++;
    for (const a of found) if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** Every string the plan uses to address or fill something. */
function planTokens(plan: Plan): string[] {
  const out: string[] = [];
  for (const n of walk(plan.steps)) {
    if (n.type === 'command') {
      out.push(...n.positionals, ...n.flags.map((f) => f.value));
    } else if (n.type === 'read') {
      out.push(n.selector);
    } else if (n.type === 'when') {
      out.push(...n.branches.map((b) => b.selector));
    } else {
      out.push(n.selector);
    }
  }
  return out;
}

/** Does the plan reference `anchor` anywhere? Forgiving in BOTH directions, because prose
 *  and plan routinely name the same element at different lengths (`vk_spinner` vs `spinner`). */
function planMentions(tokens: string[], anchor: string): boolean {
  const a = normToken(anchor);
  if (a.length < 3) return false;
  return tokens.some((t) => {
    const b = normToken(t);
    return b.length >= 3 && (b.includes(a) || a.includes(b));
  });
}

/**
 * Check a compiled plan against the prose it came from.
 *
 * @param nl   the natural-language test, verbatim
 * @param plan the plan the model just produced
 * @returns findings; empty means the plan is consistent with the prose. A finding with
 *          `fatal` set means the plan does not cover the test and must not be run.
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

  if (!coverageChecksEnabled()) return findings;

  const units = instructionUnits(nl);
  const nodes = actionNodes(plan);
  if (units >= MIN_UNITS && nodes < COVERAGE_FLOOR * units) {
    findings.push({
      fatal: true,
      message:
        `The plan performs ${nodes} step(s), but the test states about ${units} instruction(s) — only the ` +
        'beginning of it was compiled. Compile the WHOLE test: every numbered step and every instruction, ' +
        'in order, through to its final verification. Do not stop after the setup or the sign-in preamble.',
    });
  }

  const anchors = tailAnchors(nl, plan);
  if (anchors.length > 0) {
    const tokens = planTokens(plan);
    if (!anchors.some((a) => planMentions(tokens, a))) {
      findings.push({
        fatal: true,
        message:
          `The plan never references ${anchors.map((a) => JSON.stringify(a)).join(', ')} — the identifier(s) the ` +
          'test\'s CLOSING instructions name. The end of the test was not compiled. Continue past wherever the ' +
          'plan stopped and emit the remaining steps, including the final verification.',
      });
    }
  }

  return findings;
}

/** Does this plan look like only a prefix of `nl` compiled? The `fatal` half of `lintPlan`,
 *  asked on its own — used to refuse a cached plan as a seed, where the other rules are
 *  irrelevant (they are about a plan we are about to RUN, not one we are about to adapt). */
export function looksTruncated(nl: string, plan: Plan): boolean {
  return lintPlan(nl, plan).some((f) => f.fatal);
}
