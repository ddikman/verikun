// Screen capture: the one place that decides HOW a screenshot is obtained.
//
// Sits between the driver (device I/O) and image.ts (pure image math) because it
// needs both, and lives apart from cli.ts so run.ts's failure-evidence capture can
// share it without an import cycle.

import type { Driver } from './types';
import { downscalePng, pngFromRaw, type ScaleResult } from './image';

/**
 * Capture the screen as a PNG whose longest edge is at most `maxEdge` px
 * (`null` = full size). `buf` is always the image to write.
 *
 * Prefers the driver's raw path — pixels straight off the device, PNG-encoded here —
 * which avoids an on-device encode of an image we are about to shrink anyway, and is
 * roughly 2x faster end to end on Android. A backend without a raw path, or one whose
 * capture came back in a shape we do not recognize, falls back to `screenshot()`, so
 * the only observable difference is how long it took.
 */
export function capturePng(driver: Driver, maxEdge: number | null): ScaleResult {
  const raw = driver.screenshotRaw?.() ?? null;
  if (raw) return pngFromRaw(raw, maxEdge);

  const png = driver.screenshot();
  if (maxEdge === null) {
    return { buf: png, width: 0, height: 0, scaled: false, origWidth: 0, origHeight: 0, reason: 'full size requested' };
  }
  return downscalePng(png, maxEdge);
}
