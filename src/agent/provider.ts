import { Element } from '../types';
import { Plan, LeafStep } from './ir';
import { Usage } from './cost';
import { SECTION_NOTE } from './grammar';

// The seam between the engine and whatever LLM compiles/repairs a plan. Four backends
// implement it today: two over HTTP with an API key — ClaudeProvider (./claude.ts) and
// OpenAiProvider (./openai.ts) — and two that shell out to an already-logged-in agent CLI,
// both served by the one spec-parameterized CliProvider (./cli-provider.ts): codex and
// cursor-agent. `providerFor(model)` (./cost.ts) picks between them. Every call returns its
// token `usage` so the engine can bill it against the run's cost budget (a CLI backend is
// billed to the user's subscription instead, so it reports empty usage — i.e. $0).

export interface CompileInput {
  /** The natural-language test source, verbatim. */
  nl: string;
  pkg?: string;
  platform: string;
  /** A prior plan to adapt instead of compiling from scratch (new-build seeding). */
  seed?: Plan;
  /** Set only on a SECOND compile attempt: what was wrong with the first one (a lint
   *  finding — the plan lost something the prose stated). Compilation is nondeterministic,
   *  so one guided retry recovers far more than the extra call costs. */
  retryFeedback?: string;
  /** This `nl` is ONE SECTION of a test (an `@include` fragment, or the host prose around
   *  one), not a whole test. Adds SECTION_NOTE — without it the model reads a descriptive
   *  paragraph as an instruction and invents steps. See grammar.ts's SECTION_NOTE. */
  section?: boolean;
}

/**
 * The user message for a compile. Shared by all four providers, which differ only in how
 * they SEND it — the same text three times was one edit away from drifting apart, and this
 * one gained a fourth part (SECTION_NOTE).
 *
 * Order is load-bearing at both ends: the seed comes before the test so the test is what
 * the model reads last, and retry feedback comes after everything so a rejection is the
 * freshest thing in context.
 */
export function compileUserPrompt(input: CompileInput): string {
  const parts: string[] = [];
  if (input.pkg) parts.push(`App package: ${input.pkg}`);
  parts.push(`Platform: ${input.platform}`);
  if (input.seed) {
    parts.push(
      'A plan compiled for a PREVIOUS build of this app follows. Reuse it where the test still holds; ' +
        'change only what the test now requires. PRIOR PLAN:\n' +
        JSON.stringify(input.seed, null, 2),
    );
  }
  if (input.section) parts.push(SECTION_NOTE);
  parts.push(`${input.section ? 'TEST SECTION' : 'NATURAL-LANGUAGE TEST'}:\n${input.nl}`);
  if (input.retryFeedback) {
    // Last, so it is the freshest thing in context: a previous compile of this same
    // test lost something the prose stated. Naming it beats hoping the retry differs.
    parts.push(
      'YOUR PREVIOUS ATTEMPT AT THIS TEST WAS REJECTED. Fix this and emit the whole plan again:\n' +
        input.retryFeedback,
    );
  }
  return parts.join('\n\n');
}

export interface CompileResult {
  plan: Plan;
  usage: Usage;
}

/** Context handed to the model when an action step failed and needs repair. */
export interface RepairContext {
  failedStep: LeafStep;
  /** Why it failed: "selector not found" or "ambiguous" + the underlying message. */
  reason: string;
  /** Present for an ambiguous match — the elements the selector hit. */
  candidates?: Element[];
  /** The live UI hierarchy at the moment of failure. */
  hierarchy: Element[];
}

export interface RepairResult {
  /** A single replacement leaf step (v1 repair granularity — no tail re-planning),
   *  or `null` when the model DECLINES to repair: the current screen has no element
   *  serving the failed step's intent (the flow drifted to an unexpected screen). A
   *  decline is terminal — substituting a loosely-related element would let a real
   *  regression pass as green, which is the bug this guards against.
   *  The leaf is the model's PROPOSAL: engine.ts validates it against the grammar before
   *  executing it (the engine is the trust boundary), so a provider need not re-validate. */
  replaceStep: LeafStep | null;
  /** Why the model gave up, when `replaceStep` is null (surfaced in the failure). */
  declineReason?: string;
  usage: Usage;
}

export interface AgentProvider {
  /** Compile NL into a Plan IR. The expensive, once-per-test call. */
  compile(input: CompileInput): Promise<CompileResult>;
  /** Propose a single replacement step for a failed action. */
  repair(ctx: RepairContext): Promise<RepairResult>;
}
