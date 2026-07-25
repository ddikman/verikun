import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CliError } from '../errors';
import { formatCompact } from '../ui/format';
import { parsePlan, PLAN_JSON_SCHEMA, REPAIR_DECISION_JSON_SCHEMA } from './ir';
import { Usage, ProviderId } from './cost';
import { AgentProvider, CompileInput, CompileResult, RepairContext, RepairResult } from './provider';
import { GRAMMAR, REPAIR_GRAMMAR } from './grammar';
import { toStrictSchema } from './openai';
import { runText, TextResult } from '../exec';

// The CLI-agent provider: instead of an HTTP API + API key, drive an already-authenticated
// coding-agent CLI (codex / cursor-agent) as a one-shot text->JSON transformer. This lets a
// user compile/repair `vk ai` tests off their existing ChatGPT/Cursor SUBSCRIPTION — the CLI
// carries its own login, so verikun needs no key (just the binary on PATH). A sibling to
// claude.ts/openai.ts behind the same AgentProvider seam; like openai.ts is one class
// parameterized by baseUrl, this is one class parameterized by a CliAgentSpec per binary.
//
// Structured output: these CLIs are not HTTP endpoints, so there is no output_config /
// response_format. codex enforces a schema natively (--output-schema); a CLI without one
// gets the schema injected into the prompt. Either way parsePlan/validateNode (engine.ts)
// stays the execution trust boundary — ir.ts documents this exact "parse path when
// structured output is unavailable", so a malformed/hallucinated result is still rejected.
//
// These CLIs are AGENTS (tools, a working dir, a coding-oriented system prompt), so a
// forceful preamble + a read-only sandbox (per spec) coerce them into a pure transform that
// never touches the repo. The model runs here ONLY on compile + repair, never on replay.

// An agentic CLI compile is far slower than an HTTP call, and runText's 30s default would
// kill it mid-think. This is the per-invocation wall-clock cap (a hung spawn is killed and
// mapped to exit 3 by exec.ts); the engine's --timeout still bounds the whole run BETWEEN calls.
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

const PREAMBLE =
  'You are being used as a pure text-to-JSON transformer, NOT a coding assistant. ' +
  'Do NOT read, write, or edit any files. Do NOT run shell commands or use any tools. ' +
  'Do NOT explain, summarize, or add any commentary. Respond with ONLY a single JSON ' +
  'object as your final message, exactly matching the specification below.';

/** Injectable spawn (defaults to exec.ts runText) so the provider is unit-testable without
 *  a real binary — the analogue of openai.ts's injectable fetchImpl. */
export type RunImpl = (cmd: string, args: string[], opts: { input?: string; timeout?: number; cwd?: string }) => TextResult;

/** The per-binary configuration that turns this one class into a codex or a cursor provider. */
export interface CliAgentSpec {
  /** Internal backend id (matches a cost.ts ProviderId). */
  id: ProviderId;
  /** Executable name resolved on PATH. */
  bin: string;
  /** How the JSON schema reaches the model: a temp file the CLI reads (codex --output-schema)
   *  or injected into the prompt text (a CLI with no native schema flag). */
  schema: 'file' | 'prompt';
  /** Adapt the shared ir.ts schema to the CLI's schema dialect before it is written/injected.
   *  codex's backend is OpenAI's strict Structured Outputs, which rejects a schema whose
   *  `required` omits any property (it 400s with invalid_json_schema on our optional
   *  package/platform) — so codex points this at toStrictSchema. Omit for a vanilla dialect. */
  encodeSchema?: (schema: unknown) => unknown;
  /** Read the final message from an --output-last-message temp file (deterministic, independent
   *  of any stdout decoration) instead of parsing stdout. codex sets this; a CLI whose only
   *  output is stdout leaves it false and relies on rawText. */
  usesOutputFile: boolean;
  /** Build the argv for one non-interactive call. `cwd` is the neutral temp dir the CLI is run
   *  in; `schemaFile` is set only when schema==='file'; `outFile` only when usesOutputFile;
   *  `model` is an optional sub-model. */
  buildArgs(prompt: string, ctx: { schemaFile?: string; outFile?: string; cwd: string; model?: string }): string[];
  /** Peel the model's final message out of stdout — used when usesOutputFile is false, or as a
   *  fallback when the message file came back empty. */
  rawText(stdout: string): string;
  /** How to (re)authenticate — shown when the binary is absent or a call fails. */
  loginHint: string;
}

