import 'package:flutter/material.dart';

import '../widgets.dart';

/// Pins vk's **auto scroll-into-view**, and the two ways a tap used to press the
/// wrong thing and still report success (issue #42).
///
/// | element             | what it exercises                                        |
/// |---------------------|----------------------------------------------------------|
/// | `@vk_scroll_row_N`  | every row is a button that records ITS OWN id, so "the    |
/// |                     | tap landed somewhere else" is an assertion, not a guess   |
/// | `@vk_scroll_target` | a row far below the fold — `tap` must scroll to it        |
/// | `@vk_scroll_decoy`  | a full-width sticky bar the list scrolls UNDER; whatever   |
/// |                     | a misdirected tap hits near the bottom edge, it hits this |
/// | `@vk_scroll_result` | which control actually fired (in the AppBar, always seen) |
/// | `@vk_scroll_mode`   | flips the list between eager and lazy                    |
///
/// **The list is deliberately eager and unclipped.** MEASURED on emulator API 34:
/// with Flutter's defaults, Android's dumper reports only the rows actually on
/// screen — a `ListView.builder` never builds the far ones, and the viewport clips
/// away those it did. There is then no off-screen element in the hierarchy at all
/// and nothing to reproduce. `cacheExtent` keeps every row laid out and
/// `clipBehavior: Clip.none` keeps them reported, with their real coordinates.
///
/// **The bar is a `Stack` overlay, not a `bottomNavigationBar`**, so the list runs
/// underneath it. That is the layout in which a row is geometrically on screen, and
/// inside its list, yet has a sticky control drawn across its middle — the tap goes
/// to whatever is on top, and the step passes.
///
/// `@vk_scroll_mode` flips to `ListView.builder` so the honest limit is pinned too:
/// vk can only scroll to what the hierarchy contains, and a row that was never built
/// is a plain "not found" rather than a silent wrong tap.
class ScrollScreen extends StatefulWidget {
  const ScrollScreen({super.key});

  static const route = '/scroll';

  @override
  State<ScrollScreen> createState() => _ScrollScreenState();
}

class _ScrollScreenState extends State<ScrollScreen> {
  /// Fixed heights and counts so the target is far below the fold on any phone:
  /// row 30 at 96dp each is over three screens down on the largest of them.
  static const _rowCount = 40;
  static const _rowHeight = 96.0;
  static const _targetRow = 30;

  bool _lazy = false;
  String _result = 'none';

  void _record(String who) => setState(() => _result = who);

  Widget _row(int i) {
    final target = i == _targetRow;
    return SizedBox(
      height: _rowHeight,
      child: Center(
        child: VkButton(
          id: target ? 'vk_scroll_target' : 'vk_scroll_row_$i',
          label: target ? 'Target row' : 'Row $i',
          onPressed: () => _record(target ? 'target' : 'row_$i'),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const VkScreenTitle(id: 'vk_scroll', title: 'Long list'),
        actions: [
          // In the AppBar rather than the bottom bar so a test can always read the
          // outcome without scrolling, and so the bar below stays a single target.
          Center(child: VkStatus(id: 'vk_scroll_result', value: _result)),
          const SizedBox(width: 12),
          VkButton(
            id: 'vk_scroll_mode',
            label: _lazy ? 'Lazy' : 'Eager',
            onPressed: () => setState(() {
              _lazy = !_lazy;
              _result = 'none';
            }),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Stack(
        children: [
          if (_lazy)
            ListView.builder(itemCount: _rowCount, itemBuilder: (_, i) => _row(i))
          else
            ListView(
              cacheExtent: _rowCount * _rowHeight,
              clipBehavior: Clip.none,
              children: List.generate(_rowCount, _row),
            ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            // Full width, so any tap that strays into the bottom strip lands here
            // and says so — the wrong-control case needs no luck to reproduce.
            child: Material(
              elevation: 8,
              child: Padding(
                // Tall enough that it covers the CENTRE of the row it overlaps, not
                // just an edge — that is the case where a centre tap goes astray.
                padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 8),
                child: SizedBox(
                  width: double.infinity,
                  child: VkButton(
                    id: 'vk_scroll_decoy',
                    label: 'Decoy',
                    onPressed: () => _record('decoy'),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
