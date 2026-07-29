import { CliError } from '../errors';

// Token accounting and the dollar budget — the lever for the project's #1 risk.
// Pure and dependency-free so it carries its own unit tests. The model only runs
// on compile + repair (never replay), so this tracks the spend of those calls and
// aborts the run the moment the estimate crosses --max-cost-usd.

/** Normalized token-usage block (the fields we price). Anthropic's Messages API
 *  `usage` maps onto it directly; the OpenAI provider maps its `usage` into this same
 *  shape (uncached prompt → input_tokens, cached → cache_read_input_tokens). */
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
  /** Multiplier on `input` for cache-READ tokens, when the model does not bill them at the
   *  usual CACHE_READ_MULT. Set only where a vendor deviates (gpt-4.1 reads cache at 0.25x,
   *  $0.50 against $2.00 input); omitted everywhere else, and omitted by `--cost-override`,
   *  which therefore keeps the 0.1x default. */
  cacheReadMult?: number;
}

/** Which backend serves a --model. HTTP providers read an API key from env — ClaudeProvider
 *  (claude.ts) and OpenAiProvider (openai.ts); CLI providers shell out to an already-logged-in
 *  agent CLI — CliProvider (cli-provider.ts), i.e. 'codex' and 'cursor'. cmdAi routes on this. */
export type ProviderId = 'anthropic' | 'openai' | 'codex' | 'cursor';

interface ModelSpec extends Price {
  provider: ProviderId;
}

// Per-1M-token prices + owning provider — the SINGLE source of truth. MODEL_PRICES,
// ALLOWED_MODELS and providerFor all derive from this, so the --model allowlist, its
// price and its backend can never disagree. Prices WILL drift between releases
// (Anthropic cached 2026-05-26; OpenAI 2026-07-02) — `--cost-override <input/output>`
// is the escape hatch and is authoritative when supplied. Nearly every model here bills
// cached input at the ~0.1x CACHE_READ_MULT below (Anthropic + OpenAI gpt-5.x alike); the
// exception carries an explicit `cacheReadMult`.
const MODELS: Record<string, ModelSpec> = {
  'claude-haiku-4-5': { input: 1, output: 5, provider: 'anthropic' },
  'claude-sonnet-4-6': { input: 3, output: 15, provider: 'anthropic' },
  'claude-opus-4-8': { input: 5, output: 25, provider: 'anthropic' },
  'claude-fable-5': { input: 10, output: 50, provider: 'anthropic' },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, provider: 'openai' },
  'gpt-5.4': { input: 2.5, output: 15, provider: 'openai' },
  'gpt-5.5': { input: 5, output: 30, provider: 'openai' },
  // The one NON-REASONING model in the registry, and cheaper than the default sonnet
  // ($2/$8 vs $3/$15). Two consequences, both handled rather than papered over: it takes
  // no reasoning_effort (openai.ts's REASONING_MODELS gate skips the param for it), and it
  // bills cache reads at 0.25x rather than the 0.1x every other model here uses.
  'gpt-4.1': { input: 2, output: 8, provider: 'openai', cacheReadMult: 0.25 },
  // CLI-agent backends: billed to the user's ChatGPT/Cursor subscription via an already-logged-in
  // CLI, not per token — so price is $0 and --max-cost-usd/--cost-override are inert no-ops (the
  // run is bounded by maxRepairs + --timeout instead). The `-cli` suffix reads clearly as "the
  // CLI" and keeps these from colliding with the CLIs' own model aliases — cursor in particular
  // offers `gpt-5.3-codex`, `gpt-5.4-high`, `claude-opus-4-8-thinking-high` and friends.
  'codex-cli': { input: 0, output: 0, provider: 'codex' },
  'cursor-cli': { input: 0, output: 0, provider: 'cursor' },
};

// Strip `provider` off each spec; what remains IS the Price (including any cacheReadMult,
// so a per-model deviation reaches the tracker without being re-listed here).
export const MODEL_PRICES: Record<string, Price> = Object.fromEntries(
  Object.entries(MODELS).map(([m, { provider: _provider, ...price }]) => [m, price]),
);
export const ALLOWED_MODELS: readonly string[] = Object.keys(MODELS);
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Resolve which provider backend serves a model (unknown → anthropic, the default). */
export function providerFor(model: string): ProviderId {
  return MODELS[model]?.provider ?? 'anthropic';
}

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

// Cache reads bill at ~0.1x input (unless the model overrides it via Price.cacheReadMult);
// cache writes (5-min TTL) at ~1.25x input.
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
      cacheRead * price.input * (price.cacheReadMult ?? CACHE_READ_MULT)) /
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
