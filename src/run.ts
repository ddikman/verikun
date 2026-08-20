import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Driver, Element } from './types';
import { Selector, MatchTier } from './ui/selector';
import { formatCompact } from './ui/format';
import { CliError, isEnvError } from './errors';
import { artifactDir, err } from './output';
import { toJUnitXml, toHtml } from './report';
import { capturePng } from './capture';

// A "test run" is a recording of the commands an agent issues, turned into a
// JUnit suite + an HTML report on archive. Because every `vk` invocation is a
// separate process, run state is persisted to disk and reloaded per command:
//
//   ./.verikun/run/            active run (working dir)
//   ./.verikun/run/run.json    accumulated steps
//   ./.verikun/run/artifacts/  screenshots + evidence
//   ./.verikun/runs/<id>/      archived runs (report.xml, report.html, artifacts)
//
// Each recordable command = one step = one JUnit <testcase>. The selector and
// the element it resolved through are stored so the report doubles as a record
// of which identifiers worked (reusable next time, instead of re-inspecting).
//
// LANES. `VERIKUN_LANE` moves the ACTIVE run to `./.verikun/run-<lane>/`, which is
// what lets a parallel `vk suite` run several tests at once in one working
// directory: every test starts its run with force=true, which rm -rf's the active
// directory, so two concurrent tests sharing one path means the loser's in-flight
// state and artifacts are deleted under it. Archives still land in the SHARED
// ./.verikun/runs/<id>/, so the suite index's ../../runs/<id>/report.html links are
// unchanged and every lane's evidence ends up in one place. Artifact filenames are
// keyed on step index alone, which is safe precisely because they live inside the
// (now per-lane) run directory.

export interface RunStep {
  index: number;
  command: string;
  /** Human label, e.g. `tap @login_button` — never includes typed secret values. */
  name: string;
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'error';
  exitCode: number;
  message?: string;
  /** The selector used, if this step resolved one. */
  selector?: { raw: string; kind: string; value: string; contains?: boolean; index?: number };
  /** Heal tier the selector matched at (`exact` is omitted as the default). */
  tier?: string;
  /** A failed attempt the `vk ai` engine repaired — downgraded to a pass so a
   *  self-healed step does not surface as a failure in the report. */
  healed?: boolean;
  /** Summary of the element the selector resolved to. */
  resolved?: {
    type: string;
    id?: string;
    idShort?: string;
    text?: string;
    desc?: string;
    center: { x: number; y: number };
  };
  /** Relative path to an image captured by a `screenshot` step. */
  image?: string;
  /** Relative path to the screenshot captured when this step failed. */
  failImage?: string;
  /** UI hierarchy (compact text, capped) captured when this step failed. */
  failHierarchy?: string;
  /** Device logs (tail, capped) attached by an on-demand `log` step. */
  logs?: string;
}

export interface RunState {
  id: string;
  name: string;
  startedAt: string;
  /** Bumped on every step — the basis for idle-timeout rollover. */
  updatedAt: string;
  finishedAt?: string;
  platform: string;
  /** Resolved device serial/udid the run is bound to (for device-change rollover). */
  device?: string;
  /** Session identity (VERIKUN_SESSION / TERM_SESSION_ID) for session-change rollover. */
  session?: string;
  /** True when auto-started by the first action rather than `vk run start`. */
  implicit: boolean;
  /** Device-clock marker (logcat `MM-DD HH:MM:SS.mmm`) captured at the session's
   *  first step, so `vk log` can exclude logs from before the run started. */
  logStart?: string;
  /** App under test (package / bundle id), set from launch/open/stop/clear. Used
   *  to scope the archive-time app log accordion without a Flutter-specific filter. */
  appId?: string;
  /** Relative path to the full device-log artifact (`artifacts/logcat.txt`). */
  logFile?: string;
  /** Relative path to the app-scoped log artifact (`artifacts/logcat-app.txt`). */
  appLogFile?: string;
  /** Set by `vk ai`: the token/cost line, repair count, and the suggested test
   *  improvements (workarounds the model applied that you can fold back into the
   *  source to stabilize the test and cut future tokens). */
  ai?: { ok: boolean; cost: string; modelRepairs: number; improvements: string[] };
  /** A terminal failure the `vk ai` ENGINE produced rather than a command — a control
   *  node that gave up (`repeat` exhausted, `when` matched nothing), a budget/timeout
   *  abort. Those never run through beginStep, so nothing marked the run red and the
   *  archive declared a failed test green. The report trusts this over the step tally. */
  failure?: { where: string; reason: string };
  /** Device settings this run changed, each mapped to the value that was live BEFORE
   *  verikun first touched it. Kept in the run file rather than in a process-local
   *  variable so `vk device reset` still works from a LATER process — every vk call
   *  is its own process, so an in-memory latch could not undo a flow that died. */
  deviceOverrides?: Record<string, string>;
  steps: RunStep[];
}

interface NoteInfo {
  selector?: Selector;
  tier?: MatchTier | null;
  element?: Element;
  message?: string;
}

