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

/** Capture a value from the live UI tree into the run's `ctx`, for a later step to
 *  interpolate as {{ctx.NAME}}. This is how a flow reads something it cannot know at
 *  compile time — e.g. an app that marks the correct answer in the semantic tree, where
 *  the test must then TYPE that value rather than just tap it.
 *
 *  Deliberately a NODE, not a leaf command: leaves go through `exec` (executeOutcome),
 *  whose contract returns only {code, error} and so cannot hand a value back. Being a
 *  node also keeps it off `vk server`'s /exec, which rejects anything that is not a
 *  command leaf. */
export interface ReadNode {
  type: 'read';
  selector: string;
  /** Which Element field to capture. */
  field: 'text' | 'desc' | 'id' | 'idShort';
  /** ctx key to store it under — readable later as {{ctx.<into>}}. */
  into: string;
}

/** Run `body` only if `selector` is present on screen — dismisses conditional
 *  interstitials (permission dialogs, "rate us" popups) without failing the flow.
 *  Absent => SKIP. Contrast `when`, whose no-match is a failure. */
export interface IfPresentNode {
  type: 'if-present';
  selector: string;
  body: PlanNode[];
}

/** Ordered n-way dispatch: the first branch whose selector is present runs, and only
 *  that one. Models "the screen is one of these N kinds, handle whichever it is".
 *
 *  No-match is a FAILURE unless `else` is given — the opposite of `if-present`, and
 *  deliberately so. A silently-skipped dispatch inside a loop would spin to the cap
 *  doing nothing and report green, which is the false-green class parsePlan already
 *  rejects at the plan level. `else: []` is the explicit "match nothing, do nothing"
 *  opt-in and is the one body allowed to be empty. */
export interface WhenNode {
  type: 'when';
  branches: { selector: string; body: PlanNode[] }[];
  else?: PlanNode[];
}

/** Repeat `body` until `selector` appears, bounded by `cap` iterations (and a
 *  no-progress early-exit the engine applies). Models "scroll until X". */
export interface RepeatNode {
  type: 'repeat';
  selector: string;
  cap: number;
  body: PlanNode[];
}

/** Repeat `body` WHILE `selector` is present, bounded by `cap`. The selector is
 *  {{ctx.*}}-interpolated before each check, and `bind` (when set) is a ctx counter
 *  that starts at 0 and increments after each iteration — so
 *    while-present id:option_{{ctx.i}} bind=i  { tap id:option_{{ctx.i}} }
 *  walks an index-addressed list whose LENGTH is not known at compile time. That is
 *  the shape a "match the pairs"/"arrange the words" body needs, and it is why this
 *  exists instead of an expression language: the real-world requirement was a counter
 *  and a string template, not arithmetic. */
export interface WhilePresentNode {
  type: 'while-present';
  selector: string;
  bind?: string;
  cap: number;
  body: PlanNode[];
}

export type ControlNode = IfPresentNode | WhenNode | RepeatNode | WhilePresentNode;
export type PlanNode = LeafStep | ReadNode | ControlNode;

/** Max control-node nesting. 1 = a control node at top level whose body is leaves
 *  (the v1 rule). 2 = a control node inside that body, whose own body is leaves —
 *  i.e. `repeat { when { … } }`, the loop-that-branches shape a real dynamic flow
 *  needs. The schema is hand-unrolled to exactly this depth, so raising it means
 *  editing controlSchema()'s nesting as well as this constant. */
export const MAX_CONTROL_DEPTH = 2;

export const isControlNode = (n: PlanNode): n is ControlNode =>
  n.type === 'if-present' || n.type === 'when' || n.type === 'repeat' || n.type === 'while-present';

/** Every body a control node owns (a `when` owns one per branch, plus `else`). */
export function bodiesOf(n: ControlNode): PlanNode[][] {
  if (n.type === 'when') return [...n.branches.map((b) => b.body), ...(n.else ? [n.else] : [])];
  return [n.body];
}

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
 * Plan. Deliberately NON-RECURSIVE: instead of a `Plan -> node -> Plan` cycle
 * (structured output rejects recursive schemas) the control levels are HAND-UNROLLED
 * to MAX_CONTROL_DEPTH. Raising the depth means adding another unrolled level here.
 */