/** codex (OpenAI Codex CLI): non-interactive `codex exec` with NATIVE JSON-schema output
 *  (--output-schema) — the cleanest CLI path. Runs read-only in a neutral dir so it can't touch
 *  the verikun tree; the final (schema-shaped) message is written to --output-last-message, which
 *  we read back (deterministic, unlike parsing stdout, whose decoration is version-dependent). */
export const CODEX_SPEC: CliAgentSpec = {
  id: 'codex',
  bin: 'codex',
  schema: 'file',
  // codex's --output-schema is OpenAI strict Structured Outputs — adapt the shared ir.ts schema
  // the same way openai.ts does (all keys required, optionals made nullable, additionalProperties
  // false). parsePlan tolerates the resulting nulls (package/platform → undefined).
  encodeSchema: toStrictSchema,
  usesOutputFile: true,
  buildArgs(prompt, { schemaFile, outFile, cwd, model }) {
    const args = [
      'exec',
      '--skip-git-repo-check', // don't require (or scan) a git repo
      '--cd', cwd, // root the agent in a neutral temp dir, not the verikun working tree
      '--sandbox', 'read-only', // hard backstop: the agent cannot write anything
      '--ephemeral', // don't persist session files for a stateless transform
    ];
    if (schemaFile) args.push('--output-schema', schemaFile); // constrain the final message to the schema
    if (outFile) args.push('--output-last-message', outFile); // final message -> file we read back
    if (model) args.push('--model', model);
    args.push(prompt); // prompt is the trailing positional
    return args;
  },
  rawText: (stdout) => stdout, // fallback only; the message is read from --output-last-message
  loginHint: 'run `codex login` to sign in with your ChatGPT subscription (no API key needed)',
};

export interface CliProviderOpts {
  spec: CliAgentSpec;
  /** Optional underlying model for the CLI's own --model. v1 usually leaves this undefined,
   *  letting the CLI/subscription pick its default (the "I just have a subscription" path). */
  model?: string;
  /** Per-invocation wall-clock cap in ms (default 180s). */
  requestTimeoutMs?: number;
  /** Injectable spawn, for unit tests; defaults to exec.ts runText. */
  runImpl?: RunImpl;
  /** Injectable base temp dir for the neutral cwd + schema temp file; defaults to os.tmpdir(). */
  tmpDir?: string;
}

// Collision-free temp-file names within a process without needing Math.random() (which the
// plan-cache/version paths keep deterministic); pid + a counter is enough.
let tempCounter = 0;

