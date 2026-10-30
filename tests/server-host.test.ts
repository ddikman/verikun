import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { adbClaimBlockers, recycleHostAdb } from '../src/server-host';
import { claimsDir, claimDevice, deviceFileStem, setProcessScoped } from '../src/device/claims';

test('host recycling excludes another live job and serializes concurrent supervisors',async()=>{
  const home=mkdtempSync(join(tmpdir(),'vk-host-lock-'));
  const opts={home,env:{},cwd:'foreign-job'};
  setProcessScoped(true);
  try{
    const claim = claimDevice('foreign','android',opts);
    assert.equal(claim.ok,true);
    if (claim.ok) writeFileSync(join(claimsDir(opts),`${deviceFileStem('foreign')}.json`),JSON.stringify({...claim.claim,pid:process.ppid}));
    let restarts=0;
    assert.equal(await recycleHostAdb(opts,async()=>{restarts++;return true}),'blocked');
    assert.equal(restarts,0);
    rmSync(claimsDir(opts),{recursive:true,force:true});
    let finish!:()=>void;const busy=new Promise<void>(r=>finish=r);
    const first=recycleHostAdb(opts,async()=>{restarts++;await busy;return true});
    const second=await recycleHostAdb(opts,async()=>{restarts++;return true});
    assert.equal(second,'busy');finish();assert.equal(await first,'restarted');assert.equal(restarts,1);
    writeFileSync(join(claimsDir(opts),'adb-recycle.lock'),'999999999');
    assert.equal(await recycleHostAdb(opts,async()=>true),'restarted','dead-owner locks recover');
  }finally{setProcessScoped(false);rmSync(home,{recursive:true,force:true});}
});

/** Write a claim file as another process would have left it. */
function plant(opts: { home: string }, serial: string, claim: Record<string, unknown>): void {
  mkdirSync(claimsDir(opts), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(claimsDir(opts), `${deviceFileStem(serial)}.json`),
    JSON.stringify({ serial, platform: 'android', cwd: '/w/elsewhere', pid: 999999999, host: hostname(),
      processScoped: false, since: now, heartbeat: now, version: 'test', ...claim }),
  );
}

test('adbClaimBlockers: the vk jobs a host-wide adb restart would cut off', () => {
  const home = mkdtempSync(join(tmpdir(), 'vk-adb-blockers-'));
  const opts = { home, env: {}, cwd: '/w/this-job' };
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  try {
    plant(opts, 'thinking-agent', {}); // another job between two one-off commands (inside its TTL)
    plant(opts, 'sim-1', { platform: 'ios', pid: process.ppid, processScoped: true }); // iOS never touches adb
    plant(opts, 'my-last-tap', { cwd: '/w/this-job' }); // this job's own finished command
    plant(opts, 'my-other-terminal', { cwd: '/w/this-job', pid: process.ppid, processScoped: true }); // still running
    plant(opts, 'long-gone', { heartbeat: hourAgo, since: hourAgo }); // expired
    assert.deepEqual(adbClaimBlockers(opts).map((c) => c.serial).sort(), ['my-other-terminal', 'thinking-agent']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('recycleHostAdb: a caller-supplied gate replaces the default and is re-checked under the lock', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vk-host-gate-'));
  const opts = { home, env: {}, cwd: '/w/this-job' };
  try {
    // A live foreign claim the server's default check would refuse on — the supplied gate decides.
    plant(opts, 'foreign', { pid: process.ppid, processScoped: true });
    let restarts = 0;
    assert.equal(await recycleHostAdb(opts, async () => { restarts++; return true; }, () => false), 'restarted');
    assert.equal(restarts, 1);
    // Clear when first asked, in use once the lock is held: someone connected in between.
    const answers = [false, true];
    assert.equal(await recycleHostAdb(opts, async () => { restarts++; return true; }, () => answers.shift() ?? true), 'blocked');
    assert.equal(restarts, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('adbClaimBlockers: a job sharing only this session (tmux panes) is still somebody else', () => {
  // isMine's session-OR-cwd is right for picking a device, backwards for this gate: panes of one
  // tmux share TERM_SESSION_ID, so another worktree's agent between two commands would read as
  // this job and be restarted out from under.
  const home = mkdtempSync(join(tmpdir(), 'vk-adb-session-'));
  const opts = { home, env: { VERIKUN_SESSION: 'tmux-1' }, cwd: '/w/this-job' };
  try {
    plant(opts, 'other-worktree', { session: 'tmux-1', cwd: '/w/other-worktree' });
    assert.deepEqual(adbClaimBlockers(opts).map((c) => c.serial), ['other-worktree']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('recycleHostAdb: a lock nobody could still be holding is taken over, whatever host wrote it', async () => {
  // macOS changes its hostname with the network, and a Ctrl-C mid-restart skips the cleanup —
  // without a ceiling, such a lock would read as "another job is restarting" forever.
  const home = mkdtempSync(join(tmpdir(), 'vk-host-stale-'));
  const opts = { home, env: {}, cwd: '/w/this-job' };
  try {
    mkdirSync(claimsDir(opts), { recursive: true });
    const lock = join(claimsDir(opts), 'adb-recycle.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: 'old-hostname.local' }));
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(lock, hourAgo, hourAgo);
    let restarts = 0;
    assert.equal(await recycleHostAdb(opts, async () => { restarts++; return true; }, () => false), 'restarted');
    assert.equal(restarts, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('recycleHostAdb: a restart that does not come back is a failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vk-host-failed-'));
  try {
    assert.equal(await recycleHostAdb({ home, env: {} }, async () => false, () => false), 'failed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('recycleHostAdb: an unwritable store is a refusal, never a throw', async () => {
  // A sandboxed agent may not write ~/.verikun. Doctor must not turn that into exit 3.
  const dir = mkdtempSync(join(tmpdir(), 'vk-host-ro-'));
  const home = join(dir, 'not-a-directory');
  writeFileSync(home, '');
  try {
    assert.equal(await recycleHostAdb({ home, env: {} }, async () => true, () => false), 'unwritable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
