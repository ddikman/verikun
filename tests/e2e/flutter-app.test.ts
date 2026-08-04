// Device end-to-end cases against the Flutter fixture in example/flutter-app.
//
// Run with:  VK_E2E_DEVICE=<serial> npm run test:e2e
//            VK_E2E_PLATFORM=ios    npm run test:e2e
//
// These need a real device and the fixture installed; `npm test` compiles them
// but never runs them (see harness.ts).

import { before, describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_ID, byId, isAndroid, openScreen, ui, unavailable, vk } from './harness';

// One probe for the whole file: with no device or no fixture, skip with a
// diagnostic instead of producing a wall of identical failures.
const skip = unavailable();

describe('vk against the Flutter fixture', { skip: skip ?? false }, () => {
  describe('semantics shape', () => {
    before(() => openScreen('login'));

    test('Semantics(identifier:) and the widget flags land on ONE node', () => {
      // The whole fixture rests on this. A bare Semantics(identifier:) emits two
      // sibling nodes — id on one, label/flags on the other — which would make
      // `@vk_submit` and its disabled state describe different elements. The
      // widgets wrap in MergeSemantics to collapse them; this is the regression
      // test for someone removing that.
      const submit = byId(ui(), 'vk_submit');
      assert.ok(submit, 'no @vk_submit node in the hierarchy');
      assert.equal(submit.enabled, false, 'disabled state is not on the @vk_submit node');
      // The label rides the same node too — in `desc` on Android, `text` on iOS.
      const label = isAndroid ? submit.desc : submit.text;
      assert.match(label ?? '', /Sign In/);
    });

    test('a text input is recognisable as one', () => {
      const pass = byId(ui(), 'vk_pass');
      assert.ok(pass);
      // Android: Flutter reports android.widget.EditText, which is what makes
      // isInteresting()'s class regex fire. iOS: idb reports a TextField role.
      assert.match(pass.class, /EditText|TextField/);
    });

    test('obscureText sets the password flag on Android but NOT on iOS', () => {
      const pass = byId(ui(), 'vk_pass');
      assert.ok(pass);
      if (isAndroid) {
        // toJsonShape omits false/empty fields, so the flag is `true` or absent —
        // never `false`. Asserting `=== false` would always fail.
        assert.equal(pass.password, true, 'obscureText should set password=true');
      } else {
        // MEASURED GAP, not an aspiration. ios-parse derives `password` from
        // `type === 'SecureTextField'`, but idb reports a Flutter obscured field
        // as a plain `TextField` — so the flag never sets, and vk's redaction
        // does not fire for Flutter apps on iOS. Pinned here so the day someone
        // fixes it, this test tells them.
        assert.equal(pass.password, undefined, 'iOS still reports a plain TextField');
      }
    });
  });

  describe('selector resolution', () => {
    before(() => openScreen('login'));

    test('@id resolves on both platforms', () => {
      assert.equal(vk(['find', '@vk_submit', '--no-wait']).code, 0);
    });

    test('a label is reachable via text: on both platforms', () => {
      // On Android the label is content-desc and `text:` reaches it only through
      // the text->desc fallback; on iOS it is AXLabel and matches directly. Both
      // paths must work, which is why the fixture tells users to prefer text:
      // over desc: (desc: never falls back).
      const r = vk(['find', 'text:Remember me']);
      assert.equal(r.code, 0, r.stderr);
    });

    test('a missing selector fails fast with --no-wait', () => {
      const r = vk(['find', '@vk_does_not_exist', '--no-wait']);
      assert.equal(r.code, 1);
    });

    test('find --json reports a miss as an empty array, not an error envelope', () => {
      // find RETURNS 1 rather than throwing, so stdout stays a parseable result
      // set. Callers that pipe `find --json` into a parser depend on this.
      const r = vk(['find', '@vk_does_not_exist', '--no-wait', '--json']);
      assert.equal(r.code, 1);
      assert.deepEqual(JSON.parse(r.stdout), []);
    });

    test('a throwing command reports {error, exitCode} as --json', () => {
      // tap THROWS on a miss, and the single catch in run() maps it to the error
      // envelope. Same failure, different shape from find — both are contract.
      const miss = vk(['tap', '@vk_does_not_exist', '--no-wait', '--json']);
      assert.equal(miss.code, 1);
      assert.equal(JSON.parse(miss.stdout).exitCode, 1);

      const usage = vk(['tap', '--json']);
      assert.equal(usage.code, 2, 'a missing selector is a usage error');
      assert.equal(JSON.parse(usage.stdout).exitCode, 2);
    });
  });

  describe('element flags', () => {
    before(() => openScreen('login'));

    test('--enabled hides a disabled control, and stops hiding it once enabled', () => {
      // Submit is disabled until both fields have content.
      assert.equal(vk(['find', '@vk_submit', '--no-wait']).code, 0, 'should be present');
      assert.equal(
        vk(['find', '@vk_submit', '--enabled', '--no-wait']).code,
        1,
        'should be filtered out while disabled',
      );

      vk(['text', '@vk_user', 'someone@example.com']);
      vk(['text', '@vk_pass', 'hunter2']);

      assert.equal(
        vk(['find', '@vk_submit', '--enabled', '--no-wait']).code,
        0,
        'should be visible to --enabled once the form is complete',
      );
    });

    test('a checkbox reports checkable state that flips on tap', () => {
      const before = byId(ui(), 'vk_remember');
      assert.ok(before);
      assert.equal(before.checkable, true);
      // `checked` is the ONE flag toJsonShape emits as an explicit false rather
      // than omitting it (`el.checkable ? el.checked : undefined`) — so an
      // unchecked checkbox is distinguishable from a non-checkable element.
      assert.equal(before.checked, false, 'starts unchecked');

      assert.equal(vk(['tap', '@vk_remember']).code, 0);

      const after = byId(ui(), 'vk_remember');
      assert.ok(after);
      assert.equal(after.checked, true);
    });
  });

  describe('typing', () => {
    before(() => openScreen('login'));

    // Android only. On iOS a field's `text` is its AXLabel ("Username"), not its
    // contents — `text = AXLabel || title || AXValue` and the label wins — so
    // there is no way to read back what was typed, and `--clear` (which is gated
    // on the resolved element's `text`) would delete based on the label's length.
    // Skipping is the honest answer; see the measured-facts table in the app README.
    test('--clear replaces rather than appends to a prefilled field', { skip: !isAndroid }, () => {
      // cmdText only clears when the RESOLVED element reports non-empty `text`.
      // This asserts that a Flutter field's value does surface in `text` — if it
      // ever moves to content-desc, --clear silently degrades to append and this
      // case catches it.
      const before = byId(ui(), 'vk_user');
      assert.ok(before?.text, '@vk_user should start prefilled');
      const original = before.text;

      assert.equal(vk(['text', '@vk_user', '--clear', 'replaced@example.com']).code, 0);

      const after = byId(ui(), 'vk_user')?.text ?? '';
      assert.ok(!after.includes(original), `--clear left the old value behind: ${after}`);
      assert.ok(after.startsWith('replaced@example.com'), `unexpected value: ${after}`);

      // Deliberately a prefix check, not equality. `adb shell input text`
      // intermittently duplicates the final character on this hardware
      // (~1 run in 3 produced "replaced@example.comm"). That is a real vk/Android
      // typing artifact worth chasing separately — but it is NOT what this case
      // is about, and asserting equality here would make the suite flaky for a
      // reason unrelated to --clear's contract.
    });
  });

  describe('auto-wait window', () => {
    before(() => openScreen('async'));

    test('a load inside the default 5s window resolves with no flags', () => {
      assert.equal(vk(['tap', '@vk_delay_1']).code, 0);
      assert.equal(vk(['tap', '@vk_load']).code, 0);
      assert.equal(vk(['assert', '@vk_loaded']).code, 0);
    });

    test('an 8s load times out on the default window but passes with --wait 15s', () => {
      // The headline case: proves the ~5000ms default both FIRES and is
      // overridable. Nothing else on-device pins waitWindowMs.
      assert.equal(vk(['tap', '@vk_delay_8']).code, 0);

      assert.equal(vk(['tap', '@vk_load']).code, 0);
      assert.equal(vk(['assert', '@vk_loaded']).code, 1, 'default window should time out');

      assert.equal(vk(['tap', '@vk_load']).code, 0);
      assert.equal(
        vk(['assert', '@vk_loaded', '--wait', '15s']).code,
        0,
        'an explicit window should cover it',
      );
    });

    test('an animating spinner does not prevent a hierarchy dump', () => {
      // uiautomator needs the window to reach idle, and AdbDriver.dumpXml retries
      // three times before giving up. A CircularProgressIndicator animates
      // continuously, so this is the check that it does not wedge the dump.
      assert.equal(vk(['tap', '@vk_delay_8']).code, 0);
      assert.equal(vk(['tap', '@vk_load']).code, 0);

      const spinner = vk(['find', '@vk_spinner', '--no-wait']);
      assert.equal(spinner.code, 0, `dump failed while animating: ${spinner.stderr}`);

      // …and the spinner really does go away, so assert --gone has a real
      // disappearance to observe rather than an element that was never there.
      assert.equal(vk(['assert', '@vk_spinner', '--gone', '--wait', '15s']).code, 0);
    });
  });

  describe('run recording', () => {
    // Redaction keys off the resolved element's `password` flag, which iOS does
    // not set for a Flutter field (see the semantics case above). Running this on
    // iOS would assert a guarantee vk cannot currently make there.
    test('a password is redacted in the recorded step and never stored', { skip: !isAndroid }, () => {
      // CLAUDE.md calls this property load-bearing, but it is otherwise only
      // unit-tested against synthetic state. This is the end-to-end version.
      const secret = 'hunter2-e2e-secret';

      openScreen('login');
      const typed = vk(['text', '@vk_pass', secret], { record: true });
      assert.equal(typed.code, 0, typed.stderr);

      const archived = vk(['run', 'archive', '--json'], { record: true });
      assert.equal(archived.code, 0, archived.stderr);

      const { archived: runDir } = JSON.parse(archived.stdout) as { archived?: string };
      assert.ok(runDir, `no archived dir in output: ${archived.stdout}`);

      const artifacts = readdirSync(runDir).filter((f) => /\.(json|xml|html)$/.test(f));
      assert.ok(artifacts.length > 0, 'archive produced no report files');

      let sawRedaction = false;
      for (const file of artifacts) {
        const body = readFileSync(join(runDir, file), 'utf8');
        assert.ok(!body.includes(secret), `password leaked into ${file}`);
        if (body.includes('«redacted»')) sawRedaction = true;
      }
      assert.ok(sawRedaction, 'no «redacted» marker recorded for the password step');
    });
  });

  describe('app lifecycle', () => {
    test('launch restarts the app back to the home screen', () => {
      openScreen('login');
      assert.equal(vk(['find', '@vk_login', '--no-wait']).code, 0);

      // Restart-by-default is what makes the stateless fixture a clean reset.
      assert.equal(vk(['launch', APP_ID]).code, 0);
      assert.equal(vk(['assert', '@vk_home', '--wait', '20s']).code, 0);
    });

    test('launch then assert then tap actually navigates', () => {
      // The safe ordering, pinned. `launch` -> `tap` (with no assert between) was
      // measured navigating 0/4 with a text: selector while still exiting 0 — the
      // first dump after launch returns the PREVIOUS screen, so a selector that
      // also matches something there resolves against stale coordinates.
      // See "Measured Flutter facts" 10 and 11 in example/flutter-app/README.md.
      assert.equal(vk(['launch', APP_ID]).code, 0);
      assert.equal(vk(['assert', '@vk_home', '--wait', '20s']).code, 0);
      assert.equal(vk(['tap', '@vk_nav_login']).code, 0);
      assert.equal(
        vk(['assert', '@vk_login', '--wait', '10s']).code,
        0,
        'tap reported success but the app did not navigate',
      );
    });

    test('current reports the fixture as foreground', () => {
      const r = vk(['current']);
      assert.equal(r.code, 0, r.stderr);
      if (!isAndroid) {
        // iOS has no foreground query — IdbDriver.currentApp returns "(unknown)"
        // rather than half-implementing it. That degrade is the contract.
        assert.match(r.stdout, /\(unknown\)/);
        return;
      }
      assert.match(r.stdout, new RegExp(APP_ID));
    });
  });
});
