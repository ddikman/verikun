import 'package:flutter/material.dart';

/// Shared semantics conventions for the fixture.
///
/// Every identifier is `vk_<short>`, lowercase snake — grep-able across the Dart
/// here and the TypeScript in `tests/e2e/`, and impossible to confuse with a
/// framework-generated id.
///
/// `Semantics(identifier:)` maps to Android's `resource-id` (via
/// `AccessibilityNodeInfo.setViewIdResourceName`) and iOS's `AXUniqueId` (via
/// `accessibilityIdentifier`), so `vk find @vk_foo` resolves on BOTH platforms.
/// `Semantics(label:)` does not: it lands in Android's `content-desc` but iOS's
/// `AXLabel`, which vk maps to `desc` and `text` respectively. Hence the rule
/// this fixture demonstrates: **`@id` first, `text:` second, `desc:` never.**

/// MEASURED, THE HARD WAY — `MergeSemantics` is not optional here.
///
/// A bare `Semantics(identifier: 'x', child: SomeWidget())` emits **two**
/// sibling nodes on Android: one carrying the identifier and nothing else, and
/// one carrying the child's label, tap action and state flags. The first dump of
/// this app showed exactly that:
///
///     [8] Button @vk_submit (540,891) disabled
///     [9] Button desc="Sign In" (540,891) disabled
///
/// The consequence is not cosmetic. `@vk_remember` came back with no `checked`
/// state at all, because the checkbox flags lived on the *sibling* node — so
/// `vk assert @vk_remember` could never observe it. Wrapping in `MergeSemantics`
/// collapses the pair into one node that carries the identifier AND the flags,
/// which is what every selector in `tests/e2e/` depends on.
///
/// If you add a widget here, wrap it with this. Do not hand-roll a bare
/// `Semantics`.
/// A SECOND MEASURED RULE, learned from iOS: a node carrying an identifier but
/// no label, no value and no action **survives on Android and vanishes on iOS**.
/// The screen containers (`@vk_home`, `@vk_login`) and the spinner all appeared
/// as `View @vk_home` in `uiautomator dump` yet were absent from
/// `idb ui describe-all` entirely. Anything that needs to be findable on both
/// platforms must therefore carry a `label` (or wrap a widget that supplies one).
Widget _vkNode({
  required String id,
  required Widget child,
  String? label,
  bool? button,
  bool? enabled,
  bool? textField,
  bool? obscured,
  bool? selected,
}) {
  return MergeSemantics(
    child: Semantics(
      identifier: id,
      label: label,
      button: button,
      enabled: enabled,
      textField: textField,
      obscured: obscured,
      selected: selected,
      child: child,
    ),
  );
}

/// A labelled, identified tap target.
class VkButton extends StatelessWidget {
  const VkButton({
    super.key,
    required this.id,
    required this.label,
    this.onPressed,
  });

  final String id;
  final String label;

  /// Null renders a *disabled* button — `enabled="false"` on Android — which is
  /// what `vk find --enabled` filters out.
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return _vkNode(
      id: id,
      button: true,
      enabled: onPressed != null,
      child: ElevatedButton(onPressed: onPressed, child: Text(label)),
    );
  }
}

/// A read-only status line the tests assert against.
class VkStatus extends StatelessWidget {
  const VkStatus({super.key, required this.id, required this.value});

  final String id;
  final String value;

  @override
  Widget build(BuildContext context) {
    return _vkNode(
      id: id,
      child: Text(value, style: const TextStyle(fontSize: 16)),
    );
  }
}

/// A text field. The merge is what puts `password` on the same node as the id.
class VkField extends StatelessWidget {
  const VkField({
    super.key,
    required this.id,
    required this.label,
    required this.controller,
    this.obscureText = false,
    this.onChanged,
  });

