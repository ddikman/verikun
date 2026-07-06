import { CliError } from '../errors';
import { formatCompact } from '../ui/format';
import { parsePlan, PLAN_JSON_SCHEMA, REPAIR_DECISION_JSON_SCHEMA } from './ir';
import { Usage } from './cost';
import { AgentProvider, CompileInput, CompileResult, RepairContext, RepairResult } from './provider';
import { GRAMMAR, REPAIR_GRAMMAR } from './grammar';

// The one v1 provider: Anthropic's Messages API over Node's built-in fetch — no SDK,
// honoring the repo's zero-runtime-dependency rule. Structured output guarantees a
// schema-valid plan; the stable grammar prefix is cache_control'd; 429/5xx retry with
// backoff (no SDK to do it for us). The LLM runs here ONLY on compile + repair.

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Per-request wall-clock cap so a stalled connection can't hang the run past its
// --timeout deadline (the engine checks the deadline only between calls, not during one).
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

// effort (output_config.effort) is rejected by Haiku 4.5; only send it for models
// that accept it.
const EFFORT_MODELS = new Set(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5']);

export interface ClaudeProviderOpts {
  model: string;
  apiKey: string;
  /** low | medium | high | xhigh | max — sent only for models that accept it. */
  effort?: string;
  maxRetries?: number;
  /** Per-request wall-clock timeout in ms (default 120s); a stalled call is aborted and retried. */
  requestTimeoutMs?: number;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: Usage;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 15000);

export class ClaudeProvider implements AgentProvider {
  constructor(private readonly opts: ClaudeProviderOpts) {}

  async compile(input: CompileInput): Promise<CompileResult> {
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
    parts.push('NATURAL-LANGUAGE TEST:\n' + input.nl);

    const { json, usage } = await this.call(GRAMMAR, parts.join('\n\n'), PLAN_JSON_SCHEMA, 8192);
    return { plan: parsePlan(json), usage };
  }

  async repair(ctx: RepairContext): Promise<RepairResult> {
    const parts: string[] = [
      'FAILED STEP: ' + JSON.stringify(ctx.failedStep),
      'FAILURE: ' + ctx.reason,
    ];
    if (ctx.candidates && ctx.candidates.length) {
      parts.push(
        `The selector matched ${ctx.candidates.length} elements (ambiguous) — pick a more specific selector for the SAME intended element, or give_up if none of them is it.`,
      );
    }
    parts.push('CURRENT SCREEN:\n' + formatCompact(ctx.hierarchy));

    const { json, usage } = await this.call(REPAIR_GRAMMAR, parts.join('\n\n'), REPAIR_DECISION_JSON_SCHEMA, 1024);
    const decision = (json ?? {}) as { decision?: string; step?: unknown; reason?: string };
    if (decision.decision === 'give_up') {
      return {
        replaceStep: null,
        declineReason: decision.reason?.trim() || 'no element on the current screen matches the step intent',
        usage,
      };
    }
    // Hand the proposed leaf back UNVALIDATED — engine.ts validates every repair against
    // the grammar before splicing (it is the execution trust boundary and can't assume a
    // provider validated). A missing/invalid step is rejected there as a failed repair.
    return { replaceStep: (decision.step ?? null) as RepairResult['replaceStep'], usage };
  }

  private async call(system: string, user: string, schema: unknown, maxTokens: number): Promise<{ json: unknown; usage: Usage }> {
    const outputConfig: Record<string, unknown> = { format: { type: 'json_schema', schema } };
    if (this.opts.effort && EFFORT_MODELS.has(this.opts.model)) outputConfig.effort = this.opts.effort;

    const res = await this.fetchWithRetry({
      model: this.opts.model,
      max_tokens: maxTokens,
      // The grammar is the large, stable prefix — cache it so repeat calls in a
      // repair-heavy session read it at ~0.1x instead of full input price.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: outputConfig,
    });

    if (res.stop_reason === 'refusal') {
      throw new CliError('Model refused the request (stop_reason=refusal).', 1);
    }
    if (res.stop_reason === 'max_tokens') {
      throw new CliError('Model output was truncated (max_tokens) before a complete result — raise max_tokens or shorten the test.', 1);
    }
    const text = (res.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (!text.trim()) throw new CliError('Model returned an empty response.', 1);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CliError('Model output was not valid JSON.', 1);
    }
    return { json, usage: res.usage ?? {} };
  }

  private async fetchWithRetry(body: unknown): Promise<MessagesResponse> {
    const maxRetries = this.opts.maxRetries ?? 4;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let attempt = 0;
    for (;;) {
      // Abort a stalled request after timeoutMs so it can't hang forever; the abort is
      // caught below and retried like any other network error (bounded by maxRetries).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.opts.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        if (attempt++ >= maxRetries) throw new CliError(`Anthropic API request failed: ${(e as Error).message}`, 3);
        await sleep(backoffMs(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return (await res.json()) as MessagesResponse;
      // Retry 429 + 5xx with backoff, honoring Retry-After (no SDK to do it for us).
      if ((res.status === 429 || res.status >= 500) && attempt++ < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }
      const errText = await res.text().catch(() => '');
      // 401/403 = auth/permission (env); 400 = bad request (usage); else env.
      const code = res.status === 401 || res.status === 403 ? 3 : res.status === 400 ? 2 : 3;
      throw new CliError(`Anthropic API error ${res.status}: ${errText.slice(0, 500)}`, code);
    }
  }
}