const stepItems = (bodyItems: object) => ({
  anyOf: [
    leafSchema(),
    readSchema(),
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'selector', 'body'],
      properties: {
        type: { type: 'string', enum: ['if-present'] },
        selector: { type: 'string' },
        body: { type: 'array', items: bodyItems },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'branches'],
      properties: {
        type: { type: 'string', enum: ['when'] },
        branches: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['selector', 'body'],
            properties: { selector: { type: 'string' }, body: { type: 'array', items: bodyItems } },
          },
        },
        else: { type: 'array', items: bodyItems },
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
        body: { type: 'array', items: bodyItems },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'selector', 'cap', 'body'],
      properties: {
        type: { type: 'string', enum: ['while-present'] },
        selector: { type: 'string' },
        bind: { type: 'string' },
        cap: { type: 'integer' },
        body: { type: 'array', items: bodyItems },
      },
    },
  ],
});

/** The innermost level: leaves, reads, and the two SIMPLE control nodes — `if-present`
 *  and `while-present` — restricted to leaf-only bodies so they cannot open a further
 *  level.
 *
 *  Both were added from measured failures, and both are the same failure: when the model
 *  needs a construct one level deeper than the grammar allows, it does not give up — it
 *  DEGRADES to an unconditional approximation, which is exactly the bug #33 is about.
 *    - Without `while-present` here, a compile of the dynamic-lesson repro produced
 *      `repeat { when { … } }` correctly but HARD-CODED the index lists inside each branch
 *      (pairs 0..3, bubbles 0..5) — broken the moment a question has a different count.
 *    - Without `if-present` here, the same compile turned the prose "IF a Continue button
 *      appears, tap it" into an unconditional `wait id:continue_button_id` inside every
 *      branch. The app auto-advances and shows no Continue, so all three runs failed on
 *      that wait — a conditional flattened into an assertion, one level down.
 *
 *  A full third level for every node would ~3x a 28KB schema (bad for OpenAI strict
 *  limits, worse for cursor, which injects the schema as prompt text). Granting it to the
 *  two leaf-bodied nodes is the cheap, bounded version. `when` and `repeat` stay at
 *  MAX_CONTROL_DEPTH: they are the nodes whose bodies want to be deep, and allowing them
 *  here is what would actually cost the schema. */
const innerControls = () => {
  const leafBody = { type: 'array', items: { anyOf: [leafSchema(), readSchema()] } } as const;
  return [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'selector', 'body'],
      properties: {
        type: { type: 'string', enum: ['if-present'] },
        selector: { type: 'string' },
        body: leafBody,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'selector', 'cap', 'body'],
      properties: {
        type: { type: 'string', enum: ['while-present'] },
        selector: { type: 'string' },
        bind: { type: 'string' },
        cap: { type: 'integer' },
        body: leafBody,
      },
    },
  ];
};

const LEAF_ONLY_ITEMS = { anyOf: [leafSchema(), readSchema(), ...innerControls()] };

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
      items: stepItems(stepItems(LEAF_ONLY_ITEMS)),
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

function readSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'selector', 'field', 'into'],
    properties: {
      type: { type: 'string', enum: ['read'] },
      selector: { type: 'string' },
      field: { type: 'string', enum: ['text', 'desc', 'id', 'idShort'] },
      into: { type: 'string' },
    },
  } as const;
}

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

const READ_FIELDS = new Set(['text', 'desc', 'id', 'idShort']);
/** ctx keys are interpolated into selectors as {{ctx.NAME}}; keep them boring so a
 *  name can never smuggle regex/template metacharacters into a selector. */
const CTX_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a single node (used for both compile output and a spliced repair).
 *
 *  `depth` is how many control nodes enclose this one. It is the ONLY thing bounding
 *  nesting at runtime, and it must agree with PLAN_JSON_SCHEMA's hand-unrolled levels
 *  — the schema stops a compliant model, this stops everything else (a repair, a
 *  hand-edited plan, a poisoned cache entry). */