export class CliProvider implements AgentProvider {
  private readonly run: RunImpl;
  private readonly baseTmp: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CliProviderOpts) {
    this.run = opts.runImpl ?? runText;
    this.baseTmp = opts.tmpDir ?? tmpdir();
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

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
    const json = this.call(GRAMMAR, parts.join('\n\n'), PLAN_JSON_SCHEMA);
    // usage:{} — a CLI is billed to the user's subscription, not per token, so cost is $0
    // (documented no-op for --max-cost-usd). The run is still bounded by maxRepairs + --timeout.
    return { plan: parsePlan(json), usage: {} };
  }

  async repair(ctx: RepairContext): Promise<RepairResult> {
    const parts: string[] = ['FAILED STEP: ' + JSON.stringify(ctx.failedStep), 'FAILURE: ' + ctx.reason];
    if (ctx.candidates && ctx.candidates.length) {
      parts.push(
        `The selector matched ${ctx.candidates.length} elements (ambiguous) — pick a more specific selector for the SAME intended element, or give_up if none of them is it.`,
      );
    }
    parts.push('CURRENT SCREEN:\n' + formatCompact(ctx.hierarchy));
    const json = this.call(REPAIR_GRAMMAR, parts.join('\n\n'), REPAIR_DECISION_JSON_SCHEMA);
    const decision = (json ?? {}) as { decision?: string; step?: unknown; reason?: string };
    if (decision.decision === 'give_up') {
      return {
        replaceStep: null,
        declineReason: decision.reason?.trim() || 'no element on the current screen matches the step intent',
        usage: {},
      };
    }
    // Hand the proposed leaf back UNVALIDATED — engine.ts validates every repair against the
    // grammar before splicing (it is the execution trust boundary), exactly like the API providers.
    return { replaceStep: (decision.step ?? null) as RepairResult['replaceStep'], usage: {} };
  }

  /** Spawn the CLI once and return the parsed JSON object it produced. Synchronous (spawnSync);
   *  the async method wrappers satisfy the Promise-returning AgentProvider seam. */
  private call(system: string, user: string, schema: unknown): unknown {
    const spec = this.opts.spec;
    const promptParts = [PREAMBLE, system];
    if (spec.schema === 'prompt') promptParts.push(schemaInstruction(schema));
    promptParts.push(user);
    const prompt = promptParts.join('\n\n');

    let schemaFile: string | undefined;
    let outFile: string | undefined;
    try {
      if (spec.schema === 'file') {
        const encoded = spec.encodeSchema ? spec.encodeSchema(schema) : schema;
        schemaFile = this.writeTemp('schema', '.json', JSON.stringify(encoded));
      }
      if (spec.usesOutputFile) outFile = this.tempPath('out', '.txt'); // path only; the CLI writes it
      const args = spec.buildArgs(prompt, { schemaFile, outFile, cwd: this.baseTmp, model: this.opts.model });
      // runText throws CliError(exit 3) for ENOENT / timeout / spawn failure — let it propagate.
      const res = this.run(spec.bin, args, { timeout: this.timeoutMs, cwd: this.baseTmp });
      if (res.code !== 0) {
        // Lead with the CLI's own stderr — it carries the real reason (usage limit, auth, a bad
        // flag). Only fall back to the login hint when stderr said nothing, so we don't
        // mis-suggest a re-login for e.g. a quota error.
        const detail = tail(res.stderr);
        const suffix = detail ? `: ${detail}` : ` — ${spec.loginHint}`;
        throw new CliError(`\`${spec.bin}\` exited ${res.code}${suffix}`, 3);
      }
      // Prefer the message file (deterministic); fall back to stdout if the CLI wrote nothing there.
      const fromFile = outFile ? readIfExists(outFile).trim() : '';
      const text = fromFile || spec.rawText(res.stdout).trim();
      if (!text) throw new CliError(`\`${spec.bin}\` returned an empty response.`, 1);
      return extractJson(text);
    } finally {
      for (const f of [schemaFile, outFile]) {
        if (!f) continue;
        try {
          unlinkSync(f);
        } catch {
          /* best-effort cleanup — a leftover temp file is harmless */
        }
      }
    }
  }

  private tempPath(kind: string, ext: string): string {
    return join(this.baseTmp, `verikun-${this.opts.spec.id}-${kind}-${process.pid}-${tempCounter++}${ext}`);
  }

  private writeTemp(kind: string, ext: string, content: string): string {
    const file = this.tempPath(kind, ext);
    writeFileSync(file, content, 'utf8');
    return file;
  }
}

/** Read a file, returning '' if it does not exist / can't be read — lets the message-file path
 *  fall back to stdout when a CLI didn't populate --output-last-message. */
function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** For a CLI with no native schema flag (schema:'prompt'): describe the required output shape
 *  inline. parsePlan/validateNode still re-checks whatever comes back. */
export function schemaInstruction(schema: unknown): string {
  return (
    'Your entire response MUST be a single JSON object matching this JSON Schema exactly, ' +
    'with no prose and no code fences:\n' + JSON.stringify(schema)
  );
}

/** Tolerantly pull a JSON object out of a CLI's stdout. codex's --output-schema output is
 *  already clean JSON; a schema-in-prompt CLI may wrap it in ```fences``` or a sentence. The
 *  brace scanner is string/escape aware, so it finds the object even inside a fence or after a
 *  "Here is the plan:" preamble. Throws CliError(exit 1) on failure — parsePlan is still the gate. */
export function extractJson(text: string): unknown {
  const candidate = firstBalancedObject(text) ?? text.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    throw new CliError('the CLI provider did not return parseable JSON.', 1);
  }
}

/** The first balanced `{...}` in `text`, honoring string literals + backslash escapes so a
 *  brace inside a JSON string value doesn't throw off the depth count. null if there is none. */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** A trimmed, size-capped tail of a CLI's stderr for error messages ('' when it wrote nothing). */
function tail(stderr: string, n = 500): string {
  const t = stderr.trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}
