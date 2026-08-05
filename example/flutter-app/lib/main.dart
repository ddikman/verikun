import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import 'screens/async_screen.dart';
import 'screens/device_screen.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/scroll_screen.dart';
import 'screens/state_screen.dart';

/// LOAD-BEARING. Flutter only builds a semantics tree while some client holds a
/// handle — normally TalkBack (Android) or VoiceOver (iOS). Without one,
/// `uiautomator dump` sees a single empty FlutterView node, `vk ui` prints
/// `(no elements)`, and every case in this app becomes untestable.
///
/// Held for the whole process lifetime and NEVER disposed: disposing the last
/// outstanding handle flips `SemanticsBinding.semanticsEnabled` back to false
/// (see `_outstandingHandles` in flutter/lib/src/semantics/binding.dart).
/// Do not "clean this up". The analyzer flags it as unused precisely because
/// nothing reads it — holding it *is* the effect.
// ignore: unused_element
late final SemanticsHandle _semanticsHandle;

void main() {
  // Must precede SemanticsBinding.instance — the binding does not exist yet.
  WidgetsFlutterBinding.ensureInitialized();
  _semanticsHandle = SemanticsBinding.instance.ensureSemantics();
  runApp(const TestApp());
}

/// The fixture holds **no persistent state** — no shared_preferences, no files,
/// no database. That is deliberate and load-bearing: `vk clear` (`pm clear`)
/// throws on iOS, where there is no per-app data reset, so `vk suite --app`
/// degrades to a force-stop. With all state in memory, `vk launch` (which
/// force-stops first by default) is a complete and *identical* reset on both
/// platforms.
class TestApp extends StatelessWidget {
  const TestApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'vk testapp',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      // A dark theme is what makes `vk device set dark=on` observable at all: with
      // only a light theme, MaterialApp's default ThemeMode.system has nothing to
      // switch to, so the device setting would land and the app would look
      // identical — a device-settings test could then pass without proving anything.
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      // Named routes, so every screen is one tap from home and a test never has
      // to navigate through another case to reach the one it wants.
      initialRoute: HomeScreen.route,
      routes: {
        HomeScreen.route: (_) => const HomeScreen(),
        LoginScreen.route: (_) => const LoginScreen(),
        AsyncScreen.route: (_) => const AsyncScreen(),
        ScrollScreen.route: (_) => const ScrollScreen(),
        StateScreen.route: (_) => const StateScreen(),
        DeviceScreen.route: (_) => const DeviceScreen(),
      },
    );
  }
}
