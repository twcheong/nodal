# Adding a Tool Skill (runbook the executor reads)

> **Audience:** Twixy contributors.
> **This is NOT the same as adding an agent tool.** For a new callable tool
> (`tool_fetch_to_file` etc.) see [ADDING_A_NEW_AGENT_TOOL.md](ADDING_A_NEW_AGENT_TOOL.md).
> A **tool skill** adds no new capability — it gives the executor a **runbook**
> (domain know-how) for a capability it already has (usually `chrome`).
>
> ⚠️ **After you write the runbook, read [SKILL_PROPAGATION.md](SKILL_PROPAGATION.md).**
> Editing the `.tskill` is not enough to ship it: the repo's `SKILL.md` is not
> auto-compiled, and an existing user workspace **never** receives an updated
> skill (missing-only projection). A runbook that reaches nobody fixes nothing —
> and it fails silently, which is how a broken one survived for days.

---

## 0. When you need this

Use a tool skill when the executor keeps doing a domain task **wrong the same
way**, and the fix is *knowledge*, not a new tool. It is the answer to "the AI
should just KNOW how to do X on site Y."

Real example (why this doc exists): Instagram post collection kept labelling
every `/p/` post as `photo`, silently dropping all carousels. The executor had
the `chrome` tool and the `instagram` label — but **no runbook told it that
carousel vs photo needs the grid tile's `img.alt`, not the URL.** The `instagram`
skill folder simply did not exist. Adding `skills/instagram/` with that runbook
fixed it. See that skill for a worked example.

---

## 0.5 Tool vs Tool Skill — two levels, do not confuse them

A node's capability is a **two-level catalog** (`src/lib/workflowTools.ts`),
mirrored in `WORKFLOW_SOUL.md` ("Tools and Tool Skills"):

