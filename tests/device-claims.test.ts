import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  assertClaimable,
  claimDevice,
  claimTtlMs,
  claimsDir,
  claimsEnabled,
  describeClaim,
  isLive,
  isMine,
  listClaims,
  readClaim,
  releaseClaim,
  releaseOwnClaims,
  selectAndClaim,
  setProcessScoped,
  summarize,
  touchClaim,
  type ClaimOpts,
  type DeviceClaim,
} from '../src/device/claims';
import { CliError } from '../src/errors';

// The device claim store: which attached device another job is already driving.
//
// Everything here injects `home`/`cwd`/`now`/`env`/`host` rather than touching the real
// `$HOME` — the store is $HOME-relative, so unlike the run-state tests there is nothing to
// `process.chdir` into. That also means the "two parallel agents" case is expressible
// directly: two calls that differ only in `cwd` ARE two jobs.

const HOST = 'test-host';
let home: string;

/** Base options: a throwaway store, a stable host, and an env with no session set. */
function opts(over: Partial<ClaimOpts> = {}): ClaimOpts {
  return { home, host: HOST, env: {}, cwd: '/work/alpha', ...over };
}

/** A second job: same host, different working directory. */
const beta = (over: Partial<ClaimOpts> = {}) => opts({ cwd: '/work/beta', ...over });

/** `assert.throws` is typed void, and these refusals are judged by what they SAY. */
function caught(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected a throw, got none');
}

/**
 * Write a claim file by hand — the only way to test a pid that is not ours.
 *
 * The default pid is 2**22, above every platform's `pid_max` and therefore never running:
 * a planted claim means "somebody else's, and their process is gone", which is the state
 * worth testing. Pass `pid: process.pid` where the point is a job still working.
 */
const DEAD_PID = 4194304;

