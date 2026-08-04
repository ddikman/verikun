import 'dart:async';

import 'package:flutter/material.dart';

import '../widgets.dart';

/// Pins vk's **auto-wait window** — the behaviour with no other on-device test.
///
/// Every selector lookup auto-waits ~5000 ms by default. The three presets
/// straddle that boundary deliberately:
///
/// - `@vk_delay_1` / `@vk_delay_3` — resolve *inside* the default window, so
///   `vk assert @vk_loaded` passes with no flags and reports `(waited 1.2s)`.
/// - `@vk_delay_8` — resolves *outside* it, so the bare assert must fail with
///   exit 1 and `--wait 12s` must pass. That pair is the whole point: it proves
///   the default both fires and is overridable.
///
/// The delay is a plain `Future.delayed`, **not** a network call. The fixture
/// stays hermetic — it works on a phone in airplane mode and never fails for a
/// reason that isn't vk's.
class AsyncScreen extends StatefulWidget {
  const AsyncScreen({super.key});

  static const route = '/async';

  @override
  State<AsyncScreen> createState() => _AsyncScreenState();
}

enum _Phase { idle, loading, loaded, failed }

class _AsyncScreenState extends State<AsyncScreen> {
  _Phase _phase = _Phase.idle;
  int _delaySeconds = 1;
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _start({required bool succeed}) {
    _timer?.cancel();
    setState(() => _phase = _Phase.loading);
    _timer = Timer(Duration(seconds: _delaySeconds), () {
      if (!mounted) return;
      setState(() => _phase = succeed ? _Phase.loaded : _Phase.failed);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const VkScreenTitle(id: 'vk_async', title: 'Delayed load'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          VkStatus(id: 'vk_delay_current', value: 'Delay: ${_delaySeconds}s'),
          const SizedBox(height: 12),
          Row(
            children: [
              for (final s in [1, 3, 8])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: VkButton(
                    id: 'vk_delay_$s',
                    label: '${s}s',
                    onPressed: () => setState(() => _delaySeconds = s),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
          VkButton(
            id: 'vk_load',
            label: 'Load',
            onPressed: () => _start(succeed: true),
          ),
          const SizedBox(height: 8),
          VkButton(
            id: 'vk_fail',
            label: 'Load (fails)',
            onPressed: () => _start(succeed: false),
          ),
          const SizedBox(height: 24),
          if (_phase == _Phase.loading) ...[
            // A real spinner: an animating widget, so we can measure whether
            // it prevents `uiautomator dump` from reaching idle.
            const VkSpinner(id: 'vk_spinner'),
            const SizedBox(height: 12),
            // A NON-animating sibling of the spinner. If a dump fails while
            // this is on screen, the animation is the cause — this element
            // makes that attributable instead of a guess.
            const VkStatus(id: 'vk_loading_text', value: 'Loading…'),
          ],
          if (_phase == _Phase.loaded)
            const VkStatus(id: 'vk_loaded', value: 'Loaded'),
          if (_phase == _Phase.failed)
            const VkStatus(id: 'vk_error', value: 'Request timed out'),
        ],
      ),
    );
  }
}
