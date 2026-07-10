import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { OpenAiProvider, mapUsage, toStrictSchema, HttpResponse, FetchImpl } from '../src/agent/openai';
import { PLAN_JSON_SCHEMA, REPAIR_DECISION_JSON_SCHEMA } from '../src/agent/ir';
import { CliError } from '../src/errors';

// The provider is a good pure unit-test target the way engine.ts is: inject a fake fetch
// (no network, no backoff sleeps — the error cases below use non-retried statuses) and
// assert the request SHAPE, the usage mapping, and the response/finish_reason handling.

interface Captured {
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

/** A fake fetch returning `payload` with `status`; records the request into `captured`. */
function fakeFetch(payload: unknown, opts: { status?: number; captured?: Captured } = {}): FetchImpl {
  const status = opts.status ?? 200;
  return async (url, init) => {
    if (opts.captured) {
      opts.captured.url = url;
      opts.captured.headers = init.headers;
      opts.captured.body = JSON.parse(init.body) as Record<string, unknown>;
    }
    const res: HttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
    return res;
  };
}

/** A fake fetch that returns queued responses in order (holds the last), for retry tests.
 *  Each item is either a response ({status,payload}) or a thrown network error. */
function fakeFetchSeq(seq: Array<{ status?: number; payload: unknown } | { throwErr: string }>): FetchImpl {
  let i = 0;
  return async () => {
    const item = seq[Math.min(i++, seq.length - 1)];
    if ('throwErr' in item) throw new Error(item.throwErr);
    const status = item.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => item.payload,
      text: async () => (typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload)),
    };
  };
}

/** A well-formed chat/completions success body wrapping `content`. */
function chatOk(content: string): unknown {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 800 } },
  };
}

const PLAN_JSON = JSON.stringify({
  version: 1,
  steps: [{ type: 'command', command: 'tap', positionals: ['@login'], flags: [] }],
});

const FAILED_STEP = { type: 'command' as const, command: 'tap', positionals: ['@login'], flags: [] };

test('compile: posts a strict json_schema chat request and parses the returned plan', async () => {
  const captured: Captured = {};
  const provider = new OpenAiProvider({
    model: 'gpt-5.4',
    apiKey: 'sk-test',
    effort: 'high',
    fetchImpl: fakeFetch(chatOk(PLAN_JSON), { captured }),
  });
  const { plan, usage } = await provider.compile({ nl: 'tap the login button', platform: 'android' });

  assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal((captured.headers as Record<string, string>).authorization, 'Bearer sk-test');
  assert.equal(captured.body!.model, 'gpt-5.4');
  const rf = captured.body!.response_format as { type: string; json_schema: { strict: boolean; schema: Record<string, unknown> } };
  assert.equal(rf.type, 'json_schema');
  assert.equal(rf.json_schema.strict, true);
  // strict-adapted: additionalProperties:false and every top-level key required.
  assert.equal(rf.json_schema.schema.additionalProperties, false);
  assert.deepEqual([...(rf.json_schema.schema.required as string[])].sort(), ['package', 'platform', 'steps', 'version']);
  assert.equal(captured.body!.reasoning_effort, 'high');
  const messages = captured.body!.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0].role, 'system');
  assert.match(messages[1].content, /NATURAL-LANGUAGE TEST/);

  assert.equal(plan.steps.length, 1);
  // usage mapping: uncached input = prompt(1000) - cached(800); cached billed as cache_read.
  assert.deepEqual(usage, {
    input_tokens: 200,
    output_tokens: 200,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 0,
  });
});

test('effort: xhigh/max clamp to OpenAI high; no effort omits reasoning_effort', async () => {
  const capMax: Captured = {};
  await new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', effort: 'max', fetchImpl: fakeFetch(chatOk(PLAN_JSON), { captured: capMax }) }).compile({ nl: 'x', platform: 'android' });
  assert.equal(capMax.body!.reasoning_effort, 'high');

  const capNone: Captured = {};
  await new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch(chatOk(PLAN_JSON), { captured: capNone }) }).compile({ nl: 'x', platform: 'android' });
  assert.equal('reasoning_effort' in (capNone.body as object), false);
});

