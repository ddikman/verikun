import { randomUUID } from 'node:crypto';
import { Element } from '../types';
import { parseSelector, matchElements } from '../ui/selector';
import { SelectorNotFoundError, AmbiguousSelectorError, isEnvError } from '../errors';
import { Plan, PlanNode, LeafStep, ReadNode, leafToFlags, validateNode, InvalidPlanError } from './ir';
import { CostTracker } from './cost';
import { AgentProvider } from './provider';

// The interpreter. It walks a compiled Plan deterministically, executing each leaf
// through the injected `exec` (verikun's own executeOutcome, bound to ONE driver).
// No LLM on the happy path. The model is woken ONLY when an action step fails to
// resolve its selector — a miss (SelectorNotFoundError, exit 1) or an ambiguous
// match (AmbiguousSelectorError, exit 2). An assertion failure (`assert` RETURNS 1,
// never throws) is TERMINAL and never healed, or a real regression would be masked.
// A repair may itself DECLINE (provider returns replaceStep=null) when the screen
// has drifted to where no element serves the step's intent — also terminal, so a
// "too kind" substitution onto the wrong screen can never pass as a false green.
//
// Dependency-injected on purpose: engine.ts imports no cli.ts (no cycle) and is
// fully unit-testable with a fake `exec` + fake `getElements`.

export interface ExecOutcome {
  code: number;
  error?: Error;
}

export type ExecFn = (
  command: string,
  positionals: string[],
  flags: Record<string, string>,
) => Promise<ExecOutcome>;

export interface EngineDeps {
  /** Run one leaf command, returning its raw outcome (verikun's executeOutcome). */
  exec: ExecFn;
  /** Live UI hierarchy — used for control-flow guards and repair context. May be
   *  async: the remote backend (vk ai --server) fetches it over HTTP. The local
   *  path stays a sync fn (awaiting a sync value is a no-op). */
  getElements: () => Element[] | Promise<Element[]>;
  provider: AgentProvider;
  cost: CostTracker;
  /** Continuous progress to stderr (CI liveness — never goes quiet). */
  log: (msg: string) => void;
  /** Downgrade the most-recently-recorded step from a failed attempt to a healed
   *  pass (so a self-healed leaf doesn't surface as a failure in the report).
   *  Called after a successful repair, before the retry. Optional (tests omit it). */
  markHealed?: (message?: string) => void;
  /** Max model repairs per failing step before giving up. Default 3. */
  maxRepairs?: number;
  /** Seed values for the run's {{ctx.*}} store. */
  initialCtx?: Record<string, string>;
  /** Value for {{run_id}} — the Recorder run id, so a generated value is traceable
   *  back to its report. */
  runId?: string;
  /** How long an `if-present` guard waits for its selector before concluding "absent".
   *  Default DEFAULT_GUARD_SETTLE_MS. Injected (not read from process.env here) so the
   *  engine stays dependency-free and unit-testable with a fake clock-free window of 0. */
  guardSettleMs?: number;
  /** Epoch-ms wall-clock deadline for the whole run; once passed, the engine aborts
   *  between steps, loop iterations, and repairs (bounds a runaway plan). */
  deadline?: number;
}

export interface EngineResult {
  ok: boolean;
  /** The plan after any repairs were spliced in (what gets persisted on green). */
  plan: Plan;
  modelRepairs: number;
  /** Suggested permanent edits to stabilize the test and cut future tokens. */
  improvements: string[];
  failure?: { where: string; reason: string };
  abortedForBudget?: boolean;
  abortedForTimeout?: boolean;
  /** The run stopped because the ENVIRONMENT broke (exit 3: tool missing, device gone,
   *  hierarchy dump failed) rather than because the app misbehaved. `failure` is still
   *  populated — this only says the failure is not a regression, so callers can exit 3
   *  and `vk suite` can stop instead of reporting every remaining test as broken. */
  abortedForEnv?: boolean;
}

