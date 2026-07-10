import { CliError } from '../errors';
import { formatCompact } from '../ui/format';
import { parsePlan, PLAN_JSON_SCHEMA, REPAIR_DECISION_JSON_SCHEMA } from './ir';
import { Usage } from './cost';
import { AgentProvider, CompileInput, CompileResult, RepairContext, RepairResult } from './provider';
import { GRAMMAR, REPAIR_GRAMMAR } from './grammar';

// The OpenAI provider: OpenAI's Chat Completions API over Node's built-in fetch — no
// SDK, honoring the repo's zero-runtime-dependency rule (a sibling to claude.ts). The
// LLM ecosystem converged on this /chat/completions shape, so this same class drives any
// OpenAI-compatible endpoint (Groq, xAI, Together, DeepSeek, Gemini-compat) by pointing
// `baseUrl` at it — that is the whole point of doing it here rather than per vendor.
//
// Structured output: response_format json_schema with strict:true, so generation is
// HARD-CONSTRAINED to the plan/repair schema. json_object mode is not enough — a weaker
// model (e.g. gpt-5.4-mini) emits flags as a map instead of the {name,value}[] the IR
// requires, which parsePlan then rejects. The shared ir.ts schemas are adapted to
// OpenAI's strict dialect at call time by toStrictSchema (no duplication, no ir.ts
// change); engine.ts's parsePlan/validateNode stays the execution trust boundary
// regardless. The model runs here ONLY on compile + repair, never on replay.

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
// Per-request wall-clock cap so a stalled connection can't hang the run past its
// --timeout deadline (the engine checks the deadline only between calls, not during one).
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

// gpt-5.x are reasoning models: they take reasoning_effort, require max_completion_tokens
// (not max_tokens), and reject a custom temperature. Map verikun's effort scale onto
// OpenAI's (whose ceiling is 'high'), and only send it when the caller asked for one.
// INVARIANT: every OpenAI model in cost.ts's registry is a reasoning model that accepts
// reasoning_effort. If a non-reasoning model is ever added there, gate this send behind an
// allowlist like claude.ts's EFFORT_MODELS (else it 400s → exit 2 with no retry).
const EFFORT_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

export interface OpenAiProviderOpts {
  model: string;
  apiKey: string;
  /** low | medium | high | xhigh | max — mapped onto OpenAI's reasoning_effort. */
  effort?: string;
  maxRetries?: number;
  /** Per-request wall-clock timeout in ms (default 120s); a stalled call is aborted and retried. */
  requestTimeoutMs?: number;
  /** Base URL of the OpenAI-compatible API (default OpenAI). Lets the same class drive
   *  Groq/xAI/Together/etc. later without a new implementation. */
  baseUrl?: string;
  /** Injectable fetch, for unit tests; defaults to Node's global fetch. */
  fetchImpl?: FetchImpl;
  /** Injectable sleep, for unit tests; defaults to a real setTimeout delay so the
   *  retry/backoff loop can be exercised without wall-clock waits. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** The subset of a fetch `Response` this provider reads — so a test can supply a fake. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponse>;

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 15000);

/** Map OpenAI's usage onto the normalized (Anthropic-shaped) Usage the CostTracker
 *  prices. OpenAI's prompt_tokens INCLUDES the cached tokens, so subtract them out:
 *  uncached prompt → input_tokens (full price), cached → cache_read_input_tokens (0.1x).
 *  OpenAI has no separate cache-write charge, so cache_creation is 0. completion_tokens
 *  already includes reasoning tokens on gpt-5.x, so output is priced correctly. A response
 *  with no usage block maps to all-zeros (cost under-counts) — acceptable because the
 *  repair loop is also bounded by maxRepairs and the --timeout deadline, not cost alone. */
export function mapUsage(u: ChatResponse['usage']): Usage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = u?.prompt_tokens ?? 0;
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** Adapt a JSON Schema to OpenAI's strict Structured-Outputs dialect: every object must
 *  set additionalProperties:false and list ALL its properties in `required`, so a
 *  previously-optional field is kept but made nullable. Non-mutating — lets the shared
 *  ir.ts schemas stay the single source of truth while OpenAI hard-constrains generation. */
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) out[k] = toStrictSchema(v);
  const props = out.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const p = props as Record<string, unknown>;
    const keys = Object.keys(p);
    const wasRequired = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    out.additionalProperties = false;
    out.required = keys;
    for (const k of keys) if (!wasRequired.has(k)) p[k] = makeNullable(p[k]);
  }
  return out;
}

