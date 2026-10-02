import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CliError } from '../errors';
import { parsePlan, PLAN_JSON_SCHEMA, REPAIR_DECISION_JSON_SCHEMA } from './ir';
import { Usage, ProviderId } from './cost';
import {
  AgentProvider,
  CompileInput,
  CompileResult,
  RepairContext,
  RepairResult,
  compileUserPrompt,
  repairDecision,
  repairUserPrompt,
} from './provider';
import { GRAMMAR, REPAIR_GRAMMAR } from './grammar';
import { toStrictSchema } from './openai';
import { runText, TextResult } from '../exec';

// The CLI-agent provider: instead of an HTTP API + API key, drive an already-authenticated
// coding-agent CLI (codex / cursor-agent / claude) as a one-shot text->JSON transformer. This
// lets a user compile/repair `vk ai` tests off their existing ChatGPT/Cursor/Claude SUBSCRIPTION
// — the CLI carries its own login, so verikun needs no key (just the binary on PATH). A sibling
// to claude.ts/openai.ts behind the same AgentProvider seam; like openai.ts is one class
// parameterized by baseUrl, this is one class parameterized by a CliAgentSpec per binary.
//
// Structured output: these CLIs are not HTTP endpoints, so there is no output_config /
// response_format. codex and claude enforce a schema natively (--output-schema / --json-schema);
// a CLI without one gets the schema injected into the prompt. Either way parsePlan/validateNode
// (engine.ts) stays the execution trust boundary — ir.ts documents this exact "parse path when
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
export type RunImpl = (
  cmd: string,
  args: string[],
  opts: { input?: string; timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => TextResult;

/** The per-binary configuration that turns this one class into a codex, cursor or claude provider. */
export interface CliAgentSpec {
  /** Internal backend id (matches a cost.ts ProviderId). */
  id: ProviderId;
  /** Executable name resolved on PATH. */
  bin: string;
  /** How the JSON schema reaches the model: a temp file the CLI reads (codex --output-schema),
   *  the schema TEXT handed to buildArgs as an argv value (claude --json-schema), or injected
   *  into the prompt text (a CLI with no native schema flag). */
  schema: 'file' | 'inline' | 'prompt';
  /** Adapt the shared ir.ts schema to the CLI's schema dialect before it is written/injected.
   *  codex's backend is OpenAI's strict Structured Outputs, which rejects a schema whose
   *  `required` omits any property (it 400s with invalid_json_schema on our optional
   *  package/platform) — so codex points this at toStrictSchema. Omit for a vanilla dialect. */
  encodeSchema?: (schema: unknown) => unknown;
  /** Read the final message from an --output-last-message temp file (deterministic, independent
   *  of any stdout decoration) instead of parsing stdout. codex sets this; a CLI whose only
   *  output is stdout leaves it false and relies on rawText. */
  usesOutputFile: boolean;
  /** Send the prompt on stdin instead of in argv (buildArgs then leaves it out). For a CLI with a
   *  variadic flag, where a trailing positional prompt would be swallowed as one more value. */
  promptViaStdin?: boolean;
  /** Environment variables the child must NOT inherit. For a CLI that prefers an API credential
   *  in its environment over its own login: inherited, the call is billed per token to that
   *  credential while this provider reports $0. */
  dropEnv?: string[];
  /** Build the argv for one non-interactive call. `cwd` is the neutral temp dir the CLI is run
   *  in; `schemaFile` is set only when schema==='file', `schemaText` only when schema==='inline';
   *  `outFile` only when usesOutputFile; `model` is an optional sub-model. */
  buildArgs(
    prompt: string,
    ctx: { schemaFile?: string; schemaText?: string; outFile?: string; cwd: string; model?: string },
  ): string[];
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

/** cursor-agent (Cursor CLI): non-interactive `--print` with a JSON envelope on stdout. Unlike
 *  codex it has NO schema flag of any kind, so the schema is injected into the prompt and
 *  extractJson/parsePlan do the rest. Two flags are load-bearing beyond the obvious ones:
 *  `--trust`, without which a headless call dies at a "Workspace Trust Required" gate and exits 1
 *  before the model ever runs; and `--mode ask`, cursor's documented read-only Q&A mode, which
 *  stands in for codex's `--sandbox read-only` (cursor's own `--sandbox` only takes enabled/
 *  disabled). Plain `--print` "has access to all tools, including write and shell", so `--mode ask`
 *  plus the neutral `--workspace` are what keep this a pure transform — and we deliberately never
 *  pass --force/--yolo/--approve-mcps. */
export const CURSOR_SPEC: CliAgentSpec = {
  id: 'cursor',
  bin: 'cursor-agent',
  schema: 'prompt', // no native schema flag — schemaInstruction() injects it into the prompt
  usesOutputFile: false, // stdout is the only channel out; no --output-last-message equivalent
  buildArgs(prompt, { cwd, model }) {
    const args = [
      '--print', // non-interactive one-shot
      '--output-format', 'json', // a stable envelope instead of TTY-decorated text
      '--mode', 'ask', // read-only Q&A mode: no edits, no shell
      '--workspace', cwd, // root the agent in a neutral temp dir, not the verikun working tree
      '--trust', // required: else headless stops at the workspace-trust prompt
    ];
    if (model) args.push('--model', model);
    args.push(prompt); // prompt is the trailing positional
    return args;
  },
  rawText: cursorResultText,
  loginHint: 'run `cursor-agent login` to sign in with your Cursor subscription (no API key needed)',
};

/** claude (Claude Code CLI): non-interactive `-p` with NATIVE JSON-schema output and a JSON
 *  envelope on stdout. Four things differ from the other two, all measured on 2.1.284:
 *  - `--json-schema` takes the schema TEXT, not a path — hence schema:'inline'.
 *  - `--tools` is variadic, so a trailing positional prompt would be read as a tool name — hence
 *    promptViaStdin.
 *  - `--safe-mode`, not `--bare`, is what keeps the user's CLAUDE.md, hooks, skills, plugins and
 *    MCP servers out of a pure transform: `--bare` also stops reading OAuth/keychain, so it would
 *    demand ANTHROPIC_API_KEY — the one thing this backend exists to do without.
 *  - an exported ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN OUTRANKS the login (`claude auth status`
 *    flips from `claude.ai` to `api_key` / `oauth_token`; a dummy key gets a 401 beside a working
 *    subscription) — and the first is what vk's own default model has every user export.
 *    Inherited, each compile and repair is billed per token to that key while vk reports $0 and
 *    --max-cost-usd stays inert, and a stale one retries for ~181s, past the per-call cap —
 *    hence dropEnv.
 *  `--tools ""` stands in for codex's `--sandbox read-only`; structured output still works without
 *  tools. A nested call (CLAUDECODE=1, i.e. `vk` driven from inside Claude Code) runs normally. */
export const CLAUDE_SPEC: CliAgentSpec = {
  id: 'claude',
  bin: 'claude',
  schema: 'inline', // --json-schema '<text>'; the plain ir.ts dialect, as claude.ts sends over HTTP
  usesOutputFile: false, // stdout's envelope is the only channel out
  promptViaStdin: true, // a positional prompt after `--tools ""` would be swallowed as a tool name
  dropEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], // either one would be used instead of the login
  buildArgs(_prompt, { schemaText, model }) {
    const args = [
      '-p', // non-interactive one-shot; the prompt arrives on stdin
      '--output-format', 'json', // a stable envelope instead of plain text
      '--safe-mode', // no CLAUDE.md/hooks/skills/plugins/MCP, while the user's login still works
      '--tools', '', // hard backstop: no tool can run
      '--no-session-persistence', // stateless transform, like codex's --ephemeral
    ];
    if (schemaText) args.push('--json-schema', schemaText); // constrain the final message to the schema
    if (model) args.push('--model', model);
    return args;
  },
  rawText: claudeResultText,
  loginHint: 'run `claude auth login` to sign in with your Claude subscription (no API key needed)',
};

/** Peel the model's final message out of cursor-agent's `--output-format json` envelope:
 *  `{type:"result", subtype:"success", is_error:false, result:"<final text>", …}`. */
export function cursorResultText(stdout: string): string {
  const envelope = resultEnvelope(stdout, 'cursor-agent');
  // Only peel when this really IS the envelope. Parsing alone isn't enough: if cursor ever returns
  // the plan object bare (or renames the field), treating any JSON object as an envelope would
  // blank it to '' and report "returned an empty response" — so anything without a string
  // `result` falls through to the raw stdout, where extractJson can still find the object.
  return typeof envelope?.result === 'string' ? envelope.result : stdout;
}

/** Peel the plan out of claude's `--output-format json` envelope. With --json-schema it carries
 *  the object twice — parsed in `structured_output` and serialized in `result` — so prefer the one
 *  claude validated, and fall back to `result` (then raw stdout) exactly as cursor does. */
export function claudeResultText(stdout: string): string {
  const envelope = resultEnvelope(stdout, 'claude');
  const structured = envelope?.structured_output;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) return JSON.stringify(structured);
  return typeof envelope?.result === 'string' ? envelope.result : stdout;
}

/** Parse a `{type:"result", is_error, result, …}` envelope (cursor-agent and claude share the
 *  shape), or undefined when stdout is not a JSON object. Two things a plain `JSON.parse(s).result`
 *  would get wrong:
 *  - the CLI can report failure via `is_error:true` (a turn limit, an unknown model, a usage limit)
 *    with the reason in `result`. Left alone, that prose would flow into extractJson and surface as
 *    a misleading "did not return parseable JSON", so map it to the same exit 3 a non-zero exit gets.
 *    claude's error SUBTYPES (structured-output retries exhausted, an error during execution) carry
 *    no `result` at all: their reason is in `errors` (read from the 2.1.284 binary's own result
 *    schema — not yet seen live).
 *  - an envelope shape drift (or a future default of --output-format text) falls back to the raw
 *    stdout, so extractJson's tolerant scan still gets a chance instead of failing outright. */
function resultEnvelope(stdout: string, bin: string): Record<string, unknown> | undefined {
  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) envelope = parsed as Record<string, unknown>;
  } catch {
    /* not JSON at all (e.g. --output-format text) — fall through to the raw stdout */
  }
  if (envelope?.is_error === true) {
    const errors = Array.isArray(envelope.errors) ? envelope.errors.filter((e) => typeof e === 'string') : [];
    const detail = tail(typeof envelope.result === 'string' ? envelope.result : errors.join('; '));
    throw new CliError(`\`${bin}\` reported an error: ${detail || '(no detail)'}`, 3);
  }
  return envelope;
}

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
  /** Injectable environment a spec's dropEnv is applied to, for unit tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
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
    const json = this.call(GRAMMAR, compileUserPrompt(input), PLAN_JSON_SCHEMA);
    // usage:{} — a CLI is billed to the user's subscription, not per token, so cost is $0
    // (documented no-op for --max-cost-usd). The run is still bounded by maxRepairs + --timeout.
    return { plan: parsePlan(json), usage: {} };
  }

  async repair(ctx: RepairContext): Promise<RepairResult> {
    // usage:{} for the same reason as compile — billed to the subscription, not per token.
    return repairDecision(this.call(REPAIR_GRAMMAR, repairUserPrompt(ctx), REPAIR_DECISION_JSON_SCHEMA), {});
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
    let schemaText: string | undefined;
    let outFile: string | undefined;
    try {
      if (spec.schema !== 'prompt') {
        const encoded = JSON.stringify(spec.encodeSchema ? spec.encodeSchema(schema) : schema);
        if (spec.schema === 'file') schemaFile = this.writeTemp('schema', '.json', encoded);
        else schemaText = encoded;
      }
      if (spec.usesOutputFile) outFile = this.tempPath('out', '.txt'); // path only; the CLI writes it
      const args = spec.buildArgs(prompt, { schemaFile, schemaText, outFile, cwd: this.baseTmp, model: this.opts.model });
      const runOpts = {
        timeout: this.timeoutMs,
        cwd: this.baseTmp,
        ...(spec.promptViaStdin ? { input: prompt } : {}),
        ...(spec.dropEnv ? { env: withoutEnv(this.opts.env ?? process.env, spec.dropEnv) } : {}),
      };
      // runText throws CliError(exit 3) for ENOENT / timeout / spawn failure — let it propagate.
      const res = this.run(spec.bin, args, runOpts);
      if (res.code !== 0) {
        // An envelope CLI exits non-zero WITH the reason in its stdout envelope (claude: an unknown
        // model, a usage limit) while stderr holds at most a terse tag — rawText throws that reason.
        spec.rawText(res.stdout);
        // Otherwise lead with the CLI's own stderr — it carries the real reason (usage limit, auth,
        // a bad flag). Only fall back to the login hint when stderr said nothing, so we don't
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

/** `env` minus `names` — the environment a spec's dropEnv hands its child. A copy: process.env
 *  itself is never mutated. */
function withoutEnv(env: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const name of names) delete kept[name];
  return kept;
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