test('repair: a "repair" decision yields the replacement leaf via the repair grammar', async () => {
  const repair = JSON.stringify({ decision: 'repair', step: { type: 'command', command: 'tap', positionals: ['@ok'], flags: [] } });
  const captured: Captured = {};
  const provider = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch(chatOk(repair), { captured }) });
  const r = await provider.repair({ failedStep: FAILED_STEP, reason: 'selector not found', hierarchy: [] });

  assert.deepEqual(r.replaceStep, { type: 'command', command: 'tap', positionals: ['@ok'], flags: [] });
  const messages = captured.body!.messages as Array<{ content: string }>;
  assert.match(messages[0].content, /give_up/); // the REPAIR grammar, not the compile grammar
});

test('repair: a "give_up" decision is terminal (null step + decline reason)', async () => {
  const giveUp = JSON.stringify({ decision: 'give_up', reason: 'landed on the wrong screen' });
  const provider = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch(chatOk(giveUp)) });
  const r = await provider.repair({ failedStep: FAILED_STEP, reason: 'ambiguous', candidates: [], hierarchy: [] });
  assert.equal(r.replaceStep, null);
  assert.equal(r.declineReason, 'landed on the wrong screen');
});

test('a truncated response (finish_reason=length) is a CliError exit 1', async () => {
  const payload = { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: {} };
  const provider = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch(payload) });
  await assert.rejects(() => provider.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 1);
});

test('a refusal is a CliError exit 1', async () => {
  const payload = { choices: [{ message: { refusal: 'I cannot help with that' }, finish_reason: 'stop' }] };
  const provider = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch(payload) });
  await assert.rejects(() => provider.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 1);
});

test('HTTP 400 maps to usage error (exit 2); 401 maps to env error (exit 3)', async () => {
  const p400 = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch('bad request', { status: 400 }) });
  await assert.rejects(() => p400.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  const p401 = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch('unauthorized', { status: 401 }) });
  await assert.rejects(() => p401.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 3);
});