// Commands that become a recorded step (a JUnit testcase). Inspection commands
// (ui, find, devices, doctor, current) are deliberately excluded — they are how
// an agent decides what to do, not assertions about the app. `log` is the one
// exception: it inspects, but is recorded so its captured device logs land in
// the archived report (the agent pulls them on-demand after a failure).
const RECORDABLE = new Set([
  'tap', 'click',
  'text', 'type',
  'key', 'back', 'home', 'enter',
  'swipe', 'scroll',
  'screenshot', 'shot',
  'wait', 'assert',
  'launch', 'open', 'stop', 'clear',
  'log', 'logs',
  // `device` changes the environment the app runs in. A report showing "checkout
  // failed" without "we cut the network two steps earlier" would be misleading.
  'device',
]);

export function isRecordable(command: string, positionals: string[] = []): boolean {
  // `device` is the one command that is recordable only in part: `set`/`reset` change
  // the environment the app runs in and belong in the report, while `get`/`caps` are
  // pure inspection — recording those would auto-start a test run just for asking what
  // the device supports, exactly the noise `ui`/`find` are excluded to avoid.
  // `prep` joins set/reset: it changes the device the app runs on, and a report showing a
  // flaky read without "we turned animations off mid-suite" would be missing the cause.
  if (command === 'device') return ['set', 'reset', 'prep'].includes((positionals[0] ?? '').toLowerCase());
  return RECORDABLE.has(command);
}

const HIERARCHY_CAP = 24000; // chars of failure hierarchy kept inline in run.json
const LOG_CAP = 50000; // chars of device logs kept inline in run.json (tail-kept)
/** Max chars written to the archive-time `artifacts/logcat.txt` (tail-kept). Larger
 *  than the per-step LOG_CAP because the file is not inlined into run.json. */
const LOG_FILE_CAP = 512_000;
/** When no session `logStart` marker exists, archive captures this many trailing lines. */
const ARCHIVE_LOG_LINES = 5000;

export const RUN_LOG_ARTIFACT = 'artifacts/logcat.txt';
export const RUN_APP_LOG_ARTIFACT = 'artifacts/logcat-app.txt';

const APP_LIFECYCLE = new Set(['launch', 'open', 'stop', 'clear']);

export interface LogFetchOpts {
  since?: string;
  lines?: number;
  appId?: string;
  /** When set with appId, drivers must not fall back to a system-wide dump. */
  scopedOnly?: boolean;
}

export interface ArchiveLogOpts {
  /** `vk run archive --no-logs` — skip on green runs (failures still capture). */
  noLogs?: boolean;
  /** Sync fetcher (local driver). Called for the full device dump and, when an
   *  appId is known, again with `{ appId, scopedOnly: true }` for the accordion.
   *  Remote callers pre-attach via attachArchiveLogs. */
  fetchLogs?: (opts: LogFetchOpts) => string;
}

/** Whether archive-time device-log capture should run. Default on; `--no-logs` /
 *  `VERIKUN_NO_LOGS` opts out of *green* runs only — a failed run always captures
 *  (best-effort), because that is when the log is load-bearing. Exported for tests. */
export function wantsArchiveLogs(hasFailures: boolean, noLogsFlag = false): boolean {
  if (hasFailures) return true;
  if (noLogsFlag) return false;
  if (process.env.VERIKUN_NO_LOGS) return false;
  return true;
}

/** Window passed to `getLogs` at archive time: session-scoped when `logStart` is
 *  known, otherwise a bounded trailing dump. Exported for tests. */
export function archiveLogWindow(state: Pick<RunState, 'logStart'>): { since?: string; lines?: number } {
  if (state.logStart) return { since: state.logStart };
  return { lines: ARCHIVE_LOG_LINES };
}

/** Package / bundle id the run exercised, if we can tell. Prefer an explicit
 *  `state.appId` (set on launch/open/stop/clear); otherwise recover from those
 *  steps' names. Exported for tests. */
export function inferRunAppId(state: Pick<RunState, 'appId' | 'steps'>): string | undefined {
  if (state.appId && /^[A-Za-z0-9._-]+$/.test(state.appId)) return state.appId;
  for (let i = state.steps.length - 1; i >= 0; i--) {
    const s = state.steps[i];
    if (!APP_LIFECYCLE.has(s.command)) continue;
    // stepName is `launch com.foo` / `clear com.foo` (no flags in the name).
    const m = /^(?:launch|open|stop|clear)\s+([A-Za-z0-9._-]+)\s*$/.exec(s.name);
    if (m) return m[1];
  }
  return undefined;
}

function truncateLogFile(text: string): string {
  if (text.length <= LOG_FILE_CAP) return text;
  return '…(truncated)\n' + text.slice(-LOG_FILE_CAP);
}

function runHasFailures(state: RunState): boolean {
  return state.steps.some((s) => s.status !== 'passed');
}

// --- paths & persistence --------------------------------------------------

/**
 * This process's lane, or '' when it is not part of a parallel suite.
 *
 * Sanitised rather than validated: the value is spliced into a directory name and
 * into run ids, so anything outside `[A-Za-z0-9._-]` is dropped instead of being
 * allowed to steer a path. A value that sanitises away entirely reads as "no lane",
 * which is the safe direction — worst case two lanes share a directory exactly as
 * they did before lanes existed. Exported for tests.
 */
