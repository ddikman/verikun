// Device end-to-end cases against the Flutter fixture in example/flutter-app.
//
// Run with:  VK_E2E_DEVICE=<serial>     npm run test:e2e
//            VK_E2E_PLATFORM=ios        npm run test:e2e
//            VK_E2E_AI_MODEL=codex-cli  npm run test:e2e   (opt in to the `vk ai` case)
//
// These need a real device and the fixture installed; `npm test` compiles them
// but never runs them (see harness.ts). Every case here is model-free except the
// `vk ai` one, which is why that one is behind its own env var.

import { after, before, describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { APP_ID, byId, isAndroid, labelField, openScreen, ui, unavailable, vk } from './harness';
import type { RunState } from '../../src/run';

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

  describe('state modifiers', () => {
    // `selected` and `focused` do not exist on iOS: idb emits no such key, so vk refuses
    // the modifier (exit 3) rather than letting it match nothing forever. See measured
    // fact 14 in example/flutter-app/README.md.
    describe('selected', { skip: !isAndroid }, () => {
      before(() => openScreen('state'));

      test('--selected and --not-selected split the two options of a picker', () => {
        // Both are the same widget with the same label shape; the flag is the only
        // difference, so this is the narrowest possible check that it survives the dump.
        assert.equal(vk(['find', '@vk_mode_video', '--selected', '--no-wait']).code, 0);
        assert.equal(vk(['find', '@vk_mode_video', '--not-selected', '--no-wait']).code, 1);
        assert.equal(vk(['find', '@vk_mode_photo', '--not-selected', '--no-wait']).code, 0);
        assert.equal(vk(['find', '@vk_mode_photo', '--selected', '--no-wait']).code, 1);
      });

      test('the modifier works appended to the selector STRING, as a guard carries it', () => {
        // A control node holds a bare `selector: string` with nowhere to put a flag, so
        // this form is the only way an if-present guard can pin state. Same answers.
        assert.equal(vk(['find', '@vk_mode_video --selected', '--no-wait']).code, 0);
        assert.equal(vk(['find', '@vk_mode_video --not-selected', '--no-wait']).code, 1);
      });

      test('an unguarded tap on a shared-handler toggle passes while flipping the mode', () => {
        // The regression this whole modifier exists for. Both options call one handler,
        // so "make sure we are on video" as a plain tap lands on PHOTO whenever video was
        // already selected — exit 0, no heal, nothing to notice. A false green.
        openScreen('state');
        assert.equal(vk(['assert', '@vk_mode_status', '--text', 'Mode: video']).code, 0);

        const tapped = vk(['tap', '@vk_mode_video']);
        assert.equal(tapped.code, 0, 'the tap itself succeeds — that is the problem');
        assert.equal(
          vk(['assert', '@vk_mode_status', '--text', 'Mode: photo']).code,
          0,
          'an unguarded tap should have flipped the mode',
        );
      });

      test('the guard makes an already-correct state a no-op, and is idempotent', () => {
        // The fix, run twice: the guard misses, the tap is skipped, the mode holds. Two
        // passes matter — a guard that only worked once would still flip on a rerun.
        openScreen('state');
        for (const pass of [1, 2]) {
          const guard = vk(['find', '@vk_mode_video --not-selected', '--no-wait']);
          assert.equal(guard.code, 1, `pass ${pass}: guard should not match`);
          assert.equal(
            vk(['assert', '@vk_mode_status', '--text', 'Mode: video']).code,
            0,
            `pass ${pass}: mode drifted`,
          );
        }
      });

      test('the guard DOES fire when the option is not already selected', () => {
        // The other half: a guard that never matches would pass the test above for the
        // wrong reason, so prove it opens when it should and lands on the right mode.
        openScreen('state');
        assert.equal(vk(['tap', '@vk_mode_photo']).code, 0); // now Mode: photo
        assert.equal(vk(['assert', '@vk_mode_status', '--text', 'Mode: photo']).code, 0);

        assert.equal(vk(['find', '@vk_mode_video --not-selected', '--no-wait']).code, 0);
        assert.equal(vk(['tap', '@vk_mode_video']).code, 0);
        assert.equal(vk(['assert', '@vk_mode_status', '--text', 'Mode: video']).code, 0);
      });
    });

    describe('focused', { skip: !isAndroid }, () => {
      before(() => openScreen('state'));

      test('--focused follows real input focus, not a hard-coded flag', () => {
        assert.equal(
          vk(['find', '@vk_focus_field', '--focused', '--no-wait']).code,
          1,
          'nothing is focused before the field is tapped',
        );
        assert.equal(vk(['tap', '@vk_focus_field']).code, 0);
        assert.equal(vk(['find', '@vk_focus_field', '--focused', '--no-wait']).code, 0);
        assert.equal(vk(['find', '@vk_mode_video', '--focused', '--no-wait']).code, 1);
      });
    });

    describe('checked', () => {
      before(() => openScreen('login'));

      test('--checked and --not-checked track the checkbox on both platforms', () => {
        // Unlike selected/focused this one DOES survive to iOS: ios-parse derives it from
        // type + AXValue, and @vk_remember comes back as a CheckBox with AXValue "1".
        assert.equal(vk(['find', '@vk_remember', '--not-checked', '--no-wait']).code, 0);
        assert.equal(vk(['find', '@vk_remember', '--checked', '--no-wait']).code, 1);

        assert.equal(vk(['tap', '@vk_remember']).code, 0);

        assert.equal(vk(['find', '@vk_remember', '--checked', '--no-wait']).code, 0);
        assert.equal(vk(['find', '@vk_remember', '--not-checked', '--no-wait']).code, 1);
      });
    });

    describe('platform honesty', () => {
      before(() => openScreen('state'));

      test('iOS refuses --selected / --focused instead of matching nothing', { skip: isAndroid }, () => {
        // A filter the platform cannot populate would narrow the pool to zero, burn the
        // full auto-wait window, and then report "No element matched selector" — a claim
        // about the screen that is not true. Exit 3 (environment), like clearApp's refusal.
        for (const flag of ['--selected', '--not-selected', '--focused', '--not-focused']) {
          const r = vk(['find', '@vk_mode_video', flag, '--no-wait']);
          assert.equal(r.code, 3, `${flag} should be refused on iOS, got ${r.code}`);
          assert.match(r.stderr + r.stdout, /does not report/);
        }
      });

      test('the modifiers iOS CAN answer still work there', () => {
        assert.equal(vk(['find', '@vk_mode_video', '--enabled', '--no-wait']).code, 0);
      });
    });

    describe('argument parsing', () => {
      before(() => openScreen('state'));

      test('a state modifier before the selector does not swallow it', () => {
        // Regression: `enabled` was missing from args.ts BOOLEAN, so a non-BOOLEAN flag
        // consumed the next token and `vk find --enabled @x` died with "Missing selector".
        const r = vk(['find', '--enabled', '@vk_mode_video', '--no-wait']);
        assert.equal(r.code, 0, r.stderr);
      });

      test('contradictory modifiers are a usage error, never a guess', () => {
        const flags = vk(['find', '@vk_mode_video', '--selected', '--not-selected', '--no-wait']);
        assert.equal(flags.code, 2);
        const embedded = vk(['find', '@vk_mode_video --selected --not-selected', '--no-wait']);
        assert.equal(embedded.code, 2);
      });
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

  // --- A window this app does not own -------------------------------------
  //
  // Issue #79. Everything else in this file reads the fixture's own window; these
  // two cases are the only ones where the thing on screen belongs to another
  // package — `com.google.android.permissioncontroller` draws the runtime-permission
  // dialog, and the app under test owns nothing but the pixels behind it.
  //
  // Android-only because the companion is. On iOS `idb` keeps its own process alive
  // and there is no UiAutomation connection to go stale.
  describe('a window owned by another package', { skip: !isAndroid }, () => {
    const CONTROLLER = /permissioncontroller/;

    /**
     * Which package owns the foreground activity, read from `dumpsys` ONLY.
     *
     * Load-bearing that this touches no hierarchy. A stock read calls
     * `releaseCompanionOn()`, and that release is *itself* the cure for what these
     * cases measure — waiting for the dialog with `vk ui` would destroy the effect
     * before the assertion could see it. `vk current` asks the window manager
     * instead, so it is inert.
     */
    const foreground = () => vk(['current']).stdout.trim();

    /** Tap a request button and wait for the system dialog to actually take the
     *  foreground. Each `vk current` costs a device round-trip, so the loop paces
     *  itself — no sleep needed. */
    function raiseDialog(which: 'mic' | 'camera'): void {
      assert.equal(vk(['tap', `@vk_perm_${which}`, '--wait', '10s']).code, 0);
      for (let i = 0; i < 30; i++) {
        if (CONTROLLER.test(foreground())) return;
      }
      throw new Error(`the ${which} dialog never took the foreground (current: ${foreground()})`);
    }

    /** How many of the dialog's own nodes a read can see. Zero means blind.
     *  `vk ui` captures once and does not auto-wait, so this is a single honest
     *  snapshot rather than a poll that could paper over the gap. */
    function dialogNodes(opts: { noCompanion?: boolean } = {}): number {
      const r = vk(['ui', '--json'], opts);
      if (r.code !== 0) return 0;
      return (JSON.parse(r.stdout) as { id?: string }[]).filter((e) => e.id?.includes('permission_')).length;
    }

    /** A permission dialog is MODAL: a case that dies mid-flow leaves the device
     *  stuck behind it, and the Android target here may be someone's own phone.
     *  Denies via the stock path so it works even while the companion is blind. */
    function dismiss(): void {
      if (!CONTROLLER.test(foreground())) return;
      vk(['tap', '@permission_deny_button', '--wait', '5s'], { noCompanion: true });
    }

    after(dismiss);

    test('the fixture raises a real system dialog, and says that it did', () => {
      openScreen('permission', { clear: true });
      // --clear reset the grants, so nothing is held yet.
      assert.equal(vk(['assert', '@vk_perm_dialog', '--text', 'Dialog shown: no']).code, 0);

      raiseDialog('mic');
      assert.match(foreground(), CONTROLLER, 'the permission controller should own the foreground');

      // The CONTROL, and the reason the next test can mean anything: prove the
      // dialog's nodes really are on screen, using the read path that is not under
      // test. AOSP's own ids, the ones issue #79 quotes.
      const stock = vk(['ui', '--json'], { noCompanion: true });
      assert.equal(stock.code, 0, stock.stderr);
      assert.match(stock.stdout, /permission_allow_foreground_only_button/);
      assert.match(stock.stdout, /permission_deny_button/);

      dismiss();

      // THE PRECONDITION GUARD. Once the permission is granted, requestPermissions
      // returns without drawing anything — so a run that never saw a dialog would
      // otherwise be indistinguishable from one that drove it. That is exactly the
      // device-state false green issue #79 warns about: a suite green on CI because
      // that emulator already holds the permission, hanging on a device that does not.
      assert.equal(vk(['assert', '@vk_perm_dialog', '--text', 'Dialog shown: yes', '--wait', '10s']).code, 0);
      assert.equal(vk(['assert', '@vk_perm_status', '--text', 'Status: mic: denied']).code, 0);
    });

    test('the hierarchy read sees a foreign window (issue #79)', () => {
      openScreen('permission', { clear: true });
      raiseDialog('mic');

      // FIRST hierarchy read after the dialog appeared — raiseDialog deliberately
      // used only `vk current` to get here, so nothing has released the companion's
      // UiAutomation connection in between.
      const seen = dialogNodes();

      // MEASURED, and it splits by target. On a Pixel 3a (Android 12) this is 0
      // while the stock path reads all five nodes: a connection held across the
      // window change keeps serving the app's own window, silently and with exit 0,
      // so no error exists for any fallback ladder to fire on. On a Pixel 6 emulator
      // (Android 14) it reads the dialog fine. See "Measured Flutter facts" 17.
      //
      // This case is therefore RED on an affected device until the fix lands, and
      // that is deliberate — it is the regression test for #79, not a record of the
      // bug as correct behaviour.
      assert.ok(
        seen > 0,
        `the read saw none of the dialog's nodes while ${foreground()} owned the foreground ` +
          `(the stock path sees ${dialogNodes({ noCompanion: true })}). This is issue #79.`,
      );
    });
  });

  // --- vk ai: the archived verdict ----------------------------------------
  //
  // Opt-in, because unlike every other case here this one calls a MODEL. A test
  // that fails never has its plan cached (writePlan runs only on green), so every
  // run recompiles the prose — set VK_E2E_AI_MODEL to the model you want billed,
  // e.g. `codex-cli` (an already-logged-in CLI, so $0 and no API key).
  const aiModel = process.env.VK_E2E_AI_MODEL;

  describe('vk ai archives an honest verdict', { skip: aiModel ? false : 'set VK_E2E_AI_MODEL to run' }, () => {
    test('a run the engine failed is never archived as a green report', () => {
      // Regression test for #41. A `vk ai` test can fail where no COMMAND failed —
      // a `repeat` that never sees its target, a budget/timeout abort — and those
      // used to reach the archive with nothing red in it, so report.xml claimed
      // failures="0" for a test that failed. CI trusts that file.
      //
      // Deliberately asserts the INVARIANT, not one failure message: a failing test
      // recompiles every run, so which failure the plan produces is not stable — but
      // "a non-zero run is never archived green" must hold for all of them.
      const r = vk(['ai', join('tests', 'e2e', 'fixtures', 'repeat-never-satisfied.md'), '--model', aiModel!], {
        record: true,
        timeoutMs: 600_000,
      });
      assert.notEqual(r.code, 0, `the fixture test is built to fail, but vk ai passed:\n${r.stderr}`);

      // stdout is the one machine result: the path to the HTML report.
      const runDir = dirname(r.stdout.trim());
      assert.ok(runDir && runDir !== '.', `no report path on stdout: ${JSON.stringify(r.stdout)}`);

      const suiteLine = readFileSync(join(runDir, 'report.xml'), 'utf8').split('\n')[1];
      const failures = Number(/failures="(\d+)"/.exec(suiteLine)?.[1]);
      const errors = Number(/errors="(\d+)"/.exec(suiteLine)?.[1]);
      assert.ok(failures + errors > 0, `a failed run reported no failures in JUnit: ${suiteLine}`);

      const state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunState;
      assert.ok(state.failure?.where, 'run.json carries no terminal failure');
      assert.ok(state.failure?.reason);

      const red = state.steps.filter((s) => s.status !== 'passed');
      assert.equal(red.length, 1, 'exactly one step should carry the failure — never zero, never doubled');
      // The archive must show what the screen looked like, not just that it broke.
      assert.ok(red[0].failImage || red[0].failHierarchy, 'the failing step captured no evidence');

      const html = readFileSync(join(runDir, 'report.html'), 'utf8');
      assert.match(html, /This run did not pass/);
    });
  });

  // `vk device set` changes the device the app runs on. The fixture's Device state
  // screen reports what the PLATFORM tells the app (MediaQuery, not app state), so
  // asserting on those lines proves a setting actually reached the app rather than
  // merely landing in a system database — the difference between a real offline test
  // and one that goes green while the app is still online.
  //
  // Everything here restores in `after`, so a failure mid-run cannot leave the device
  // dark, rotated or enlarged for the next test in the file.
  describe('device settings', () => {
    before(() => openScreen('device'));
    after(() => dev(['reset']));

    // LOAD-BEARING: every device set/reset must run with recording ON. The snapshot of
    // the pre-change value lives in the run file, so under the suite's default
    // VERIKUN_NO_RUN=1 a `set` records nothing and the matching `reset` silently
    // restores nothing — the tests would pass while leaving the device modified.
    const dev = (args: string[]) => vk(['device', ...args], { record: true });

    /**
     * The value one Device-state line currently shows, as the APP reports it.
     *
     * Reads via labelField() because a Flutter label lands in `desc` on Android and
     * `text` on iOS (measured fact 4 in example/flutter-app/README.md) — hard-coding
     * `text` here silently returns '' on Android and fails for the wrong reason.
     */
    const lineText = (id: string): string => {
      const found = JSON.parse(vk(['find', `@${id}`, '--json']).stdout) as Array<Record<string, string>>;
      return found[0]?.[labelField()] ?? '';
    };
    const brightness = () => lineText('vk_dev_brightness');
    const orientation = () => lineText('vk_dev_orientation');

    test('caps reports this platform honestly', () => {
      const r = dev(['caps', '--json']);
      assert.equal(r.code, 0, r.stderr);
      const caps = JSON.parse(r.stdout) as {
        settings: Array<{ key: string; support: string; manual?: string }>;
      };
      const byKey = Object.fromEntries(caps.settings.map((s) => [s.key, s]));
      assert.equal(byKey.dark.support, 'supported', 'dark should work on both platforms');
      if (isAndroid) {
        assert.equal(byKey.rotation.support, 'supported');
        assert.equal(byKey.airplane.support, 'supported');
      } else {
        // The honest-degrade contract: refuse, and say what to do by hand instead.
        assert.equal(byKey.rotation.support, 'unsupported');
        assert.equal(byKey.airplane.support, 'unsupported');
        assert.ok(byKey.rotation.manual, 'an unsupported key must name a manual equivalent');
        assert.equal(byKey['stay-awake'].support, 'noop');
      }
    });

    test('dark mode reaches the app, and reset brings it back', () => {
      // Flip whatever the device is CURRENTLY on rather than assuming it starts light:
      // a phone in daily use is often already in dark mode, and a test that fails
      // because of the tester's own preference is a test nobody trusts.
      const before = brightness();
      assert.ok(['light', 'dark'].includes(before), `unexpected brightness line: ${before}`);
      const flipped = before === 'dark' ? 'off' : 'on';
      const want = before === 'dark' ? 'light' : 'dark';

      assert.equal(dev(['set', `dark=${flipped}`]).code, 0);
      assert.equal(brightness(), want, 'the app never saw the brightness change');

      assert.equal(dev(['reset']).code, 0);
      assert.equal(brightness(), before, 'reset did not restore the original brightness');
    });

    test('reset restores the value that was live BEFORE the run, not a default', () => {
      // The whole point of snapshotting: a phone in daily use has usually drifted from
      // the defaults already, and clobbering that would be its own bug.
      const before = JSON.parse(dev(['get', '--json']).stdout) as Record<string, string>;
      assert.equal(dev(['set', 'dark=on']).code, 0);
      assert.equal(dev(['reset']).code, 0);
      const after = JSON.parse(dev(['get', '--json']).stdout) as Record<string, string>;
      assert.deepEqual(after, before);
    });

    test('an unknown key or value is a usage error, before touching the device', () => {
      const before = brightness();
      assert.equal(dev(['set', 'bogus=1']).code, 2);
      assert.equal(dev(['set', 'dark=maybe']).code, 2);
      assert.equal(dev(['set', 'dark']).code, 2);
      // Unchanged — a rejected command must not half-apply.
      assert.equal(brightness(), before);
    });

    test('rotation re-lays out the app', { skip: !isAndroid && 'Android only' }, () => {
      // Pin the starting orientation through the same mechanism instead of assuming
      // the device is held portrait. Doing it as a `set` also means the snapshot keeps
      // the EARLIEST original, so the single reset below still restores what the
      // device really had — which is that "earliest wins" rule under test for free.
      const before = orientation();
      assert.equal(dev(['set', 'rotation=portrait']).code, 0);
      assert.equal(orientation(), 'portrait');

      assert.equal(dev(['set', 'rotation=landscape']).code, 0);
      assert.equal(orientation(), 'landscape', 'the app never saw the orientation change');

      assert.equal(dev(['reset']).code, 0);
      assert.equal(orientation(), before, 'reset did not restore the pre-test orientation');
    });

    test('font-scale reaches the app', () => {
      // Asserts the scale WENT UP and comes back, not that it equals 1.30 — because the
      // effective ratio is not the number you asked for on either platform:
      //   - Android 14+ (API 34) applies NON-LINEAR font scaling, so a 16px body at
      //     font_scale 1.3 reports ~1.26. Measured on a Pixel 6 emulator; a Pixel 3a and
      //     a Samsung on API 31 both report 1.30, which is how the API-31 assumption
      //     baked into an earlier version of this test survived until it didn't.
      //   - iOS has named Dynamic Type categories rather than a float, so 1.3 lands on
      //     the nearest one and reports ~1.35.
      // "Bigger than before, and restored after" is the claim that is true everywhere.
      const before = Number(lineText('vk_dev_textscale'));
      assert.ok(Number.isFinite(before), `text scale line is not a number: ${lineText('vk_dev_textscale')}`);

      // Pin BOTH ends through the same mechanism rather than assuming the device does
      // not already sit at the target — a previous run that died mid-test leaves it
      // there, and then "set 1.3" changes nothing and the test fails for the wrong
      // reason. The snapshot keeps the earliest original, so one reset still undoes it.
      assert.equal(dev(['set', 'font-scale=1.0']).code, 0);
      const small = Number(lineText('vk_dev_textscale'));
      assert.equal(dev(['set', 'font-scale=1.5']).code, 0);
      const large = Number(lineText('vk_dev_textscale'));
      assert.ok(large > small, `text scale did not grow: ${small} -> ${large}`);

      assert.equal(dev(['reset']).code, 0);
      assert.equal(Number(lineText('vk_dev_textscale')), before, 'reset did not restore the text scale');
    });

    test('an unsupported setting exits 3 naming the manual equivalent', { skip: isAndroid && 'iOS only' }, () => {
      const r = dev(['set', 'rotation=landscape']);
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, /not supported on ios/i);
      assert.match(r.stderr, /Simulator window|Cmd\+Left/, 'no manual equivalent offered');
    });

    test('device get/caps do not start a test run', () => {
      // They are inspection, like `ui`/`find`. Recording them would auto-start a run
      // just for asking what the platform supports.
      vk(['run', 'clear'], { record: true });
      assert.equal(dev(['get']).code, 0);
      assert.equal(dev(['caps']).code, 0);
      assert.match(vk(['run', 'status'], { record: true }).stdout, /no active test run/i);
    });
  });
});