type StepResult =
  | { status: 'ok' }
  /** The element a guard matched vanished before the guarded body could act on it, and
   *  it is genuinely gone now. Stop this body; the enclosing guard treats it as done. */
  | { status: 'guard-gone' }
  | { status: 'fail'; reason: string; where: string }
  | { status: 'env'; reason: string; where: string }
  | { status: 'budget' }
  | { status: 'timeout' };

/** An outcome is environment-flavoured if it carries an exit-3 CliError, or simply
 *  reported code 3 — the latter also catches a remote step whose error crossed the
 *  wire as a plain Error (rebuildError drops exitCode) and a non-CliError throw,
 *  both of which the top-level contract already maps to exit 3. Over-classifying is
 *  safe here because `vk suite` re-probes before treating it as fatal. */
const isEnvOutcome = (outcome: ExecOutcome): boolean => outcome.code === 3 || isEnvError(outcome.error);

/**
 * A control-flow guard could not read the screen even once, because the environment is
 * broken (exit 3). Thrown out of `present()` and converted to a `status: 'env'` step
 * result by the single catch in runPlan's step loop.
 *
 * A throw rather than a wider `present()` return type on purpose: `present()` has seven
 * call sites across `if-present` / `when` / `repeat` / `while-present` / the guard-race
 * check, and every one of them would need the same three-line env branch — repetition in
 * the most intricate code here, and a silent false green at whichever site someone forgot.
 * runPlan still RETURNS its result; this never escapes the engine.
 */
class GuardBlindError extends Error {
  constructor(selector: string, cause: Error) {
    super(`could not read the screen to evaluate '${selector}': ${cause.message.split('\n')[0]}`);
    this.name = 'GuardBlindError';
  }
}

const describe = (leaf: LeafStep): string =>
  [leaf.command, ...leaf.positionals, ...leaf.flags.map((f) => (f.value === 'true' ? `--${f.name}` : `--${f.name} ${f.value}`))]
    .join(' ')
    .trim();

/** A screenshot leaf is best-effort review evidence, not a gate. The `vk ai`
 *  grammar has the model sprinkle them around transitions, so a capture that
 *  fails (a device hiccup on screencap) must never turn a green run red — see
 *  the guard in execLeaf. */
const isScreenshotLeaf = (leaf: LeafStep): boolean => leaf.command === 'screenshot' || leaf.command === 'shot';

/** A structural fingerprint of the screen: a sorted id+text+desc+type set. Used for the
 *  loop no-progress check — deliberately NOT the raw hierarchy (its node ordering is
 *  nondeterministic between identical states, which would false-trip).
 *
 *  BOTH content fields are sampled, and that is load-bearing rather than belt-and-braces.
 *  Sampling `text` alone made this blind on Flutter apps, which map `Semantics(label:)` to
 *  Android's `contentDescription` — i.e. to `desc`, never to `text`. Measured on a live
 *  Flutter screen: 14 elements, **0** carrying `text`, 8 carrying `desc`. The fingerprint
 *  degenerated to `id||type` for the entire screen, so two completely different questions
 *  hashed byte-identically and a loop answering them correctly was declared stalled.
 *
 *  Uses the full `id`, not `idShort` (the suffix after the last '/'), so elements from
 *  different packages/namespaces cannot collide in what is meant to be a fingerprint.
 *
 *  When in doubt, sample MORE: an over-sensitive hash only costs a loop running to its cap;
 *  an under-sensitive one fails a passing test, since a stalled loop is now fatal. */
function structuralHash(els: Element[]): string {
  return els
    .map((e) => `${e.id}|${e.text}|${e.desc}|${e.type}`)
    .sort()
    .join('\n');
}

/** An unresolvable {{...}} placeholder. Terminal and never healed: the model cannot
 *  repair a missing value, and substituting one would be inventing test data. */
class CtxError extends Error {}

function isHealable(outcome: ExecOutcome): boolean {
  return (
    !!outcome.error &&
    (outcome.error instanceof SelectorNotFoundError || outcome.error instanceof AmbiguousSelectorError)
  );
}

