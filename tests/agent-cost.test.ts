import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseCostOverride,
  estimateCostUsd,
  CostTracker,
  resolveModel,
  priceFor,
  providerFor,
  MODEL_PRICES,
  ALLOWED_MODELS,
  DEFAULT_MODEL,
} from '../src/agent/cost';
import { CliError } from '../src/errors';

test('providerFor: routes known models to their backend, unknown falls back to anthropic', () => {
  assert.equal(providerFor('gpt-5.4'), 'openai');
  assert.equal(providerFor('gpt-5.4-mini'), 'openai');
  assert.equal(providerFor('claude-opus-4-8'), 'anthropic');
  assert.equal(providerFor('codex-cli'), 'codex');
  assert.equal(providerFor('nonexistent-model'), 'anthropic');
});

test('codex-cli: allowed, resolves, and is priced $0 (billed to the subscription)', () => {
  assert.ok(ALLOWED_MODELS.includes('codex-cli'));
  assert.equal(resolveModel('codex-cli'), 'codex-cli');
  assert.deepEqual(priceFor('codex-cli'), { input: 0, output: 0 });
  // $0 price ⇒ any usage estimates to $0 ⇒ the budget gate can never trip for a CLI provider.
  const t = new CostTracker(priceFor('codex-cli'), 3);
  t.add({ input_tokens: 9_000_000, output_tokens: 9_000_000 }, 'compile');
  assert.equal(t.usd(), 0);
  assert.equal(t.exceeded(), false);
});

test('registry: every allowed model has a price', () => {
  for (const m of ALLOWED_MODELS) assert.ok(MODEL_PRICES[m], `${m} must be priced`);
});

test('parseCostOverride: parses <input/output>', () => {
  assert.deepEqual(parseCostOverride('3/15'), { input: 3, output: 15 });
  assert.deepEqual(parseCostOverride(' 2.5 / 12.5 '), { input: 2.5, output: 12.5 });
});

test('parseCostOverride: throws CliError(2) on garbage', () => {
  assert.throws(() => parseCostOverride('cheap'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
});

test('estimateCostUsd: prices input + output at the per-1M rate', () => {
  const price = { input: 3, output: 15 };
  // 1M input ($3) + 1M output ($15) = $18
  assert.equal(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, price), 18);
});

test('estimateCostUsd: cache reads are billed at ~0.1x input', () => {
  const price = { input: 3, output: 15 };
  assert.ok(Math.abs(estimateCostUsd({ cache_read_input_tokens: 1_000_000 }, price) - 0.3) < 1e-9);
});

test('estimateCostUsd: cache writes are billed at 1.25x input', () => {
  assert.equal(estimateCostUsd({ cache_creation_input_tokens: 1_000_000 }, { input: 3, output: 15 }), 3 * 1.25);
});

test('resolveModel: default when omitted, known passes, unknown is exit-2', () => {
  assert.equal(resolveModel(undefined), DEFAULT_MODEL);
  assert.equal(resolveModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.throws(() => resolveModel('gpt-5'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
});

test('priceFor: an override wins over the bundled table', () => {
  assert.deepEqual(priceFor('claude-opus-4-8', { input: 1, output: 2 }), { input: 1, output: 2 });
  assert.deepEqual(priceFor('claude-opus-4-8'), MODEL_PRICES['claude-opus-4-8']);
});

test('CostTracker: accumulates spend and the budget gate trips when crossed', () => {
  const t = new CostTracker({ input: 3, output: 15 }, 0.01);
  assert.equal(t.exceeded(), false);
  t.add({ input_tokens: 1_000_000 }, 'compile'); // $3, well over the $0.01 ceiling
  assert.equal(t.exceeded(), true);
  assert.ok(t.usd() >= 3);
  assert.match(t.summaryLine(), /compile=\$/);
  assert.match(t.summaryLine(), /replay=\$0/);
});

test('CostTracker: with no ceiling, exceeded() never trips', () => {
  const t = new CostTracker({ input: 3, output: 15 });
  t.add({ input_tokens: 9_000_000 }, 'repair');
  assert.equal(t.exceeded(), false);
  assert.ok(t.usd() > 0);
});