test('mapUsage: subtracts cached from prompt; never charges cache-write', () => {
  assert.deepEqual(mapUsage({ prompt_tokens: 500, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 120 } }), {
    input_tokens: 380,
    output_tokens: 100,
    cache_read_input_tokens: 120,
    cache_creation_input_tokens: 0,
  });
  assert.deepEqual(mapUsage(undefined), {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test('toStrictSchema: requires all keys and makes previously-optional fields nullable', () => {
  const strict = toStrictSchema({
    type: 'object',
    required: ['a'],
    properties: {
      a: { type: 'string' },
      b: { type: 'string', enum: ['x', 'y'] },
      c: { type: 'object', required: ['d'], properties: { d: { type: 'string' } } },
    },
  }) as {
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, { type: unknown; enum?: unknown[]; additionalProperties?: boolean }>;
  };
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual([...strict.required].sort(), ['a', 'b', 'c']);
  assert.deepEqual(strict.properties.a.type, 'string'); // was required -> unchanged
  assert.deepEqual(strict.properties.b.type, ['string', 'null']); // optional scalar -> nullable
  assert.deepEqual(strict.properties.b.enum, ['x', 'y', null]); // null added to the enum
  assert.deepEqual(strict.properties.c.type, ['object', 'null']); // optional object -> nullable
  assert.equal(strict.properties.c.additionalProperties, false); // nested object strict-adapted
});

test('toStrictSchema: adapts the real PLAN and REPAIR schemas (nested anyOf + nullable step)', () => {
  const plan = toStrictSchema(PLAN_JSON_SCHEMA) as {
    additionalProperties: boolean;
    required: string[];
    properties: { platform: { type: unknown }; steps: { items: { anyOf: Array<{ additionalProperties: boolean; required: string[] }> } } };
  };
  assert.equal(plan.additionalProperties, false);
  assert.deepEqual([...plan.required].sort(), ['package', 'platform', 'steps', 'version']);
  assert.deepEqual(plan.properties.platform.type, ['string', 'null']); // optional -> nullable
  // the leaf branch of steps.items.anyOf stays strict (additionalProperties:false, all required)
  const leaf = plan.properties.steps.items.anyOf[0];
  assert.equal(leaf.additionalProperties, false);
  assert.deepEqual([...leaf.required].sort(), ['command', 'flags', 'positionals', 'type']);

  const rep = toStrictSchema(REPAIR_DECISION_JSON_SCHEMA) as {
    required: string[];
    properties: { step: { type: unknown }; reason: { type: unknown } };
  };
  assert.deepEqual([...rep.required].sort(), ['decision', 'reason', 'step']);
  assert.deepEqual(rep.properties.step.type, ['object', 'null']); // optional object -> nullable
  assert.deepEqual(rep.properties.reason.type, ['string', 'null']);
});

test('mapUsage: no prompt_tokens_details -> cached 0, full prompt as input', () => {
  assert.deepEqual(mapUsage({ prompt_tokens: 100, completion_tokens: 20 }), {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test('mapUsage: clamps when cached exceeds prompt (input never negative)', () => {
  const u = mapUsage({ prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } });
  assert.equal(u.input_tokens, 0);
  assert.equal(u.cache_read_input_tokens, 80);
});

test('call: empty content -> CliError exit 1', async () => {
  const payload = { choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: {} };
  const p = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch(payload) });
  await assert.rejects(() => p.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 1);
});

test('call: non-JSON content -> CliError exit 1', async () => {
  const payload = { choices: [{ message: { content: 'not json at all' }, finish_reason: 'stop' }], usage: {} };
  const p = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch(payload) });
  await assert.rejects(() => p.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 1);
});

test('call: content_filter finish_reason -> CliError exit 1', async () => {
  const payload = { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] };
  const p = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl: fakeFetch(payload) });
  await assert.rejects(() => p.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 1);
});

test('call: a 2xx body that is not JSON -> CliError exit 3', async () => {
  const fetchImpl: FetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    text: async () => 'gateway error page',
  });
  const p = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', fetchImpl });
  await assert.rejects(() => p.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 3);
});

test('fetchWithRetry: retries 5xx then succeeds (sleep stubbed)', async () => {
  const p = new OpenAiProvider({
    model: 'gpt-5.4',
    apiKey: 'k',
    maxRetries: 3,
    sleepImpl: async () => {},
    fetchImpl: fakeFetchSeq([
      { status: 500, payload: 'err' },
      { status: 500, payload: 'err' },
      { status: 200, payload: chatOk(PLAN_JSON) },
    ]),
  });
  const { plan } = await p.compile({ nl: 'x', platform: 'android' });
  assert.equal(plan.steps.length, 1);
});

test('fetchWithRetry: a persistent network error surfaces as CliError exit 3', async () => {
  const p = new OpenAiProvider({
    model: 'gpt-5.4',
    apiKey: 'k',
    maxRetries: 2,
    sleepImpl: async () => {},
    fetchImpl: fakeFetchSeq([{ throwErr: 'ECONNRESET' }]),
  });
  await assert.rejects(() => p.compile({ nl: 'x', platform: 'android' }), (e: unknown) => e instanceof CliError && e.exitCode === 3);
});

test('fetchWithRetry: honors Retry-After seconds on 429', async () => {
  const delays: number[] = [];
  let calls = 0;
  const fetchImpl: FetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (n: string) => (n === 'retry-after' ? '2' : null) },
        json: async () => ({}),
        text: async () => '',
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => chatOk(PLAN_JSON), text: async () => '' };
  };
  const p = new OpenAiProvider({ model: 'gpt-5.4', apiKey: 'k', sleepImpl: async (ms) => { delays.push(ms); }, fetchImpl });
  await p.compile({ nl: 'x', platform: 'android' });
  assert.deepEqual(delays, [2000]); // 2s from the Retry-After header, not exponential backoff
});