export function laneId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.VERIKUN_LANE ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32);
}

const activeDir = () => join(artifactDir(), laneId() ? `run-${laneId()}` : 'run');
const archiveBase = () => join(artifactDir(), 'runs');
const statePath = (dir: string) => join(dir, 'run.json');

function loadState(dir: string): RunState | null {
  if (!existsSync(statePath(dir))) return null;
  try {
    return JSON.parse(readFileSync(statePath(dir), 'utf8')) as RunState;
  } catch (e) {
    // The state file exists but won't parse — it's corrupt. Surface it (then treat as no
    // active run, which the next run start overwrites) instead of swallowing it silently.
    err(`[verikun] ignoring unreadable run state ${statePath(dir)} (${(e as Error).message})`);
    return null;
  }
}

/** Relative path of a step's failure screenshot. One place, because a synthetic
 *  terminal-failure step has to land on the same convention as a recorded one. */
const failImagePath = (index: number) => `artifacts/step-${index}-fail.png`;

function writeArtifactTo(dir: string, rel: string, buf: Buffer): void {
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, rel), buf);
}

/** Compact hierarchy text, HEAD-capped — a failure dump is read top-down, so the
 *  first screenful is the useful part (unlike logs, which are kept tail-first). */
function capHierarchy(els: Element[]): string {
  const text = formatCompact(els);
  return text.length > HIERARCHY_CAP ? text.slice(0, HIERARCHY_CAP) + '\n…(truncated)' : text;
}

function saveState(dir: string, state: RunState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Timestamp id used for runs — exported so `vk suite` mints suite ids the same way.
 *
 * A LANE is appended when one is set, because the base id has one-second resolution
 * and carries no pid: two lanes starting a test in the same second would otherwise
 * mint the same id. Within a lane runs are strictly serial, so the suffix makes the
 * id collision-free by construction — and self-describing, which `-2` was not.
 */
export function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const lane = laneId();
  return lane ? `${stamp}-${lane}` : stamp;
}

/**
 * Claim the first free `<base>`, `<base>-2`, `<base>-3`, … and RETURN IT CREATED.
 *
 * The claim is the `mkdir` itself, not a preceding `existsSync`. Check-then-act was
 * sound while only one run could be active per working directory; with lanes, two
 * processes archiving in the same second can both see the same candidate free and
 * both take it — one silently clobbering the other's report. An exclusive (non
 * `recursive`) mkdir is the smallest thing that decides a winner, and `EEXIST` just
 * means "try the next number".
 *
 * Callers therefore receive an EMPTY EXISTING directory, not a free path. Writing
 * into it needs nothing extra; renaming ONTO it needs `renameOnto` below.
 */
export function uniqueDir(base: string): string {
  mkdirSync(dirname(base), { recursive: true });
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/**
 * Move `from` onto a directory `uniqueDir` already claimed.
 *
 * POSIX `rename()` replaces an existing EMPTY directory, which is exactly the state
 * a claim leaves behind — so the happy path is a single atomic call and the claim is
 * never released. The fallback covers filesystems that refuse it (Windows), where
 * removing our own empty claim first is safe because nobody else can be inside it.
 */
function renameOnto(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    rmSync(to, { recursive: true, force: true });
    renameSync(from, to);
  }
}

// --- run-context rollover -------------------------------------------------
//
// An implicit run should not silently swallow unrelated activity. Before adding
// a step to an existing run we check whether the context still matches; if not,
// the old run is auto-closed (archived — never discarded) and a fresh one starts.

/** A stable-per-session id, if the environment provides one. Opt-in by design:
 *  in an agent harness each command may be a fresh shell, so we never derive it
 *  from the process tree (that would roll over on every action). */
function currentSession(): string | undefined {
  return process.env.VERIKUN_SESSION || process.env.TERM_SESSION_ID || undefined;
}

