// The command grammar handed to the model so it compiles NL into a valid plan IR.
// This mirrors the agent-facing contract in .claude/skills/verikun/SKILL.md; keep
// the two in sync (the SKILL.md is the human/source-of-truth, this is the compact
// runtime copy). It is the large, STABLE prefix of every compile/repair prompt, so
// the provider marks it cache_control: ephemeral to bill repeat calls at ~0.1x.

export const GRAMMAR = `You compile a natural-language mobile UI test into a verikun PLAN — a JSON program
that a deterministic engine replays against a real Android/iOS device with NO further
model calls on the happy path. Emit ONLY the plan object matching the provided schema.

A plan has { "version": 1, "package"?, "platform"?, "steps": [...] }.
Each step is one of three node types:

1. COMMAND leaf — { "type":"command", "command":<name>, "positionals":[...], "flags":[{"name","value"}] }
   A boolean flag is {"name":"clear","value":"true"}. A valued flag is {"name":"wait","value":"5s"}.
   Available commands (verikun):
     launch <package> [--clear] [--no-restart]  — start the app; force-stops it first so a
                                  rerun starts FRESH (--clear also wipes data → fresh-install;
                                  --no-restart skips the force-stop, just bringing it forward)
     stop <package>               — force-stop the app
     tap <selector>               — tap the element a selector resolves to
     text <selector> <value...>   — focus a field and type value (--clear to clear first, --enter to submit)
     type <value...>              — type into the already-focused field
     key <name> | back | home | enter
     swipe <up|down|left|right> [--on <selector>]  — scroll/swipe (up = scroll down the page)
     assert <selector> [--text <s>] [--gone]       — assert presence/text/absence (FAILS the test if false)
     wait <selector> [--gone] [--timeout <ms>]     — block until present/absent
     screenshot                   — capture the screen into the report

2. IF-PRESENT — { "type":"if-present", "selector":<sel>, "body":[<command leaves>] }
   Run body ONLY if the selector is on screen now. Use for OPTIONAL interstitials:
   permission dialogs, "rate us" popups, cookie banners, A/B variants. This is how you
   keep a flow from breaking when an extra screen sometimes appears.

3. REPEAT — { "type":"repeat", "selector":<sel>, "cap":<n>, "body":[<command leaves>] }
   Repeat body until the selector appears, up to cap iterations. Use for "scroll until X
   is visible". Always set a sane cap (e.g. 10). The engine also stops early if the screen
   stops changing.

NESTING: control-node bodies hold COMMAND leaves only — do NOT nest if-present/repeat
inside another control node.

SELECTORS (the engine auto-heals case/whitespace/partial, so prefer stable identifiers):
  @login            resource-id 'login' (shorthand for id:login)
  id:login          resource-id (full, suffix, or short)
  text:Sign in      visible text (case-insensitive)
  desc:Submit       content-desc / accessibility label
  class:Button      type or class
  "Sign in"         bare string == text:Sign in

RULES:
- assert is for VERIFICATION only and is terminal — never use it as a step you expect to
  fail. Put genuinely-optional UI behind if-present.
- Prefer resource-id / accessibility selectors over visible text where possible.
- Translate the test literally and minimally; do not invent steps the prose does not imply.`;

export const REPAIR_GRAMMAR = `A single step in a verikun plan failed to resolve its selector against the live screen
(shown below). Decide between two outcomes — and be STRICT:

- "repair": the current screen genuinely contains an element that serves the SAME
  PURPOSE as the failed step (the same control after a UI/build change, a renamed id,
  a translated label, the same button relocated). Return it as ONE replacement command
  leaf in "step", reusing the same command unless the screen clearly requires another.

- "give_up": the screen does NOT contain an element matching the step's intent — e.g.
  the flow has landed on an unexpected screen, a different app, or a dead end. Return
  "give_up" with a short "reason". The test will then FAIL, which is the CORRECT result.

"Same purpose" means the same user-facing action, NOT merely "a tappable element
exists". Do NOT substitute a loosely-related or convenient element (a back arrow, a
prominent unrelated button, a menu item that sounds similar) just to make the step
pass — a wrong substitution hides a real regression behind a false green. If you are
not confident the element does what the original step intended, choose give_up.

Emit ONLY an object matching the schema:
  { "decision":"repair", "step": { "type":"command","command","positionals":[...],"flags":[{"name","value"}] } }
  { "decision":"give_up", "reason": "<why no element on this screen matches the intent>" }
Prefer a stable selector (resource-id / accessibility label) visible in the hierarchy.
Do not invent elements that are not in the hierarchy.`;
