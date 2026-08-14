package dev.verikun.testapp

import android.Manifest
import android.content.pm.PackageManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * The fixture's one piece of native code, and it exists for one reason: to raise a
 * **real runtime-permission dialog**, i.e. a window owned by
 * `com.google.android.permissioncontroller` rather than by this app. See
 * `lib/screens/permission_screen.dart` for what that measures (issue #79).
 *
 * Deliberately framework-only — `android.app.Activity.requestPermissions`, API 23+,
 * against this app's `minSdk` of 24. No androidx, and no Flutter permission plugin:
 * `pubspec.yaml` says the fixture is dependency-free beyond the Flutter SDK, and
 * that is load-bearing rather than tidiness. A ruler with dependencies is a ruler
 * that can break for reasons which have nothing to do with `vk`.
 */
class MainActivity : FlutterActivity() {

    private companion object {
        const val CHANNEL = "dev.verikun.testapp/permission"
        const val REQUEST_CODE = 1979
    }

    /** The in-flight request, or null. `requestPermissions` answers asynchronously in
     *  `onRequestPermissionsResult`, so the Dart reply has to be parked until then. */
    private var pending: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                if (call.method != "request") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                // A CLOSED MAPPING, not a passthrough. Dart sends one of two literals
                // and anything else is refused here, so no caller-supplied string can
                // reach a platform permission call — the same habit the CLI keeps for
                // device tokens.
                val permission = when (call.arguments) {
                    "mic" -> Manifest.permission.RECORD_AUDIO
                    "camera" -> Manifest.permission.CAMERA
                    else -> {
                        result.error("unknown_permission", "expected 'mic' or 'camera'", null)
                        return@setMethodCallHandler
                    }
                }
                request(permission, result)
            }
    }

    private fun request(permission: String, result: MethodChannel.Result) {
        // ALREADY GRANTED IS ITS OWN ANSWER, not a success. requestPermissions returns
        // without drawing anything in that case, so a test told only "granted" cannot
        // tell a dialog it drove from one it never saw. Saying so is what lets
        // `@vk_perm_dialog` report `no` and a test fail its own precondition instead of
        // passing vacuously.
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            result.success("already_granted")
            return
        }
        // One at a time: a second request while one is in flight would strand the first
        // callback with no way to answer it.
        if (pending != null) {
            result.error("busy", "a permission request is already in flight", null)
            return
        }
        pending = result
        requestPermissions(arrayOf(permission), REQUEST_CODE)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CODE) return
        val result = pending ?: return
        pending = null
        // An EMPTY grantResults means the request was cancelled — the dialog was
        // dismissed without a choice (back press, or the system interrupting it). That
        // is neither granted nor denied, and reporting it as "denied" would make a
        // cancelled run look like a deliberate refusal.
        val answer = when {
            grantResults.isEmpty() -> "cancelled"
            grantResults[0] == PackageManager.PERMISSION_GRANTED -> "granted"
            else -> "denied"
        }
        result.success(answer)
    }
}
