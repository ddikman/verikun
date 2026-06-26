# Camera capture-and-delete smoke test

Launch the `com.android.camera` app.

After launching, a system permission dialog may appear (for example, location access).
If the "While using the app" button (resource id `permission_allow_foreground_only_button`)
is present, tap it to approve the permission.

Then take a photo at 2x zoom and delete it — twice in a row. For each round:

1. Tap the control whose accessibility description is `2.0X zoom`.
2. Tap the shutter button (resource id `shutter_button`) to take the photo.
3. Tap the most recent photo thumbnail to open it — its resource id contains
   `thumbnail_image` (match by substring).
4. Tap the trash / delete icon to delete the photo.
5. If a confirmation dialog appears, tap its confirm button (resource id `button1`).
6. Press back to return to the camera viewfinder before the next round.
