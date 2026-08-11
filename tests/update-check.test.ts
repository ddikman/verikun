import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSemver,
  compareVersions,
  readPluginInstall,
  defaultPluginStatePath,
  fetchLatest,
  updateProbes,
  DIST_TAGS_URL,
  FetchImpl,
} from '../src/update-check';

// The fetch and both paths are injected, so nothing here touches the network or $HOME.

let dir: string;
let pluginPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vk-update-'));
  pluginPath = join(dir, 'installed_plugins.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Asserting on `calls` is how "no request was made" is proven. */
function fakeFetch(latest: string | null = '0.21.0') {
  const calls: { url: string; method: string }[] = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    return { ok: true, json: async () => (latest === null ? {} : { latest }) };
  };
  return { impl, calls };
}
const opts = (extra: Record<string, unknown> = {}) => ({
  pluginStatePath: pluginPath,
  env: {} as NodeJS.ProcessEnv,
  cliVersion: '0.20.0',
  ...extra,
});
const writePlugins = (v: unknown) => writeFileSync(pluginPath, JSON.stringify(v));
const installed = (version: string, scope = 'user') => ({
  version: 2,
  plugins: { 'verikun@verikun': [{ scope, version }] },
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

test('parseSemver: accepts a leading v and ignores a prerelease or build suffix', () => {
  assert.deepEqual(parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemver('1.2.3-rc.1'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemver('1.2.3+abc'), { major: 1, minor: 2, patch: 3 });
});

// Not hypothetical: installed_plugins.json carries both of these for plugins whose source
// has no manifest version. They must produce "no opinion", never a guess.
test('parseSemver: real-world junk returns null', () => {
  for (const junk of ['unknown', '407e4651ff74', '', '1.2', '1.2.3.4', 'latest']) {
    assert.equal(parseSemver(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test('compareVersions: numeric, not lexicographic', () => {
  // The classic bug: "0.9.0" > "0.10.0" as strings.
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.20.0', '0.19.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

// So a maintainer on a local rc build is not nagged about the release it matches.
test('compareVersions: a prerelease compares equal to its release', () => {
  assert.equal(compareVersions('0.20.0-rc.1', '0.20.0'), 0);
});

test('compareVersions: an unparseable side yields no opinion', () => {
  assert.equal(compareVersions('unknown', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '407e4651ff74'), 0);
});

// ---------------------------------------------------------------------------
// installed_plugins.json
// ---------------------------------------------------------------------------

test('readPluginInstall: reads the real registry shape', () => {
  writePlugins(installed('0.11.0'));
  assert.deepEqual(readPluginInstall(pluginPath), {
    version: '0.11.0',
    scope: 'user',
    key: 'verikun@verikun',
    installCount: 1,
  });
});

// Pins the duck-typing decision: gating on `version === 2` would silently disable the whole
// check the day Claude Code bumps its schema.
test('readPluginInstall: an unknown top-level schema version still parses', () => {
  writePlugins({ version: 3, plugins: { 'verikun@verikun': [{ scope: 'user', version: '0.11.0' }] } });
  assert.equal(readPluginInstall(pluginPath)?.version, '0.11.0');
});

test('readPluginInstall: picks the highest parseable version and skips the junk ones', () => {
  writePlugins({
    version: 2,
    plugins: {
      'verikun@verikun': [
        { scope: 'user', version: '0.11.0' },
        { scope: 'local', version: 'unknown' },
        { scope: 'project', version: '0.9.0' },
      ],
    },
  });
  const got = readPluginInstall(pluginPath);
  assert.equal(got?.version, '0.11.0');
  assert.equal(got?.scope, 'user');
  assert.equal(got?.installCount, 2, 'the "unknown" entry must not be counted');
});

test('readPluginInstall: no parseable version at all reads as not installed', () => {
  writePlugins({ version: 2, plugins: { 'verikun@verikun': [{ scope: 'user', version: '407e4651ff74' }] } });
  assert.equal(readPluginInstall(pluginPath), null);
});

// The hint names this key, so a user who added the marketplace under another name still
// gets a command that works.
test('readPluginInstall: falls back to another marketplace name and reports the key', () => {
  writePlugins({ version: 2, plugins: { 'verikun@my-fork': [{ scope: 'user', version: '0.11.0' }] } });
  assert.equal(readPluginInstall(pluginPath)?.key, 'verikun@my-fork');
});

test('readPluginInstall: missing, malformed or foreign files read as not installed', () => {
  assert.equal(readPluginInstall(join(dir, 'nope.json')), null);
  writeFileSync(pluginPath, '{ not json');
  assert.equal(readPluginInstall(pluginPath), null);
  writePlugins({ version: 2, plugins: { 'other@mkt': [{ scope: 'user', version: '1.0.0' }] } });
  assert.equal(readPluginInstall(pluginPath), null);
});

test('defaultPluginStatePath: honours CLAUDE_CONFIG_DIR', () => {
  const relocated = defaultPluginStatePath({ CLAUDE_CONFIG_DIR: '/tmp/cfg' } as NodeJS.ProcessEnv, '/home/x');
  assert.equal(relocated, join('/tmp/cfg', 'plugins', 'installed_plugins.json'));
  const fallback = defaultPluginStatePath({} as NodeJS.ProcessEnv, '/home/x');
  assert.equal(fallback, join('/home/x', '.claude', 'plugins', 'installed_plugins.json'));
});

// ---------------------------------------------------------------------------
// fetchLatest
// ---------------------------------------------------------------------------

test('fetchLatest: hits the dist-tags endpoint with GET', async () => {
  const { impl, calls } = fakeFetch('0.21.0');
  assert.equal(await fetchLatest({ fetchImpl: impl }), '0.21.0');
  // Load-bearing: the full packument is megabytes, this endpoint is 19 bytes. Nothing else
  // in the suite would catch a regression to `registry.npmjs.org/verikun`.
  assert.deepEqual(calls, [{ url: DIST_TAGS_URL, method: 'GET' }]);
});

test('fetchLatest: every failure mode returns null instead of throwing', async () => {
  const throwing: FetchImpl = async () => {
    throw new Error('offline');
  };
  assert.equal(await fetchLatest({ fetchImpl: throwing }), null);
  assert.equal(await fetchLatest({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }), null);
  assert.equal(await fetchLatest({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), null);
  // A captive portal returns 200 with an HTML body, so the shape is checked too.
  assert.equal(
    await fetchLatest({ fetchImpl: async () => ({ ok: true, json: async () => ({ latest: '<html>' }) }) }),
    null,
  );
});

// ---------------------------------------------------------------------------
// doctor's probes
// ---------------------------------------------------------------------------

test('updateProbes: a stale plugin is reported, with a hint naming the real marketplace', async () => {
  writePlugins({ version: 2, plugins: { 'verikun@my-fork': [{ scope: 'user', version: '0.11.0' }] } });
  const { impl } = fakeFetch('0.20.0');
  const skew = (await updateProbes(opts({ fetchImpl: impl }))).find((p) => p.name === 'claude-code-plugin');
  assert.equal(skew?.advisory, true);
  assert.match(String(skew?.detail), /behind this CLI/);
  assert.match(String(skew?.hint), /claude plugin update verikun@my-fork/);
});

test('updateProbes: a plugin ahead of the CLI points at the npm upgrade instead', async () => {
  writePlugins(installed('0.21.0'));
  const { impl } = fakeFetch('0.20.0');
  const skew = (await updateProbes(opts({ fetchImpl: impl }))).find((p) => p.name === 'claude-code-plugin');
  assert.equal(skew?.advisory, true);
  assert.match(String(skew?.hint), /npm install -g verikun@latest/);
});

test('updateProbes: an in-sync plugin is reported without a warning', async () => {
  writePlugins(installed('0.20.0'));
  const { impl } = fakeFetch('0.20.0');
  const p = (await updateProbes(opts({ fetchImpl: impl }))).find((x) => x.name === 'claude-code-plugin');
  assert.equal(p?.advisory, undefined);
  assert.match(String(p?.detail), /in sync/);
});

test('updateProbes: being behind npm is reported with the upgrade command', async () => {
  const { impl } = fakeFetch('0.21.0');
  const cli = (await updateProbes(opts({ fetchImpl: impl }))).find((p) => p.name === 'verikun');
  assert.equal(cli?.advisory, true);
  assert.match(String(cli?.detail), /npm has 0\.21\.0/);
});

// The maintainer case: an unreleased local build must not be nagged.
test('updateProbes: a CLI ahead of npm latest is not flagged', async () => {
  const { impl } = fakeFetch('0.19.0');
  const cli = (await updateProbes(opts({ fetchImpl: impl }))).find((p) => p.name === 'verikun');
  assert.equal(cli?.advisory, undefined);
});

// A firewalled CI box must not be told to act on something it cannot check.
test('updateProbes: an unreachable registry reports plainly, with no hint', async () => {
  const dead: FetchImpl = async () => {
    throw new Error('offline');
  };
  const cli = (await updateProbes(opts({ fetchImpl: dead }))).find((p) => p.name === 'verikun');
  assert.match(String(cli?.detail), /npm check unavailable/);
  assert.equal(cli?.advisory, undefined);
});

test('updateProbes: no plugin installed means no plugin probe at all', async () => {
  const { impl } = fakeFetch('0.20.0');
  const probes = await updateProbes(opts({ fetchImpl: impl }));
  assert.equal(
    probes.some((p) => p.name === 'claude-code-plugin'),
    false,
    'most vk users are not on Claude Code; a permanent "not installed" line is noise',
  );
});

// The whole point of the advisory flag: nothing here may ever fail doctor.
test('updateProbes: no combination of staleness produces a failing probe', async () => {
  writePlugins(installed('0.11.0'));
  const { impl } = fakeFetch('0.99.0');
  const probes = await updateProbes(opts({ fetchImpl: impl }));
  assert.ok(probes.length >= 2, 'both a CLI and a plugin probe should be present');
  assert.deepEqual(probes.filter((p) => !p.ok), [], 'an out-of-date verikun is not a broken setup');
});

test('updateProbes: the env opt-out removes the probes and makes no request', async () => {
  writePlugins(installed('0.11.0'));
  const { impl, calls } = fakeFetch('0.21.0');
  const probes = await updateProbes(
    opts({ fetchImpl: impl, env: { VERIKUN_NO_UPDATE_CHECK: '1' } as NodeJS.ProcessEnv }),
  );
  assert.deepEqual(probes, []);
  assert.equal(calls.length, 0);
});

// An advisory check must never be the thing that breaks a device run.
test('updateProbes: survives a broken registry file and a dead network at once', async () => {
  writeFileSync(pluginPath, 'not json');
  const dead: FetchImpl = async () => {
    throw new Error('offline');
  };
  const probes = await updateProbes(opts({ fetchImpl: dead }));
  assert.deepEqual(probes.filter((p) => !p.ok), []);
});
