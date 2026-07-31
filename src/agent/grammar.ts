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

3. REPEAT — { "type":"repeat", "selector":<sel>, "cap":<n>, "body":[<nodes>] }
   Repeat body UNTIL the selector appears, up to cap iterations. Use for "scroll until X
   is visible", or "keep answering until the results screen". Always set a sane cap (e.g.
   10). The engine also stops early if the screen stops changing. A repeat that finishes
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

RULES:
- --enabled on a tap makes it match only a control that is ACTIONABLE right now, and (with
  auto-wait) wait until it becomes so. Use it for any button that the app disables until
  something else is done — a Check/Submit/Continue that only lights up once an answer is
  selected or a form is valid. Without it the step taps a dead control, does nothing, and
  the failure surfaces later as a confusing timeout on the NEXT step.
- assert is for VERIFICATION only and is terminal — never use it as a step you expect to
  fail. Put genuinely-optional UI behind if-present.
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
Do not invent elements that are not in the hierarchy.`;
