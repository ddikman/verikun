// The plan IR: the deterministic, replayable program the LLM compiles a natural-
// language test down to. The LLM is a COMPILER here, not a runtime — once an IR
// exists it is re-run with zero model calls on the happy path. The model is woken
// only to repair a step that genuinely fails (see ../agent/engine.ts).
//
// Shape rules (load-bearing, decided in plan-eng-review):
//  - Nodes are a UNIFORM typed union — a leaf command, or a control node. (Mixing
//    command-strings with structured control nodes would be the ugly split we
//    avoided.) A leaf carries the verikun command triple {command, positionals,
//    flags} directly, so the engine feeds it straight to executeOutcome.
//  - SHALLOW: control-node bodies hold LEAF steps only — no loop-inside-loop / if-
//    inside-loop in v1. That keeps the JSON schema NON-RECURSIVE, which is what lets
//    Anthropic structured output (output_config.format) guarantee a valid IR.
//    (A real flow that needs deeper nesting is the trigger to revisit — bounded-depth
//    schema or prompt-and-parse; see the design doc's validation gate.)
//  - flags are an array of {name,value} pairs (string values), NOT an open map —
//    structured-output schemas can't express an arbitrary-key object. A pure boolean
//    flag is value:"true" (flagBool reads 'true' as true; flagStr reads the string).

export interface FlagSpec {
  name: string;
  value: string;
}

export interface LeafStep {
  type: 'command';
  /** A verikun command, e.g. "tap", "text", "assert", "launch". */
  command: string;
  positionals: string[];
  flags: FlagSpec[];
}

/** Run `body` only if `selector` is present on screen — dismisses conditional
 *  interstitials (permission dialogs, "rate us" popups) without failing the flow. */
export interface IfPresentNode {
  type: 'if-present';
  selector: string;
  body: LeafStep[];
}

/** Repeat `body` until `selector` appears, bounded by `cap` iterations (and a
 *  no-progress early-exit the engine applies). Models "scroll until X". */
export interface RepeatNode {
  type: 'repeat';
  selector: string;
  cap: number;
  body: LeafStep[];
}

export type PlanNode = LeafStep | IfPresentNode | RepeatNode;

export interface Plan {
  version: 1;
  /** App package / bundle id under test (part of the cache key). */
  package?: string;
  platform?: string;
  steps: PlanNode[];
}

/** Commands a leaf step is allowed to carry — the agent-emittable ACTION/assertion verbs
 *  the grammar offers, a SUBSET of cli.ts's dispatch (inspection/diagnostic commands are
 *  excluded; see the note in the set). The engine validates every step — including a
 *  model-generated REPAIR — against this set before executing it, so a hallucinated
 *  command is rejected instead of hitting executeCommand's `default` (exit 2 + abort). */
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  'tap', 'click',
  'text', 'type',
  'key', 'back', 'home', 'enter',
  'swipe', 'scroll',
  'screenshot', 'shot',
  'wait', 'assert',
  'launch', 'open', 'stop', 'clear',
  // Inspection/diagnostic commands (`current`, `ui`, `find`, `log`, `logs`) are
  // deliberately NOT here: they are not test actions (the grammar never offers them), so
  // a plan or repair must never emit them — and `log`'s flags reach a device shell
  // (`--since`) and a host write (`--out`). Restricting the allowlist to the grammar's
  // action set also preserves a load-bearing invariant: every command that can raise a
  // heal trigger (a selector miss/ambiguity) is RECORDABLE, so markLastStepHealed ("heal
  // the last recorded step") always targets the step that actually failed — a
  // non-recordable selector-resolver here (e.g. `find`) would corrupt an unrelated step.
]);

export const DEFAULT_LOOP_CAP = 25;

/**
 * JSON Schema for `output_config.format` so the model returns a guaranteed-valid
 * Plan. Deliberately NON-RECURSIVE: control-node `body` arrays reference only the
 * leaf schema, so there is no `Plan -> node -> Plan` cycle (structured output
 * rejects recursive schemas). One nesting level, by design.
 */
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'steps'],
  properties: {
    version: { type: 'integer', enum: [1] },
    package: { type: 'string' },
    platform: { type: 'string', enum: ['android', 'ios'] },
    steps: {
      type: 'array',
      items: {
        anyOf: [
          leafSchema(),
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'selector', 'body'],
            properties: {
              type: { type: 'string', enum: ['if-present'] },
              selector: { type: 'string' },
              body: { type: 'array', items: leafSchema() },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'selector', 'cap', 'body'],
            properties: {
              type: { type: 'string', enum: ['repeat'] },
              selector: { type: 'string' },
              cap: { type: 'integer' },
              body: { type: 'array', items: leafSchema() },
            },
          },
        ],
      },
    },
  },
} as const;

