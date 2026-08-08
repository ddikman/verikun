# Device-state smoke test

Checks that the app copes when the **device** changes underneath it — dark mode and
larger system text — and that everything is put back afterwards.

Launch the `dev.verikun.testapp` app — the fixture app in `example/flutter-app`.

It keeps no state between runs, so a fresh launch is a complete reset and always lands on
the home screen. Confirm the home screen (`vk_home`) is showing before doing anything else.

## Open the device-state screen

The Device state row (`vk_nav_device`) opens a screen that reports what the platform tells
the app about itself. Each value is a line the test can assert on, so this checks the
setting actually reached the app rather than just landing in a system database.

1. Tap the Device state row (`vk_nav_device`) and confirm `vk_device` is showing.
2. Confirm the brightness line (`vk_dev_brightness`) reads "light".

## Switch the device to dark mode

3. Run `device set dark=on`.
4. Confirm the brightness line (`vk_dev_brightness`) now reads "dark". The app is not
   told anything by the test — it re-reads the platform brightness, so this passing is
   what proves the device setting took effect.
5. Take a screenshot.

## Enlarge the system text

6. Run `device set font-scale=1.3`.
7. Confirm the sample line (`vk_dev_sample`) is still showing — larger text is the classic
   way a layout overflows and pushes content off screen.
8. Take a screenshot.

## Put the device back

9. Run `device reset`. This restores whatever the device had before the test started —
   not some assumed default, which matters because a phone in daily use has often drifted
   away from the defaults already.
10. Confirm the brightness line (`vk_dev_brightness`) reads "light" again.

---

> **Scope.** This test covers only the settings that work on **both** Android and an iOS
> simulator, so `vk suite example` stays green on either platform. `rotation` and
> `airplane` are Android-only — on iOS they exit 3 naming the manual equivalent, which
> would fail the suite. They are exercised in `tests/e2e/flutter-app.test.ts`, which knows
> which platform it is on.
>
> **Testing offline handling** is the same shape: `device set airplane=on`, assert your
> app's offline banner, then `device reset`. One caveat when you write that test — coming
> back from `airplane=off` re-enables the radio, not the internet, so follow it with a
> wait or an assert rather than tapping straight away.
