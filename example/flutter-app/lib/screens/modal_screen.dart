import 'package:flutter/material.dart';

import '../widgets.dart';

/// Raises a **modal barrier** — the full-screen node a sheet or dialog puts in
/// front of everything else — so vk can be measured against the one tree shape
/// that reads as "empty" while the screen is plainly full (issue #131).
///
/// | element               | what it exercises                                     |
/// |-----------------------|-------------------------------------------------------|
/// | `@vk_sheet_open`      | a modal bottom sheet at Flutter's own 250 ms entrance  |
/// | `@vk_sheet_open_blank`| the same sheet with its contents `ExcludeSemantics`'d: |
/// |                       | the barrier is all a read can see while it is up       |
/// | `@vk_sheet_confirm`   | a control ON the sheet — what a test waits for         |
/// | `@vk_sheet_dialog`    | a dialog raised OVER the sheet: the report's flow      |
/// | `@vk_dialog_ok`       | dismisses that dialog, exposing the sheet again        |
/// | `@vk_sheet_close`     | dismisses the sheet                                    |
/// | `@vk_modal_result`    | which control fired, readable from the page            |
///
/// Flutter's `ModalBarrier` is a `BlockSemantics` around one full-screen
/// `Semantics(label:, onTap:)` node: it drops the whole route beneath it, and
/// the sheet's own contents join the tree only once on screen — so mid-entrance
/// the hierarchy is the barrier and nothing else. MEASURED: the 250 ms default
/// is enough (the read right after the tap returned held only the barrier on an
/// SM-A415F and a motorola one); a 3 s `sheetAnimationStyle` was tried and did
/// not widen the window, so do not reintroduce it. The label is localised, so
/// vk detects the barrier by shape. See the README's measured fact 18.
class ModalScreen extends StatefulWidget {
  const ModalScreen({super.key});

  static const route = '/modal';

  @override
  State<ModalScreen> createState() => _ModalScreenState();
}

class _ModalScreenState extends State<ModalScreen> {
  String _result = 'none';

  void _record(String what) => setState(() => _result = what);

  /// The sheet whose contents a read can never see. Not `Offstage` and not an
  /// empty sheet: the controls are painted and tappable, exactly like the
  /// report's, and only their semantics are withheld.
  Future<void> _openBlankSheet() async {
    // Mark the page BEFORE the sheet goes up, so whatever a previous flow left in
    // `_result` cannot be mistaken for this sheet's outcome.
    _record('blank open');
    await showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => ExcludeSemantics(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Sheet (no semantics)'),
                const SizedBox(height: 16),
                ElevatedButton(
                  onPressed: () {
                    _record('blank confirmed');
                    Navigator.of(sheetContext).pop();
                  },
                  child: const Text('Confirm'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    // Reached however the sheet went away — the barrier tap, Back, or the
    // button — so the page can prove the modal is gone.
    if (mounted && _result == 'blank open') _record('blank closed');
  }

  Future<void> _openSheet() async {
    await showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const VkStatus(id: 'vk_sheet_title', value: 'Sheet'),
              const SizedBox(height: 16),
              VkButton(
                id: 'vk_sheet_confirm',
                label: 'Confirm',
                onPressed: () {
                  _record('confirmed');
                  Navigator.of(sheetContext).pop();
                },
              ),
              const SizedBox(height: 8),
              VkButton(
                id: 'vk_sheet_dialog',
                label: 'Open dialog',
                onPressed: () => _openDialog(sheetContext),
              ),
              const SizedBox(height: 8),
              VkButton(
                id: 'vk_sheet_close',
                label: 'Close',
                onPressed: () {
                  _record('closed');
                  Navigator.of(sheetContext).pop();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// A dialog on top of the sheet. Its barrier blocks the sheet's semantics for
  /// as long as it is up — including the fade-out after `@vk_dialog_ok` — which
  /// is the moment the report's failing wait was issued in.
  Future<void> _openDialog(BuildContext sheetContext) async {
    await showDialog<void>(
      context: sheetContext,
      builder: (dialogContext) => AlertDialog(
        title: const VkStatus(id: 'vk_dialog_title', value: 'Dialog'),
        content: const Text('A modal on top of a modal.'),
        actions: [
          VkButton(
            id: 'vk_dialog_ok',
            label: 'OK',
            onPressed: () {
              _record('dialog ok');
              Navigator.of(dialogContext).pop();
            },
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const VkScreenTitle(id: 'vk_modal', title: 'Modals'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          VkStatus(id: 'vk_modal_result', value: 'Result: $_result'),
          const SizedBox(height: 16),
          VkButton(
            id: 'vk_sheet_open',
            label: 'Open sheet',
            onPressed: _openSheet,
          ),
          const SizedBox(height: 8),
          VkButton(
            id: 'vk_sheet_open_blank',
            label: 'Open sheet (no semantics)',
            onPressed: _openBlankSheet,
          ),
        ],
      ),
    );
  }
}
