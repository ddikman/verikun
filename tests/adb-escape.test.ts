import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { escapeText } from '../src/drivers/adb';

// escapeText prepares a string for `adb shell input text`: spaces become the
// literal token %s, and characters the on-device shell would interpret are
// backslash-escaped. This is the device-side injection boundary, so it is worth
// pinning down precisely.

test('escapeText: spaces become %s', () => {
  assert.equal(escapeText('hello world'), 'hello%sworld');
  assert.equal(escapeText('a b c'), 'a%sb%sc');
});

test('escapeText: plain text passes through unchanged', () => {
  assert.equal(escapeText('me@example.com'), 'me@example.com');
});

test('escapeText: shell metacharacters are backslash-escaped', () => {
  assert.equal(escapeText('a&b'), 'a\\&b');
  assert.equal(escapeText("it's"), "it\\'s");
  assert.equal(escapeText('a$b|c;d'), 'a\\$b\\|c\\;d');
  assert.equal(escapeText('(x)'), '\\(x\\)');
});

test('escapeText: a literal backslash is escaped', () => {
  assert.equal(escapeText('a\\b'), 'a\\\\b');
});

test('escapeText: spaces and metacharacters combine', () => {
  // "a b&c" -> space to %s, then & escaped.
  assert.equal(escapeText('a b&c'), 'a%sb\\&c');
});

test('escapeText: an empty string stays empty', () => {
  assert.equal(escapeText(''), '');
});
