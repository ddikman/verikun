import { CliError } from '../errors';

// Token accounting and the dollar budget — the lever for the project's #1 risk.
// Pure and dependency-free so it carries its own unit tests. The model only runs
// on compile + repair (never replay), so this tracks the spend of those calls and
// aborts the run the moment the estimate crosses --max-cost-usd.

/** The Anthropic Messages API `usage` block (the fields we price). */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface Price {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

// Per-1M-token prices (Anthropic, cached 2026-05-26). This table WILL drift as
// pricing changes between releases — `--cost-override <input/output>` is the escape
// hatch, and is authoritative when supplied. The --model allowlist is exactly the
// keys of this table, so the two can never disagree.
export const MODEL_PRICES: Record<string, Price> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
};

export const ALLOWED_MODELS: readonly string[] = Object.keys(MODEL_PRICES);
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Default total-run cost ceiling for `vk ai` when --max-cost-usd is not given, so a
 *  runaway compile/repair loop can't spend unbounded tokens. */
export const DEFAULT_MAX_COST_USD = 3;

/** Validate a --model against the allowlist (unknown -> exit 2, not a raw 404). */
export function resolveModel(model: string | undefined): string {
  if (!model) return DEFAULT_MODEL;
  if (!MODEL_PRICES[model]) {
    throw new CliError(`Unknown --model '${model}'. Allowed: ${ALLOWED_MODELS.join(', ')}.`, 2);
  }
  return model;
}

/** Parse `--cost-override <input/output>` (e.g. "3/15" => $3 in / $15 out per 1M). */
export function parseCostOverride(raw: string): Price {
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) throw new CliError(`--cost-override must be <input/output> per 1M tokens, e.g. 3/15; got '${raw}'`, 2);
  return { input: Number(m[1]), output: Number(m[2]) };
}

/** Resolve the price to use: an explicit override wins over the bundled table. */
export function priceFor(model: string, override?: Price): Price {
  return override ?? MODEL_PRICES[model] ?? MODEL_PRICES[DEFAULT_MODEL];
}

// Cache reads bill at ~0.1x input; cache writes (5-min TTL) at ~1.25x input.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;
const PER_M = 1_000_000;

/** Estimate the USD cost of a single API response from its `usage`. */
export function estimateCostUsd(usage: Usage, price: Price): number {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (input * price.input +
      output * price.output +
      cacheWrite * price.input * CACHE_WRITE_MULT +
      cacheRead * price.input * CACHE_READ_MULT) /
    PER_M
  );
}

/**
 * Accumulates token usage across a run and exposes the running dollar estimate.
 * `exceeded()` is the budget gate: when the estimate crosses `maxUsd`, the engine
 * aborts the run (recording it as aborted) rather than spending unbounded tokens.
 */
export class CostTracker {
  private cacheRead = 0;
  private compileUsd = 0;
  private repairUsd = 0;

  constructor(
    private readonly price: Price,
    private readonly maxUsd?: number,
  ) {}

  /** Record one API response. `phase` splits compile vs repair spend for the report. */
  add(usage: Usage, phase: 'compile' | 'repair'): void {
    this.cacheRead += usage.cache_read_input_tokens ?? 0;
    const usd = estimateCostUsd(usage, this.price);
    if (phase === 'compile') this.compileUsd += usd;
    else this.repairUsd += usd;
  }

  usd(): number {
    return this.compileUsd + this.repairUsd;
  }

  /** True once the running estimate has crossed the configured ceiling. */
  exceeded(): boolean {
    return this.maxUsd !== undefined && this.usd() >= this.maxUsd;
  }

  get budgetUsd(): number | undefined {
    return this.maxUsd;
  }

  /** The `compile=… · repairs=… · replay=0 · cache_read=… · est $…` report line. */
  summaryLine(): string {
    const fmt = (n: number) => `$${n.toFixed(4)}`;
    return `compile=${fmt(this.compileUsd)} · repairs=${fmt(this.repairUsd)} · replay=$0 · cache_read=${this.cacheRead} tok · est ${fmt(this.usd())}`;
  }
}