function plant(serial: string, over: Partial<DeviceClaim> = {}): DeviceClaim {
  const claim: DeviceClaim = {
    serial,
    platform: 'android',
    cwd: '/work/gamma',
    pid: DEAD_PID,
    host: HOST,
    processScoped: false,
    since: new Date(0).toISOString(),
    heartbeat: new Date(0).toISOString(),
    version: 'test',
    ...over,
  };
  const dir = claimsDir({ home });
  mkdirSync(dir, { recursive: true });
  // Reuse the module's own filename derivation by claiming and overwriting, so a change
  // to the naming scheme cannot silently desync this fixture from the code under test.
  claimDevice(serial, 'android', opts({ cwd: claim.cwd }));
  const file = readdirSync(dir).find((f) => f.includes(serial.replace(/[^A-Za-z0-9._-]/g, '_')));
  writeFileSync(join(dir, file!), JSON.stringify(claim, null, 2));
  return claim;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vk-claims-'));
  setProcessScoped(false);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// --- environment ------------------------------------------------------------

describe('environment', () => {
  test('claims are on by default and off for any non-empty VERIKUN_NO_CLAIM', () => {
    assert.equal(claimsEnabled({}), true);
    assert.equal(claimsEnabled({ VERIKUN_NO_CLAIM: '1' }), false);
    // Mirrors VERIKUN_NO_RUN: presence disables, the value is not parsed.
    assert.equal(claimsEnabled({ VERIKUN_NO_CLAIM: 'yes' }), false);
    assert.equal(claimsEnabled({ VERIKUN_NO_CLAIM: '' }), true);
  });

  test('claimTtlMs: 5 minutes by default, tunable, and junk falls back rather than throwing', () => {
    assert.equal(claimTtlMs({}), 5 * 60000);
    assert.equal(claimTtlMs({ VERIKUN_CLAIM_TTL_MIN: '12' }), 12 * 60000);
    assert.equal(claimTtlMs({ VERIKUN_CLAIM_TTL_MIN: '0' }), 0);
    assert.equal(claimTtlMs({ VERIKUN_CLAIM_TTL_MIN: 'soon' }), 5 * 60000);
    assert.equal(claimTtlMs({ VERIKUN_CLAIM_TTL_MIN: '-3' }), 5 * 60000);
  });
});

// --- store ------------------------------------------------------------------

describe('store', () => {
  test('claim then read round-trips, and nothing is written before the first claim', () => {
    assert.equal(readClaim('emulator-5554', opts()), null);
    assert.deepEqual(listClaims(opts()), []);

    const r = claimDevice('emulator-5554', 'android', opts());
    assert.equal(r.ok, true);

    const back = readClaim('emulator-5554', opts());
    assert.equal(back?.serial, 'emulator-5554');
    assert.equal(back?.cwd, '/work/alpha');
    assert.equal(back?.platform, 'android');
    assert.equal(listClaims(opts()).length, 1);
  });

  test('a serial with punctuation gets its own file (a wireless adb target must not collide)', () => {
    claimDevice('192.168.1.5:5555', 'android', opts());
    claimDevice('192.168.1.5_5555', 'android', opts());
    assert.equal(listClaims(opts()).length, 2);
    assert.equal(readClaim('192.168.1.5:5555', opts())?.serial, '192.168.1.5:5555');
    assert.equal(readClaim('192.168.1.5_5555', opts())?.serial, '192.168.1.5_5555');
  });

  test('a corrupt claim file reads as UNCLAIMED, so a poisoned file cannot brick a device', () => {
    claimDevice('emulator-5554', 'android', beta());
    const dir = claimsDir({ home });
    const file = readdirSync(dir)[0];
    writeFileSync(join(dir, file), '{not json');

    assert.equal(readClaim('emulator-5554', opts()), null);
    assert.deepEqual(listClaims(opts()), []);
    // ...and it is takeable, not merely invisible.
    assert.equal(claimDevice('emulator-5554', 'android', opts()).ok, true);
    assert.equal(readClaim('emulator-5554', opts())?.cwd, '/work/alpha');
  });

  test('JSON that parses but is not a claim is also treated as unclaimed', () => {
    claimDevice('emulator-5554', 'android', opts());
    const dir = claimsDir({ home });
    writeFileSync(join(dir, readdirSync(dir)[0]), JSON.stringify({ hello: 'world' }));
    assert.equal(readClaim('emulator-5554', opts()), null);
  });

  test('listClaims skips non-JSON droppings (a half-written temp file is not a claim)', () => {
    claimDevice('emulator-5554', 'android', opts());
    writeFileSync(join(claimsDir({ home }), 'x.json.tmp-1-2'), 'garbage');
    assert.equal(listClaims(opts()).length, 1);
  });
});

// --- ownership (D3) ---------------------------------------------------------

describe('ownership', () => {
  test('the same working directory is the same job', () => {
    claimDevice('emulator-5554', 'android', opts());
    const held = readClaim('emulator-5554', opts())!;
    assert.equal(isMine(held, opts()), true);
    assert.equal(isMine(held, beta()), false);
  });

  test('a matching session is the same job even from a different directory', () => {
    const env = { VERIKUN_SESSION: 'sess-1' };
    claimDevice('emulator-5554', 'android', opts({ env }));
    const held = readClaim('emulator-5554', opts({ env }))!;
    // Different cwd, same session -> still mine. This is the forgiving direction on
    // purpose: the only unsafe error is falsely accusing your own job.
    assert.equal(isMine(held, beta({ env })), true);
    assert.equal(isMine(held, beta({ env: { VERIKUN_SESSION: 'sess-2' } })), false);
  });

  test('TERM_SESSION_ID stands in when VERIKUN_SESSION is unset', () => {
    const env = { TERM_SESSION_ID: 'tab-7' };
    claimDevice('emulator-5554', 'android', opts({ env }));
    const held = readClaim('emulator-5554', opts({ env }))!;
    assert.equal(held.session, 'tab-7');
    assert.equal(isMine(held, beta({ env })), true);
  });

  test('with no session anywhere, ownership is decided by cwd alone', () => {
    claimDevice('emulator-5554', 'android', opts());
    const held = readClaim('emulator-5554', opts())!;
    assert.equal(held.session, undefined);
    assert.equal(isMine(held, beta()), false);
  });
});

// --- liveness (D4) ----------------------------------------------------------

describe('liveness', () => {
  const t0 = Date.parse('2026-08-13T12:00:00.000Z');

  test('a one-off command holds its device for the TTL and no longer', () => {
    // A command that has already exited, which is the whole point of the TTL.
    const c = plant('emulator-5554', { processScoped: false, heartbeat: new Date(t0).toISOString() });
    assert.equal(isLive(c, opts({ now: t0 + 60_000 })), true, '1m in');
    assert.equal(isLive(c, opts({ now: t0 + 4 * 60_000 })), true, '4m in');
    assert.equal(isLive(c, opts({ now: t0 + 6 * 60_000 })), false, 'past the 5m default');
  });

  test('a one-off command STILL RUNNING keeps its device past the TTL', () => {
    // The heartbeat only fires between commands, so a single long one — a big `install`,
    // a `wait --timeout 600000` — has no way to report that it is still working. Its own
    // live pid is the evidence, and it must never be taken as merely idle.
    const c = plant('emulator-5554', { processScoped: false, pid: process.pid, heartbeat: new Date(t0).toISOString() });
    assert.equal(isLive(c, opts({ now: t0 + 30 * 60_000 })), true, 'half an hour into one command');
  });

  test('a process-scoped claim outlives the TTL while its process is alive', () => {
    // A ten-minute `install` or a model repair round-trip cannot heartbeat through
    // itself; the pid is what stops the device being taken out from under it.
    const c = plant('emulator-5554', { processScoped: true, pid: process.pid, heartbeat: new Date(t0).toISOString() });
    assert.equal(isLive(c, opts({ now: t0 + 60 * 60_000 })), true, 'an hour in, still running');
  });

  test('a process-scoped claim dies the instant its process does — no waiting out the TTL', () => {
    const c = plant('emulator-5554', { processScoped: true, heartbeat: new Date(t0).toISOString() });
    assert.equal(isLive(c, opts({ now: t0 + 1000 })), false, 'heartbeat is one second old but the job is gone');
  });

  test('a pid from another host is not evidence of anything — fall back to the TTL', () => {
    const c = plant('emulator-5554', {
      processScoped: true,
      host: 'someone-elses-laptop',
      heartbeat: new Date(t0).toISOString(),
    });
    assert.equal(isLive(c, opts({ now: t0 + 60_000 })), true, 'fresh heartbeat, unknowable pid');
    assert.equal(isLive(c, opts({ now: t0 + 6 * 60_000 })), false, 'stale heartbeat');
  });

  test('an ancient process-scoped claim is dead even if some process now owns that pid', () => {
    const c = plant('emulator-5554', { processScoped: true, pid: process.pid, heartbeat: new Date(t0).toISOString() });
    assert.equal(isLive(c, opts({ now: t0 + 7 * 60 * 60_000 })), false, 'past the pid-trust ceiling');
  });

  test('an unparseable heartbeat reads as ancient, so a malformed claim is takeable', () => {
    const c = plant('emulator-5554', { heartbeat: 'whenever' });
    assert.equal(isLive(c, opts({ now: t0 })), false);
  });

  test('VERIKUN_CLAIM_TTL_MIN=0 makes a one-off claim expire immediately', () => {
    const c = plant('emulator-5554', { heartbeat: new Date(t0).toISOString() });
    assert.equal(isLive(c, opts({ now: t0, env: { VERIKUN_CLAIM_TTL_MIN: '0' } })), false);
  });
});

// --- acquisition ------------------------------------------------------------

describe('acquisition', () => {
  test('a second job is refused a device the first is driving', () => {
    assert.equal(claimDevice('emulator-5554', 'android', opts()).ok, true);
    const r = claimDevice('emulator-5554', 'android', beta());
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.held?.cwd, '/work/alpha');
    // The loser did not overwrite the winner.
    assert.equal(readClaim('emulator-5554', opts())?.cwd, '/work/alpha');
  });

  test('re-claiming my own device keeps `since` — how long I have held it is the useful number', () => {
    const t0 = Date.parse('2026-08-13T12:00:00.000Z');
    claimDevice('emulator-5554', 'android', opts({ now: t0 }));
    claimDevice('emulator-5554', 'android', opts({ now: t0 + 90_000 }));
    const held = readClaim('emulator-5554', opts())!;
    assert.equal(held.since, new Date(t0).toISOString());
    assert.equal(held.heartbeat, new Date(t0 + 90_000).toISOString());
  });

  // The invariant the takeover path exists to preserve. `ok: true` is a licence to drive a
  // device, so it must be backed by a claim file that is actually ours — anything else puts
  // two jobs on one phone, which is the whole failure this feature prevents. The bug it
  // guards against: after losing an `unlink` race, the old code re-read the path, found it
  // momentarily empty (the winner had not published yet), and returned success anyway.
  const assertOwnershipIsReal = (r: ReturnType<typeof claimDevice>, o: ClaimOpts) => {
    if (!r.ok) return;
    const onDisk = readClaim('emulator-5554', o);
    assert.ok(onDisk, 'ok:true must leave a readable claim on disk');
    assert.ok(isMine(onDisk!, o), `ok:true must leave a claim owned by ${o.cwd}, got ${onDisk!.cwd}`);
  };

  test('taking over a dead claim leaves a real claim file, not just a success', () => {
    plant('emulator-5554', { cwd: '/work/gamma' });
    const r = claimDevice('emulator-5554', 'android', opts());
    assert.equal(r.ok, true);
    assertOwnershipIsReal(r, opts());
  });

  test('taking over an UNREADABLE claim is exclusive too, not an unconditional overwrite', () => {
    // A corrupt file used to be replaced with a plain overwrite, so every racer "won" it.
    claimDevice('emulator-5554', 'android', beta());
    writeFileSync(join(claimsDir({ home }), readdirSync(claimsDir({ home }))[0]), '{ truncated');

    const first = claimDevice('emulator-5554', 'android', opts());
    assert.equal(first.ok, true);
    assertOwnershipIsReal(first, opts());

    // A third job arriving after the repair sees a normal, live claim and is refused.
    const second = claimDevice('emulator-5554', 'android', opts({ cwd: '/work/gamma' }));
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.held?.cwd, '/work/alpha');
  });

  /** The path of the exclusive token a taker holds while replacing a dead claim. */
  const tokenPath = (serial: string) => {
    const dir = claimsDir({ home });
    const file = readdirSync(dir).find((f) => f.startsWith(serial) && f.endsWith('.json'));
    return join(dir, `${file}.takeover`);
  };

  // Replacing a dead claim cannot be unlink-then-create: between reading "this is dead" and
  // unlinking it, another taker can publish, and the unlink then deletes a LIVE claim —
  // two jobs, one device. A taker therefore first wins an exclusive token, and only the
  // token holder may write the claim path. These two cases pin that deterministically; the
  // multi-process races below exercise it, but only detect a regression under load.
  test('a live takeover token keeps a second taker off a dead claim', () => {
    plant('emulator-5554', { cwd: '/work/abandoned' });
    writeFileSync(
      tokenPath('emulator-5554'),
      // Owned by a pid that is definitely running (ours), i.e. a taker mid-takeover.
      JSON.stringify({ serial: 'emulator-5554', cwd: '/work/other-taker', pid: process.pid, host: HOST }),
    );

    const r = claimDevice('emulator-5554', 'android', opts());
    assert.equal(r.ok, false, 'must not replace a dead claim while another taker holds the token');
    assert.equal(readClaim('emulator-5554', opts())?.cwd, '/work/abandoned', 'the dead claim must be left alone');
  });

  test('a token abandoned by a dead process does not block takeover forever', () => {
    plant('emulator-5554', { cwd: '/work/abandoned' });
    writeFileSync(
      tokenPath('emulator-5554'),
      JSON.stringify({ serial: 'emulator-5554', cwd: '/work/crashed-taker', pid: DEAD_PID, host: HOST }),
    );

    const r = claimDevice('emulator-5554', 'android', opts());
    assert.equal(r.ok, true, 'a crashed taker must not strand the device');
    assert.equal(readClaim('emulator-5554', opts())?.cwd, '/work/alpha');
    assert.equal(existsSync(tokenPath('emulator-5554')), false, 'the token is released when the takeover ends');
  });

  test('a dead claim is taken over, and `since` restarts for the new owner', () => {
    const t0 = Date.parse('2026-08-13T12:00:00.000Z');
    plant('emulator-5554', { cwd: '/work/gamma', heartbeat: new Date(t0).toISOString() });
    const late = t0 + 60 * 60_000;
    assert.equal(claimDevice('emulator-5554', 'android', opts({ now: late })).ok, true);
    const held = readClaim('emulator-5554', opts())!;
    assert.equal(held.cwd, '/work/alpha');
    assert.equal(held.since, new Date(late).toISOString());
  });
});

