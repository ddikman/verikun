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
     tap <selector>               — tap the element a selector resolves to (scrolls it into view first)
     text <selector> <value...>   — focus a field and type value (--clear to clear first, --enter to submit)
     type <value...>              — type into the already-focused field
     key <name> | back | home | enter
     swipe <up|down|left|right> [--on <selector>]  — scroll/swipe (up = scroll down the page)
     assert <selector> [--text <s>] [--gone]       — assert presence/text/absence (FAILS the test if false)
     wait <selector> [--gone] [--timeout <ms>]     — block until present/absent
     screenshot                   — capture the screen into the report
     device <set|get|reset|caps>  — change the DEVICE (not the app) to test how the app
                                  copes. The command name is EXACTLY "device"; the
                                  subcommand is the FIRST POSITIONAL, never part of the
                                  command name. Each assignment is one positional:
                                    {"command":"device","positionals":["set","dark=on","font-scale=1.3"]}
                                    {"command":"device","positionals":["reset"]}
                                  Keys: airplane=on|off (go offline — for retry/error
                                  handling), dark=on|off, font-scale=<0.5-3.0>,
                                  rotation=portrait|landscape|portrait-reverse|
                                  landscape-reverse|auto, stay-awake=on|off.
                                  ALWAYS finish the scenario with a "reset" step. Do NOT
                                  tap immediately after airplane=off — the radio is back
                                  but the network is not; follow it with a wait/assert.
                                  Android only for airplane + rotation.

2. IF-PRESENT — { "type":"if-present", "selector":<sel>, "body":[<command leaves>] }
   Run body ONLY if the selector is on screen now. Use for OPTIONAL interstitials:
   permission dialogs, "rate us" popups, cookie banners, A/B variants. This is how you
   keep a flow from breaking when an extra screen sometimes appears.

3. REPEAT — { "type":"repeat", "selector":<sel>, "cap":<n>, "body":[<nodes>] }
   Repeat body UNTIL the selector appears, up to cap iterations. Use for "keep answering
   until the results screen" — NOT for scrolling to something that is already in the
   hierarchy, since tap scrolls to its own target. Always set a sane cap (e.g. 10). The engine also stops early if the screen stops changing. A repeat that finishes
   without its selector ever appearing FAILS the test — it did not do its job.

4. WHEN — { "type":"when", "branches":[{ "selector":<sel>, "body":[<nodes>] }, ...],
            "else":[<nodes>]  (optional) }
   Ordered n-way dispatch: the FIRST branch whose selector is on screen runs, and only it.
   Use when a screen is one of several KINDS that each need different handling —
   "the question is multiple-choice, or match-the-pairs, or arrange-the-words".
   If no branch matches and there is no "else", the test FAILS (the app showed something
   this test does not handle — that is a real result, not something to skip past).
   Use "else": [] to say explicitly "if none match, do nothing".
   WHEN vs IF-PRESENT: if-present = "this may or may not be there, carry on either way".
   when = "it is one of these; if it is none of them, that is a failure".

5. WHILE-PRESENT — { "type":"while-present", "selector":<sel>, "bind":<name>,
                     "cap":<n>, "body":[<nodes>] }
   Repeat body WHILE the selector is present. With "bind", the named counter starts at 0
   and increments after each iteration, and you reference it as {{ctx.<name>}} inside the
   selector and the body. This is how you walk an index-addressed list whose LENGTH you
   cannot know when compiling:
     { "type":"while-present", "selector":"id:word_bubble_container_id_{{ctx.i}}",
       "bind":"i", "cap":20,
       "body":[ { "type":"command","command":"tap",
                  "positionals":["id:word_bubble_container_id_{{ctx.i}}"],"flags":[] } ] }

6. READ — { "type":"read", "selector":<sel>, "field":"text"|"desc"|"id"|"idShort",
            "into":<name> }
   Capture a value off the live screen into {{ctx.<name>}} for a later step to use. Use it
   when the test must ACT ON a value it cannot know in advance — e.g. read the correct
   answer's text, then type that text into a field.

PLACEHOLDERS — any positional or flag value, and any control-node selector, may contain:
  {{ctx.NAME}}   a value stored by read, or a while-present counter
  {{env.NAME}}   an environment variable (use for credentials; never inline a secret)
  {{uuid}}       a fresh id, generated once per run (same value everywhere in the run)
  {{timestamp}}  epoch ms, once per run       {{run_id}}  this run's id
Use {{uuid}} when the test needs data that must be unique per run, e.g. a signup email
like "user-{{uuid}}@example.com" — never a hard-coded literal, which collides on rerun.

NESTING: control nodes may nest ONE level — a control node inside a control node, whose
body is command leaves. A repeat containing a when is the shape for "until the flow ends,
handle whichever screen is showing", and it is legal. Three levels is not.
EXCEPT: if-present and while-present may go one level deeper (their bodies are leaves), so
  repeat { when { while-present { tap ... } } }     — walk an index-addressed list
  repeat { when { if-present { tap ... } } }        — an optional step inside a branch
are both legal. Use them rather than approximating.
In particular: "if X appears, tap it" inside a branch is an if-present. Do NOT turn it
into a bare wait + tap — wait FAILS the test when X never appears, and "if" means it
might not. That mistake reads as a passing plan and fails on the first run where the app
skips that step.

Inside a "repeat until X" loop, GUARD a tap whose target is the thing that brings X about:
  repeat until <form> { if-present <button> { tap <button> } ; screenshot }
