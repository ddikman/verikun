import { Element } from '../types';
import { Plan, LeafStep } from './ir';
import { Usage } from './cost';

// The seam between the engine and whatever LLM compiles/repairs a plan. v1 ships
// one implementation (ClaudeProvider, ./claude.ts); Grok/OpenAI/Gemini are future
// implementations behind this same interface. Every call returns its token `usage`
// so the engine can bill it against the run's cost budget.

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