/**
 * Schema for a repair RESPONSE. A repair is a DECISION, not a forced substitution:
 *  - "repair" + `step`: the screen has an element serving the failed step's intent.
 *  - "give_up" + `reason`: it does NOT (the flow drifted to an unexpected screen),
 *    so the test must FAIL rather than tap a loosely-related element and pass falsely.
 * Non-recursive (the `step` is a flat leaf), so structured output can guarantee it.
 */
export const REPAIR_DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['repair', 'give_up'] },
    step: leafSchema(),
    reason: { type: 'string' },
  },
} as const;

function leafSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'command', 'positionals', 'flags'],
    properties: {
      type: { type: 'string', enum: ['command'] },
      command: { type: 'string' },
      positionals: { type: 'array', items: { type: 'string' } },
      flags: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'value'],
          properties: { name: { type: 'string' }, value: { type: 'string' } },
        },
      },
    },
  } as const;
}

/** Raised when a model-produced plan (or repair) is structurally invalid. Kept
 *  out of errors.ts because it is an agent-layer concern, not a CLI exit code. */
export class InvalidPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlanError';
  }
}

function isFlagSpecArray(v: unknown): v is FlagSpec[] {
  return (
    Array.isArray(v) &&
    v.every(
      (f) =>
        f && typeof f === 'object' && typeof (f as FlagSpec).name === 'string' && typeof (f as FlagSpec).value === 'string',
    )
  );
}

/** Validate a single node (used for both compile output and a spliced repair). */
export function validateNode(node: unknown, where: string): PlanNode {
  if (!node || typeof node !== 'object') throw new InvalidPlanError(`${where}: not an object`);
  const n = node as Record<string, unknown>;
  switch (n.type) {
    case 'command': {
      if (typeof n.command !== 'string' || !KNOWN_COMMANDS.has(n.command)) {
        throw new InvalidPlanError(`${where}: unknown command ${JSON.stringify(n.command)}`);
      }
      if (!Array.isArray(n.positionals) || !n.positionals.every((p) => typeof p === 'string')) {
        throw new InvalidPlanError(`${where}: positionals must be a string[]`);
      }
      if (!isFlagSpecArray(n.flags)) throw new InvalidPlanError(`${where}: flags must be {name,value}[]`);
      return { type: 'command', command: n.command, positionals: n.positionals as string[], flags: n.flags };
    }
    case 'if-present':
    case 'repeat': {
      if (typeof n.selector !== 'string' || !n.selector) throw new InvalidPlanError(`${where}: ${n.type} needs a selector`);
      if (!Array.isArray(n.body)) throw new InvalidPlanError(`${where}: ${n.type} body must be an array`);
      const body = n.body.map((b, i) => {
        const leaf = validateNode(b, `${where}.body[${i}]`);
        if (leaf.type !== 'command') throw new InvalidPlanError(`${where}.body[${i}]: only leaf commands allowed (no nesting in v1)`);
        return leaf;
      });
      if (n.type === 'if-present') return { type: 'if-present', selector: n.selector, body };
      const cap = typeof n.cap === 'number' && n.cap > 0 ? Math.floor(n.cap) : DEFAULT_LOOP_CAP;
      return { type: 'repeat', selector: n.selector, cap, body };
    }
    default:
      throw new InvalidPlanError(`${where}: unknown node type ${JSON.stringify(n.type)}`);
  }
}

/** Validate + normalize a parsed plan object (belt-and-suspenders even with
 *  structured output, and the parse path when structured output is unavailable). */
export function parsePlan(raw: unknown): Plan {
  if (!raw || typeof raw !== 'object') throw new InvalidPlanError('plan: not an object');
  const p = raw as Record<string, unknown>;
  if (p.version !== 1) throw new InvalidPlanError(`plan: unsupported version ${JSON.stringify(p.version)} (expected 1)`);
  if (!Array.isArray(p.steps)) throw new InvalidPlanError('plan: steps must be an array');
  const steps = p.steps.map((s, i) => validateNode(s, `steps[${i}]`));
  return {
    version: 1,
    package: typeof p.package === 'string' ? p.package : undefined,
    platform: typeof p.platform === 'string' ? p.platform : undefined,
    steps,
  };
}

/** Convert a leaf's {name,value}[] flags into the args-parser Flags record that
 *  executeOutcome consumes. A boolean flag is carried as value "true" (flagBool
 *  reads 'true' as true); a valued flag keeps its string. */
export function leafToFlags(step: LeafStep): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of step.flags) out[name] = value;
  return out;
}
