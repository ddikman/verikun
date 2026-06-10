import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseArgs, flagStr, flagBool, flagNum } from '../src/args';
import { CliError } from '../src/errors';

test('parseArgs: first positional becomes the command', () => {
  const { command, positionals } = parseArgs(['tap', '@login', 'extra']);
  assert.equal(command, 'tap');
  assert.deepEqual(positionals, ['@login', 'extra']);
});

test('parseArgs: no args yields undefined command and empty positionals', () => {
  const r = parseArgs([]);
  assert.equal(r.command, undefined);
  assert.deepEqual(r.positionals, []);
  assert.deepEqual(r.flags, {});
});

test('parseArgs: a value flag consumes the following token', () => {
  const { flags } = parseArgs(['ui', '--device', 'emulator-5554']);
  assert.equal(flags.device, 'emulator-5554');
});

test('parseArgs: --flag=value form keeps the inline value', () => {
  const { flags } = parseArgs(['find', '--index=3']);
  assert.equal(flags.index, '3');
});

test('parseArgs: boolean flags never consume the next token', () => {
  const { positionals, flags } = parseArgs(['ui', '--json', 'tail']);
  assert.equal(flags.json, true);
  assert.deepEqual(positionals, ['tail']);
});

test('parseArgs: a flag followed by another flag is boolean true', () => {
  const { flags } = parseArgs(['x', '--foo', '--bar']);
  assert.equal(flags.foo, true);
  assert.equal(flags.bar, true);
});

test('parseArgs: a trailing non-boolean flag with no value is boolean true', () => {
  const { flags } = parseArgs(['x', '--device']);
  assert.equal(flags.device, true);
});

test('parseArgs: short aliases expand to long names', () => {
  const { flags } = parseArgs(['find', '-d', 'serial', '-i', '2', '-j']);
  assert.equal(flags.device, 'serial');
  assert.equal(flags.index, '2');
  assert.equal(flags.json, true); // -j is a boolean alias
});

test('parseArgs: "--" sends the rest to positionals even if they start with "-"', () => {
  const { command, positionals } = parseArgs(['type', '--', '--weird', '-text']);
  assert.equal(command, 'type');
  assert.deepEqual(positionals, ['--weird', '-text']);
});

test('parseArgs: a lone "-" is a positional, not a flag', () => {
  const { command, positionals } = parseArgs(['cat', '-']);
  assert.equal(command, 'cat');
  assert.deepEqual(positionals, ['-']);
});

test('parseArgs: a value starting with "-" is not consumed (becomes boolean)', () => {
  // Documented quirk: --distance does not swallow "-5"; -5 looks like a flag.
  const { flags } = parseArgs(['swipe', '--distance', '-5']);
  assert.equal(flags.distance, true);
  assert.equal(flags['5'], true);
});

test('flagStr: returns the string value or undefined for booleans/absent', () => {
  assert.equal(flagStr({ device: 'x' }, 'device'), 'x');
  assert.equal(flagStr({ json: true }, 'json'), undefined);
  assert.equal(flagStr({}, 'device'), undefined);
});

test('flagBool: true for boolean true and the string "true"', () => {
  assert.equal(flagBool({ json: true }, 'json'), true);
  assert.equal(flagBool({ json: 'true' }, 'json'), true);
  assert.equal(flagBool({ json: 'false' }, 'json'), false);
  assert.equal(flagBool({}, 'json'), false);
});

test('flagNum: parses numbers, returns undefined when absent', () => {
  assert.equal(flagNum({ index: '3' }, 'index'), 3);
  assert.equal(flagNum({ index: '2.5' }, 'index'), 2.5);
  assert.equal(flagNum({}, 'index'), undefined);
});

test('flagNum: throws CliError(2) on a non-numeric value', () => {
  assert.throws(
    () => flagNum({ index: 'abc' }, 'index'),
    (e: unknown) => e instanceof CliError && e.exitCode === 2,
  );
});
