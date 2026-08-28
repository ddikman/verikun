import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimGrant,
  leaseGrant,
  processClaimGrant,
  releaseGrants,
  requireClaimGrant,
  type ClaimGrantOpts,
  type DeviceGrant,
} from '../src/device/grant';
import { claimDevice, claimHeartbeatMs, claimsDir, deviceFileStem, readClaim } from '../src/device/claims';
import { CliError } from '../src/errors';
import { sleep } from '../src/wait';

// `DeviceGrant` — the one run-scoped "I hold this device" contract, over two stores that
// share nothing: the host claim files (`device/claims.ts`) and a `vk server` lease.
//
// Everything here injects `home`/`cwd`/`env`/`host` the way tests/device-claims.test.ts
// does, so no test touches the developer's real `~/.verikun/devices`. Grants are built
// with `heartbeatMs: 0` unless the timer IS the subject: a live interval would rewrite
// the store underneath an assertion about what is in it.

const HOST = 'test-host';
let home: string;

function opts(over: Partial<ClaimGrantOpts> = {}): ClaimGrantOpts {
  return { home, host: HOST, env: {}, cwd: '/work/alpha', heartbeatMs: 0, ...over };
}

/** A second job on the same host: same store, different working directory. */
const beta = (over: Partial<ClaimGrantOpts> = {}) => opts({ cwd: '/work/beta', ...over });

function claimPath(serial: string): string {
  return join(claimsDir({ home }), `${deviceFileStem(serial)}.json`);
}

