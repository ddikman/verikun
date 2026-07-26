import { Element } from '../types';
import { Plan, LeafStep } from './ir';
import { Usage } from './cost';

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