export function validateNode(node: unknown, where: string, depth = 0): PlanNode {
  if (!node || typeof node !== 'object') throw new InvalidPlanError(`${where}: not an object`);
  const n = node as Record<string, unknown>;

  /** Validate one control body. `allowEmpty` is true only for `when`'s `else`. */
  const validateBody = (raw: unknown, label: string, allowEmpty = false): PlanNode[] => {
    if (!Array.isArray(raw)) throw new InvalidPlanError(`${label}: body must be an array`);
    if (raw.length === 0 && !allowEmpty) {
      // Silence must never read as success — same rule parsePlan applies to the plan.
      throw new InvalidPlanError(`${label}: body is empty (a control body must do something; use when's "else": [] to mean "do nothing")`);
    }
    return raw.map((b, i) => validateNode(b, `${label}[${i}]`, depth + 1));
  };
  /** `if-present` and `while-present` are allowed one level deeper than the branching
   *  nodes: they are the conditional and the index-walk an innermost branch body needs,
   *  and because their own bodies are leaves they cannot open a further level. Blocking
   *  them here does not make the model simplify — it makes it emit an unconditional
   *  approximation instead. See LEAF_ONLY_ITEMS. */
  const guardDepth = (extra = 0) => {
    const limit = MAX_CONTROL_DEPTH + extra;
    if (depth >= limit) {
      throw new InvalidPlanError(
        `${where}: control nodes may nest ${limit} deep at most (got ${depth + 1}) — flatten this or lift it to an outer step`,
      );
    }
  };
  const selectorOf = (): string => {
    if (typeof n.selector !== 'string' || !n.selector) throw new InvalidPlanError(`${where}: ${n.type} needs a selector`);
    return n.selector;
  };
  // OpenAI/codex strict mode forces every property into `required` and nullifies the
  // optional ones, so an absent `else`/`bind` arrives as null rather than missing.
  const optional = <T>(v: unknown, pick: (x: unknown) => T | undefined): T | undefined =>
    v === undefined || v === null ? undefined : pick(v);

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
    case 'read': {
      const selector = selectorOf();
      if (typeof n.field !== 'string' || !READ_FIELDS.has(n.field)) {
        throw new InvalidPlanError(`${where}: read needs field one of ${[...READ_FIELDS].join('|')} (got ${JSON.stringify(n.field)})`);
      }
      if (typeof n.into !== 'string' || !CTX_NAME_RE.test(n.into)) {
        throw new InvalidPlanError(`${where}: read "into" must be a plain identifier (got ${JSON.stringify(n.into)})`);
      }
      return { type: 'read', selector, field: n.field as ReadNode['field'], into: n.into };
    }
    case 'if-present': {
      guardDepth(1);
      return { type: 'if-present', selector: selectorOf(), body: validateBody(n.body, `${where}.body`) };
    }
    case 'when': {
      guardDepth();
      if (!Array.isArray(n.branches) || n.branches.length === 0) {
        throw new InvalidPlanError(`${where}: when needs at least one branch`);
      }
      const branches = n.branches.map((b, i) => {
        const br = b as Record<string, unknown>;
        if (!br || typeof br !== 'object' || typeof br.selector !== 'string' || !br.selector) {
          throw new InvalidPlanError(`${where}.branches[${i}]: needs a selector`);
        }
        return { selector: br.selector, body: validateBody(br.body, `${where}.branches[${i}].body`) };
      });
      const els = optional(n.else, (v) => validateBody(v, `${where}.else`, true));
      return { type: 'when', branches, ...(els ? { else: els } : {}) };
    }
    case 'repeat':
    case 'while-present': {
      guardDepth(n.type === 'while-present' ? 1 : 0);
      const selector = selectorOf();
      const cap = typeof n.cap === 'number' && n.cap > 0 ? Math.floor(n.cap) : DEFAULT_LOOP_CAP;
      const body = validateBody(n.body, `${where}.body`);
      if (n.type === 'repeat') return { type: 'repeat', selector, cap, body };
      const bind = optional(n.bind, (v) => {
        if (typeof v !== 'string' || !CTX_NAME_RE.test(v)) {
          throw new InvalidPlanError(`${where}: while-present "bind" must be a plain identifier (got ${JSON.stringify(v)})`);
        }
        return v;
      });
      return { type: 'while-present', selector, cap, body, ...(bind ? { bind } : {}) };
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
  // A plan with zero steps would "pass" green having done nothing — reject it so a
  // compiler misfire, prompt injection, or truncated cache entry can't be a false green.
  if (steps.length === 0) throw new InvalidPlanError('plan: has no steps (a test must have at least one step)');
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
