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

  // Issue #42: `tap` pressed an element's recorded centre even when that point was
  // not on the element — hitting whatever was actually there, and reporting success.
  // Every row here is a button that records ITS OWN id, so "the tap landed somewhere
  // else" is an assertion rather than a screenshot argument.
  describe('auto scroll-into-view', () => {
    const result = (): string | undefined => {
      const el = byId(ui(), 'vk_scroll_result');
      return isAndroid ? el?.desc : el?.text;
    };

    /** The row whose own centre falls inside the sticky bar — the reproduction.
     *  Which row that is depends on screen size, so it is found, not hard-coded. */
    const rowUnderTheBar = (): { id: string; centre: string } | null => {
      const els = ui();
      const decoy = byId(els, 'vk_scroll_decoy');
      if (!decoy) return null;
      const b = decoy.bounds;
      const hit = els.find(
        (e) =>
          /vk_scroll_row_\d+$/.test(e.id ?? '') &&
          e.center.y >= b.y1 &&
          e.center.y < b.y2 &&
          e.center.x >= b.x1 &&
          e.center.x < b.x2,
      );
      return hit ? { id: hit.id!.replace(/^.*\//, ''), centre: `${hit.center.x},${hit.center.y}` } : null;
    };

    before(() => openScreen('scroll'));

    test('a row under the sticky bar is tapped on the ROW, not on the bar', () => {
      openScreen('scroll');
      assert.equal(result(), 'none', 'fixture did not start clean');
      const row = rowUnderTheBar();
      assert.ok(row, 'no row centre falls inside the decoy bar — the fixture layout changed');

      // First: prove the bug is still reproducible on this device by pressing the
      // raw coordinate the old code would have used. It must hit the bar.
      assert.equal(vk(['tap', '--at', row.centre]).code, 0);
      assert.equal(result(), 'decoy', `tapping ${row.centre} did not reach the bar — layout changed?`);

      // Now the real thing: the same row by selector must reach the row itself.
      openScreen('scroll');
      const tapped = vk(['tap', `@${row.id}`]);
      assert.equal(tapped.code, 0, `${tapped.stdout}${tapped.stderr}`);
      assert.match(tapped.stdout, /scrolled into view/, 'the covered row should have been scrolled clear');
      assert.equal(result(), row.id.replace('vk_scroll_', ''), 'the tap landed on something else');
    });

    test('an already-clear element is tapped with no scrolling at all', () => {
      openScreen('scroll');
      const tapped = vk(['tap', '@vk_scroll_row_1']);
      assert.equal(tapped.code, 0, tapped.stderr);
      assert.ok(!tapped.stdout.includes('scrolled into view'), 'scrolled for an element already in the clear');
      assert.equal(result(), 'row_1');
    });

    test('a row the platform never reports is an honest not-found, never a wrong tap', () => {
      // MEASURED on API 32 and 34: Android's dumper drops a node it considers
      // invisible, so a row 30 screens down is not in the hierarchy at all — there is
      // nothing to match and nothing to scroll to. vk says so and exits 1 rather than
      // pressing coordinates; the false-green shape of #42 cannot occur here.
      openScreen('scroll');
      const tapped = vk(['tap', '@vk_scroll_target', '--wait', '2s']);
      assert.equal(tapped.code, 1, 'a target that is not in the tree must not report success');
      assert.equal(result(), 'none', 'something was tapped anyway');
    });

    test('--no-scroll refuses rather than tapping a target it cannot reach', () => {
      openScreen('scroll');
      const row = rowUnderTheBar();
      assert.ok(row);
      const tapped = vk(['tap', `@${row.id}`, '--no-scroll']);
      // Not scrolled, so the press falls back to a point clear of the bar where one
      // exists — what must NOT happen is the bar firing.
      assert.notEqual(result(), 'decoy', 'a refused-to-scroll tap still hit the bar');
      if (tapped.code !== 0) assert.match(tapped.stderr, /scrolled out of view|covered/);
    });

    test('a lazy list can only be scrolled to what it has actually built', () => {
      // `ListView.builder` never builds the far row, so no amount of scrolling can
      // resolve a selector for it. A plain not-found — never a wrong tap.
      openScreen('scroll');
      assert.equal(vk(['tap', '@vk_scroll_mode']).code, 0);
      assert.equal(byId(ui(), 'vk_scroll_target'), undefined, 'the lazy list built the far row after all');
      assert.equal(vk(['tap', '@vk_scroll_target', '--wait', '2s']).code, 1);
      assert.equal(result(), 'none');
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