Once the transition starts, <button> is gone — so on the final iteration an unguarded tap
misses and fails the whole run, even though the loop did its job. The guard makes that
last lap a no-op instead of an error. Apply this whenever the prose says "tap ... until"
or "repeatedly until".

Do NOT flatten a branch into an unconditional sequence: emitting the taps for ALL the
kinds of screen one after another is wrong — on any given iteration most of them are not
there, and the test will fail on the first one that is missing. Use when.

Do NOT hard-code a run of indices you were not told the length of. If the prose says
"tap each pair", "until every pair is matched", or "tap the bubbles in order", the COUNT
varies per run — emit a while-present over {{ctx.i}} rather than tap _0, _1, _2, _3.
A hard-coded list is right only when the prose states the exact count.

SELECTORS (the engine auto-heals case/whitespace/partial, so prefer stable identifiers):
  @login            resource-id 'login' (shorthand for id:login)
  id:login          resource-id (full, suffix, or short)
  text:Sign in      visible text (case-insensitive)
  desc:Submit       content-desc / accessibility label
  class:Button      type or class
  "Sign in"         bare string == text:Sign in

A selector may also pin ELEMENT STATE, in both polarities:
  --enabled  / --not-enabled     actionable right now
  --selected / --not-selected    current option of a segmented control / tab bar / mode picker
  --checked  / --not-checked     checkbox / switch / radio state
  --focused  / --not-focused     holds input focus
On a command leaf write it as a flag. On a CONTROL NODE append it to the selector string —
that is the only place one can go, and it is what makes a state-conditional guard possible:
  { "type":"if-present", "selector":"id:mode_video --not-selected",
    "body":[ { "type":"command","command":"tap","positionals":["id:mode_video"],"flags":[] } ] }

RULES:
- --enabled on a tap makes it match only a control that is ACTIONABLE right now, and (with
  auto-wait) wait until it becomes so. Use it for any button that the app disables until
  something else is done — a Check/Submit/Continue that only lights up once an answer is
  selected or a form is valid. Without it the step taps a dead control, does nothing, and
  the failure surfaces later as a confusing timeout on the NEXT step.
- A picker or toggle whose options share ONE handler FLIPS on any tap, so an unconditional
  "tap the option you want" lands on the option you did NOT want whenever it was already
  chosen — and its starting state is usually content-driven, so you cannot know it now.
  Guard it: if-present "id:<option> --not-selected" { tap id:<option> }. The guard makes an
  already-correct state a no-op instead of a flip. Unguarded, the flow completes either way
  and the test PASSES having exercised the opposite mode — a false green, worse than a fail.
  Same shape for a checkbox that toggles: guard with --not-checked / --checked.
- assert is for VERIFICATION only and is terminal — never use it as a step you expect to
  fail. Put genuinely-optional UI behind if-present.
- tap/text SCROLL THEIR TARGET INTO VIEW automatically, so "scroll down to X and tap it"
  is just \`tap X\`. Do NOT wrap a tap in a repeat-until-visible loop to reach something
  below the fold — that is now redundant. Emit an explicit swipe only when the SCROLLING
  ITSELF is what the test asks for ("scroll the feed three times"), or to reveal content
  that is not in the hierarchy until it is built (an infinite/lazy list).
- Prefer resource-id / accessibility selectors over visible text where possible.
- Translate the test literally and minimally: do not invent ACTION steps (tap/text/swipe/key/assert)
  the prose does not imply. The ONE exception is screenshot — insert screenshot steps liberally as
  post-run review evidence: after each screen transition (launch, a navigation tap, a submit, a
  swipe/scroll) AND inside if-present/repeat bodies, so a failing branch or loop iteration is visible
  in the report. Screenshots never affect the result; err toward too many. They are dumped into the
  report for humans and never read back, so they are free on replay.`;

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
Do not invent elements that are not in the hierarchy.
An element tagged \`offscreen\` is in the tree but scrolled out of view; tap/text scroll
to their target on their own, so the fact a step failed on one means scrolling could not
reach it — pick a different element only if one genuinely serves the same purpose.`;

/**
 * Extra framing for compiling ONE SECTION of a test rather than a whole one — what
 * `@include` splits a test into (see ./include.ts, and compileFromSegments in ../cli.ts).
 *
 * It exists because of a measured failure, not a hypothetical one. `example-test-devicestate.md`
 * opens with a paragraph SUMMARISING the test ("checks that the app copes when the device
 * changes underneath it — dark mode and larger system text — and that everything is put back
 * afterwards"). Compiled as a whole test that paragraph is context; compiled alone it is the
 * entire prompt, and the model dutifully turned it into `device set dark=on font-scale=1.3`,
 * `screenshot`, `device reset` — three invented steps, ahead of the launch, that the test
 * never asked for. A section compile therefore has to be told it is a fragment, and that
 * emitting nothing is a legitimate answer.
 */
export const SECTION_NOTE = `THIS IS ONE SECTION OF A LARGER TEST, not a whole test. Other sections run before and
after it, in the order the test file lists them. Compile ONLY the actions THIS section
states, in the order it states them:
- Do NOT add setup — launching the app, signing in, navigating to a screen — that this
  section does not itself state. An earlier section has already done whatever was needed.
- Do NOT add teardown this section does not state, INCLUDING a trailing "device reset";
  a later section owns it.
- Prose that DESCRIBES the test rather than instructing it — a title, a summary of what
  the test covers, the rationale for a step — is NOT an instruction.
- If this section states no action at all, emit "steps": [].`;
