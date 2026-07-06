import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parsePlan, validateNode, leafToFlags, InvalidPlanError, KNOWN_COMMANDS, LeafStep } from '../src/agent/ir';

test('parsePlan: a valid plan with command + if-present + repeat round-trips', () => {
  const plan = parsePlan({
    version: 1,
    package: 'com.x',
    platform: 'android',
    steps: [
      { type: 'command', command: 'launch', positionals: ['com.x'], flags: [{ name: 'clear', value: 'true' }] },
      { type: 'if-present', selector: 'text:Allow', body: [{ type: 'command', command: 'tap', positionals: ['text:Allow'], flags: [] }] },
      { type: 'repeat', selector: '@row', cap: 5, body: [{ type: 'command', command: 'swipe', positionals: ['up'], flags: [] }] },
    ],
  });
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0].type, 'command');
  assert.equal(plan.steps[1].type, 'if-present');
  assert.equal(plan.steps[2].type, 'repeat');
});

test('parsePlan: rejects an unsupported version', () => {
  assert.throws(() => parsePlan({ version: 2, steps: [] }), InvalidPlanError);
});

test('parsePlan: rejects an empty plan (zero steps) so it cannot pass green having done nothing', () => {
  assert.throws(() => parsePlan({ version: 1, steps: [] }), InvalidPlanError);
});

test('validateNode: rejects malformed control nodes and unknown types', () => {
  assert.throws(() => validateNode({ type: 'if-present', selector: '', body: [] }, 'x'), InvalidPlanError);
  assert.throws(() => validateNode({ type: 'repeat', selector: 'r', body: {} }, 'x'), InvalidPlanError);
  assert.throws(() => validateNode({ type: 'mystery' }, 'x'), InvalidPlanError);
  assert.throws(
    () => validateNode({ type: 'if-present', selector: 's', body: [{ type: 'command', command: 'tap', positionals: [1], flags: [] }] }, 'x'),
    InvalidPlanError,
  );
});

test('parsePlan: rejects a non-array steps', () => {
  assert.throws(() => parsePlan({ version: 1, steps: {} }), InvalidPlanError);
});

test('validateNode: rejects an unknown command (the hallucination guard)', () => {
  assert.throws(
    () => validateNode({ type: 'command', command: 'frobnicate', positionals: [], flags: [] }, 'x'),
    InvalidPlanError,
  );
});

test('validateNode: rejects a control node nested in a control body (shallow only in v1)', () => {
  assert.throws(
    () => validateNode({ type: 'if-present', selector: 'x', body: [{ type: 'if-present', selector: 'y', body: [] }] }, 'x'),
    InvalidPlanError,
  );
});

test('validateNode: rejects flags that are not {name,value}[]', () => {
  assert.throws(
    () => validateNode({ type: 'command', command: 'tap', positionals: [], flags: { clear: true } }, 'x'),
    InvalidPlanError,
  );
});

test('validateNode: repeat without a positive cap falls back to the default cap', () => {
  const node = validateNode({ type: 'repeat', selector: '@x', cap: 0, body: [] }, 'x');
  assert.equal(node.type, 'repeat');
  if (node.type === 'repeat') assert.ok(node.cap > 0);
});

test('leafToFlags: {name,value}[] becomes a flags record; a boolean stays "true"', () => {
  const leaf: LeafStep = {
    type: 'command',
    command: 'text',
    positionals: ['@email', 'a@b.com'],
    flags: [
      { name: 'clear', value: 'true' },
      { name: 'wait', value: '5s' },
    ],
  };
  assert.deepEqual(leafToFlags(leaf), { clear: 'true', wait: '5s' });
});

test('KNOWN_COMMANDS includes the action + assertion verbs', () => {
  for (const c of ['tap', 'text', 'swipe', 'assert', 'launch']) assert.ok(KNOWN_COMMANDS.has(c));
});

test('KNOWN_COMMANDS excludes inspection/diagnostic commands (agent action set only)', () => {
  // log/logs reach a device shell + host write; find/ui/current are non-recordable
  // selector-resolvers (the markLastStepHealed coupling). None may be agent-emitted.
  for (const c of ['find', 'ui', 'current', 'log', 'logs']) assert.ok(!KNOWN_COMMANDS.has(c));
});