// --- concurrency ------------------------------------------------------------

describe('concurrent acquisition', () => {
  // The property the whole store rests on: N agents starting at the same instant must
  // produce exactly ONE owner. Only real processes can show it — in-process calls are
  // serialized by the event loop, so they would pass no matter what the writer did.
  //
  // Scope, honestly: this pins EXCLUSIVITY, not the publish window. The `writeFileSync(…,
  // {flag:'wx'})` this replaced also passes here, because its create-then-fill gap is
  // microseconds and only opens under real load (where it was seen to hand one device to
  // three racers). A test that reproduced that reliably would have to load the machine,
  // which does not belong in a unit suite — `writeExclusive` closes the gap structurally
  // instead, and this guards the invariant that would break if the exclusive create were
  // ever swapped for a plain write.
  //
  // Device-free (no adb, no xcrun) — it only touches a temp claim store — so it belongs in
  // the unit suite rather than tests/e2e.
  const RACERS = 16;

  test(`${RACERS} processes racing for one device yield exactly one winner`, () => {
    const claims = require.resolve('../src/device/claims');
    // Arguments travel by environment, not argv: under `node -e` there is no script path,
    // so argv[1] is already the first user argument and a slice(2) would silently drop one.
    const child = `
      const { claimDevice } = require(${JSON.stringify(claims)});
      const r = claimDevice('emulator-5554', 'android', {
        home: process.env.VK_TEST_HOME,
        cwd: process.env.VK_TEST_CWD,
        env: {},
        host: 'race-host',
      });
      process.stdout.write(r.ok ? 'WON' : 'LOST');
    `;

    // Spawn first, then let them all run: staggering the starts would hide the race.
    const kids = Array.from({ length: RACERS }, (_, i) =>
      spawn(process.execPath, ['-e', child], {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, VK_TEST_HOME: home, VK_TEST_CWD: `/work/racer-${i}` },
      }),
    );
    const results = kids.map(
      (k) =>
        new Promise<string>((res) => {
          let out = '';
          k.stdout.on('data', (b: Buffer) => (out += b.toString()));
          k.on('close', () => res(out));
        }),
    );

    return Promise.all(results).then((outcomes) => {
      const won = outcomes.filter((o) => o === 'WON');
      assert.equal(won.length, 1, `expected exactly 1 winner, got ${won.length} of ${outcomes.length}: ${outcomes}`);

      // And the one file on disk names the winner — no torn or empty claim survives.
      const claim = readClaim('emulator-5554', opts({ host: 'race-host' }));
      assert.ok(claim, 'the winning claim must be readable');
      assert.match(claim!.cwd, /^\/work\/racer-\d+$/);
      assert.equal(listClaims(opts()).length, 1, 'exactly one claim file, no scratch left behind');
    });
  });

  test(`${RACERS} processes racing to TAKE OVER one dead claim yield exactly one winner`, () => {
    // The harder race: every racer agrees the incumbent is dead, so all of them try to
    // replace it. Unlink-then-create loses here — one racer's unlink deletes another's
    // freshly published claim — which is why takeover goes through an exclusive token.
    //
    // Same caveat as the test above, and it bit during development: this detects the bug
    // only under load. It caught two-winners at 16 racers on a machine running two e2e
    // suites, and passed 20/20 against the same broken code once the box went quiet. The
    // DETERMINISTIC guards for this path are the two takeover-token tests in `acquisition`;
    // this one is a smoke test that never false-alarms, not the gate.
    plant('emulator-5554', { cwd: '/work/abandoned', host: 'race-host' });

    const claims = require.resolve('../src/device/claims');
    const child = `
      const { claimDevice } = require(${JSON.stringify(claims)});
      const r = claimDevice('emulator-5554', 'android', {
        home: process.env.VK_TEST_HOME,
        cwd: process.env.VK_TEST_CWD,
        env: {},
        host: 'race-host',
      });
      process.stdout.write(r.ok ? 'WON' : 'LOST');
    `;
    const kids = Array.from({ length: RACERS }, (_, i) =>
      spawn(process.execPath, ['-e', child], {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, VK_TEST_HOME: home, VK_TEST_CWD: `/work/taker-${i}` },
      }),
    );
    const results = kids.map(
      (k) =>
        new Promise<string>((res) => {
          let out = '';
          k.stdout.on('data', (b: Buffer) => (out += b.toString()));
          k.on('close', () => res(out));
        }),
    );

    return Promise.all(results).then((outcomes) => {
      const won = outcomes.filter((o) => o === 'WON');
      assert.equal(won.length, 1, `expected exactly 1 taker, got ${won.length} of ${outcomes.length}: ${outcomes}`);

      const claim = readClaim('emulator-5554', opts({ host: 'race-host' }));
      assert.ok(claim, 'the winning taker must have published a claim');
      assert.match(claim!.cwd, /^\/work\/taker-\d+$/, 'the abandoned claim must be gone, not merely reported dead');
      assert.equal(listClaims(opts()).length, 1);
    });
  });
});

