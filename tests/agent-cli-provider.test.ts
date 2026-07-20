import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CliProvider,
  CliAgentSpec,
  CODEX_SPEC,
  RunImpl,
  extractJson,
  schemaInstruction,
} from '../src/agent/cli-provider';
import { PLAN_JSON_SCHEMA } from '../src/agent/ir';
import { CliError } from '../src/errors';

// Same idea as agent-openai.test.ts: inject a fake spawn (no real binary, no device) and assert
// the argv SHAPE, the JSON extraction, the give_up/repair decode, the error mapping, and that the
// temp schema file is always cleaned up. A real tmp dir is used so writeSchemaTemp/unlink run for real.

interface Captured {
  bin?: string;
  args?: string[];
  opts?: { input?: string; timeout?: number; cwd?: string };
}

function fakeRun(result: { code?: number; stdout?: string; stderr?: string }, captured?: Captured): RunImpl {
  return (bin, args, opts) => {
    if (captured) {
      captured.bin = bin;
      captured.args = args;
      captured.opts = opts;
    }
    return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

/** The value following `flag` in an argv (e.g. argVal(args, '--output-schema')). */
function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function withTmp(fn: (dir: string) => unknown): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vk-cli-test-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PLAN_JSON = JSON.stringify({
  version: 1,
  steps: [{ type: 'command', command: 'tap', positionals: ['@login'], flags: [] }],
});

const FAILED_STEP = { type: 'command' as const, command: 'tap', positionals: ['@login'], flags: [] };

test('compile (codex): builds a read-only exec argv, parses the plan, reports $0 usage', () => {
  return withTmp((dir) => {
    const captured: Captured = {};
    const provider = new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl: fakeRun({ stdout: PLAN_JSON }, captured) });
    return provider.compile({ nl: 'tap the login button', platform: 'android' }).then(({ plan, usage }) => {
      assert.equal(captured.bin, 'codex');
      const args = captured.args!;
      assert.equal(args[0], 'exec');
      assert.ok(args.includes('--skip-git-repo-check'));
      assert.equal(argVal(args, '--sandbox'), 'read-only'); // hard backstop: the agent can't write
      assert.equal(argVal(args, '--cd'), dir); // rooted in the neutral temp dir, not the repo
      assert.equal(captured.opts!.cwd, dir);
      // native schema enforcement: the shared PLAN schema was written to the file passed to --output-schema
      const schemaFile = argVal(args, '--output-schema')!;
      assert.ok(schemaFile && schemaFile.startsWith(dir));
      // the final message is read back from a deterministic --output-last-message temp file
      assert.ok(argVal(args, '--output-last-message')?.startsWith(dir));
      // the prompt is the trailing positional and carries the anti-agentic preamble + the grammar + the test
      const prompt = args[args.length - 1];
      assert.match(prompt, /pure text-to-JSON transformer/);
      assert.match(prompt, /NATURAL-LANGUAGE TEST/);
      // a generous per-invocation timeout (not runText's 30s default)
      assert.ok((captured.opts!.timeout ?? 0) >= 120_000);

      assert.equal(plan.steps.length, 1);
      assert.deepEqual(usage, {}); // subscription-billed ⇒ no token usage ⇒ $0
      assert.equal(existsSync(schemaFile), false); // temp schema file cleaned up
      assert.deepEqual(readdirSync(dir), []); // nothing left behind in the dir
    });
  });
});

test('compile (codex): the --output-schema file is OpenAI-strict (every property required)', () => {
  return withTmp((dir) => {
    let schemaContent = '';
    const runImpl: RunImpl = (_bin, args) => {
      const sf = argVal(args, '--output-schema');
      if (sf) schemaContent = readFileSync(sf, 'utf8'); // read it before the finally-block unlinks it
      const of = argVal(args, '--output-last-message');
      if (of) writeFileSync(of, PLAN_JSON);
      return { code: 0, stdout: '', stderr: '' };
    };
    return new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl }).compile({ nl: 'x', platform: 'android' }).then(() => {
      const schema = JSON.parse(schemaContent) as { required: string[]; additionalProperties: boolean };
      // Strict Structured Outputs requires every property in `required` — codex's backend 400s
      // with invalid_json_schema otherwise (it rejected our optional `package`/`platform`).
      assert.deepEqual([...schema.required].sort(), ['package', 'platform', 'steps', 'version']);
      assert.equal(schema.additionalProperties, false);
    });
  });
});

test('compile (codex): reads the plan from the --output-last-message file, not stdout', () => {
  return withTmp((dir) => {
    // Simulate codex: write the final message to --output-last-message and print nothing to stdout.
    const runImpl: RunImpl = (_bin, args) => {
      const outFile = argVal(args, '--output-last-message');
      if (outFile) writeFileSync(outFile, PLAN_JSON);
      return { code: 0, stdout: '', stderr: '' };
    };
    const provider = new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl });
    return provider.compile({ nl: 'x', platform: 'android' }).then(({ plan }) => {
      assert.equal(plan.steps.length, 1); // parsed from the message file despite empty stdout
      assert.deepEqual(readdirSync(dir), []); // both the schema file and the message file are cleaned up
    });
  });
});

test('repair (codex): a "repair" decision yields the replacement leaf via the repair grammar', () => {
  return withTmp((dir) => {
    const repair = JSON.stringify({ decision: 'repair', step: { type: 'command', command: 'tap', positionals: ['@ok'], flags: [] } });
    const captured: Captured = {};
    const provider = new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl: fakeRun({ stdout: repair }, captured) });
    return provider.repair({ failedStep: FAILED_STEP, reason: 'selector not found', hierarchy: [] }).then((r) => {
      assert.deepEqual(r.replaceStep, { type: 'command', command: 'tap', positionals: ['@ok'], flags: [] });
      assert.deepEqual(r.usage, {});
      assert.match(args_prompt(captured), /give_up/); // the REPAIR grammar, not the compile grammar
    });
  });
});

