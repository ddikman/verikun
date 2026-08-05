import 'package:flutter/material.dart';

import '../widgets.dart';

/// Reports the DEVICE state the app is running under, as assertable text.
///
/// This is the fixture surface for `vk device set`. Without it a device-settings
/// test could only take screenshots and eyeball them; here each setting lands in a
/// `VkStatus` line, so a test can `assert @vk_dev_brightness --text dark` and get a
/// real pass/fail rather than a picture someone has to look at.
///
/// Every value comes from `MediaQuery`, i.e. from the platform — not from app state
/// — so these lines change only because the device changed underneath the app.
class DeviceScreen extends StatelessWidget {
  const DeviceScreen({super.key});

  static const route = '/device';

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final dark = media.platformBrightness == Brightness.dark;
    final landscape = media.orientation == Orientation.landscape;
    // The scale applied to a 16px body: 1.0 -> "1.00". Reported rounded to two
    // decimals because the platforms do not agree to the last digit — Android hands
    // over the float verbatim while iOS derives it from a Dynamic Type category.
    final scale = media.textScaler.scale(16) / 16;

    return Scaffold(
      appBar: AppBar(
        title: const VkScreenTitle(id: 'vk_device', title: 'Device state'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('Brightness', style: TextStyle(fontWeight: FontWeight.bold)),
          VkStatus(id: 'vk_dev_brightness', value: dark ? 'dark' : 'light'),
          const SizedBox(height: 16),
          const Text('Orientation', style: TextStyle(fontWeight: FontWeight.bold)),
          VkStatus(id: 'vk_dev_orientation', value: landscape ? 'landscape' : 'portrait'),
          const SizedBox(height: 16),
          const Text('Text scale', style: TextStyle(fontWeight: FontWeight.bold)),
          VkStatus(id: 'vk_dev_textscale', value: scale.toStringAsFixed(2)),
          const SizedBox(height: 16),
          // Ordinary body text, so it grows with the text scale like the rest of the app.
          // Its job is to still BE there after a font-scale change — an overflowing line
          // is exactly how a layout breaks at accessibility sizes.
          const Text('Sample', style: TextStyle(fontWeight: FontWeight.bold)),
          const VkStatus(id: 'vk_dev_sample', value: 'The quick brown fox'),
        ],
      ),
    );
  }
}
