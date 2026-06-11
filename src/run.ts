import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Driver, Element } from './types';
import { Selector, MatchTier } from './ui/selector';
import { formatCompact } from './ui/format';
import { CliError } from './errors';
import { artifactDir, err } from './output';
import { toJUnitXml, toHtml } from './report';

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
// an agent decides what to do, not assertions about the app.
const RECORDABLE = new Set([
  'tap', 'click',
  'text', 'type',
  'key', 'back', 'home', 'enter',
  'swipe', 'scroll',
  'screenshot', 'shot',
  'wait', 'assert',
  'launch', 'open', 'stop', 'clear',
]);

export function isRecordable(command: string): boolean {
  return RECORDABLE.has(command);
}

const HIERARCHY_CAP = 24000; // chars of failure hierarchy kept inline in run.json

// --- paths & persistence --------------------------------------------------

const activeDir = () => join(artifactDir(), 'run');
const archiveBase = () => join(artifactDir(), 'runs');
const statePath = (dir: string) => join(dir, 'run.json');

function loadState(dir: string): RunState | null {
  if (!existsSync(statePath(dir))) return null;
  try {
    return JSON.parse(readFileSync(statePath(dir), 'utf8')) as RunState;
  } catch {
    return null;
  }
}

function saveState(dir: string, state: RunState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

function nowIso(): string {
  return new Date().toISOString();
}

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function uniqueDir(base: string): string {
  if (!existsSync(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existsSync(candidate)) return candidate;
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
  ): Recorder | null {
    if (process.env.VERIKUN_NO_RUN) return null;

    const dir = activeDir();
    let state = loadState(dir);
    const session = currentSession();
    let rolledOver = false;

    // Close a stale / context-mismatched run before continuing.
    if (state) {
      const reason = rolloverReason(state, serial, session);
      if (reason) {
        try {
          const dest = Recorder.seal(state, dir);
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
    this.capture(driver);
    this.commit();
  }

  // Best-effort: grab a screenshot and the UI hierarchy of the failing page.
  // The device may be unreachable (that may be why we failed) — swallow errors.
  private capture(driver?: Driver): void {
    if (!driver) return;
    try {
      this.writeArtifact(`artifacts/step-${this.step.index}-fail.png`, driver.screenshot());
      this.step.failImage = `artifacts/step-${this.step.index}-fail.png`;
    } catch {
      /* device may be gone */
    }
    try {
      const text = formatCompact(driver.getElements({ all: false }));
      this.step.failHierarchy = text.length > HIERARCHY_CAP ? text.slice(0, HIERARCHY_CAP) + '\n…(truncated)' : text;
    } catch {
      /* hierarchy unavailable */
    }
  }

  private writeArtifact(rel: string, buf: Buffer): void {
    mkdirSync(join(this.dir, 'artifacts'), { recursive: true });
    writeFileSync(join(this.dir, rel), buf);
  }

  private commit(): void {
    this.step.durationMs = Date.now() - this.startMs;
    this.state.steps.push(this.step);
    this.state.updatedAt = nowIso();
    saveState(this.dir, this.state);
  }

  /** Finalize a run: write reports next to it, then move it into ./.verikun/runs/<id>/. */
  private static seal(state: RunState, dir: string): string {
    state.finishedAt = nowIso();
    state.updatedAt = nowIso();
    saveState(dir, state);
    writeFileSync(join(dir, 'report.xml'), toJUnitXml(state));
    writeFileSync(join(dir, 'report.html'), toHtml(state));
    mkdirSync(archiveBase(), { recursive: true });
    const dest = uniqueDir(join(archiveBase(), state.id));
    renameSync(dir, dest);
    return dest;
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

  /** Write JUnit + HTML reports and move the run into ./.verikun/runs/<id>/. */
  static archive(name?: string): { dir: string; xmlPath: string; htmlPath: string; state: RunState } {
    const dir = activeDir();
    if (!existsSync(statePath(dir))) {
      throw new CliError('No active test run to archive. Run an action first, or `vk run start`.', 1);
    }
    const state = loadState(dir);
    if (!state) throw new CliError('Active run state is unreadable (.verikun/run/run.json is corrupt).', 3);

    if (name) state.name = name;
    const dest = Recorder.seal(state, dir);
    return { dir: dest, xmlPath: join(dest, 'report.xml'), htmlPath: join(dest, 'report.html'), state };
  }
}
