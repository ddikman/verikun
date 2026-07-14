import { Element } from '../types';
import { parseSelector, matchElements } from '../ui/selector';
import { SelectorNotFoundError, AmbiguousSelectorError } from '../errors';
import { Plan, PlanNode, LeafStep, leafToFlags, validateNode, InvalidPlanError } from './ir';
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
}

type StepResult =
  | { status: 'ok' }
  | { status: 'fail'; reason: string; where: string }
  | { status: 'budget' }
  | { status: 'timeout' };

const describe = (leaf: LeafStep): string =>
  [leaf.command, ...leaf.positionals, ...leaf.flags.map((f) => (f.value === 'true' ? `--${f.name}` : `--${f.name} ${f.value}`))]
    .join(' ')
    .trim();

/** A structural fingerprint of the screen: sorted id+text+type set. Used for the
 *  loop no-progress check — deliberately NOT the raw hierarchy (its node ordering
 *  is nondeterministic between identical states, which would false-trip). */
function structuralHash(els: Element[]): string {
  return els
    .map((e) => `${e.idShort}|${e.text}|${e.type}`)
    .sort()
    .join('\n');
}

function isHealable(outcome: ExecOutcome): boolean {
  return (
    !!outcome.error &&
    (outcome.error instanceof SelectorNotFoundError || outcome.error instanceof AmbiguousSelectorError)
  );
}

/** Default wall-clock ceiling for a whole `vk ai` run (overridable via --timeout). */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

export async function runPlan(plan: Plan, deps: EngineDeps): Promise<EngineResult> {
  const maxRepairs = deps.maxRepairs ?? 3;
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

  const present = async (selector: string): Promise<boolean> => {
    // Re-fetch on a dump FAILURE (uiautomator can throw transiently) so a flaky dump at
    // a guard check doesn't silently read as "absent" and skip a body that should run.
    // Once a dump SUCCEEDS (even if empty) we trust it — no slow re-poll, so a genuinely
    // absent guard still skips fast (the common if-present case).
    let els: Element[] | undefined;
    for (let i = 0; i < 2 && els === undefined; i++) {
      try {
        els = await deps.getElements();
      } catch {
        /* transient dump failure — retry once before concluding "absent" */
      }
    }
    if (els === undefined) return false;
    try {
      return matchElements(els, parseSelector(selector)).matches.length > 0;
    } catch (e) {
      // A guard selector that won't parse is a compiler/plan bug — surface it (then treat
      // as not present) rather than silently skip the guarded body.
      deps.log(`[ai] guard selector '${selector}' did not parse (${(e as Error).message}) — treating as not present`);
      return false;
    }
  };

  const runLeaf = (leaf: LeafStep): Promise<ExecOutcome> =>
    deps.exec(leaf.command, leaf.positionals, leafToFlags(leaf));

  /** Execute one leaf, healing a selector miss/ambiguity via the model up to the cap.
   *  `replace` writes a repaired leaf back into the plan so it persists on green. */
  async function execLeaf(leaf: LeafStep, where: string, replace: (l: LeafStep) => void): Promise<StepResult> {
    deps.log(`[ai] ${where}: ${describe(leaf)}`);
    let current = leaf;
    let outcome = await runLeaf(current);
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
    if (isHealable(outcome)) {
      return { status: 'fail', where, reason: `unresolved after ${maxRepairs} repair attempt(s): ${outcome.error!.message.split('\n')[0]}` };
    }
    // Terminal: an assertion failure (exit 1, no throw) or an environment error.
    const reason = outcome.error ? outcome.error.message.split('\n')[0] : `exited ${outcome.code}`;
    return { status: 'fail', where, reason };
  }

  async function walkBody(body: LeafStep[], parentWhere: string): Promise<StepResult> {
    for (let j = 0; j < body.length; j++) {
      const res = await execLeaf(body[j], `${parentWhere}.body[${j}]`, (l) => (body[j] = l));
      if (res.status !== 'ok') return res;
    }
    return { status: 'ok' };
  }

  async function walkNode(node: PlanNode, where: string, replace: (l: LeafStep) => void): Promise<StepResult> {
    switch (node.type) {
      case 'command':
        return execLeaf(node, where, replace);

      case 'if-present': {
        if (await present(node.selector)) {
          deps.log(`[ai] ${where}: if-present '${node.selector}' → present, running ${node.body.length} step(s)`);
          return walkBody(node.body, where);
        }
        deps.log(`[ai] ${where}: if-present '${node.selector}' → absent, skipping`);
        return { status: 'ok' };
      }

      case 'repeat': {
        let prevHash = '';
        for (let i = 0; i < node.cap; i++) {
          if (overDeadline()) {
            deps.log(`[ai] ${where}: run timeout reached — stopping repeat after ${i} iteration(s)`);
            return { status: 'timeout' };
          }
          if (await present(node.selector)) {
            deps.log(`[ai] ${where}: repeat reached '${node.selector}' after ${i} iteration(s)`);
            return { status: 'ok' };
          }
          const hash = structuralHash(await safeElements());
          if (i > 0 && hash === prevHash) {
            deps.log(`[ai] ${where}: repeat made no progress (screen unchanged) — stopping after ${i} iteration(s)`);
            return { status: 'ok' };
          }
          prevHash = hash;
          deps.log(`[ai] ${where}: repeat iteration ${i + 1}/${node.cap}`);
          const res = await walkBody(node.body, `${where}#${i + 1}`);
          if (res.status !== 'ok') return res;
        }
        deps.log(`[ai] ${where}: repeat hit cap ${node.cap} without '${node.selector}' (continuing)`);
        return { status: 'ok' };
      }
    }
  }

  for (let i = 0; i < plan.steps.length; i++) {
    if (overDeadline()) {
      deps.log(`[ai] run timeout reached before steps[${i}] — aborting`);
      return { ok: false, plan, modelRepairs, improvements, abortedForTimeout: true };
    }
    const res = await walkNode(plan.steps[i], `steps[${i}]`, (l) => (plan.steps[i] = l));
    if (res.status === 'budget') {
      return { ok: false, plan, modelRepairs, improvements, abortedForBudget: true };
    }
    if (res.status === 'timeout') {
      return { ok: false, plan, modelRepairs, improvements, abortedForTimeout: true };
    }
    if (res.status === 'fail') {
      deps.log(`[ai] FAILED at ${res.where}: ${res.reason}`);
      return { ok: false, plan, modelRepairs, improvements, failure: { where: res.where, reason: res.reason } };
    }
  }

  deps.log(`[ai] all ${plan.steps.length} step(s) passed${modelRepairs ? ` (${modelRepairs} model repair(s))` : ''}`);
  return { ok: true, plan, modelRepairs, improvements };
}
