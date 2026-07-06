import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseCostOverride,
  estimateCostUsd,
  CostTracker,
  resolveModel,
  priceFor,
  MODEL_PRICES,
  DEFAULT_MODEL,
} from '../src/agent/cost';
import { CliError } from '../src/errors';

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
