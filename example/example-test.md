# Login and delayed-load smoke test

Launch the `dev.verikun.testapp` app — the fixture app in `example/flutter-app`.

It keeps no state between runs, so a fresh launch is a complete reset and always lands on
the home screen. Confirm the home screen (`vk_home`) is showing before doing anything else.

## Sign in

The username field (`vk_user`) is already prefilled, and the "Sign In" button stays
disabled until both fields have content — so filling in the password is what makes the
form submittable.

1. Tap the Login row (`vk_nav_login`) to open the login screen.
2. Confirm the login screen (`vk_login`) is showing.
3. Type "hunter2" into the password field (`vk_pass`).
4. Tap the "Remember me" checkbox (`vk_remember`).
5. Tap the "Sign In" button (`vk_submit`).
6. Confirm the result line (`vk_login_ok`) now reads "Signed in".

## Go back without a hardware Back button

Return to the home screen by tapping the on-screen "Back" control in the top-left corner,
rather than pressing a hardware Back button. That holds on both platforms, for two
different reasons: iOS has no hardware Back button at all, and on Android the soft keyboard
is still up after typing, so a hardware Back press is consumed dismissing the keyboard
instead of navigating.

7. Tap the "Back" control to return to the home screen.
8. Confirm the home screen (`vk_home`) is showing again.

## Wait for a slow load

9. Tap the Delayed load row (`vk_nav_async`), and confirm `vk_async` is showing.
10. Tap the "8s" button (`vk_delay_8`) to select an eight-second delay.
11. Tap the Load button (`vk_load`).
12. Wait up to 15 seconds for the result line (`vk_loaded`) to appear. The load takes
    longer than verikun's default five-second wait window, so this step needs an
    explicitly longer wait — without it the step would time out and fail.
13. Confirm the spinner (`vk_spinner`) is gone.