// --- selection --------------------------------------------------------------

describe('selectAndClaim', () => {
  const pool = [
    { serial: '032AY1UNR2', model: 'Pixel_3a' },
    { serial: 'emulator-5554', model: 'sdk_gphone64_arm64' },
  ];

  test('takes the first free device, in the backend\'s own order', () => {
    const r = selectAndClaim(pool, 'android', opts());
    assert.equal(r.serial, '032AY1UNR2');
    assert.equal(r.skipped.length, 0);
    assert.equal(r.total, 2);
  });

  test('skips what another job holds and takes the next one', () => {
    selectAndClaim(pool, 'android', opts());
    const r = selectAndClaim(pool, 'android', beta());
    assert.equal(r.serial, 'emulator-5554');
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].candidate.serial, '032AY1UNR2');
  });

  test('the same job asking twice gets the same device back, not a second one', () => {
    assert.equal(selectAndClaim(pool, 'android', opts()).serial, '032AY1UNR2');
    assert.equal(selectAndClaim(pool, 'android', opts()).serial, '032AY1UNR2');
  });

  test('every device busy is exit 2, naming who holds each — never a silent guess', () => {
    selectAndClaim(pool, 'android', opts());
    selectAndClaim(pool, 'android', beta());
    const e = caught(() => selectAndClaim(pool, 'android', opts({ cwd: '/work/gamma' })));
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /Every attached device is in use/);
    assert.match(e.message, /032AY1UNR2 \(Pixel_3a\)\s+workspace 'alpha'/);
    assert.match(e.message, /emulator-5554 .*workspace 'beta'/);
    assert.match(e.message, /verikun device release <serial>/);
    assert.match(e.message, /VERIKUN_NO_CLAIM=1/);
  });

  test('a single attached device is claimed too — "someone else is on the only phone" is the point', () => {
    const one = [{ serial: 'emulator-5554' }];
    assert.equal(selectAndClaim(one, 'android', opts()).total, 1);
    assert.throws(() => selectAndClaim(one, 'android', beta()), (e: CliError) => e.exitCode === 2);
  });
});

