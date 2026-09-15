// The remote-install time budget is shared by the client that owns the request and the
// server that may retry it. Keeping the numbers together prevents a server-side retry plan
// that can never finish before the client gives up.

/** Whole upload + install request, enforced by the remote client. */
export const REMOTE_INSTALL_TIMEOUT_MS = 15 * 60_000;

/** One device gets four minutes; a measured ~170s large install still has useful margin. */
export const INSTALL_DEVICE_TIMEOUT_MS = 4 * 60_000;

/** Three attempts consume at most 12m, leaving 3m of the request budget for the upload. */
export const MAX_INSTALL_FAILOVER_HOPS =
  Math.max(0, Math.floor(REMOTE_INSTALL_TIMEOUT_MS / INSTALL_DEVICE_TIMEOUT_MS) - 1);
