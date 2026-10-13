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

const tapLeaf = { type: 'command', command: 'tap', positionals: ['@a'], flags: [] };

test('validateNode: accepts a control node nested ONE level (repeat containing a when)', () => {
  // The loop-that-branches shape: "until the flow ends, handle whichever screen is showing".
  const node = validateNode(
    {
      type: 'repeat',
      selector: 'text:Review',
      cap: 20,
      body: [{ type: 'when', branches: [{ selector: '@multi', body: [tapLeaf] }] }],
    },
    'x',
  );
  assert.equal(node.type, 'repeat');
});

test('validateNode: rejects a THIRD level of the BRANCHING nodes (when/repeat)', () => {
  // if-present and while-present are allowed this deep (leaf-only bodies); when and
  // repeat are not — they are the ones whose bodies want to be deep, and allowing them
  // is what would actually blow up the schema.
  assert.throws(
    () =>
      validateNode(
        {
          type: 'repeat',
          selector: 'text:Review',
          cap: 5,
          body: [
            {
              type: 'when',
              branches: [
                { selector: '@a', body: [{ type: 'when', branches: [{ selector: '@b', body: [tapLeaf] }] }] },
              ],
            },
          ],
        },
        'x',
      ),
    InvalidPlanError,
  );
});

test('validateNode: while-present may sit one level deeper than the branching nodes', () => {
  // repeat { when { while-present { tap } } } — a branch that walks an index-addressed
  // list. Without this the model hard-codes _0.._3 and the plan breaks the moment a
  // question has a different number of pairs.
  const node = validateNode(
    {
      type: 'repeat',
      selector: 'text:Review',
      cap: 20,
      body: [
        {
          type: 'when',
          branches: [
            {
              selector: '@pairs',
              body: [{ type: 'while-present', selector: 'id:opt_{{ctx.i}}', bind: 'i', cap: 10, body: [tapLeaf] }],
            },
          ],
        },
      ],
    },
    'x',
  );
  assert.equal(node.type, 'repeat');
});

