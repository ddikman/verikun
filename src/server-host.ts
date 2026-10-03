import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, platform } from 'node:os';
import { spawnCollect } from './exec';
import { countViolations } from './adb-health';
import { ClaimOpts, claimsDir, isLive, listClaims, pidAlive, writeExclusive } from './device/claims';

/** Serialize host-global adb recycling and respect other live verikun jobs. */
export async function recycleHostAdb(opts: ClaimOpts, restart: () => Promise<boolean>): Promise<boolean> {
  if (listClaims(opts).some(c => c.pid !== process.pid && isLive(c, opts))) return false;
  const dir = claimsDir(opts); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'adb-recycle.lock');
  const owner = { pid: process.pid, host: hostname() };
  const live = (file: string): boolean => {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as {pid?: number; host?: string} | number | string;
      if (typeof value === 'object') return value.host !== hostname() || pidAlive(Number(value.pid));
      return pidAlive(Number(value));
    } catch { return false; }
  };
  let acquired = false;
  try {
    acquired = writeExclusive(path, owner);
    if (!acquired) {
      if (live(path)) return false;
      // Serialize stale replacement, then re-read under the takeover token. An
      // absent-to-present link can race safely; deleting a freshly published lock cannot.
      const takeover = `${path}.takeover`;
      if (!writeExclusive(takeover, owner)) return false;
      try {
        if (live(path)) return false;
        try { unlinkSync(path); } catch { /* another creator may have won the absent path */ }
        acquired = writeExclusive(path, owner);
      } finally { try { unlinkSync(takeover); } catch {} }
      if (!acquired) return false;
    }
    if (listClaims(opts).some(c => c.pid !== process.pid && isLive(c, opts))) return false;
    return await restart();
  } catch { return false; }
  finally { if (acquired) { try { unlinkSync(path); } catch {} } }
}

export async function hostAdbRotting(): Promise<boolean> {
  if (platform() !== 'darwin') return false;
  const r = await spawnCollect('/usr/bin/log', ['show', '--last', '120s', '--style', 'compact', '--predicate',
    'process == "kernel" AND eventMessage CONTAINS "EXC_GUARD" AND eventMessage CONTAINS "[adb:"'], { timeout: 20_000 });
  return r.code === 0 && countViolations(r.stdout) > 0;
}
