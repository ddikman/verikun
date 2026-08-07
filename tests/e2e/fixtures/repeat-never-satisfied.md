# A loop that can never finish

**This test is meant to FAIL.** It is the on-device reproduction for
[#41](https://github.com/ddikman/verikun/issues/41) — a `repeat` whose target never
appears used to archive as a fully green report. It lives under `tests/e2e/fixtures/`
rather than `example/` on purpose: `vk suite example` would otherwise pick it up and
turn the example suite red.

Launch the `dev.verikun.testapp` app — the fixture app in `example/flutter-app`. It keeps no
state between runs, so a fresh launch is a complete reset and always lands on the home
screen.

1. Wait up to 20 seconds for the home screen (`vk_home`) to appear. A debug Flutter build is
   slow to first paint, so this needs an explicitly long wait — the default five-second
   window is not reliably enough on a mid-range phone.
2. Tap the Delayed load row (`vk_nav_async`), and wait up to 15 seconds for `vk_async`.
3. Repeatedly tap the "1s" button (`vk_delay_1`), at most 4 times, until the result line
   (`vk_loaded`) appears.

Step 3 can never succeed: `vk_delay_1` only selects the delay, it never starts a load, so
`vk_loaded` is never rendered. The loop is expected to give up and fail the test.