describe('assertClaimable', () => {
  test('an explicitly named busy device is refused with the free alternatives', () => {
    claimDevice('032AY1UNR2', 'android', opts());
    const alternatives = () => [{ serial: '032AY1UNR2', model: 'Pixel_3a' }, { serial: 'emulator-5554' }];
    const e = caught(() => assertClaimable('032AY1UNR2', 'android', alternatives, beta()));
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /032AY1UNR2 is in use by workspace 'alpha' \(last seen .+ ago\)/);
    assert.match(e.message, /free now: +emulator-5554/);
    assert.match(e.message, /verikun device release 032AY1UNR2/);
  });

  test('the alternatives thunk is not called on the happy path (it costs an adb round trip)', () => {
    let calls = 0;
    assertClaimable('emulator-5554', 'android', () => ((calls += 1), []), opts());
    assert.equal(calls, 0);
  });

  test('a throwing alternatives thunk cannot replace the refusal it was decorating', () => {
    // Plausible state: the device you named is claimed AND nothing else is attached, so
    // listing devices raises its own exit 3. The claim refusal is what the user needs.
    claimDevice('032AY1UNR2', 'android', opts());
    const e = caught(() =>
      assertClaimable(
        '032AY1UNR2',
        'android',
        () => {
          throw new CliError('No Android devices/emulators connected.', 3);
        },
        beta(),
      ),
    );
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /032AY1UNR2 is in use by workspace 'alpha'/);
    assert.doesNotMatch(e.message, /free now/);
  });

  test('a busy device with nothing else free omits the "free now" line rather than lying', () => {
    claimDevice('032AY1UNR2', 'android', opts());
    const e = caught(() => assertClaimable('032AY1UNR2', 'android', () => [{ serial: '032AY1UNR2' }], beta()));
    assert.doesNotMatch(e.message, /free now/);
  });
});