/** Widen a property schema to also admit null (how strict mode expresses "optional"). */
function makeNullable(prop: unknown): unknown {
  if (!prop || typeof prop !== 'object') return prop;
  const p = prop as Record<string, unknown>;
  if (Array.isArray(p.anyOf)) return { ...p, anyOf: [...(p.anyOf as unknown[]), { type: 'null' }] };
  if (typeof p.type === 'string') {
    const next: Record<string, unknown> = { ...p, type: [p.type, 'null'] };
    if (Array.isArray(p.enum)) next.enum = [...(p.enum as unknown[]), null];
    return next;
  }
  if (Array.isArray(p.type)) {
    return { ...p, type: [...(p.type as unknown[]).filter((t) => t !== 'null'), 'null'] };
  }
  return { anyOf: [prop, { type: 'null' }] };
}

export class OpenAiProvider implements AgentProvider {
  constructor(private readonly opts: OpenAiProviderOpts) {}

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

    // Generous completion budget: on reasoning models the plan JSON shares this ceiling
    // with reasoning tokens, so leave headroom (a 'length' finish is surfaced as an error).
    const { json, usage } = await this.call(GRAMMAR, parts.join('\n\n'), PLAN_JSON_SCHEMA, 16384);
    return { plan: parsePlan(json), usage };
  }

  async repair(ctx: RepairContext): Promise<RepairResult> {
    const parts: string[] = ['FAILED STEP: ' + JSON.stringify(ctx.failedStep), 'FAILURE: ' + ctx.reason];
    if (ctx.candidates && ctx.candidates.length) {
      parts.push(
        `The selector matched ${ctx.candidates.length} elements (ambiguous) — pick a more specific selector for the SAME intended element, or give_up if none of them is it.`,
      );
    }
    parts.push('CURRENT SCREEN:\n' + formatCompact(ctx.hierarchy));

    const { json, usage } = await this.call(REPAIR_GRAMMAR, parts.join('\n\n'), REPAIR_DECISION_JSON_SCHEMA, 4096);
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
    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_completion_tokens: maxTokens,
      // Hard-constrain generation to the schema (strict Structured Outputs), adapting the
      // shared ir.ts schema to OpenAI's strict dialect. parsePlan/validateNode still gates.
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'verikun_output', strict: true, schema: toStrictSchema(schema) },
      },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (this.opts.effort) {
      const mapped = EFFORT_MAP[this.opts.effort];
      if (mapped) body.reasoning_effort = mapped;
    }

    const res = await this.fetchWithRetry(body);
    const choice = res.choices?.[0];
    if (choice?.message?.refusal) {
      throw new CliError(`Model refused the request: ${choice.message.refusal}`, 1);
    }
    if (choice?.finish_reason === 'length') {
      throw new CliError(
        'Model output was truncated (finish_reason=length) before a complete result — raise the budget or shorten the test.',
        1,
      );
    }
    if (choice?.finish_reason === 'content_filter') {
      throw new CliError('Model output was blocked by the content filter.', 1);
    }
    const text = (choice?.message?.content ?? '').trim();
    if (!text) throw new CliError('Model returned an empty response.', 1);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CliError('Model output was not valid JSON.', 1);
    }
    return { json, usage: mapUsage(res.usage) };
  }

  private async fetchWithRetry(body: unknown): Promise<ChatResponse> {
    const maxRetries = this.opts.maxRetries ?? 4;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const doFetch: FetchImpl =
      this.opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<HttpResponse>);
    const doSleep = this.opts.sleepImpl ?? sleep;
    const url = (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '') + '/chat/completions';
    let attempt = 0;
    for (;;) {
      // Abort a stalled request after timeoutMs so it can't hang forever; the abort is
      // caught below and retried like any other network error (bounded by maxRetries).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: HttpResponse;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        if (attempt++ >= maxRetries) throw new CliError(`OpenAI API request failed: ${(e as Error).message}`, 3);
        await doSleep(backoffMs(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        try {
          return (await res.json()) as ChatResponse;
        } catch {
          // A 2xx with a non-JSON body (proxy/API corruption) — map to the env exit code
          // rather than letting a raw SyntaxError escape as an unhandled throw.
          throw new CliError('OpenAI returned a non-JSON success body.', 3);
        }
      }
      // Retry 429 + 5xx with backoff, honoring Retry-After (no SDK to do it for us).
      if ((res.status === 429 || res.status >= 500) && attempt++ < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await doSleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }
      const errText = await res.text().catch(() => '');
      // 401/403 = auth/permission (env); 400 = bad request (usage); else env.
      const code = res.status === 401 || res.status === 403 ? 3 : res.status === 400 ? 2 : 3;
      throw new CliError(`OpenAI API error ${res.status}: ${errText.slice(0, 500)}`, code);
    }
  }
}
