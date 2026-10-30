import { mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, platform } from 'node:os';
import { spawnCollect } from './exec';
import { countViolations } from './adb-health';
import { ClaimOpts, DeviceClaim, claimsDir, isLive, listClaims, pidAlive, writeExclusive } from './device/claims';

/** The server's gate: any other live verikun job on this host. */
const othersLive = (opts: ClaimOpts): boolean => listClaims(opts).some(c => c.pid !== process.pid && isLive(c, opts));

/**
 * The verikun jobs a host-wide adb restart would cut off, for a restart one job ASKED for
 * (`vk doctor --restart-adb`). Narrower than the server's gate in two ways, both because the
 * asker is not the server: an iOS claim never touches adb, and this job's own FINISHED commands
 * (a one-off `vk tap` still inside its TTL) are the asker itself. Its own LIVE processes still
 * block — a `vk ai` running in a second terminal of the same checkout is mid-flow.
 *
 * "This job" is the working directory ONLY, unlike `isMine`'s session-or-cwd. That leniency
 * is right when picking a device and backwards here: tmux panes share one TERM_SESSION_ID, so
 * another worktree's agent between two commands would pass as the asker.
 */
export function adbClaimBlockers(opts: ClaimOpts = {}): DeviceClaim[] {
  const cwd = opts.cwd ?? process.cwd();
  return listClaims(opts).filter(c => c.platform === 'android' && c.pid !== process.pid && isLive(c, opts) &&
    !(c.cwd === cwd && !pidAlive(c.pid)));
}

/** No restart holds the lock this long: seconds, plus a 20s device wait. Past it the lock is a
 *  leftover, whichever host wrote it — macOS renames itself with the network, and a Ctrl-C
 *  mid-restart skips the cleanup. */
const LOCK_TRUST_MAX_MS = 10 * 60 * 1000;

const aged = (file: string): boolean => {
  try { return Date.now() - statSync(file).mtimeMs > LOCK_TRUST_MAX_MS; } catch { return false; }
};

/** What a recycle attempt came to. Only `restarted` and `failed` ran the restart. */
export type RecycleResult = 'restarted' | 'failed' | 'blocked' | 'busy' | 'unwritable';

/**
 * Serialize host-global adb recycling and respect other live verikun jobs. `blocked` is asked
 * before taking the lock and again while holding it, so a job that arrives in between is seen.
 */
export async function recycleHostAdb(opts: ClaimOpts, restart: () => Promise<boolean>,
  blocked: () => boolean = () => othersLive(opts)): Promise<RecycleResult> {
  if (blocked()) return 'blocked';
  const dir = claimsDir(opts);
  const path = join(dir, 'adb-recycle.lock');
  const owner = { pid: process.pid, host: hostname() };
  const live = (file: string): boolean => {
    if (aged(file)) return false;
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as {pid?: number; host?: string} | number | string;
      if (typeof value === 'object') return value.host !== hostname() || pidAlive(Number(value.pid));
      return pidAlive(Number(value));
    } catch { return false; }
  };
  let acquired = false;
  let ran = false;
  try {
    // Inside the try: an unwritable store is a refusal, never a throw out of `vk doctor`.
    mkdirSync(dir, { recursive: true });
    acquired = writeExclusive(path, owner);
    if (!acquired) {
      if (live(path)) return 'busy';
      // Serialize stale replacement, then re-read under the takeover token. An
      // absent-to-present link can race safely; deleting a freshly published lock cannot.
      const takeover = `${path}.takeover`;
      if (!writeExclusive(takeover, owner)) {
        if (!aged(takeover)) return 'busy';
        try { unlinkSync(takeover); } catch { /* raced with its owner's own cleanup */ }
        if (!writeExclusive(takeover, owner)) return 'busy';
      }
      try {
        if (live(path)) return 'busy';
        try { unlinkSync(path); } catch { /* another creator may have won the absent path */ }
        acquired = writeExclusive(path, owner);
      } finally { try { unlinkSync(takeover); } catch {} }
      if (!acquired) return 'busy';
    }
    if (blocked()) return 'blocked';
    ran = true;
    return (await restart()) ? 'restarted' : 'failed';
  } catch { return ran ? 'failed' : 'unwritable'; }
  finally { if (acquired) { try { unlinkSync(path); } catch {} } }
}

export async function hostAdbRotting(): Promise<boolean> {
  if (platform() !== 'darwin') return false;
  const r = await spawnCollect('/usr/bin/log', ['show', '--last', '120s', '--style', 'compact', '--predicate',
    'process == "kernel" AND eventMessage CONTAINS "EXC_GUARD" AND eventMessage CONTAINS "[adb:"'], { timeout: 20_000 });
  return r.code === 0 && countViolations(r.stdout) > 0;
}
