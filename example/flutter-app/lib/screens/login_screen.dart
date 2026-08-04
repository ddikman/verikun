import 'package:flutter/material.dart';

import '../widgets.dart';

/// Pins the input-and-flags half of vk's contract.
///
/// | element        | what it exercises                                        |
/// |----------------|----------------------------------------------------------|
/// | `@vk_user`     | `vk text --clear` on a **prefilled** field                |
/// | `@vk_pass`     | the `password` flag + `«redacted»` in the run report      |
/// | `@vk_remember` | `checkable` / `checked`                                   |
/// | `@vk_submit`   | disabled control vs `vk find --enabled`                   |
/// | `@vk_login_ok` | `vk assert --text` against a Flutter node                 |
///
/// `--clear` is the subtle one. `cmdText` only clears when the *resolved
/// element* reports non-empty `text`. On Android a Flutter field's value does
/// surface in `text`, so `--clear` works; the username is prefilled so that is
/// exercised rather than assumed. On iOS it does not: `text` is `AXLabel ||
/// title || AXValue` and the label wins, so a filled field reports
/// `text="Username"` and `--clear` would size deletions from the label — hence
/// the typing case is Android-only.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  static const route = '/login';

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  // Prefilled on purpose — see the class doc.
  final _user = TextEditingController(text: 'prefilled@example.com');
  final _pass = TextEditingController();
  bool _remember = false;
  bool _submitted = false;

  /// Submit stays disabled until both fields have content, so a test can flip a
  /// control from `enabled="false"` to `enabled="true"` and watch
  /// `vk find --enabled` change its answer.
  bool get _canSubmit => _user.text.isNotEmpty && _pass.text.isNotEmpty;

  @override
  void dispose() {
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const VkScreenTitle(id: 'vk_login', title: 'Login'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          VkField(
            id: 'vk_user',
            label: 'Username',
            controller: _user,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 16),
          VkField(
            id: 'vk_pass',
            label: 'Password',
            controller: _pass,
            obscureText: true,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 8),
          VkCheckbox(
            id: 'vk_remember',
            label: 'Remember me',
            value: _remember,
            onChanged: (v) => setState(() => _remember = v),
          ),
          const SizedBox(height: 8),
          VkButton(
            id: 'vk_submit',
            label: 'Sign In',
            onPressed: _canSubmit
                ? () => setState(() => _submitted = true)
                : null,
          ),
          const SizedBox(height: 24),
          // Absent until submit, so `vk assert @vk_login_ok --gone` has a real
          // disappearance to wait for and the happy path has a real arrival.
          if (_submitted) const VkStatus(id: 'vk_login_ok', value: 'Signed in'),
        ],
      ),
    );
  }
}