// --- heartbeat and release --------------------------------------------------

describe('heartbeat and release', () => {
  test('touchClaim moves the heartbeat forward without disturbing `since`', () => {
    const t0 = Date.parse('2026-08-13T12:00:00.000Z');
    claimDevice('emulator-5554', 'android', opts({ now: t0 }));
    touchClaim('emulator-5554', 'android', opts({ now: t0 + 120_000 }));
    const held = readClaim('emulator-5554', opts())!;
    assert.equal(held.since, new Date(t0).toISOString());
    assert.equal(held.heartbeat, new Date(t0 + 120_000).toISOString());
  });

  test('touchClaim never steals: a device that became someone else\'s is left alone', () => {
    claimDevice('emulator-5554', 'android', beta());
    touchClaim('emulator-5554', 'android', opts());
    assert.equal(readClaim('emulator-5554', opts())?.cwd, '/work/beta');
  });

  test('touchClaim re-takes a device whose claim vanished under an active job', () => {
    claimDevice('emulator-5554', 'android', opts());
    releaseClaim('emulator-5554', opts());
    touchClaim('emulator-5554', 'android', opts());
    assert.equal(readClaim('emulator-5554', opts())?.cwd, '/work/alpha');
  });

  test('touchClaim is a no-op when claims are disabled', () => {
    touchClaim('emulator-5554', 'android', opts({ env: { VERIKUN_NO_CLAIM: '1' } }));
    assert.equal(readClaim('emulator-5554', opts()), null);
  });

  test('mineOnly refuses to release another job\'s device; the manual command does not', () => {
    claimDevice('emulator-5554', 'android', beta());
    assert.equal(releaseClaim('emulator-5554', { ...opts(), mineOnly: true }), null);
    assert.equal(readClaim('emulator-5554', opts())?.cwd, '/work/beta');

    const released = releaseClaim('emulator-5554', opts());
    assert.equal(released?.cwd, '/work/beta');
    assert.equal(readClaim('emulator-5554', opts()), null);
  });

  test('releasing something unclaimed is null, not an error', () => {
    assert.equal(releaseClaim('emulator-5554', opts()), null);
  });

  test('releaseOwnClaims hands back everything this process took, and nothing else', () => {
    claimDevice('emulator-5554', 'android', opts());
    claimDevice('032AY1UNR2', 'android', opts());
    claimDevice('other-device', 'android', beta());

    const released = releaseOwnClaims(opts());
    assert.deepEqual(released.sort(), ['032AY1UNR2', 'emulator-5554']);
    assert.equal(readClaim('emulator-5554', opts()), null);
    assert.equal(readClaim('other-device', opts())?.cwd, '/work/beta');
  });
});