  final String id;
  final String label;
  final TextEditingController controller;
  final bool obscureText;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    return _vkNode(
      id: id,
      textField: true,
      obscured: obscureText,
      child: TextField(
        controller: controller,
        obscureText: obscureText,
        onChanged: onChanged,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }
}

/// A checkbox row. Merging is what makes `checked` observable on `@id`.
class VkCheckbox extends StatelessWidget {
  const VkCheckbox({
    super.key,
    required this.id,
    required this.label,
    required this.value,
    required this.onChanged,
  });

  final String id;
  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return _vkNode(
      id: id,
      child: CheckboxListTile(
        title: Text(label),
        value: value,
        onChanged: (v) => onChanged(v ?? false),
      ),
    );
  }
}

/// One option of a two-option mode picker — the fixture for `selected`.
///
/// Deliberately faithful to the app that motivated it: **both options call the
/// same handler**, so a tap *flips* the mode rather than setting it. Landing on
/// a known mode therefore requires knowing the current one, which is precisely
/// what `--selected` / `--not-selected` exist to express.
///
/// This shape is the reason the modifier matters. An unguarded tap here exits 0
/// and leaves the app in the *opposite* mode, so the flow completes and the test
/// passes while having exercised the wrong thing — a false green, which is worse
/// than a red one. `@vk_mode_status` is what makes that observable.
///
/// A plain `GestureDetector` rather than a `ChoiceChip` on purpose: the fixture
/// is a ruler, so the only `selected` in the tree should be the one written
/// here, not one a Material widget also contributes.
class VkModeOption extends StatelessWidget {
  const VkModeOption({
    super.key,
    required this.id,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String id;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return _vkNode(
      id: id,
      button: true,
      selected: selected,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          decoration: BoxDecoration(
            color: selected ? scheme.primary : scheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(
            label,
            style: TextStyle(color: selected ? scheme.onPrimary : scheme.onSurface),
          ),
        ),
      ),
    );
  }
}

/// The loading spinner — an *animating* widget, present only while a load is in
/// flight. It exists to answer a question the repo has only guessed at: does a
/// continuously-animating Flutter widget stop `uiautomator dump` from reaching
/// idle, tripping the 3-attempt retry in `AdbDriver.dumpXml`?
///
/// `@vk_loading_text` sits beside it as a non-animating sibling, so a failed
/// dump is attributable to the animation rather than assumed.
class VkSpinner extends StatelessWidget {
  const VkSpinner({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    return _vkNode(
      id: id,
      // A CircularProgressIndicator supplies no label of its own, so without an
      // explicit one this node is invisible to iOS entirely — see _vkNode.
      label: 'Busy',
      child: const SizedBox(
        width: 40,
        height: 40,
        child: CircularProgressIndicator(),
      ),
    );
  }
}

/// The per-screen anchor, mounted as the AppBar title.
///
/// MEASURED: a bare `Semantics(identifier: 'vk_login')` wrapped around a screen's
/// body **does not survive on iOS**. Android materialises it as a plain
/// `View @vk_login`, but the iOS accessibility tree drops a node that carries no
/// label, no value and no actions, so `vk assert @vk_login --ios` could never
/// pass. Hanging the screen id on the title — a node that is already labelled and
/// already interesting on both platforms — gives every screen one anchor that
/// resolves everywhere.
class VkScreenTitle extends StatelessWidget {
  const VkScreenTitle({super.key, required this.id, required this.title});

  final String id;
  final String title;

  @override
  Widget build(BuildContext context) {
    return _vkNode(id: id, child: Text(title));
  }
}

/// A navigation row on the home screen.
class VkNavTile extends StatelessWidget {
  const VkNavTile({
    super.key,
    required this.id,
    required this.title,
    required this.subtitle,
    required this.route,
  });

  final String id;
  final String title;
  final String subtitle;
  final String route;

  @override
  Widget build(BuildContext context) {
    return _vkNode(
      id: id,
      button: true,
      child: Card(
        child: ListTile(
          title: Text(title),
          subtitle: Text(subtitle),
          onTap: () => Navigator.of(context).pushNamed(route),
        ),
      ),
    );
  }
}
