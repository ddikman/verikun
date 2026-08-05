import 'package:flutter/material.dart';

import '../widgets.dart';

/// Pins the **state-flag** half of vk's selector contract — the attributes an
/// element carries rather than the text it shows.
///
/// | element            | what it exercises                                    |
/// |--------------------|------------------------------------------------------|
/// | `@vk_mode_photo`   | `selected` / `--not-selected` on the inactive option  |
/// | `@vk_mode_video`   | `selected` / `--selected` on the active option        |
/// | `@vk_mode_status`  | which mode a run *actually* landed in                 |
/// | `@vk_focus_field`  | `focused`, from real input focus rather than a flag   |
///
/// The mode picker is the point of the screen. Both options call one
/// `_toggleMode()`, so **any** tap flips the mode — reproducing a real control
/// whose default is content-driven and therefore unknowable when a plan is
/// compiled. Without a way to ask "is it already selected?", a test taps blind:
/// it completes either way, nothing fails, and the run may have exercised the
/// opposite mode from the one it claims. `@vk_mode_status` exists so a test can
/// prove which one it got, instead of assuming.
///
/// `@vk_focus_field` takes focus the honest way — by being tapped — rather than
/// by hard-coding `Semantics(focused: true)`. What we want measured is whether
/// vk can observe *real* input focus, which is the only kind a test can act on.
class StateScreen extends StatefulWidget {
  const StateScreen({super.key});

  static const route = '/state';

  @override
  State<StateScreen> createState() => _StateScreenState();
}

enum _Mode { photo, video }

class _StateScreenState extends State<StateScreen> {
  /// Starts on `video`, so the interesting case — "the option you were asked to
  /// pick is already selected" — is the one a test meets first.
  _Mode _mode = _Mode.video;

  final _focus = TextEditingController();

  /// The whole hazard in one method: shared by both options, so it flips.
  void _toggleMode() {
    setState(() => _mode = _mode == _Mode.photo ? _Mode.video : _Mode.photo);
  }

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const VkScreenTitle(id: 'vk_state', title: 'State flags'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          VkStatus(id: 'vk_mode_status', value: 'Mode: ${_mode.name}'),
          const SizedBox(height: 12),
          Row(
            children: [
              VkModeOption(
                id: 'vk_mode_photo',
                label: 'Photo',
                selected: _mode == _Mode.photo,
                onTap: _toggleMode,
              ),
              const SizedBox(width: 12),
              VkModeOption(
                id: 'vk_mode_video',
                label: 'Video',
                selected: _mode == _Mode.video,
                onTap: _toggleMode,
              ),
            ],
          ),
          const SizedBox(height: 32),
          VkField(
            id: 'vk_focus_field',
            label: 'Focus me',
            controller: _focus,
          ),
        ],
      ),
    );
  }
}