/** Default wall-clock ceiling for a whole `vk ai` run (overridable via --timeout). */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long a CONDITIONAL guard (`if-present`) waits for its selector to show up
 *  before concluding "absent". Interstitials animate in: a permission dialog or promo
 *  panel typically lands a few hundred ms after the transition that triggers it. Every
 *  selector-resolving leaf command already auto-waits ~5s (cli.ts resolveOneWaiting),
 *  so before this window existed a guard was strictly LESS patient than a bare `tap` —
 *  and an optional dialog could be missed by the very construct meant to catch it.
 *  Kept far below the leaf 5s because an ABSENT guard pays this window, every time, and
 *  skipping fast is the common case.
 *
 *  NOTE the floor in present(): any non-zero window buys at least TWO looks at the screen.
 *  Wall clock alone is not a usable unit here — a uiautomator dump measured ~2.4s on
 *  emulator-5554 and can be ~10x faster on a physical device, so a pure time box gives a
 *  fast phone a dozen looks and a slow emulator none. Set 0 to restore the old
 *  single-shot probe. Override per run with VERIKUN_GUARD_SETTLE_MS (see cli.ts). */
export const DEFAULT_GUARD_SETTLE_MS = 1500;

/** Re-dump cadence inside a guard's settle window. */
const GUARD_POLL_MS = 150;

/** Consecutive identical screen snapshots before a loop is believed to be stuck.
 *
 *  This check is a TIME SAVER and nothing more. A loop already fails when its exit
 *  selector never appears, so stopping early buys no safety — it only decides how long we
 *  wait before reaching the same verdict. That asymmetry is the whole design: a false
 *  positive fails a passing test, while a false negative costs `cap` iterations of runtime.
 *
 *  Tuned from a measured false positive, twice over. At 2 strikes the same plan answered
 *  17 questions on one run and bailed after 4 on the next — the loop bodies drive screen
 *  transitions, and a single dump lands mid-transition often enough to produce a
 *  coincidental pair of matching hashes.
 *
 *  4 discriminates well because the two cases differ in character, not just degree: a loop
 *  genuinely at rest (a scrolled-to-the-bottom list — the case this exists for) yields
 *  identical hashes indefinitely, whereas an animating screen rarely yields four in a row. */
const NO_PROGRESS_STRIKES = 4;