test('repair (codex): a "give_up" decision is terminal (null step + decline reason)', () => {
  return withTmp((dir) => {
    const giveUp = JSON.stringify({ decision: 'give_up', reason: 'landed on the wrong screen' });
    const provider = new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl: fakeRun({ stdout: giveUp }) });
    return provider.repair({ failedStep: FAILED_STEP, reason: 'ambiguous', candidates: [], hierarchy: [] }).then((r) => {
      assert.equal(r.replaceStep, null);
      assert.equal(r.declineReason, 'landed on the wrong screen');
    });
  });
});

test('a non-zero CLI exit is an env error (exit 3); stderr is surfaced when present', () => {
  return withTmp((dir) => {
    // stderr carries the real reason (e.g. a usage limit) — it is surfaced verbatim.
    const provider = new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl: fakeRun({ code: 1, stderr: 'ERROR: usage limit reached' }) });
    return assert.rejects(
      () => provider.compile({ nl: 'x', platform: 'android' }),
      (e: unknown) => e instanceof CliError && e.exitCode === 3 && /usage limit reached/.test(e.message),
    );
  });
});

test('a non-zero CLI exit with no stderr falls back to the login hint', () => {
  return withTmp((dir) => {
    const provider = new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl: fakeRun({ code: 1 }) });
    return assert.rejects(
      () => provider.compile({ nl: 'x', platform: 'android' }),
      (e: unknown) => e instanceof CliError && e.exitCode === 3 && /codex login/.test(e.message),
    );
  });
});

test('empty stdout -> CliError exit 1; unparseable stdout -> CliError exit 1', () => {
  return withTmp((dir) => {
    const empty = new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl: fakeRun({ stdout: '   ' }) });
    const junk = new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl: fakeRun({ stdout: 'I could not do that' }) });
    return Promise.all([
      assert.rejects(() => empty.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 1),
      assert.rejects(() => junk.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 1),
    ]);
  });
});

test('the temp schema file is cleaned up even when the CLI call fails', () => {
  return withTmp((dir) => {
    const provider = new CliProvider({ spec: CODEX_SPEC, tmpDir: dir, runImpl: fakeRun({ code: 2, stderr: 'boom' }) });
    return provider
      .compile({ nl: 'x', platform: 'android' })
      .then(() => assert.fail('should have thrown'))
      .catch((e) => {
        assert.ok(e instanceof CliError);
        assert.deepEqual(readdirSync(dir), []); // finally-block cleanup ran despite the throw
      });
  });
});

// A schema:'prompt' spec (the shape the future cursor provider uses): no --output-schema file;
// the schema is injected into the prompt, and rawText peels the model's text out of an envelope.
const ENVELOPE_SPEC: CliAgentSpec = {
  id: 'codex', // any ProviderId; irrelevant for schema:'prompt' (no temp file is written)
  bin: 'fake-agent',
  schema: 'prompt',
  usesOutputFile: false, // this CLI's only output is stdout — read via rawText
  buildArgs: (prompt, { model }) => {
    const a = ['-p', '--output-format', 'json'];
    if (model) a.push('--model', model);
    a.push(prompt);
    return a;
  },
  rawText: (stdout) => (JSON.parse(stdout) as { result: string }).result,
  loginHint: 'log in',
};

test("schema:'prompt' path: injects the schema into the prompt and peels a fenced envelope result", () => {
  return withTmp((dir) => {
    const envelope = JSON.stringify({ result: '```json\n' + PLAN_JSON + '\n```' });
    const captured: Captured = {};
    const provider = new CliProvider({ spec: ENVELOPE_SPEC, tmpDir: dir, runImpl: fakeRun({ stdout: envelope }, captured) });
    return provider.compile({ nl: 'x', platform: 'android' }).then(({ plan }) => {
      assert.equal(plan.steps.length, 1);
      assert.ok(!captured.args!.includes('--output-schema')); // no native schema flag for this path
      assert.match(args_prompt(captured), /JSON Schema/); // schema was injected into the prompt text
      assert.deepEqual(readdirSync(dir), []); // no temp file written for the prompt path
    });
  });
});

test('extractJson: bare, fenced, prose-wrapped, and brace-in-string cases; throws exit 1 on garbage', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here is the plan: {"a":1} — done.'), { a: 1 });
  // a brace/quote inside a string value must not confuse the balanced-object scan
  assert.deepEqual(extractJson('{"t":"a } b { c","n":{"x":1}}'), { t: 'a } b { c', n: { x: 1 } });
  assert.throws(() => extractJson('no json here'), (e: unknown) => e instanceof CliError && e.exitCode === 1);
  assert.throws(() => extractJson('{ not valid }'), (e: unknown) => e instanceof CliError && e.exitCode === 1);
});

test('schemaInstruction: describes the shape and embeds the schema JSON', () => {
  const s = schemaInstruction(PLAN_JSON_SCHEMA);
  assert.match(s, /single JSON object/);
  assert.match(s, /JSON Schema/);
  assert.ok(s.includes(JSON.stringify(PLAN_JSON_SCHEMA)));
});

/** The trailing-positional prompt from a captured argv. */
function args_prompt(captured: Captured): string {
  const args = captured.args!;
  return args[args.length - 1];
}