| | **Tool** (depth 1) | **Tool Skill** (depth 2) |
|---|---|---|
| What it is | A **capability** the executor can invoke | A **narrower flavour** of that capability |
| Examples | `chrome`, `read`, `write`, `data`, `api` | `chrome → instagram`, `write → xlsx`, `data → query` |
| Node field | `tool` (exactly one per action node) | `toolSkills` (zero or more, all under the node's one tool) |
| Backed by | actual executable tooling (browser engine, file writer, DuckDB…) | **just a label** — until a `SKILL.md` runbook exists for it |
| How many per node | **one** L1 tool (soft rule — see SOUL) | several L2 skills, as long as all belong to that one tool |

The distinction that trips people up:

- A **Tool** is real machinery. `chrome` genuinely drives a browser; `write`
  genuinely writes files. Choosing the wrong tool means the node *cannot* do the
  work (e.g. `web-fetch` can't log into Instagram).
- A **Tool Skill** is, by default, **only a name**. `chrome → instagram` does not
  add any Instagram ability — the browser could already go anywhere. Its value
  appears *only* when a `SKILL.md` runbook is attached to that name (the entire
  point of this document). Without a runbook, a tool skill is an empty label that
  makes the node *look* specialised while giving the executor nothing extra.

So: **adding a Tool** = wiring new executable machinery
([ADDING_A_NEW_AGENT_TOOL.md](ADDING_A_NEW_AGENT_TOOL.md), 6+ layers, a patch).
**Adding a Tool Skill** = writing a runbook for machinery that already exists
(this doc, one `.tskill` file). The Instagram bug was precisely a tool skill that
was all label and no runbook.

One more rule the two levels imply (from SOUL, "One node stays inside one Tool"):
a single node uses **one L1 tool** but may use **several of that tool's L2
skills**. Reaching for a *second L1 tool* in the same node is the signal to split
into another node.

---

## 1. How a skill actually reaches the executor (the load-bearing fact)

There is exactly one delivery path, and it is **not** the workflow catalog:

```
skills/<name>/<name>.tskill   (you write this — TSL source)
        │  app watcher compiles on change (electron/main.ts: startSkillsWatcher)
        ▼
skills/<name>/SKILL.md         (compiled markdown — what the executor reads)
        │  app regenerates the index (regenerateSkillsIndex)
        ▼
<workspace>/SKILLS.md          (index: name + path + description of every skill)
        │  the workflow-runner reads SKILLS.md at the START of every node
        ▼  (confirmed in session logs: "read the SKILLS.md first as required by SOUL.md")
executor decides, per the description, whether to open <name>/SKILL.md
```

Two consequences you must design around:

- **The workflow tool catalog (`workflowTools.ts`) does NOT carry skill
  bodies.** `renderToolCatalog()` emits sub-skill **IDs only** — the builder and
  executor never see a sub-skill's description through the catalog. The runbook
  travels *only* through the SKILLS.md → SKILL.md path above.
- **Discovery is by description, not by `toolSkills` id match.** The executor
  reads the SKILLS.md index and chooses which SKILL.md to open based on each
  skill's `description`. So the description is the trigger — write it to fire on
  the task, and tell the reader to read it *before* acting (see §3).

---

## 2. Steps

### 1. Write the TSL source — `skills/<name>/<name>.tskill`

`<name>` should match the catalog sub-skill id when there is one (e.g. the
`chrome` catalog lists `instagram`, so the skill folder is `skills/instagram/`).
That is what lets a node tagged `[chrome / instagram]` line up with the skill in
the reader's mind — but remember matching is by description, not a hard join.

Minimal grammar (full example: `skills/instagram/instagram.tskill`):

```
@workspace twixy

SKILL "Human-Readable Title"
  version: 1.0
  description: "One line. This is the TRIGGER — see §3."
  tags: [instagram, carousel, browser]

PLATFORMS { INSTAGRAM }          # from KNOWN_PLATFORMS in tsl-compiler.ts

GOAL "..." { objective: "..."  kpi: some_metric }

# Stage blocks (any subset, in order): COLLECT / ANALYZE / EXECUTE / TRACK
COLLECT "..." {
  USE instagram WITH profile = "openclaw" AS ig
  ...free-form runbook prose + exact tool snippets the executor should copy...
}
TRACK "..." { ...how to report / a sanity check... }
```

Notes from the compiler (`electron/tsl-compiler.ts`):
- Header fields parsed: `version`, `description`, `tags` (and `author`).
- Block keywords: `PLATFORMS`, `GOAL`, `COLLECT`, `ANALYZE`, `EXECUTE`, `TRACK`.
- Everything inside a stage block is passed through as prose — put the concrete
  `browser act kind=evaluate fn='…'` snippets right there; the executor copies them.
- Comments: `#` lines are stripped.

### 2. Compile + install (two ways)

**Automatic (app running):** drop the `.tskill` into the workspace
`skills/<name>/` folder. `startSkillsWatcher` recompiles it to `SKILL.md` and
regenerates `SKILLS.md` within ~400ms (plus a 30s safety poll). Confirmed to
work end-to-end.

**Manual (app closed / CI):** compile with the same function the app uses —
`compileTSL(source, '<name>.tskill')` from `electron/tsl-compiler.js` (build
electron first with `tsc -p tsconfig.electron.json`). Write the returned
`markdown` to `SKILL.md`. The app regenerates `SKILLS.md` on next startup
(`ensureWorkspace` → `compileTskillFiles` + `regenerateSkillsIndex`).

Put the source of truth in the **repo** `skills/<name>/` (version controlled).
Delivery to a user workspace is a **3-hop chain**, and knowing where it can
stall saves a debugging session:

```
repo skills/<name>/            (bundle; dev = repo dir, prod = app resources)
  → <project>/shared/skills/   seedSharedFromBundle — every launch + watcher pass
  → <project>/users/<uid>/skills/   projectSharedIntoUser — BUILT-INS ONLY,
                                    missing-only clone (never overwrites)
  → <workspace>/SKILLS.md      regenerateSkillsIndex — launch + watcher pass
```

Built-ins now auto-deliver at launch **and** from the skills watcher
(30s poll bound), so a skill added while the app is running appears in
SKILLS.md within ~30s. Teammate-shared skills are the exception: they stop at
`shared/` until the user explicitly pulls (pull-shared IPC) — that's by
design, not a bug. Before 2026-08-12 built-ins also stalled at `shared/`
(projection had been removed from startup for the team-collab design), which
is exactly how a freshly added `skills/pptx` stayed invisible to the executor
while looking fully delivered in `shared/` — if a new skill is missing from
SKILLS.md, check `users/<uid>/skills/` before suspecting the description.

### 3. Write the description as a trigger

The `description` in the `.tskill` header is the ONLY thing the executor sees in
the index before deciding whether to open the skill. Make it:
- **name the task and platform** ("Collect a profile's posts …"),
- **name the failure it prevents** ("… with CORRECT upload-type detection
  (reel / carousel / photo)"),
- **tell the reader to read it first** ("Read this before any Instagram
  post-collection or audit node.").

A vague description ("Instagram helpers") will sit in the index unread.

### 4. (Optional) register the id in the workflow catalog

If you want the workflow **builder** to be able to put `toolSkills: ["<name>"]`
on a node, add the id under the parent tool's `skills` in
`src/lib/workflowTools.ts` (`WORKFLOW_TOOLS`). This only affects authoring/UI —
it does **not** deliver the runbook (that's §1). A skill can exist and be read
via SKILLS.md without a catalog entry; a catalog entry without a `SKILL.md` is
just an unbacked label (which is exactly how `instagram` started out broken).

---

## 3.5 Verification — behavioural, in the session log

A skill file that compiles is not proof it's used. Verify against a real run:

1. Confirm the index lists it: `grep -A2 '<name>' <workspace>/SKILLS.md`.
2. Run a task that should trigger it. In the workflow-runner session log
   (`~/.openclaw/agents/workflow-runner/sessions/<latest>.jsonl`):
   - the executor should read `SKILLS.md` (it does this every node), and
   - then read your `skills/<name>/SKILL.md` (`grep 'skills/<name>/SKILL.md'`).
3. Check the OUTPUT reflects the runbook (e.g. carousels now appear).

If step 2b never happens, the description didn't trigger the read. Strengthen it
(§3). If it still won't read reliably, the guaranteed fallback is to inject the
skill body through the **node prompt** in `buildNodePrompt` (both copies —
`useWorkflowTest.ts` and `runWorkflowNodes.ts`; see the layer-7 note in
ADDING_A_NEW_AGENT_TOOL.md), keyed on `toolSkills` containing the name. That is
the reliable channel when discovery-by-description is not enough.

---

## 4. Common mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Added the id to `workflowTools.ts` but no `SKILL.md` | Node says `[chrome / instagram]`, executor has no runbook, keeps doing it wrong | Create `skills/<name>/<name>.tskill` — the catalog id is just a label |
| Put the know-how in the sub-skill `description` in the catalog | Never reaches anyone — `renderToolCatalog()` emits IDs only | Put it in the `.tskill` / `SKILL.md` |
| Weak/vague `description` header | Skill sits in SKILLS.md unread | Make the description a trigger (§3) |
| Wrote `SKILL.md` by hand only | Next compile/edit from `.tskill` overwrites it | Author the `.tskill` source; treat `SKILL.md` as build output |
| Wrote only to the repo | Live workspace run doesn't see it for up to 30s (watcher poll) | Wait one poll, or check the 3-hop chain above — skill in `shared/` but not `users/<uid>/skills/` means projection stalled |
| Snapshot-only DOM read in the runbook | Signals in `img.alt` / DOM attributes are invisible to the accessibility tree | Instruct `browser act kind=evaluate`, not a snapshot, for attribute-level signals |
