// The client upload ceiling and the server's per-target install ceiling are distinct.

/** Whole upload + install request, enforced by the remote client. */
export const REMOTE_INSTALL_TIMEOUT_MS = 15 * 60_000;

/** One device gets four minutes; a measured ~170s large install still has useful margin. */
export const INSTALL_DEVICE_TIMEOUT_MS = 4 * 60_000;