/** Idle-timeout in minutes (0 disables). Default 30. */
function idleMinutes(): number {
  const v = process.env.VERIKUN_RUN_IDLE_MIN;
  if (v === undefined) return 30;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function lastActiveMs(state: RunState): number {
  const ts =
    state.updatedAt ||
    (state.steps.length ? state.steps[state.steps.length - 1].startedAt : '') ||
    state.startedAt;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? Date.now() : ms;
}

function ageMs(state: RunState): number {
  return Date.now() - lastActiveMs(state);
}

function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Why the active run should be closed before recording the next step, or null to keep it. */
export function rolloverReason(state: RunState, serial: string | undefined, session: string | undefined): string | null {
  // A different device or session is a hard context change — applies to any run.
  if (state.device && serial && state.device !== serial) return `device changed (${state.device} → ${serial})`;
  if (state.session && session && state.session !== session) return 'different session';
  // Idle timeout only retires runs that were auto-started; an explicitly named
  // run (`vk run start`) is the user's deliberate container and persists.
  const idle = idleMinutes();
  if (idle > 0 && state.implicit && ageMs(state) > idle * 60000) return `idle for ${fmtAge(ageMs(state))} (>${idle}m)`;
  return null;
}

/** Whether the incoming step's driver is safe to use for archive-time logs of the
 *  run being sealed. On a device-change rollover the driver is already pointed at
 *  the *new* serial — pulling logcat from it would attribute the wrong device's
 *  output to the old run. Idle/session rollover on the same device is fine.
 *  Exported for tests. */
export function rolloverLogsSameDevice(runDevice: string | undefined, newSerial: string | undefined): boolean {
  return !runDevice || !newSerial || runDevice === newSerial;
}

export function stepName(command: string, positionals: string[], flags: Record<string, string | boolean>): string {
  const p = positionals;
  const at = typeof flags['at'] === 'string' ? (flags['at'] as string) : undefined;
  const from = typeof flags['from'] === 'string' ? (flags['from'] as string) : undefined;
  const to = typeof flags['to'] === 'string' ? (flags['to'] as string) : undefined;
  const on = typeof flags['on'] === 'string' ? (flags['on'] as string) : undefined;
  switch (command) {
    case 'tap':
    case 'click':
      return at ? `tap (${at})` : `tap ${p[0] ?? ''}`.trim();
    case 'text':
      return `text ${p[0] ?? ''}`.trim(); // omit the typed value (may be secret)
    case 'type':
      return 'type';
    case 'swipe':
    case 'scroll':
      if (from && to) return `swipe ${from}->${to}`;
      return `swipe ${p[0] ?? ''}${on ? ` on ${on}` : ''}`.trim();
    case 'screenshot':
    case 'shot':
      return 'screenshot';
    case 'back':
    case 'home':
    case 'enter':
      return command;
    case 'device':
      // The payload IS the story here — "device set" alone would tell a report
      // reader nothing about what changed, so keep the whole assignment list.
      return `device ${p.join(' ')}`.trim();
    default:
      return `${command} ${p[0] ?? ''}`.trim();
  }
}

// --- recorder -------------------------------------------------------------

export class Recorder {
  private constructor(
    private readonly state: RunState,
    private readonly dir: string,
    private readonly step: RunStep,
    private readonly startMs: number,
    /** Ephemeral mode (vk server): artifacts land here instead of on disk, and
     *  commit() never touches ./.verikun — the step is returned to the caller
     *  via takeEphemeral() and spliced into the CALLER's run instead. */
    private readonly sink?: Record<string, Buffer>,
  ) {}

  /**
   * Open a step for a recordable command, auto-starting an implicit run if none
   * is active. Returns null when recording is disabled via VERIKUN_NO_RUN.
   */
  static beginStep(
    command: string,
    positionals: string[],
    flags: Record<string, string | boolean>,
    platform: string,
    deviceReq?: string,
    serial?: string,
    driver?: Driver,
  ): Recorder | null {
    if (process.env.VERIKUN_NO_RUN) return null;

    const dir = activeDir();
    let state = loadState(dir);
    const session = currentSession();
    let rolledOver = false;

    // Close a stale / context-mismatched run before continuing.
    let carriedOverrides: Record<string, string> | undefined;
    if (state) {
      const reason = rolloverReason(state, serial, session);
      if (reason) {
        // A sealed run takes its deviceOverrides with it, and `device reset` reads the
        // ACTIVE run — so without this the device silently stays modified and reset
        // cheerfully reports "nothing to restore". Same device: carry the snapshot into
        // the fresh run so reset still works. Different device: we cannot drive the old
        // one from here, so say exactly what was left changed and where.
        const stranded = state.deviceOverrides ?? {};
        if (Object.keys(stranded).length > 0) {
          // Same predicate as the log-attribution check: "is the device in front of us
          // still the one this run was bound to?"
          const sameDevice = rolloverLogsSameDevice(state.device, serial);
          if (sameDevice) {
            carriedOverrides = stranded;
          } else {
            const listed = Object.entries(stranded).map(([k, v]) => `${k} (was ${v})`).join(', ');
            err(
              `[verikun] WARNING: run for device ${state.device} is being closed while it still has ` +
                `device settings applied: ${listed}. That device was NOT restored — put it back with ` +
                `\`vk device set ${Object.entries(stranded).map(([k, v]) => `${k}=${v}`).join(' ')} --device ${state.device}\``,
            );
          }
        }
        try {
          // Only reuse this step's driver when it still targets the run's device.
          // A device-change rollover must not write the new device's logcat into
          // the old run's archive (vk run archive binds a driver to state.device).
          const fetchLogs =
            driver && rolloverLogsSameDevice(state.device, serial)
              ? (opts: LogFetchOpts) => driver.getLogs(opts)
              : undefined;
          const dest = Recorder.seal(state, dir, { fetchLogs });
          err(`[verikun] previous run '${state.name}' (${state.steps.length} step(s)) auto-closed → ${dest} (${reason}); starting a fresh run`);
          state = null;
          rolledOver = true;
        } catch (e) {
          err(`[verikun] could not close stale run (${(e as Error).message}); appending to it instead`);
        }
      }
    }

    if (!state) {
      state = {
        id: runId(),
        name: 'run',
        startedAt: nowIso(),
        updatedAt: nowIso(),
        platform,
        device: serial || deviceReq,
        session,
        implicit: true,
        // Survives a same-device rollover, so `device reset` can still undo what an
        // earlier run applied to the device now in front of us.
        ...(carriedOverrides ? { deviceOverrides: carriedOverrides } : {}),
        steps: [],
      };
      if (!rolledOver) {
        err('[verikun] recording test run (implicit) — archive: `vk run archive` · discard: `vk run clear`');
      }
    } else {
      // Backfill identity once it becomes known (e.g. a run started without a device).
      if (!state.device && (serial || deviceReq)) state.device = serial || deviceReq;
      if (!state.session && session) state.session = session;
    }

    // Remember the app under test from lifecycle commands so archive can scope
    // the accordion log without requiring a separate flag.
    if (APP_LIFECYCLE.has(command) && positionals[0] && /^[A-Za-z0-9._-]+$/.test(positionals[0])) {
      state.appId = positionals[0];
    }

    // Anchor the log window at the session's first step (covers both implicit
    // creation and an explicit `vk run start`, which records no marker itself).
    // Best-effort — a missing marker just means `vk log` falls back to last-N.
    if (driver && !state.logStart) {
      try {
        const t = driver.deviceTime();
        if (t) state.logStart = t;
      } catch {
        /* device clock unavailable */
      }
    }

    const step: RunStep = {
      index: state.steps.length,
      command,
      name: stepName(command, positionals, flags),
      startedAt: nowIso(),
      durationMs: 0,
      status: 'passed',
      exitCode: 0,
    };

    return new Recorder(state, dir, step, Date.now());
  }

  /**
   * Open a single-step recorder that never touches disk — the `vk server` path.
   * The step (and any artifacts, e.g. failure screenshots) accumulate in memory
   * and are handed back by takeEphemeral() for the wire; the CALLING verikun
   * splices them into its own on-disk run via appendForeignStep. Deliberately
   * ignores VERIKUN_NO_RUN: this is how step detail reaches the remote caller,
   * not a local test run.
   */
  static beginEphemeralStep(
    command: string,
    positionals: string[],
    flags: Record<string, string | boolean>,
    platform: string,
    serial?: string,
  ): Recorder {
    const state: RunState = {
      id: 'ephemeral',
      name: 'ephemeral',
      startedAt: nowIso(),
      updatedAt: nowIso(),
      platform,
      device: serial,
      implicit: true,
      steps: [],
    };
    const step: RunStep = {
      index: 0,
      command,
      name: stepName(command, positionals, flags),
      startedAt: nowIso(),
      durationMs: 0,
      status: 'passed',
      exitCode: 0,
    };
    // No dir: ephemeral recording never touches disk (activeDir() would mkdir
    // ./.verikun as a side effect), and writeArtifact/commit divert to the sink.
    return new Recorder(state, '', step, Date.now(), {});
  }

  /** The finished ephemeral step + its in-memory artifacts. Only meaningful after
   *  finish()/finishError() on a beginEphemeralStep recorder. */
  takeEphemeral(): { step: RunStep; artifacts: Record<string, Buffer> } {
    return { step: this.step, artifacts: this.sink ?? {} };
  }

  /** Attach selector / heal-tier / resolved-element / message detail to the current step. */
  note(info: NoteInfo): void {
    const s = this.step;
    if (info.selector) {
      s.selector = {
        raw: info.selector.raw,
        kind: info.selector.kind,
        value: info.selector.value,
        contains: info.selector.contains || undefined,
        index: info.selector.index,
      };
    }
    if (info.tier && info.tier !== 'exact') s.tier = info.tier;
    if (info.element) {
      const el = info.element;
      s.resolved = {
        type: el.type,
        id: el.id || undefined,
        idShort: el.idShort || undefined,
        text: el.text || undefined,
        desc: el.desc || undefined,
        center: el.center,
      };
    }
    if (info.message) s.message = info.message;
  }

  /** Store an image captured by a `screenshot` step in the run's artifacts. */
  attachImage(buf: Buffer): void {
    const rel = `artifacts/step-${this.step.index}-screenshot.png`;
    this.writeArtifact(rel, buf);
    this.step.image = rel;
  }

  /** Store device logs captured by a `log` step. Keeps the TAIL — the newest
   *  lines, where a crash/stack trace is — unlike failHierarchy which keeps the head. */
  attachLog(text: string): void {
    this.step.logs = text.length > LOG_CAP ? '…(truncated)\n' + text.slice(-LOG_CAP) : text;
  }

  /** The session-start log marker — but only once a prior step exists, so a `log`
   *  that is itself the first action isn't scoped to an empty (just-now) window. */
  logWindowStart(): string | undefined {
    return this.state.steps.length > 0 ? this.state.logStart : undefined;
  }

  /** Finalize a step that returned a normal exit code (0 pass, 1 fail, ≥2 error). */
  finish(exitCode: number, driver?: Driver): void {
    this.step.exitCode = exitCode;
    this.step.status = exitCode === 0 ? 'passed' : exitCode === 1 ? 'failed' : 'error';
    if (exitCode !== 0) this.capture(driver);
    this.commit();
  }

  /** Finalize a step whose command threw. */
  finishError(e: Error, driver?: Driver): void {
    const exitCode = e instanceof CliError ? e.exitCode : 3;
    this.step.exitCode = exitCode;
    this.step.status = exitCode === 1 ? 'failed' : 'error';
    if (!this.step.message) this.step.message = e.message;
    // The step failed BECAUSE the environment is broken, so evidence capture is
    // near-certain to fail the same way. Still attempt it (a screencap can succeed
    // where a dump doesn't), but don't narrate two more copies of the same error.
    this.capture(driver, isEnvError(e));
    this.commit();
  }

  // Best-effort: grab a screenshot and the UI hierarchy of the failing page.
  // The device may be unreachable (that may be why we failed) — swallow errors.
  private capture(driver?: Driver, quiet = false): void {
    if (!driver) return;
    // No device, no evidence. When resolution itself is what failed — nothing attached,
    // or another job holds every device — there is no screen to photograph, and both
    // attempts below would re-raise that same error and print it again. Staying silent
    // here is what keeps ONE failure reading as one message instead of three.
    try {
      driver.resolvedSerial();
    } catch {
      return;
    }
    try {
      // Full resolution on purpose — a human reads this in the report — but via the
      // raw path, which reaches the same PNG without the device-side encode.
      this.writeArtifact(failImagePath(this.step.index), capturePng(driver, null).buf);
      this.step.failImage = failImagePath(this.step.index);
    } catch (e) {
      // Best-effort evidence: the device may be gone (often why the step failed). Surface
      // it so a screenshot bug isn't hidden, but never let it derail failure recording.
      if (!quiet) err(`[verikun] could not capture failure screenshot (${(e as Error).message})`);
    }
    try {
      this.step.failHierarchy = capHierarchy(driver.getElements({ all: false }));
    } catch (e) {
      if (!quiet) err(`[verikun] could not capture failure hierarchy (${(e as Error).message})`);
    }
  }

  private writeArtifact(rel: string, buf: Buffer): void {
    if (this.sink) {
      this.sink[rel] = buf;
      return;
    }
    writeArtifactTo(this.dir, rel, buf);
  }

  private commit(): void {
    this.step.durationMs = Date.now() - this.startMs;
    if (this.sink) return; // ephemeral: the step goes to the wire, not to disk
    this.state.steps.push(this.step);
    this.state.updatedAt = nowIso();
    saveState(this.dir, this.state);
  }

  /** Finalize a run: optionally capture device logs, write reports next to it, then
   *  move it into ./.verikun/runs/<id>/. Log capture is best-effort — a device that
   *  is gone (often why the run failed) must never prevent sealing the report. */
  private static seal(state: RunState, dir: string, opts: ArchiveLogOpts = {}): string {
    Recorder.maybeCaptureArchiveLogs(state, dir, opts);
    state.finishedAt = nowIso();
    state.updatedAt = nowIso();
    saveState(dir, state);
    writeFileSync(join(dir, 'report.xml'), toJUnitXml(state));
    // Accordion embeds the *app*-scoped dump (readable); the full device dump stays
    // a file link in the meta row. Missing file is fine — capture is best-effort.
    let appLog: string | undefined;
    if (state.appLogFile) {
      try {
        appLog = readFileSync(join(dir, state.appLogFile), 'utf8');
      } catch {
        /* report still writes */
      }
    }
    writeFileSync(join(dir, 'report.html'), toHtml(state, { appLog }));
    const dest = uniqueDir(join(archiveBase(), state.id));
    renameOnto(dir, dest);
    return dest;
  }

  /** Write archive-time log artifacts on the ACTIVE run without sealing. Used by
   *  remote (`--server`) callers that fetch asynchronously before `archive()`.
   *  Pass `full` / `app` only for the pieces you have — omitted sides are left alone. */
  static attachArchiveLogs(full?: string, app?: string): void {
    const dir = activeDir();
    const state = loadState(dir);
    if (!state) return;
    if (full !== undefined) {
      Recorder.writeArchiveLog(state, dir, full, RUN_LOG_ARTIFACT, 'logFile');
    }
    if (app !== undefined && app !== '') {
      if (!state.appId) state.appId = inferRunAppId(state);
      Recorder.writeArchiveLog(state, dir, app, RUN_APP_LOG_ARTIFACT, 'appLogFile');
    }
    saveState(dir, state);
  }

  private static writeArchiveLog(
    state: RunState,
    dir: string,
    text: string,
    rel: string,
    field: 'logFile' | 'appLogFile',
  ): void {
    const body = truncateLogFile(text);
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(join(dir, rel), body);
    state[field] = rel;
  }

  private static maybeCaptureArchiveLogs(state: RunState, dir: string, opts: ArchiveLogOpts): void {
    if (!wantsArchiveLogs(runHasFailures(state), opts.noLogs)) return;
    if (!opts.fetchLogs) return;
    const window = archiveLogWindow(state);
    if (!state.logFile) {
      try {
        const text = opts.fetchLogs(window);
        if (text !== undefined && text !== null) {
          Recorder.writeArchiveLog(state, dir, text, RUN_LOG_ARTIFACT, 'logFile');
        }
      } catch (e) {
        err(`[verikun] could not capture archive device logs (${(e as Error).message})`);
      }
    }
    const appId = inferRunAppId(state);
    if (appId) state.appId = appId;
    if (appId && !state.appLogFile) {
      try {
        const text = opts.fetchLogs({ ...window, appId, scopedOnly: true });
        if (text) Recorder.writeArchiveLog(state, dir, text, RUN_APP_LOG_ARTIFACT, 'appLogFile');
      } catch (e) {
        err(`[verikun] could not capture archive app logs (${(e as Error).message})`);
      }
    }
  }

  /** One-line context summary for `vk run status`. */
  static contextLine(state: RunState): string {
    const bits: string[] = [];
    if (state.device) bits.push(`device ${state.device}`);
    if (state.session) bits.push(`session ${state.session}`);
    bits.push(`last active ${fmtAge(ageMs(state))} ago`);
    return bits.join(' · ');
  }

  // --- lifecycle (vk run <sub>) ------------------------------------------

  static status(): RunState | null {
    return loadState(activeDir());
  }

  // --- device overrides ---------------------------------------------------
  //
  // These are INSTANCE methods on purpose. A recorder holds the run state in memory
  // for the duration of a step and writes the whole thing in commit(), so a static
  // that loaded-mutated-saved the file mid-step would be silently overwritten a
  // moment later by that commit — the snapshot would vanish and `device reset` would
  // have nothing to undo. Mutating this.state lets commit() persist it.

  /**
   * Record what a device setting held BEFORE this run changed it. Keeps the EARLIEST
   * original: setting `dark` twice must still restore to the pre-run appearance, not
   * to the intermediate value.
   */
  rememberDeviceOverride(key: string, original: string): void {
    this.state.deviceOverrides ??= {};
    if (!(key in this.state.deviceOverrides)) this.state.deviceOverrides[key] = original;
  }

  /** The pre-run values of every device setting this run changed. */
  deviceOverrides(): Record<string, string> {
    return this.state.deviceOverrides ?? {};
  }

  /** Drop override records once they have been restored (all, or a named subset). */
  forgetDeviceOverrides(keys?: string[]): void {
    if (!this.state.deviceOverrides) return;
    if (keys) for (const k of keys) delete this.state.deviceOverrides[k];
    else this.state.deviceOverrides = {};
  }

  /** Whether the run on disk has anything to restore. Used OUTSIDE a step — by the
   *  batch/ai/suite teardown deciding whether a `device reset` is worth issuing. */
  static hasDeviceOverrides(): boolean {
    return Object.keys(Recorder.status()?.deviceOverrides ?? {}).length > 0;
  }

  /** Merge a patch into the active run (used by `vk ai` to attach its summary
   *  before archiving). No-op if there is no active run. */
  static annotateRun(patch: Partial<RunState>): void {
    const dir = activeDir();
    const state = loadState(dir);
    if (!state) return;
    Object.assign(state, patch);
    saveState(dir, state);
  }

  /**
   * Splice a step another verikun produced (a `vk server`'s ephemeral step) into
   * the ACTIVE local run, so a remote `vk ai` run archives a report identical to
   * a local one. Re-indexes the step, writes its artifact buffers under the new
   * index, and rewrites the step's artifact references to match. Creates an
   * implicit run first if none is active (parity with beginStep's auto-start).
   * `ctx.logStart` (device-clock marker from the server) is recorded on the first
   * splice so archive-time / `vk log` scoping works the same as a local run.
   */
  static appendForeignStep(
    step: RunStep,
    artifacts: Record<string, Buffer> = {},
    ctx: { platform?: string; device?: string; logStart?: string } = {},
  ): void {
    if (process.env.VERIKUN_NO_RUN) return;
    const dir = activeDir();
    let state = loadState(dir);
    if (!state) {
      state = {
        id: runId(),
        name: 'run',
        startedAt: nowIso(),
        updatedAt: nowIso(),
        platform: ctx.platform ?? 'android',
        device: ctx.device,
        session: currentSession(),
        implicit: true,
        steps: [],
      };
      err('[verikun] recording test run (implicit) — archive: `vk run archive` · discard: `vk run clear`');
    }

    // Anchor the log window from the server's device clock (beginEphemeralStep
    // never persists state, so the marker has to travel on the wire).
    if (!state.logStart && ctx.logStart) state.logStart = ctx.logStart;

    // Mirror local beginStep: remember the app from lifecycle steps so archive
    // can scope the accordion without a local launch having set state.appId.
    if (APP_LIFECYCLE.has(step.command)) {
      const m = /^(?:launch|open|stop|clear)\s+([A-Za-z0-9._-]+)\s*$/.exec(step.name);
      if (m) state.appId = m[1];
    }

    const index = state.steps.length;
    const spliced: RunStep = { ...step, index };
    for (const [rel, buf] of Object.entries(artifacts)) {
      // The rel path comes from the (authenticated) server's response; still, never
      // let it steer the write outside the run's artifacts/ directory.
      if (!/^artifacts\/[A-Za-z0-9._-]+$/.test(rel)) {
        err(`[verikun] skipping remote artifact with unexpected path '${rel}'`);
        continue;
      }
      const newRel = rel.replace(/\bstep-\d+-/, `step-${index}-`);
      mkdirSync(join(dir, 'artifacts'), { recursive: true });
      writeFileSync(join(dir, newRel), buf);
      if (spliced.image === rel) spliced.image = newRel;
      if (spliced.failImage === rel) spliced.failImage = newRel;
    }
    state.steps.push(spliced);
    state.updatedAt = nowIso();
    saveState(dir, state);
  }

  /** Downgrade the most-recently-recorded step from a failed attempt to a healed
   *  pass — the `vk ai` engine calls this after a successful repair so a
   *  self-healed leaf does not count as a failure (and the run that the engine
   *  considers green has a clean report). No-op if there is no active run. */
  static markLastStepHealed(message?: string): void {
    const dir = activeDir();
    const state = loadState(dir);
    if (!state || state.steps.length === 0) return;
    const last = state.steps[state.steps.length - 1];
    last.healed = true;
    last.status = 'passed';
    last.exitCode = 0;
    // The attempt that just failed had failure evidence captured (screenshot +
    // hierarchy); drop it so a now-green healed step doesn't render as a failure.
    delete last.failImage;
    delete last.failHierarchy;
    if (message) last.message = message;
    saveState(dir, state);
  }

  /**
   * Record a terminal failure the `vk ai` ENGINE produced rather than a command — a
   * control node that gave up (`repeat` exhausted, `when` matched no branch), a
   * budget/timeout abort, an engine-internal throw. None of those go through
   * beginStep, so before this existed nothing marked the run red and the archived
   * report declared a failed test fully green (issue #41).
   *
   * Always records the run-level verdict. Appends a synthetic failed step ONLY when
   * no step is already red — a leaf failure carries its own step and evidence, and
   * counting it twice would be its own kind of lie.
   */
  static recordTerminalFailure(
    failure: { where: string; reason: string; kind: 'fail' | 'env' | 'budget' | 'timeout' },
    evidence?: { png?: Buffer; hierarchy?: Element[] },
  ): void {
    if (process.env.VERIKUN_NO_RUN) return;
    const dir = activeDir();
    const state = loadState(dir);
    if (!state) return;

    state.failure = { where: failure.where, reason: failure.reason };

    if (state.steps.every((s) => s.status === 'passed')) {
      const index = state.steps.length;
      // An environment abort is exit 3 (the box is broken, not the app), matching
      // what `vk ai` itself returns; everything else is an exit-1 assertion failure.
      const env = failure.kind === 'env';
      const step: RunStep = {
        index,
        command: 'ai',
        name: `ai ${env ? 'aborted' : 'failed'} at ${failure.where}`,
        startedAt: nowIso(),
        durationMs: 0,
        status: env ? 'error' : 'failed',
        exitCode: env ? 3 : 1,
        message: failure.reason,
      };
      if (evidence?.png) {
        try {
          writeArtifactTo(dir, failImagePath(index), evidence.png);
          step.failImage = failImagePath(index);
        } catch (e) {
          err(`[verikun] could not write the failure screenshot (${(e as Error).message})`);
        }
      }
      if (evidence?.hierarchy) step.failHierarchy = capHierarchy(evidence.hierarchy);
      state.steps.push(step);
    }

    state.updatedAt = nowIso();
    saveState(dir, state);
  }

  static start(name: string | undefined, platform: string, device: string | undefined, force: boolean): RunState {
    const dir = activeDir();
    const existing = loadState(dir);
    if (existing && existing.steps.length > 0 && !force) {
      throw new CliError(
        `A test run ('${existing.name}', ${existing.steps.length} step(s)) is already active. ` +
          'Archive it (`vk run archive`), discard it (`vk run clear`), or pass --force to replace.',
        2,
      );
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const state: RunState = {
      id: runId(),
      name: name || 'run',
      startedAt: nowIso(),
      updatedAt: nowIso(),
      platform,
      device,
      session: currentSession(),
      implicit: false,
      steps: [],
    };
    saveState(dir, state);
    return state;
  }

  /** Discard the active run without producing a report. Returns what was cleared. */
  static clear(): RunState | null {
    const dir = activeDir();
    const existing = loadState(dir);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    return existing;
  }

  /** Write JUnit + HTML reports and move the run into ./.verikun/runs/<id>/.
   *  By default captures a bounded device-log tail into `artifacts/logcat.txt`
   *  (see wantsArchiveLogs / ArchiveLogOpts). */
  static archive(name?: string, opts: ArchiveLogOpts = {}): { dir: string; xmlPath: string; htmlPath: string; state: RunState } {
    const dir = activeDir();
    if (!existsSync(statePath(dir))) {
      throw new CliError('No active test run to archive. Run an action first, or `vk run start`.', 1);
    }
    const state = loadState(dir);
    if (!state) throw new CliError('Active run state is unreadable (.verikun/run/run.json is corrupt).', 3);

    if (name) state.name = name;
    const dest = Recorder.seal(state, dir, opts);
    return { dir: dest, xmlPath: join(dest, 'report.xml'), htmlPath: join(dest, 'report.html'), state };
  }
}
