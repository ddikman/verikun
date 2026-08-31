// The signature-conflict half of `AdbDriver.install` — the two pure functions the
// automatic replace turns on. Device-free: everything here is string work.
//
// The case that carries the weight is the NEGATIVE one. `blockingPackage` feeds a package
// name straight to `adb uninstall`, so a pattern that is too loose does not merely produce
// a bad message — it removes the wrong app. Every "returns null" test below is that gate,
// not padding.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { blockingPackage, signatureConflictHelp } from '../src/drivers/adb';

// The two wordings adb has used, inside the envelope the driver actually collapses.
const CURRENT =
  "adb: failed to install /tmp/app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: " +
  'Existing package com.example.app signatures do not match newer version; ignoring!]';
const OLDER =
  'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.example.app signatures do not ' +
  'match previously installed version; ignoring!]';

test('blockingPackage: names the package in both adb wordings', () => {
  assert.equal(blockingPackage(CURRENT), 'com.example.app');
  assert.equal(blockingPackage(OLDER), 'com.example.app');
});

test('blockingPackage: an unrelated install failure names nothing', () => {
  for (const out of [
    'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]',
    'Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES]',
    'java.io.IOException: Requested internal only, but not enough space',
    'adb: device offline',
    '',
  ]) {
    assert.equal(blockingPackage(out), null, out);
  }
});

test('blockingPackage: a conflict that names no package returns null, never a guess', () => {
  // Seen when adb's detail is truncated or an OEM reworded it. There is nothing safe to
  // remove here, so install must say so rather than pick something.
  assert.equal(blockingPackage('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]'), null);
  assert.equal(
    blockingPackage('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]'),
    null,
  );
});

test('blockingPackage: what it returns can only ever be a package id', () => {
  // The pattern IS the safety gate — no assertSafeAppId call stands between this and
  // `adb uninstall`, so a shell-metacharacter payload must not survive the match.
  //
  // It does not survive it as a TRUNCATION either, which is the stronger property: the
  // trailing `\s+signatures do not match` has to line up too, so an id with a stray
  // character in it fails the whole match instead of yielding the prefix before it.
  // Refusing to name a package is safe (install reports it and stops); naming the wrong
  // one would uninstall an app nobody asked about.
  for (const hostile of [
    'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.a;rm -rf / signatures do not match newer version]',
    'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.a$(id) signatures do not match newer version]',
  ]) {
    assert.equal(blockingPackage(hostile), null, hostile);
  }
  assert.match(blockingPackage(CURRENT)!, /^[A-Za-z0-9._]+$/);
});

test('signatureConflictHelp: explains the signing key, not adb string soup', () => {
  const msg = signatureConflictHelp('/tmp/app.apk', 'com.example.app', 'retry-failed', CURRENT);
  assert.match(msg, /signed by a different key/);
  assert.match(msg, /will not update a package across signing keys/);
  assert.match(msg, /removed 'com\.example\.app' and installed again/);
  // The remedy has to be in the message: a --server caller has no shell on the host.
  assert.match(msg, /adb uninstall com\.example\.app/);
});

test('signatureConflictHelp: says WHICH half of the replace failed', () => {
  const removeFailed = signatureConflictHelp('/tmp/app.apk', 'com.example.app', 'remove-failed', 'boom');
  assert.match(removeFailed, /could not remove 'com\.example\.app'/);
  assert.doesNotMatch(removeFailed, /installed again/, 'it never got that far');

  const notNamed = signatureConflictHelp('/tmp/app.apk', null, 'not-named', CURRENT);
  assert.match(notNamed, /did not name the installed package/);
  // With no package known, the remedy is still actionable, just parameterised.
  assert.match(notNamed, /adb uninstall <package>/);
});
