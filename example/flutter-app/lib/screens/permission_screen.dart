import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../widgets.dart';

/// Raises a **real system permission dialog** — a window owned by another
/// package, drawn on top of this app.
///
/// This is the only screen in the fixture whose subject is not a widget. What it
/// measures is what `vk` can read when the thing on screen **is not this app**:
/// `com.google.android.permissioncontroller` owns the window, this app owns
/// nothing but the pixels behind it.
///
/// | element             | what it exercises                                     |
/// |---------------------|-------------------------------------------------------|
/// | `@vk_perm_mic`      | the dialog as it was seen in the field (microphone)    |
/// | `@vk_perm_camera`   | a SECOND dialog, raisable with no force-stop nearby    |
/// | `@vk_perm_status`   | what the app was told, so a run cannot merely assume   |
/// | `@vk_perm_dialog`   | whether a dialog was raised **at all**                 |
///
/// TWO PERMISSIONS, AND THE SECOND ONE IS THE POINT. Issue #79 reports that with
/// the on-device companion on, a permission dialog is absent from the hierarchy
/// entirely. Two explanations fit the same evidence, and one button cannot
/// separate them:
///
///   1. the companion goes blind to the permission window specifically, or
///   2. it is briefly wedged after a force-stop, and the permission request in
///      the field just happened to sit in that window.
///
/// Microphone reproduces the field observation (a Pixel 3a, `RECORD_AUDIO`).
/// Camera exists so a dialog can be raised **later in the same session**, with no
/// force-stop anywhere near it — holding one variable still while the other
/// moves. With a single permission the two are welded together and the
/// measurement cannot say which is which.
///
/// `@vk_perm_dialog` is load-bearing for a different reason. Once the permission
/// is granted, `requestPermissions` returns immediately and **no dialog appears**
/// — so a test that only checks the outcome passes identically whether it drove a
/// dialog or never saw one. That is precisely the false green issue #79 warns
/// about: a suite green on CI because that emulator already holds the permission,
/// hanging on a device that does not. The line makes the precondition assertable
/// rather than assumed. Reset it with `vk launch dev.verikun.testapp --clear`,
/// which resets runtime grants along with the app data.
///
/// iOS DEGRADES HONESTLY. There is no Swift counterpart: the companion is
/// Android-only, so an iOS system alert would measure nothing about #79. The
/// channel call raises `MissingPluginException` there and the status reads
/// `unavailable` — the screen still renders and `@vk_permission` still asserts,
/// so `openScreen('permission')` works on both platforms.
class PermissionScreen extends StatefulWidget {
  const PermissionScreen({super.key});

  static const route = '/permission';

  @override
  State<PermissionScreen> createState() => _PermissionScreenState();
}

/// The host side of the channel. `MainActivity.kt` maps these two literals
/// through a closed `when` — nothing caller-supplied ever reaches a platform
/// permission call.
enum _Perm {
  mic('mic'),
  camera('camera');

  const _Perm(this.wire);

  /// What crosses the MethodChannel.
  final String wire;
}

class _PermissionScreenState extends State<PermissionScreen> {
  static const _channel = MethodChannel('dev.verikun.testapp/permission');

  String _status = 'idle';
  String _dialogShown = 'no';

  Future<void> _request(_Perm perm) async {
    // Clear both lines FIRST, so a stale "yes" from a previous tap can never be
    // read as this request's answer.
    setState(() {
      _status = '${perm.wire}: requesting';
      _dialogShown = 'no';
    });

    String result;
    try {
      result = await _channel.invokeMethod<String>('request', perm.wire) ?? 'no reply';
    } on MissingPluginException {
      // iOS, or an Android build without the handler. Say so rather than
      // reporting a denial that never happened.
      setState(() {
        _status = 'unavailable';
        _dialogShown = 'no';
      });
      return;
    } on PlatformException catch (e) {
      setState(() => _status = '${perm.wire}: error ${e.code}');
      return;
    }
    if (!mounted) return;

    setState(() {
      _status = '${perm.wire}: $result';
      // `already_granted` is the host telling us it returned without asking. Every
      // other outcome went through the system dialog.
      _dialogShown = result == 'already_granted' ? 'no' : 'yes';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const VkScreenTitle(id: 'vk_permission', title: 'Permissions'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          VkStatus(id: 'vk_perm_status', value: 'Status: $_status'),
          const SizedBox(height: 8),
          VkStatus(id: 'vk_perm_dialog', value: 'Dialog shown: $_dialogShown'),
          const SizedBox(height: 24),
          VkButton(
            id: 'vk_perm_mic',
            label: 'Request microphone',
            onPressed: () => _request(_Perm.mic),
          ),
          const SizedBox(height: 12),
          VkButton(
            id: 'vk_perm_camera',
            label: 'Request camera',
            onPressed: () => _request(_Perm.camera),
          ),
        ],
      ),
    );
  }
}