function caught(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected a throw, got none');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vk-grant-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// --- claimGrant: the elastic answer -----------------------------------------

describe('claimGrant', () => {
  test('takes a free device and publishes a claim for it', () => {
    const grant = claimGrant('device-a', 'android', opts());
    assert.ok(grant, 'a free device is granted');
    assert.equal(grant.serial, 'device-a');
    assert.equal(readClaim('device-a', { home })?.cwd, '/work/alpha');
  });

  test('returns null for a device another live job holds — the caller drops that lane', () => {
    assert.ok(claimDevice('device-a', 'android', beta({ now: Date.now() })).ok);
    assert.equal(claimGrant('device-a', 'android', opts()), null);
    // And it did NOT overwrite the holder on the way out.
    assert.equal(readClaim('device-a', { home })?.cwd, '/work/beta');
  });

  test('with claims off it holds nothing, and still never reports a device as busy', () => {
    const off = { VERIKUN_NO_CLAIM: '1' };
    assert.ok(claimDevice('device-a', 'android', beta({ now: Date.now() })).ok);
    // The whole point of the escape hatch: restore the pre-claims behaviour EXACTLY. A
    // null here would make `--devices all` skip a device for a reason nothing can see.
    const grant = claimGrant('device-a', 'android', opts({ env: off }));
    assert.ok(grant, 'a busy device is still granted when claims are disabled');
    assert.equal(grant.serial, 'device-a');
    // Someone else's claim is left exactly as it was — no read, no write.
    assert.equal(readClaim('device-a', { home })?.cwd, '/work/beta');
  });

  test('with claims off, releasing holds nothing back', async () => {
    const grant = claimGrant('device-a', 'android', opts({ env: { VERIKUN_NO_CLAIM: '1' } }));
    await grant!.release();
    assert.equal(existsSync(claimPath('device-a')), false, 'nothing was ever written');
  });
});

// --- requireClaimGrant: the named answer ------------------------------------

describe('requireClaimGrant', () => {
  test('takes a free device', () => {
    const grant = requireClaimGrant('device-a', 'android', () => [], opts());
    assert.equal(grant.serial, 'device-a');
    assert.equal(readClaim('device-a', { home })?.cwd, '/work/alpha');
  });

  test('refuses a device another job holds — exit 2, naming who and what to do', () => {
    assert.ok(claimDevice('device-a', 'android', beta({ now: Date.now() })).ok);
    const e = caught(() => requireClaimGrant('device-a', 'android', () => [], opts()));
    assert.equal(e.exitCode, 2, 'busy is "you must choose", not a broken machine');
    assert.match(e.message, /device-a is in use/);
    assert.match(e.message, /device release device-a/);
  });

  test('the two polarities differ only in whose idea the serial was', () => {
    assert.ok(claimDevice('device-a', 'android', beta({ now: Date.now() })).ok);
    // Same device, same store, same instant: `all` skips it, a named serial refuses.
    assert.equal(claimGrant('device-a', 'android', opts()), null);
    assert.equal(caught(() => requireClaimGrant('device-a', 'android', () => [], opts())).exitCode, 2);
  });

  test('with claims off it never refuses', () => {
    assert.ok(claimDevice('device-a', 'android', beta({ now: Date.now() })).ok);
    const grant = requireClaimGrant('device-a', 'android', () => [], opts({ env: { VERIKUN_NO_CLAIM: '1' } }));
    assert.equal(grant.serial, 'device-a');
  });
});

// --- release ----------------------------------------------------------------

describe('a claim grant hands the device back', () => {
  test('release drops the claim file', async () => {
    const grant = claimGrant('device-a', 'android', opts())!;
    assert.equal(existsSync(claimPath('device-a')), true);
    await grant.release();
    assert.equal(existsSync(claimPath('device-a')), false);
  });

  test('releasing twice cannot take a device somebody else has since claimed', async () => {
    const grant = claimGrant('device-a', 'android', opts())!;
    await grant.release();
    assert.ok(claimDevice('device-a', 'android', beta({ now: Date.now() })).ok, 'a sibling job takes it');
    await grant.release();
    assert.equal(readClaim('device-a', { home })?.cwd, '/work/beta', 'still theirs');
  });

  test('touch after release does not re-take the device', async () => {
    // `touchClaim` re-publishes a claim whose file has gone (that is how a heartbeat
    // survives an `rm -rf ~/.verikun`), so a grant that kept working after release would
    // silently reacquire a phone this job had finished with — and a sibling job that took
    // it in the meantime would be running under a claim that says otherwise.
    const grant = claimGrant('device-a', 'android', opts())!;
    await grant.release();
    grant.touch();
    assert.equal(existsSync(claimPath('device-a')), false);
  });
});

// --- the heartbeat ----------------------------------------------------------

describe('the heartbeat lives in the grant', () => {
  test('a holder that runs no commands still re-stamps its claim', async () => {
    // The parallel suite parent's exact shape: every device call happens in a child, so
    // nothing else would ever touch the claim and it would keep its start-of-suite
    // timestamp for the whole run.
    const grant = claimGrant('device-a', 'android', opts({ heartbeatMs: 10 }))!;
    const first = readClaim('device-a', { home })!.heartbeat;
    await sleep(120);
    const later = readClaim('device-a', { home })!.heartbeat;
    await grant.release();
    assert.notEqual(later, first, 'the claim was re-stamped without the holder doing anything');
  });

  test('release stops it, so a finished job cannot reacquire the phone', async () => {
    const grant = claimGrant('device-a', 'android', opts({ heartbeatMs: 10 }))!;
    await grant.release();
    await sleep(60);
    assert.equal(existsSync(claimPath('device-a')), false, 'no timer resurrected the claim');
  });

  test('heartbeatMs: 0 starts no timer', async () => {
    const grant = claimGrant('device-a', 'android', opts())!;
    const first = readClaim('device-a', { home })!.heartbeat;
    await sleep(40);
    assert.equal(readClaim('device-a', { home })!.heartbeat, first);
    await grant.release();
  });
});

describe('claimHeartbeatMs', () => {
  test('the default TTL keeps the 60s period this replaced', () => {
    assert.equal(claimHeartbeatMs({}), 60_000);
  });

  test('a short TTL pulls the period down with it', () => {
    // A period larger than the window it is measured against would publish a claim that
    // is already expired — the state a holder judged by the TTL (i.e. not process-scoped)
    // would be read in.
    assert.equal(claimHeartbeatMs({ VERIKUN_CLAIM_TTL_MIN: '1' }), 15_000);
  });

  test('always leaves room for missed beats inside the window', () => {
    for (const min of ['0.5', '1', '2', '5', '30', '600']) {
      const ttl = Number(min) * 60_000;
      assert.ok(claimHeartbeatMs({ VERIKUN_CLAIM_TTL_MIN: min }) <= ttl / 2, `TTL ${min}m`);
    }
  });

  test('a pathological TTL is floored rather than becoming a spin', () => {
    assert.equal(claimHeartbeatMs({ VERIKUN_CLAIM_TTL_MIN: '0.01' }), 5_000);
  });

  test('a disabled TTL says nothing about how often a long-lived holder reports in', () => {
    assert.equal(claimHeartbeatMs({ VERIKUN_CLAIM_TTL_MIN: '0' }), 60_000);
  });
});

// --- the other two implementations ------------------------------------------

describe('processClaimGrant', () => {
  test('defers to the claim store, and releases exactly once', async () => {
    let released = 0;
    const grant = processClaimGrant(undefined, () => {
      released += 1;
    });
    // No serial: a local run that let verikun auto-select resolves its device lazily,
    // inside the driver, long after this grant was made.
    assert.equal(grant.serial, undefined);
    grant.touch(); // `executeOutcome` is the heartbeat on this path — nothing to do here
    await grant.release();
    await grant.release();
    assert.equal(released, 1);
  });

  test('reports the serial when the caller pinned one', () => {
    assert.equal(processClaimGrant('device-a', () => {}).serial, 'device-a');
  });
});

describe('leaseGrant', () => {
  test('release frees the server lock exactly once', async () => {
    let closed = 0;
    const grant = leaseGrant({ close: () => { closed += 1; } }, 'emulator-5554');
    assert.equal(grant.serial, 'emulator-5554');
    grant.touch(); // the server stamps the lease on every request; no client-side clock
    assert.equal(closed, 0);
    await grant.release();
    await grant.release();
    assert.equal(closed, 1);
  });

  test('an unreachable server does not fail the teardown', async () => {
    const grant = leaseGrant({ close: () => Promise.reject(new Error('fetch failed')) }, 'x');
    await grant.release(); // the server's idle takeover covers a lease we could not release
  });

  test('a backend with nothing to close is still a valid grant', async () => {
    await leaseGrant({}, 'x').release();
  });
});

// --- teardown ---------------------------------------------------------------

describe('releaseGrants', () => {
  test('hands every grant back', async () => {
    const grants = ['device-a', 'device-b', 'device-c'].map((s) => claimGrant(s, 'android', opts())!);
    await releaseGrants(grants);
    for (const s of ['device-a', 'device-b', 'device-c']) {
      assert.equal(existsSync(claimPath(s)), false, s);
    }
  });

  test('one grant that throws does not strand the phones beside it', async () => {
    // It runs from a `finally`, often while something has already gone wrong: an
    // unreachable server must not keep local claims held for the rest of the TTL.
    const angry: DeviceGrant = {
      serial: 'device-x',
      touch: () => {},
      release: () => Promise.reject(new Error('server gone')),
    };
    const a = claimGrant('device-a', 'android', opts())!;
    const b = claimGrant('device-b', 'android', opts())!;
    await releaseGrants([a, angry, b]);
    assert.equal(existsSync(claimPath('device-a')), false);
    assert.equal(existsSync(claimPath('device-b')), false);
  });
});
