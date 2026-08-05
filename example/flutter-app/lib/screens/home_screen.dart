import 'package:flutter/material.dart';

import '../widgets.dart';
import 'async_screen.dart';
import 'device_screen.dart';
import 'login_screen.dart';
import 'scroll_screen.dart';
import 'state_screen.dart';

/// The launch screen and the fixture's reset anchor.
///
/// Because the app holds no persistent state, `vk launch dev.verikun.testapp`
/// (which force-stops before launching) always lands here — so every test can
/// begin by asserting `@vk_home` and know exactly what is on screen.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  static const route = '/';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const VkScreenTitle(id: 'vk_home', title: 'vk testapp'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: const [
          VkNavTile(
            id: 'vk_nav_login',
            title: 'Login',
            subtitle: 'password, clear, enabled, checked',
            route: LoginScreen.route,
          ),
          VkNavTile(
            id: 'vk_nav_async',
            title: 'Delayed load',
            subtitle: 'auto-wait window, wait, assert gone',
            route: AsyncScreen.route,
          ),
          VkNavTile(
            id: 'vk_nav_scroll',
            title: 'Long list',
            subtitle: 'off-screen elements, auto scroll-into-view',
            route: ScrollScreen.route,
          ),
          VkNavTile(
            id: 'vk_nav_state',
            title: 'State flags',
            subtitle: 'selected, focused, a toggle you must guard',
            route: StateScreen.route,
          ),
          VkNavTile(
            id: 'vk_nav_device',
            title: 'Device state',
            subtitle: 'dark mode, text scale, orientation',
            route: DeviceScreen.route,
          ),
        ],
      ),
    );
  }
}
