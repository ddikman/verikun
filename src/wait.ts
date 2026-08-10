// Time helpers shared by the selector auto-wait (cli.ts) and device lifecycle
// (drivers/lifecycle.ts). Pure, platform-agnostic, zero-dep.

/** Poll interval (ms) used by device lifecycle waits. */
export const DEFAULT_DEVICE_POLL_MS = 1000;
/** A cold AVD on a laptop takes 60-120s; CI is slower. */
export const DEFAULT_BOOT_TIMEOUT_MS = 180_000;
export const DEFAULT_STOP_TIMEOUT_MS = 60_000;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A progress callback that fires at most once per `everyMs`, timed from when it was
 * CREATED. Multi-phase waits (find the serial, then wait for boot) chain several
 * pollUntil calls, each of which restarts its own elapsed counter — so throttling on
 * the per-poll elapsed both double-reports and reports the wrong number ("…0s" twice).
 * Anchoring here reports one honest clock for the whole operation.
 */
export function throttledProgress(
  onProgress: ((message: string) => void) | undefined,
  everyMs: number,
  render: (elapsedMs: number) => string,
): () => void {
  const t0 = Date.now();
  let lastAt = 0;
  return () => {
    if (!onProgress) return;
    const elapsed = Date.now() - t0;
    if (elapsed - lastAt < everyMs) return;
    lastAt = elapsed;
    onProgress(render(elapsed));
  };
}

/**
 * Poll `probe` until it returns a value other than `undefined`, or the window
 * elapses (then `undefined`). Return `undefined` from `probe` to keep polling —
 * so a boolean probe returns `true | undefined`, never `false`.
 *
 * Each probe MUST be short. Everything in this repo shells out via `spawnSync`,
 * which blocks the event loop for the duration of the child process; it is the
 * AWAITED GAP between probes that keeps timers and sockets alive. That is what
 * lets `vk server` keep answering /v1/health through a 30-120s device boot —
 * a single blocking `simctl bootstatus -b` / `adb wait-for-device` would not.
 */
export async function pollUntil<T>(
  probe: () => T | undefined,
  opts: { timeoutMs: number; intervalMs?: number; onTick?: (elapsedMs: number) => void },
): Promise<T | undefined> {
  const interval = opts.intervalMs ?? DEFAULT_DEVICE_POLL_MS;
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  for (;;) {
    const hit = probe();
    if (hit !== undefined) return hit;
    const now = Date.now();
    if (now >= deadline) return undefined;
    opts.onTick?.(now - started);
    // Never overshoot the deadline — the caller's timeout is the ceiling.
    await sleep(Math.min(interval, deadline - now));
  }
}
