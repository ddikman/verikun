---
name: Improvement suggestion
about: verikun itself is the friction — a step that heals on every cached replay, a repair that gives up, or a gotcha in its own operation
---

<!--
  For when verikun ITSELF is the problem, not the app under test and not a selector you could
  refine. An agent running the verikun skill can draft it for you, already redacted, through
  its `suggest-verikun-improvement` skill.

  Describe verikun's behaviour, never your app: no package or app names, on-screen text,
  selector values, test prose, logs, screenshots, device serials or account data. Keep a
  selector's kind (`text:`, `desc:`, resource-id) and drop the string it matched.

  Title: the weakness in one line. Fill in the vk-improve line if you can name the category,
  so a repeat report of the same weakness finds this issue. Delete any section that would only
  repeat another.
-->

<!-- vk-improve: <android|ios>/<area, e.g. vk-ai, ui, launch, text, wait>/<short-slug-of-the-weakness> -->

**TL;DR:** <!-- one sentence: the verikun weakness, generalised -->

**Pattern:** <!-- cached-replay heal | give-up | gotcha --> — <!-- what verikun did, structurally -->

**Evidence (generalised):**
- <!-- the verikun-side signal: an exit code and its message, or vk ai JSON with "cached": true and "modelRepairs": 1 -->
- <!-- the mechanic, e.g. a `text:` selector on a control with no resource-id healed to `desc:` -->

**Environment:** verikun <!-- version --> · <!-- android|ios + OS version --> · <!-- emulator, simulator or physical -->

**Repro (generalised):** <!-- steps that reproduce the verikun behaviour without your app -->

**Proposed fix**
- <!-- 2–4 bullets on what should change and roughly where: a direction, not a design -->