export async function runPlan(plan: Plan, deps: EngineDeps): Promise<EngineResult> {
  const maxRepairs = deps.maxRepairs ?? 3;
  const guardSettleMs = deps.guardSettleMs ?? DEFAULT_GUARD_SETTLE_MS;

  // The run's mutable state, scoped to THIS runPlan call — never module-level. `vk suite`
  // runs every test in one process, so a shared store would hand two sign-up tests the
  // same {{uuid}} and recreate the collision it exists to prevent. Per-leaf generation
  // would be equally wrong: a sign-up needs the same address in the email field, the
  // confirm field, and a later assert.
  const ctx = new Map<string, string>(Object.entries(deps.initialCtx ?? {}));
  const generated = new Map<string, string>();
  const runId = deps.runId ?? 'run';

  /** Resolve {{...}} placeholders. A closed set on purpose — this is a template
   *  substitution, not an expression language, so there is nothing to sandbox.
   *  Unknown placeholders are left verbatim rather than blanked: a silent empty string
   *  is how a typo becomes a false green. */
  function interpolate(s: string): string {
    if (!s.includes('{{')) return s;
    return s.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (whole, name: string) => {
      if (name.startsWith('ctx.')) {
        const key = name.slice(4);
        const v = ctx.get(key);
        if (v === undefined) throw new CtxError(`{{${name}}} is not set — no earlier step stored it`);
        return v;
      }
      if (name.startsWith('env.')) {
        const key = name.slice(4);
        const v = process.env[key];
        // Loud, not empty: a missing CI secret must fail the step, not type "" into a field.
        if (v === undefined || v === '') throw new CtxError(`{{${name}}} is not set in the environment`);
        return v;
      }
      if (name === 'run_id') return runId;
      // uuid/timestamp are generated ONCE per run and memoized by placeholder name.
      if (name === 'uuid' || name === 'timestamp') {
        const existing = generated.get(name);
        if (existing !== undefined) return existing;
        const v = name === 'uuid' ? randomUUID() : String(Date.now());
        generated.set(name, v);
        return v;
      }
      return whole;
    });
  }
  const overDeadline = (): boolean => deps.deadline !== undefined && Date.now() >= deps.deadline;
  const improvements: string[] = [];
  let modelRepairs = 0;

  // A UI dump can fail transiently on a real device (uiautomator throws). Treat
  // that as "empty screen" rather than letting it abort the whole run — the rest
  // of the codebase treats dumps as recoverable (resolveOneWaiting re-polls).
  const safeElements = async (): Promise<Element[]> => {
    try {
      return await deps.getElements();
    } catch {
      return [];
    }
  };

  /** Is `selector` on screen? `settleMs` is how long to keep re-dumping while it is
   *  absent before answering "no" — see DEFAULT_GUARD_SETTLE_MS.
   *
   *  Two retry behaviours here are deliberately ORTHOGONAL, and conflating them is the
   *  bug this signature exists to prevent:
   *    - a dump that THROWS is always retried once, even at settleMs=0, so a flaky
   *      uiautomator call never silently reads as "absent" and skips a body that
   *      should run;
   *    - a dump that SUCCEEDS but does not match is re-polled only while settleMs
   *      remains. At settleMs=0 that means exactly one pass — the fast, single-shot
   *      probe a loop-exit check needs.
   *  So one dump attempt always happens regardless of the window.
   *
   *  Throws GuardBlindError when the window closes having NEVER once read the screen
   *  and the failure was an environment error — see that class for why. */
  const present = async (selector: string, settleMs: number): Promise<boolean> => {
    let sel;
    try {
      sel = parseSelector(selector);
    } catch (e) {
      // A guard selector that won't parse is a compiler/plan bug — surface it (then treat
      // as not present) rather than silently skip the guarded body.
      deps.log(`[ai] guard selector '${selector}' did not parse (${(e as Error).message}) — treating as not present`);
      return false;
    }
    const deadline = Date.now() + Math.max(0, settleMs);
    // A non-zero window must buy at least one SECOND look, independent of the clock.
    // Measured on emulator-5554: one uiautomator dump costs ~2.4s, which already exceeds
    // a 1.5s window — so a purely time-boxed loop returns after a single dump and the
    // window is a silent no-op on exactly the slow devices that need it most. Dump cost
    // swings ~10x across devices, so "how long to wait" cannot be expressed in wall clock
    // alone without making the guard's patience device-dependent.
    let looks = 0;
    // Did ANY dump in this whole call come back? A successful-but-empty tree counts: that
    // is a bad read of a live screen, not a blind one, and it is already handled below.
    let everRead = false;
    let lastErr: unknown;
    const minLooks = settleMs > 0 ? 2 : 1;
    for (;;) {
      let els: Element[] | undefined;
      for (let i = 0; i < 2; i++) {
        try {
          els = await deps.getElements();
          everRead = true;
        } catch (e) {
          els = undefined; // transient dump failure — retry once before concluding "absent"
          lastErr = e;
        }
        // An EMPTY tree is not a screen, it is a bad read: a live app always has nodes, and
        // this device routinely returns a partial/blank dump mid-transition (measured: `ui`
        // reported zero elements while `tap`'s auto-wait found its target 3.1s later).
        // Trusting it means "absent" — which silently skips a guard, or sends a loop round
        // again to tap something that already went away. Retry once even at settleMs=0,
        // which is what the loop-exit check runs at.
        if (els !== undefined && els.length > 0) break;
      }
      looks++;
      if (els !== undefined && matchElements(els, sel).matches.length > 0) return true;
      const remaining = deadline - Date.now();
      if (looks >= minLooks && remaining <= 0) {
        // The window closed having NEVER once read the screen, because the environment is
        // broken. Answering "absent" here is a lie that silently skips the body — and a
        // guard-heavy plan would then finish fully GREEN having executed nothing.
        if (!everRead && isEnvError(lastErr)) throw new GuardBlindError(selector, lastErr as Error);
        return false;
      }
      await sleep(Math.max(0, Math.min(GUARD_POLL_MS, remaining)));
    }
  };

  const runLeaf = (leaf: LeafStep): Promise<ExecOutcome> => {
    const flags = leafToFlags(leaf);
    for (const k of Object.keys(flags)) flags[k] = interpolate(flags[k]);
    return deps.exec(leaf.command, leaf.positionals.map(interpolate), flags);
  };

  /** Execute one leaf, healing a selector miss/ambiguity via the model up to the cap.
   *  `replace` writes a repaired leaf back into the plan so it persists on green. */
  async function execLeaf(leaf: LeafStep, where: string, replace: (l: LeafStep) => void, guard?: string): Promise<StepResult> {
    deps.log(`[ai] ${where}: ${describe(leaf)}`);
    let current = leaf;
    let outcome = await runLeaf(current);

    // Guard raced the body: `if-present X { … tap X … }` checked X, X was there, and by
    // the time the tap ran it had gone. That is not drift and there is nothing to repair —
    // it is exactly the transient the guard exists to tolerate, and on a fast-transitioning
    // app it happens routinely. Checked BEFORE the heal loop, because otherwise it costs
    // three model calls to conclude that a thing which was optional is absent.
    // Deliberately narrow: only the leaf that targets the guard's own selector, and only
    // once the guard is confirmed false again.
    if (
      guard !== undefined &&
      outcome.error instanceof SelectorNotFoundError &&
      current.positionals.some((p) => interpolate(p) === interpolate(guard)) &&
      !(await present(interpolate(guard), 0))
    ) {
      deps.log(`[ai] ${where}: '${interpolate(guard)}' disappeared after the guard matched — ending the guarded body`);
      return { status: 'guard-gone' };
    }

    let attempts = 0;

    while (isHealable(outcome) && attempts < maxRepairs) {
      if (deps.cost.exceeded()) {
        deps.log(`[ai] budget ceiling reached ($${deps.cost.budgetUsd}) — aborting before another repair`);
        return { status: 'budget' };
      }
      if (overDeadline()) {
        deps.log(`[ai] run timeout reached — aborting before another repair`);
        return { status: 'timeout' };
      }
      attempts++;
      const reason = outcome.error!.message.split('\n')[0];
      const candidates = outcome.error instanceof AmbiguousSelectorError ? outcome.error.candidates : undefined;
      deps.log(`[ai]   ${where} failed (${reason}) — asking model to repair (attempt ${attempts}/${maxRepairs})`);

      let repaired: LeafStep;
      try {
        const { replaceStep, declineReason, usage } = await deps.provider.repair({
          failedStep: current,
          reason,
          candidates,
          hierarchy: await safeElements(),
        });
        deps.cost.add(usage, 'repair');
        // The model may DECLINE (null) when the current screen has no element serving
        // this step's intent — i.e. the flow drifted to an unexpected screen. Fail
        // terminally rather than substitute a loosely-related element, which would let
        // a real regression pass as a false green (the bug this guards against).
        if (replaceStep === null) {
          return { status: 'fail', where, reason: `drifted, not repaired: ${declineReason ?? 'no element matches the step intent'}` };
        }
        // The SOLE validation gate for a repair: the provider hands back the model's
        // proposed leaf UNVALIDATED (a third-party provider can't be trusted to check),
        // so the engine validates it against the grammar BEFORE splicing. A hallucinated
        // command is rejected here, never run (it would otherwise exit 2 + abort).
        const node = validateNode(replaceStep, 'repair');
        if (node.type !== 'command') throw new InvalidPlanError('repair must be a single command step');
        repaired = node;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { status: 'fail', where, reason: `repair failed: ${msg}` };
      }

      // The just-failed attempt was recorded as a failed step; downgrade it to a
      // healed pass so a self-healed leaf doesn't surface as a failure in the
      // report (the retry below records its own step).
      deps.markHealed?.(`healed: ${reason} → ${describe(repaired)}`);
      improvements.push(
        `${where}: "${describe(current)}" needed repair (${reason}); model replaced it with "${describe(repaired)}". ` +
          `Update the test to "${describe(repaired)}" to skip this repair next run.`,
      );
      modelRepairs++;
      current = repaired;
      replace(current);
      deps.log(`[ai]   ${where} repaired → ${describe(current)} (retrying)`);
      outcome = await runLeaf(current);
    }

    if (outcome.code === 0) return { status: 'ok' };
    // A review screenshot is best-effort evidence, never a gate. The grammar has the
    // model insert them liberally around transitions, so a capture that fails (a
    // device hiccup on screencap) must not fail an otherwise-green run. Log it,
    // downgrade the just-recorded failed step to a clean pass (markLastStepHealed
    // sets status=passed/exitCode=0 and drops the failure evidence) so the report and
    // JUnit stay consistent with the green run, then continue. Scoped to screenshot/
    // shot — every other command's failure stays terminal.
    if (isScreenshotLeaf(current)) {
      const why = outcome.error ? outcome.error.message.split('\n')[0] : `exited ${outcome.code}`;
      deps.log(`[ai] ${where}: screenshot capture failed (${why}) — continuing (best-effort review screenshot)`);
      deps.markHealed?.(`screenshot capture failed (${why}) — skipped (best-effort)`);
      return { status: 'ok' };
    }
    if (isHealable(outcome)) {
      return { status: 'fail', where, reason: `unresolved after ${maxRepairs} repair attempt(s): ${outcome.error!.message.split('\n')[0]}` };
    }
    // Terminal: an assertion failure (exit 1, no throw) or an environment error. The
    // two are reported differently — an assertion failure is a regression to fix, an
    // environment error means the harness is broken and nothing downstream is
    // trustworthy, so the caller aborts rather than banking a red result.
    const reason = outcome.error ? outcome.error.message.split('\n')[0] : `exited ${outcome.code}`;
    return { status: isEnvOutcome(outcome) ? 'env' : 'fail', where, reason };
  }

  async function walkBody(body: PlanNode[], parentWhere: string, guard?: string): Promise<StepResult> {
    for (let j = 0; j < body.length; j++) {
      const res = await walkNode(body[j], `${parentWhere}[${j}]`, (l) => (body[j] = l), guard);
      // 'guard-gone' ends this body, not the run: the thing the guard matched went away
      // mid-body, which is precisely the situation the guard exists to tolerate.
      if (res.status === 'guard-gone') return { status: 'ok' };
      if (res.status !== 'ok') return res;
    }
    return { status: 'ok' };
  }

  /** Capture a value from the live tree into ctx. Not routed through `exec`: the
   *  ExecFn contract returns only {code,error}, so a leaf could never hand a value back. */
  async function execRead(node: ReadNode, where: string): Promise<StepResult> {
    const selector = interpolate(node.selector);
    let sel;
    try {
      sel = parseSelector(selector);
    } catch (e) {
      return { status: 'fail', where, reason: `read selector '${selector}' did not parse: ${(e as Error).message}` };
    }
    // Same patience as a conditional guard: the value may not have rendered yet.
    const deadline = Date.now() + Math.max(0, guardSettleMs);
    let looks = 0;
    const minLooks = guardSettleMs > 0 ? 2 : 1;
    for (;;) {
      const els = await safeElements();
      const { matches } = matchElements(els, sel);
      looks++;
      if (matches.length > 0) {
        const value = String(matches[0][node.field] ?? '');
        ctx.set(node.into, value);
        deps.log(`[ai] ${where}: read ${node.field} of '${selector}' → ctx.${node.into} = ${JSON.stringify(value)}`);
        return { status: 'ok' };
      }
      const remaining = deadline - Date.now();
      if (looks >= minLooks && remaining <= 0) {
        // Terminal, not healable: a missing source value would silently propagate an
        // empty string into every later {{ctx.*}} use, which is a false green waiting
        // to happen. Fail where the information is.
        return { status: 'fail', where, reason: `read found no element matching '${selector}' (nothing to store in ctx.${node.into})` };
      }
      await sleep(Math.max(0, Math.min(GUARD_POLL_MS, remaining)));
    }
  }

  async function walkNode(node: PlanNode, where: string, replace: (l: LeafStep) => void, guard?: string): Promise<StepResult> {
    try {
      return await walkNodeInner(node, where, replace, guard);
    } catch (e) {
      // An unresolvable placeholder is a plan defect, not a device failure: report it
      // as this step's terminal failure rather than letting it abort the whole run as
      // an "unexpected error" (exit 3).
      if (e instanceof CtxError) return { status: 'fail', where, reason: e.message };
      throw e;
    }
  }

  async function walkNodeInner(node: PlanNode, where: string, replace: (l: LeafStep) => void, guard?: string): Promise<StepResult> {
    switch (node.type) {
      case 'command':
        return execLeaf(node, where, replace, guard);

      case 'read':
        return execRead(node, where);

      case 'if-present': {
        const selector = interpolate(node.selector);
        if (await present(selector, guardSettleMs)) {
          deps.log(`[ai] ${where}: if-present '${selector}' → present, running ${node.body.length} step(s)`);
          return walkBody(node.body, `${where}.body`, selector);
        }
        deps.log(`[ai] ${where}: if-present '${selector}' → absent, skipping`);
        return { status: 'ok' };
      }

      case 'when': {
        for (let b = 0; b < node.branches.length; b++) {
          const selector = interpolate(node.branches[b].selector);
          // Ordered: first present branch wins, and only it runs. The settle window is
          // per NODE, spent on the first branch checked — re-polling every branch would
          // cost cap x branches x window inside a loop, and would let a slower-appearing
          // earlier branch beat an already-present later one (making dispatch depend on
          // timing rather than on order).
          if (await present(selector, b === 0 ? guardSettleMs : 0)) {
            deps.log(`[ai] ${where}: when → branch ${b} '${selector}' matched`);
            return walkBody(node.branches[b].body, `${where}.branches[${b}].body`);
          }
        }
        if (node.else) {
          deps.log(`[ai] ${where}: when → no branch matched, running else (${node.else.length} step(s))`);
          return walkBody(node.else, `${where}.else`);
        }
        // No branch, no else => FAIL. Skipping here is the false-green this node exists
        // to prevent: inside a loop it would spin to the cap doing nothing and pass.
        const tried = node.branches.map((b) => `'${interpolate(b.selector)}'`).join(', ');
        return {
          status: 'fail',
          where,
          reason: `when: no branch matched (tried ${tried}) and no else was given — the screen is one this test does not handle`,
        };
      }

      case 'repeat': {
        let prevHash = '';
        let stalled = 0;
        let satisfied = false;
        let i = 0;
        for (; i < node.cap; i++) {
          if (overDeadline()) {
            deps.log(`[ai] ${where}: run timeout reached — stopping repeat after ${i} iteration(s)`);
            return { status: 'timeout' };
          }
          // settleMs=0 on purpose: this guard is absent on EVERY iteration by construction
          // (that is what makes it a loop), so a settle window here would be paid `cap`
          // times — 25 × 1.5s ≈ 37s of dead wall-clock per loop — to discover something
          // we already expect. The interstitial case that needs patience is `if-present`.
          if (await present(interpolate(node.selector), 0)) {
            satisfied = true;
            deps.log(`[ai] ${where}: repeat reached '${node.selector}' after ${i} iteration(s)`);
            break;
          }
          // No-progress detection over a SINGLE un-settled dump is unreliable on a real
          // app: mid-transition frames read as empty (measured — `vk ui` reported zero
          // elements on a screen where `tap`'s auto-wait found its target 3.1s later).
          // Two such frames hash identically and look exactly like a stuck loop. Since a
          // stalled loop is now a FAILURE, a false positive here fails a passing test, so
          // this needs two independent guards:
          //   1. an empty dump is UNKNOWN, not "unchanged" — never a progress sample;
          //   2. require consecutive identical NON-EMPTY snapshots before believing it.
          const els = await safeElements();
          if (els.length === 0) {
            deps.log(`[ai] ${where}: screen read as empty (mid-transition?) — not counting it as progress either way`);
          } else {
            const hash = structuralHash(els);
            stalled = i > 0 && hash === prevHash ? stalled + 1 : 0;
            prevHash = hash;
            if (stalled >= NO_PROGRESS_STRIKES) {
              deps.log(`[ai] ${where}: repeat made no progress across ${stalled + 1} checks — stopping after ${i} iteration(s)`);
              break;
            }
          }
          deps.log(`[ai] ${where}: repeat iteration ${i + 1}/${node.cap}`);
          const res = await walkBody(node.body, `${where}#${i + 1}.body`);
          if (res.status !== 'ok') return res;
        }
        // A loop that stopped without ever seeing its target did NOT do its job. Both
        // exits (cap exhausted, and the no-progress bail) used to return ok, which let a
        // loop whose body did nothing report green — the reachable false green.
        if (!satisfied && !(await present(interpolate(node.selector), guardSettleMs))) {
          return {
            status: 'fail',
            where,
            reason: `repeat stopped after ${i} iteration(s) without '${interpolate(node.selector)}' ever appearing`,
          };
        }
        return { status: 'ok' };
      }

      case 'while-present': {
        if (node.bind) ctx.set(node.bind, '0');
        let ran = 0;
        for (let i = 0; i < node.cap; i++) {
          if (overDeadline()) {
            deps.log(`[ai] ${where}: run timeout reached — stopping while-present after ${i} iteration(s)`);
            return { status: 'timeout' };
          }
          const selector = interpolate(node.selector);
          // First check gets the settle window (the list may still be rendering); later
          // checks are single-shot, since by then the list is up and we are just walking it.
          if (!(await present(selector, i === 0 ? guardSettleMs : 0))) {
            deps.log(`[ai] ${where}: while-present '${selector}' → absent, loop done after ${ran} iteration(s)`);
            return { status: 'ok' };
          }
          deps.log(`[ai] ${where}: while-present iteration ${i + 1}/${node.cap} ('${selector}')`);
          const res = await walkBody(node.body, `${where}#${i + 1}.body`, selector);
          if (res.status !== 'ok') return res;
          ran++;
          if (node.bind) ctx.set(node.bind, String(Number(ctx.get(node.bind) ?? '0') + 1));
        }
        deps.log(`[ai] ${where}: while-present hit cap ${node.cap}`);
        return { status: 'ok' };
      }
    }
  }

  for (let i = 0; i < plan.steps.length; i++) {
    if (overDeadline()) {
      deps.log(`[ai] run timeout reached before steps[${i}] — aborting`);
      return { ok: false, plan, modelRepairs, improvements, abortedForTimeout: true };
    }
    // The one place a blind guard becomes a step result — see GuardBlindError.
    let res: StepResult;
    try {
      res = await walkNode(plan.steps[i], `steps[${i}]`, (l) => (plan.steps[i] = l));
    } catch (e) {
      if (!(e instanceof GuardBlindError)) throw e;
      res = { status: 'env', where: `steps[${i}]`, reason: e.message };
    }
    if (res.status === 'budget') {
      return { ok: false, plan, modelRepairs, improvements, abortedForBudget: true };
    }
    if (res.status === 'timeout') {
      return { ok: false, plan, modelRepairs, improvements, abortedForTimeout: true };
    }
    if (res.status === 'env') {
      // `failure` is populated as well as the flag: the suite report still wants a row
      // reason, and callers that only know about `failure` keep working unchanged.
      deps.log(`[ai] ABORTED at ${res.where} — environment: ${res.reason}`);
      return { ok: false, plan, modelRepairs, improvements, abortedForEnv: true, failure: { where: res.where, reason: res.reason } };
    }
    if (res.status === 'fail') {
      deps.log(`[ai] FAILED at ${res.where}: ${res.reason}`);
      return { ok: false, plan, modelRepairs, improvements, failure: { where: res.where, reason: res.reason } };
    }
  }

  deps.log(`[ai] all ${plan.steps.length} step(s) passed${modelRepairs ? ` (${modelRepairs} model repair(s))` : ''}`);
  return { ok: true, plan, modelRepairs, improvements };
}