// --- reporting --------------------------------------------------------------

describe('reporting', () => {
  test('summarize labels my own claim "this job" and a stale one not at all', () => {
    const t0 = Date.parse('2026-08-13T12:00:00.000Z');
    // Planted rather than claimed: a claim this live process just took would stay live on
    // its own pid, and the point here is what happens once the owner is gone.
    plant('emulator-5554', { cwd: '/work/alpha', heartbeat: new Date(t0).toISOString() });

    const mine = summarize('emulator-5554', opts({ now: t0 }));
    assert.equal(mine?.mine, true);
    assert.equal(mine?.by, 'this job');

    const theirs = summarize('emulator-5554', beta({ now: t0 + 60_000 }));
    assert.equal(theirs?.mine, false);
    assert.equal(theirs?.by, "workspace 'alpha' · 1m ago");

    // A dead claim is not reported at all — `vk devices` must not show a phantom holder.
    assert.equal(summarize('emulator-5554', beta({ now: t0 + 60 * 60_000 })), undefined);
    assert.equal(summarize('never-claimed', opts()), undefined);
  });

  test('describeClaim names the workspace, falling back to the session when there is no directory', () => {
    const t0 = Date.parse('2026-08-13T12:00:00.000Z');
    const withDir = plant('a', { cwd: '/work/islamabad', heartbeat: new Date(t0).toISOString() });
    assert.equal(describeClaim(withDir, opts({ now: t0 + 150_000 })), "workspace 'islamabad' · 2m ago");

    const noDir = plant('b', { cwd: '', session: 'sess-9', heartbeat: new Date(t0).toISOString() });
    assert.equal(describeClaim(noDir, opts({ now: t0 + 30_000 })), 'session sess-9 · 30s ago');
  });

  test('ages read in the largest useful unit', () => {
    const t0 = Date.parse('2026-08-13T12:00:00.000Z');
    const c = plant('a', { cwd: '/work/x', heartbeat: new Date(t0).toISOString() });
    assert.match(describeClaim(c, opts({ now: t0 + 5_000 })), /· 5s ago$/);
    assert.match(describeClaim(c, opts({ now: t0 + 45 * 60_000 })), /· 45m ago$/);
    assert.match(describeClaim(c, opts({ now: t0 + 130 * 60_000 })), /· 2h10m ago$/);
  });
});
