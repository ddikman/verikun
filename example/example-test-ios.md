# Settings navigate-and-search smoke test (iOS)

Launch the `com.apple.Preferences` app (the iOS **Settings** app).

First, drill into the General settings and confirm the device details:

1. Tap "General" to open the General settings.
2. Tap "About" to open the About screen.
3. Confirm the About screen is showing device information — the "Model Name" row is
   visible.

iOS has **no hardware Back button**, so go back using the on-screen back control in the
top-left corner. Note that its label is the *previous* screen's title (so it reads
"General" on the About screen, then "Settings" on the General screen) rather than the
word "Back":

4. Tap the back button in the top-left to return to the General screen.
5. Tap the back button again to return to the main Settings list.
6. Confirm you are back at the top level — the "General" row is visible again.

Finally, use the search field to filter the settings:

7. Tap the search field at the top of the Settings list.
8. Type "AutoFill".
9. Confirm a result for "AutoFill & Passwords" appears.