test('validateNode: the innermost while-present may NOT contain another control node', () => {
  assert.throws(
    () =>
      validateNode(
        {
          type: 'repeat',
          selector: 'text:Review',
          cap: 5,
          body: [
            {
              type: 'when',
              branches: [
                {
                  selector: '@a',
                  body: [
                    {
                      type: 'while-present',
                      selector: '@b',
                      cap: 5,
                      body: [{ type: 'if-present', selector: '@c', body: [tapLeaf] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        'x',
      ),
    InvalidPlanError,
  );
});

test('validateNode: rejects an empty control body (silence must not read as success)', () => {
  assert.throws(() => validateNode({ type: 'if-present', selector: 'x', body: [] }, 'x'), InvalidPlanError);
  assert.throws(() => validateNode({ type: 'repeat', selector: 'x', cap: 3, body: [] }, 'x'), InvalidPlanError);
  assert.throws(() => validateNode({ type: 'while-present', selector: 'x', cap: 3, body: [] }, 'x'), InvalidPlanError);
});

test("validateNode: when's else MAY be empty — the explicit \"do nothing\" opt-in", () => {
  const node = validateNode({ type: 'when', branches: [{ selector: '@a', body: [tapLeaf] }], else: [] }, 'x');
  assert.equal(node.type, 'when');
  if (node.type === 'when') assert.deepEqual(node.else, []);
});

test('validateNode: when with no branches is rejected', () => {
  assert.throws(() => validateNode({ type: 'when', branches: [] }, 'x'), InvalidPlanError);
});

test('validateNode: tolerates null for optional fields (OpenAI strict mode nullifies them)', () => {
  const w = validateNode({ type: 'when', branches: [{ selector: '@a', body: [tapLeaf] }], else: null }, 'x');
  assert.equal(w.type, 'when');
  if (w.type === 'when') assert.equal(w.else, undefined);
  const l = validateNode({ type: 'while-present', selector: '@a', bind: null, cap: 5, body: [tapLeaf] }, 'x');
  assert.equal(l.type, 'while-present');
  if (l.type === 'while-present') assert.equal(l.bind, undefined);
});

test('validateNode: read needs a known field and an identifier-shaped "into"', () => {
  const node = validateNode({ type: 'read', selector: '@answer', field: 'text', into: 'answer' }, 'x');
  assert.equal(node.type, 'read');
  assert.throws(() => validateNode({ type: 'read', selector: '@a', field: 'bounds', into: 'x' }, 'x'), InvalidPlanError);
  assert.throws(() => validateNode({ type: 'read', selector: '@a', field: 'text', into: 'a.b' }, 'x'), InvalidPlanError);
});

test('validateNode: rejects flags that are not {name,value}[]', () => {
  assert.throws(
    () => validateNode({ type: 'command', command: 'tap', positionals: [], flags: { clear: true } }, 'x'),
    InvalidPlanError,
  );
});

test('validateNode: repeat without a positive cap falls back to the default cap', () => {
  // Body is non-empty on purpose: this test is about the CAP fallback, and an empty body
  // is now rejected for its own reasons — keep the two failures from masking each other.
  const node = validateNode({ type: 'repeat', selector: '@x', cap: 0, body: [tapLeaf] }, 'x');
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

test('validateNode: if-present may also sit at the innermost level, inside a when branch', () => {
  // The measured failure: blocked from a conditional here, the model emitted an
  // unconditional `wait` instead, which fails whenever the optional step is skipped.
  const node = validateNode(
    {
      type: 'repeat',
      selector: 'text:Review',
      cap: 20,
      body: [
        {
          type: 'when',
          branches: [
            { selector: '@multi', body: [{ type: 'if-present', selector: '@continue', body: [tapLeaf] }] },
          ],
        },
      ],
    },
    'x',
  );
  assert.equal(node.type, 'repeat');
});

// --- device steps are validated at COMPILE time ---------------------------
//
// Unlike every other command — where a bad selector is a runtime fact the engine can
// heal — a device setting's key and value are knowable statically. Checking them here
// is what makes a suite fail before the first tap rather than twenty steps in, on a
// device it has already half-modified.

const deviceLeaf = (positionals: string[]) => ({ type: 'command', command: 'device', positionals, flags: [] });

test('KNOWN_COMMANDS includes device (the grammar offers it as an action)', () => {
  assert.ok(KNOWN_COMMANDS.has('device'));
});

test('validateNode: accepts well-formed device steps', () => {
  assert.equal(validateNode(deviceLeaf(['set', 'airplane=on']), 'x').type, 'command');
  assert.equal(validateNode(deviceLeaf(['set', 'dark=on', 'font-scale=1.3']), 'x').type, 'command');
  assert.equal(validateNode(deviceLeaf(['reset']), 'x').type, 'command');
  assert.equal(validateNode(deviceLeaf(['get']), 'x').type, 'command');
});

test('validateNode: rejects a hallucinated device setting at plan-validation time', () => {
  assert.throws(() => validateNode(deviceLeaf(['set', 'bogus=1']), 'steps[0]'), InvalidPlanError);
  assert.throws(() => validateNode(deviceLeaf(['reset', 'bogus']), 'steps[0]'), InvalidPlanError);
});

test('validateNode: rejects an out-of-domain device value', () => {
  assert.throws(() => validateNode(deviceLeaf(['set', 'rotation=sideways']), 'steps[0]'), InvalidPlanError);
  assert.throws(() => validateNode(deviceLeaf(['set', 'font-scale=99']), 'steps[0]'), InvalidPlanError);
});

test('validateNode: folds the "device set" one-word spelling back into the canonical shape', () => {
  // Observed from a real compile: `device` is the only verb with a subcommand and every
  // other one is a single word, so the model writes the pair as one command name. That
  // is a spelling of a real command, not a hallucination — normalize rather than fail.
  for (const spelling of ['device set', 'device  set', 'DEVICE SET', 'device-set', 'device_set']) {
    const node = validateNode({ type: 'command', command: spelling, positionals: ['dark=on'], flags: [] }, 'x');
    assert.equal(node.type, 'command');
    assert.equal((node as LeafStep).command, 'device');
    assert.deepEqual((node as LeafStep).positionals, ['set', 'dark=on']);
  }
});

test('validateNode: the normalization does not widen the allowlist', () => {
  // Only real subcommands fold; anything else still hits the unknown-command guard.
  assert.throws(
    () => validateNode({ type: 'command', command: 'device explode', positionals: [], flags: [] }, 'x'),
    InvalidPlanError,
  );
  assert.throws(
    () => validateNode({ type: 'command', command: 'devices', positionals: [], flags: [] }, 'x'),
    InvalidPlanError,
  );
});

test('validateNode: a normalized device step is still value-checked', () => {
  assert.throws(
    () => validateNode({ type: 'command', command: 'device set', positionals: ['bogus=1'], flags: [] }, 'x'),
    InvalidPlanError,
  );
});

test('validateNode: rejects an unknown device subcommand', () => {
  assert.throws(() => validateNode(deviceLeaf(['enable', 'dark=on']), 'steps[0]'), InvalidPlanError);
  assert.throws(() => validateNode(deviceLeaf([]), 'steps[0]'), InvalidPlanError);
});

test('parsePlan: an invalid device step fails the whole plan, not just the step', () => {
  assert.throws(
    () => parsePlan({ version: 1, steps: [deviceLeaf(['set', 'wifi=off'])] }),
    InvalidPlanError,
  );
});

// --- issue #158: what the compile schema admits and the validator used to reject ----------

/** The rejection a call throws — failing the test if it throws anything else, or nothing. */
function rejection(fn: () => unknown): InvalidPlanError {
  try {
    fn();
  } catch (e) {
    if (e instanceof InvalidPlanError) return e;
    throw e;
  }
  return assert.fail('expected an InvalidPlanError');
}

const swipeLeaf = { type: 'command', command: 'swipe', positionals: ['up'], flags: [] };
const loop = { type: 'repeat', selector: 'id:target', cap: 20, body: [swipeLeaf] };
/** What the model wrote in 11 of 20 rejected compiles: the loop spelled as a command, then the loop. */
const echo = { type: 'command', command: 'repeat', positionals: ['id:target'], flags: [{ name: 'cap', value: '20' }] };

test('parsePlan: drops a command leaf that echoes the loop right after it, and says so (#158)', () => {
  const notes: string[] = [];
  const plan = parsePlan({ version: 1, steps: [tapLeaf, echo, loop] }, notes);
  assert.deepEqual(plan.steps.map((s) => s.type), ['command', 'repeat']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /steps\[1\]/);
});

test('parsePlan: the echo is dropped inside a control body too (#158)', () => {
  const guard = { type: 'if-present', selector: '@ok', body: [tapLeaf] };
  const echoGuard = { type: 'command', command: 'if-present', positionals: ['@ok'], flags: [] };
  const plan = parsePlan({
    version: 1,
    steps: [{ type: 'repeat', selector: '@done', cap: 5, body: [{ type: 'when', branches: [{ selector: '@q', body: [echoGuard, guard] }] }] }],
  });
  const outer = plan.steps[0];
  assert.ok(outer.type === 'repeat' && outer.body[0].type === 'when');
  assert.deepEqual(outer.body[0].branches[0].body.map((s) => s.type), ['if-present']);
});

test('parsePlan: an error after a dropped echo still names the RAW index the model wrote (#158)', () => {
  const bad = { type: 'command', command: 'frobnicate', positionals: [], flags: [] };
  assert.match(rejection(() => parsePlan({ version: 1, steps: [echo, loop, bad] })).message, /^steps\[2\]/);
});

test('parsePlan: a control-word leaf that does not echo the node after it is still rejected (#158)', () => {
  const cases: Record<string, unknown[]> = {
    // 8 of 20: the plan STOPS at the stray leaf — the loop and every later step are missing.
    trailing: [echo],
    'after the loop, not before it': [loop, echo],
    'a different selector': [{ ...echo, positionals: ['id:other'] }, loop],
    'followed by a leaf': [echo, tapLeaf],
    // `when` has no selector to match on, so "the same node" cannot be shown.
    'before a when': [
      { type: 'command', command: 'when', positionals: [], flags: [] },
      { type: 'when', branches: [{ selector: '@a', body: [tapLeaf] }] },
    ],
    // `command` is a node type but not a control word; nothing here was written twice.
    'command spelled as a command': [{ type: 'command', command: 'command', positionals: [], flags: [] }, tapLeaf],
  };
  for (const [name, steps] of Object.entries(cases)) {
    assert.throws(() => parsePlan({ version: 1, steps }), InvalidPlanError, name);
  }
});

test('an InvalidPlanError carries the node it rejected, so a failed compile can show it (#158)', () => {
  const err = rejection(() => parsePlan({ version: 1, steps: [tapLeaf, echo] }));
  assert.deepEqual(err.node, echo);
});

test('a body error names the control node that owns the body (#158)', () => {
  const emptyGuard = { type: 'if-present', selector: '@x', body: [] };
  const err = rejection(() => parsePlan({ version: 1, steps: [{ type: 'repeat', selector: '@done', cap: 5, body: [emptyGuard] }] }));
  assert.deepEqual(err.node, emptyGuard);
});

test('validateNode: a when BRANCH may be empty — "this screen is expected, nothing to do" (#158)', () => {
  // The plan the model wrote for "the second panel — do nothing, it clears by itself".
  const plan = parsePlan({
    version: 1,
    steps: [
      {
        type: 'repeat',
        selector: '@ready',
        cap: 20,
        body: [{ type: 'when', branches: [{ selector: '@panel_a', body: [tapLeaf] }, { selector: '@panel_b', body: [] }] }],
      },
    ],
  });
  const outer = plan.steps[0];
  assert.ok(outer.type === 'repeat' && outer.body[0].type === 'when');
  assert.deepEqual(outer.body[0].branches[1].body, []);
});

test('validateNode: a when with only empty branches and no else still checks the screen — kept (#158)', () => {
  // No match and no else FAILS, so this asserts "the screen is one of these" — it does something.
  const node = validateNode({ type: 'when', branches: [{ selector: '@a', body: [] }, { selector: '@b', body: [] }] }, 'x');
  assert.equal(node.type, 'when');
});

test('validateNode: a when that can neither act nor fail is rejected (#158)', () => {
  // Every branch empty AND an empty else: no screen makes it do anything, and none makes it fail.
  assert.throws(() => validateNode({ type: 'when', branches: [{ selector: '@a', body: [] }], else: [] }, 'x'), InvalidPlanError);
});
