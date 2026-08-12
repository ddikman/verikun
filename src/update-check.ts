// Version probes for `vk doctor`: is this CLI behind npm's `latest`, and is the installed
// Claude Code plugin's skill documentation behind this CLI?
//
// The second is the one that bites. The plugin ships SKILL.md — the agent-facing contract —
// so a stale plugin means an agent confidently using a flag this CLI no longer has, with
// nothing anywhere reporting it (issue #59: the reporter's plugin was 8 minor versions
// behind their CLI).
//
// Deliberately small. This runs from `vk doctor`, which SKILL.md tells the agent to run
// once at the start of a session — an explicit "check my setup", not a hot path. That is
// what makes a cache, a snooze and a persisted opt-out unnecessary: there is nothing to
// nag, and one 19-byte request per session is not worth a state file.
//
// Load-bearing: `updateProbes` swallows every error and returns []. An advisory check must
// never change an exit code or fail a device run.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from './version';
import type { ToolProbe } from './types';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * `null` for anything that is not MAJOR.MINOR.PATCH.
 *
 * Not defensive padding: `installed_plugins.json` really does carry `"version": "unknown"`
 * and bare git SHAs for plugins whose source has no manifest version. Those must produce
 * *no opinion*, never a guess.
 */
export function parseSemver(v: string): Semver | null {
  const m = SEMVER_RE.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

/**
 * -1 / 0 / +1, comparing the release triple only — a prerelease suffix is ignored, so a
 * local `0.20.0-rc.1` reads as equal to `0.20.0` rather than as something to nag about.
 * Returns 0 ("no opinion") when either side is unparseable.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return 0;
  if (x.major !== y.major) return x.major < y.major ? -1 : 1;
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// npm's published `latest`
// ---------------------------------------------------------------------------

/** 19 bytes on the wire (`{"latest":"0.19.0"}`) versus megabytes for the full packument. */
export const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/verikun/dist-tags';

export interface HttpResponse {
  ok: boolean;
  json(): Promise<unknown>;
}
export type FetchImpl = (url: string, init: { method: 'GET'; signal: AbortSignal }) => Promise<HttpResponse>;

/** `null` on every failure — offline, non-200, junk body, timeout. Never throws, never retries. */
export async function fetchLatest(
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<HttpResponse>);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await fetchImpl(DIST_TAGS_URL, { method: 'GET', signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { latest?: unknown };
    const latest = typeof body?.latest === 'string' ? body.latest.trim() : '';
    // Shape-check the payload, not just the status: a captive portal happily returns 200
    // with an HTML login page.
    return latest && parseSemver(latest) ? latest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The installed Claude Code plugin
// ---------------------------------------------------------------------------

export interface PluginInstall {
  version: string;
  scope: string;
  /**
   * The registry key this was found under (`<plugin>@<marketplace>`), so the remediation
   * hint names the marketplace the user ACTUALLY added — hardcoding `verikun@verikun`
   * hands a broken command to anyone who added it under another name.
   */
  key: string;
  /** How many scoped installs carried a parseable version (user / project / local). */
  installCount: number;
}

/** `CLAUDE_CONFIG_DIR` relocates the whole `~/.claude` root, plugin registry included. */
export function defaultPluginStatePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return join(configured || join(home, '.claude'), 'plugins', 'installed_plugins.json');
}

/**
 * Read the installed `verikun` plugin's version out of Claude Code's registry.
 *
 * The file's own top-level `"version": 2` is deliberately IGNORED: gating on it would
 * silently disable this check the day Claude Code bumps the schema. Duck-typing on the
 * shape survives any bump that keeps it, and fails to the same `null` if it does not.
 */
export function readPluginInstall(path: string): PluginInstall | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { plugins?: Record<string, unknown> };
    const plugins = raw?.plugins;
    if (!plugins || typeof plugins !== 'object') return null;

    const key =
      'verikun@verikun' in plugins ? 'verikun@verikun' : Object.keys(plugins).find((k) => k.startsWith('verikun@'));
    if (!key) return null;

    const installs = plugins[key];
    if (!Array.isArray(installs)) return null;

    let best: { version: string; scope: string } | null = null;
    let count = 0;
    for (const entry of installs as { version?: unknown; scope?: unknown }[]) {
      const version = typeof entry?.version === 'string' ? entry.version : '';
      if (!version || !parseSemver(version)) continue; // drops "unknown" and git SHAs
      count++;
      // Max wins. Matching `projectPath` against cwd would be more precise but needs path
      // normalisation and symlink handling; if ANY install is current, claiming "stale" is
      // the worse error.
      if (!best || compareVersions(version, best.version) > 0) {
        best = { version, scope: typeof entry?.scope === 'string' ? entry.scope : 'unknown' };
      }
    }
    return best ? { ...best, key, installCount: count } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// doctor's view
// ---------------------------------------------------------------------------

export interface UpdateProbeOpts {
  cliVersion?: string;
  pluginStatePath?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/**
 * **Every probe here is advisory** — `ok: true`, with `advisory` set on the ones worth
 * acting on, so they print with their remediation hint but never change doctor's exit code.
 * Being out of date is not a broken machine, and exit `3` is reserved for one ("a machine
 * to fix", per the exit-code contract). A firewalled CI box must not go red either.
 *
 * A plugin that isn't installed produces no probe at all — most `vk` users are not on
 * Claude Code, and a permanent "not installed" line is noise.
 */
export async function updateProbes(opts: UpdateProbeOpts = {}): Promise<ToolProbe[]> {
  const env = opts.env ?? process.env;
  if (env.VERIKUN_NO_UPDATE_CHECK?.trim()) return [];

  try {
    const cliVersion = opts.cliVersion ?? VERSION;
    const latest = await fetchLatest({ fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
    const plugin = readPluginInstall(opts.pluginStatePath ?? defaultPluginStatePath(env));
    const probes: ToolProbe[] = [];

    if (!latest) {
      probes.push({ name: 'verikun', ok: true, detail: `${cliVersion} (npm check unavailable)` });
    } else if (compareVersions(cliVersion, latest) < 0) {
      probes.push({
        name: 'verikun',
        ok: true,
        advisory: true,
        detail: `${cliVersion} — npm has ${latest}`,
        hint: 'npm install -g verikun@latest',
      });
    } else {
      probes.push({ name: 'verikun', ok: true, detail: `${cliVersion} (latest)` });
    }

    if (plugin) {
      const cmp = compareVersions(plugin.version, cliVersion);
      if (cmp !== 0) {
        const behind = cmp < 0;
        probes.push({
          name: 'claude-code-plugin',
          ok: true,
          advisory: true,
          detail: behind
            ? `${plugin.version} — behind this CLI (${cliVersion}); the agent is reading stale skill docs`
            : `${plugin.version} — ahead of this CLI (${cliVersion}); the skill documents commands it may not have`,
          hint: behind
            ? `claude plugin update ${plugin.key}   (then restart Claude Code)`
            : 'npm install -g verikun@latest',
        });
      } else {
        const scope = plugin.installCount > 1 ? `${plugin.scope} scope, ${plugin.installCount} installs` : `${plugin.scope} scope`;
        probes.push({ name: 'claude-code-plugin', ok: true, detail: `${plugin.version} (in sync, ${scope})` });
      }
    }
    return probes;
  } catch {
    return [];
  }
}
