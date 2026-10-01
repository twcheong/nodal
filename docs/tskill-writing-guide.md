# .tskill Writing Guide

Quick reference for writing Twixy Skill Language (TSL) files.
Full spec: `TSL.md` — Compiler source: `dist-electron/tsl-compiler.js`

---

## File skeleton

```tskill
@workspace twixy                    ← required, must be "twixy"

SKILL "Skill Name"
  version: 1.0
  summary: "한 줄 요약 — SKILLS.md 인덱스에 표시됨"
  description: "Full description. Include trigger phrases here."
  tags: [tag1, tag2]
  trigger: "user asks to analyze instagram performance"
  output: "engagement report, top post list"
  schedule: "0 9 * * *"            ← optional: cron schedule
  LISTENS TO "signal" FROM SKILL "Other Skill"  ← optional: event trigger

PLATFORMS {
  INSTAGRAM
  YOUTUBE
}

GOAL "label" {
  objective: "one sentence"
  kpi: engagement_rate
  target: 0.06                      ← optional
  window: 30 days                   ← optional
}

PHASE "Phase Name" {
  COLLECT "label" { ... }
  ANALYZE "label" { ... }
}

PHASE "Phase Name" {
  STRATEGIZE "label" { ... }
  EXECUTE "label" { ... }
  TRACK "label" { ... }
}
```

---

## SKILL header fields


| Field         | Required | Description                                  |
| ------------- | -------- | -------------------------------------------- |
| `version`     | yes      | Semver string                                |
| `summary`     | yes      | One-liner for SKILLS.md index                |
| `description` | yes      | Full description + trigger phrases           |
| `tags`        | yes      | Array of topic tags                          |
| `trigger`     | yes      | Explicit conditions that activate this skill |
| `output`      | yes      | Artifacts this skill produces                |
| `schedule`    | no       | Cron expression for scheduled runs           |
| `LISTENS TO`  | no       | Event-driven trigger from another skill      |


### `trigger` vs `description`

- `description` — full prose for Codex to understand what the skill does
- `trigger` — short, concrete phrases that activate the skill (used by Twixy's dispatcher)

```tskill
description: "Analyzes the last 30 days of Instagram reels to surface top-performing content patterns."
trigger: "analyze instagram, reel performance, what's working on instagram"
```

### `output`

Comma-separated list of artifacts the skill writes to disk or emits.

```tskill
output: "insights report ($INSIGHTS), top post list ($RAW), signal: insights_ready"
```

---

## PHASE

PHASEs are named groupings of pipeline stages. They replace bare stages at the top level.
Every stage must live inside a PHASE. Stages within a PHASE must still follow pipeline order.

```tskill
PHASE "리서치" {
  COLLECT "Pull recent reels" { ... }
  ANALYZE "Score by engagement" { ... }
}

PHASE "전략 수립" {
  STRATEGIZE "Build test plan" { ... }
}

PHASE "실행" {
  EXECUTE "Post drafts" { ... }
}

PHASE "측정" {
  TRACK "Write performance report" { ... }
}
```

PHASEs themselves must appear in pipeline order (COLLECT before ANALYZE, etc. across all PHASEs).
Phase names are free-form — use whatever is meaningful for the skill.

---

## Pipeline stages

Stages must appear in this order (across all PHASEs). Skip stages you don't need.


| #   | Stage        | Use for                                         |
| --- | ------------ | ----------------------------------------------- |
| —   | `GOAL`       | Objective + KPI (not counted in Behavior steps) |
| 1   | `COLLECT`    | Open platforms, pull raw data                   |
| 2   | `ANALYZE`    | Find patterns, score, evaluate hypotheses       |
| 3   | `STRATEGIZE` | Form hypothesis, build plan                     |
| 4   | `EXECUTE`    | Take action in the world                        |
| 5   | `TRACK`      | Measure outcomes, write reports, emit signals   |


---

## Actions (inside any stage)

### USE — open a platform session

```tskill
USE instagram AS ig
USE google_analytics AS ga WITH property = "UA-123456"
```

### EXTRACT — pull data

```tskill
EXTRACT Post FROM ig
  WHERE type = "REEL"
  LIMIT 30
  SINCE 30 days
  ORDER BY published_at DESC
  INTO $raw_posts
```

### STORE — save to workspace

```tskill
STORE $raw_posts AS "instagram_posts_{date}" IN $RAW
```

### LOAD — read from workspace

```tskill
LOAD "instagram_posts_{date}" FROM $RAW AS $posts
```

### HYPOTHESIZE — generate a hypothesis

```tskill
HYPOTHESIZE Hypothesis AS $h1
  FROM $insights
  ABOUT "which content format drives highest engagement"
  CONTEXT "we have 30 days of reel data"
```

### PLAN — generate a strategy

```tskill
PLAN Strategy AS $weekly_plan
  FROM $h1
  ABOUT "3-post test targeting winning format"
```

### SPAWN — delegate to a sub-agent

```tskill
SPAWN caption_writer
  TASK "write 3 caption variants with strong hook and CTA"
  USING $top_posts
  OUTPUT $captions
  AWAIT            ← or ASYNC for parallel
```

### POST — publish content (EXECUTE only)

```tskill
POST $draft TO instagram
  AT $draft.schedule_time
  WITH caption = $draft.body
```

⚠ `POST` without `APPROVE` = compile error.

### APPROVE — human approval gate (required before POST)

```tskill
APPROVE "Review drafts before publishing" {
  show: $drafts
  timeout: 24 hours
  on_timeout: CANCEL    ← CANCEL | ESCALATE | PROCEED
}
```

### EMIT — send signal to another skill

```tskill
EMIT "scout_complete"
  WITH payload = $posts
  TO SKILL "Analytics"
```

### LET — declare a variable

```tskill
LET $cutoff = TODAY - 30 days
LET $top = $scored_posts WHERE engagement_rate > 0.05 LIMIT 10
```

---

## Control flow

```tskill
IF $results.count = 0 {
  EMIT "collection_failed"
}

FOR EACH $post IN $top_posts {
  SPAWN scorer
    TASK "score this post"
    USING $post
    OUTPUT $post.score
    AWAIT
}

WHEN $post.views > $min_views {
  STORE $post AS "top_performer" IN $INSIGHTS
}
```

---

## Reserved path aliases


| Alias         | Resolves to          |
| ------------- | -------------------- |
| `$RAW`        | `data/raw/`          |
| `$INSIGHTS`   | `data/insights/`     |
| `$STRATEGIES` | `strategies/`        |
| `$DRAFTS`     | `content/drafts/`    |
| `$PUBLISHED`  | `content/published/` |
| `$REPORTS`    | `data/reports/`      |


Custom variables use `LET $myVar = ...` (lowercase recommended).

---

## Signal system

Chain skills by emitting and listening to signals.

```tskill
// Sender skill (TRACK stage)
EMIT "insights_ready"
  WITH payload = $insights
  TO SKILL "Strategy Gen"

// Receiver skill (header)
SKILL "Strategy Gen"
  LISTENS TO "insights_ready" FROM SKILL "Analytics"

// Receiver skill (COLLECT stage) — payload arrives as $incoming
COLLECT "Load incoming data" {
  LOAD $incoming AS $fresh_insights
}
```

---

## Supported platforms

```
INSTAGRAM  TIKTOK  YOUTUBE  TWITTER  LINKEDIN
GOOGLE_ANALYTICS  GOOGLE_ADS  META_ADS
NOTION  AIRTABLE  SLACK
```

---

## TSL types


| Type         | Produced by                     |
| ------------ | ------------------------------- |
| `Post`       | `EXTRACT Post FROM ...`         |
| `Metric`     | `EXTRACT Metric FROM ...`       |
| `Hypothesis` | `HYPOTHESIZE Hypothesis AS ...` |
| `Strategy`   | `PLAN Strategy AS ...`          |
| `Campaign`   | manual / executor               |
| `Report`     | `TRACK` output                  |


---

## Compile errors to avoid


| Error                       | Cause                                                             |
| --------------------------- | ----------------------------------------------------------------- |
| `invalid workspace`         | `@workspace` ≠ `twixy`                                            |
| `missing SKILL declaration` | No `SKILL "..."` block                                            |
| `missing summary`           | `summary` field not set                                           |
| `missing trigger`           | `trigger` field not set                                           |
| `missing output`            | `output` field not set                                            |
| `stage outside PHASE`       | Stage declared at top level, not inside a PHASE block             |
| `PUBLISH without APPROVE`   | `POST` in EXECUTE without `APPROVE {}`                            |
| `stage out of order`        | Stages not in GOAL→COLLECT→ANALYZE→STRATEGIZE→EXECUTE→TRACK order |
| `unknown path alias`        | Using `$SOMETHING` not in reserved list without `LET`             |


---

## After writing

1. Save as `skills/<name>/<name>.tskill`
2. Twixy app auto-compiles to `SKILL.md` on file save (watchSync)
3. `summary` field populates the skill's entry in `SKILLS.md` index automatically


---

## Building a skill from a past conversation

When the user asks "create a skill from what we just did" (or similar):

1. Read the current session log from `logs/sessions/` — find the most recent file matching today's date. Each line is a raw JSON gateway frame.
2. Extract tool calls from `toolCall` blocks inside `message` events (role: assistant). These show exactly what actions were taken: `browser.open`, `browser.act`, `write`, `sessions_spawn`, etc.
3. Extract the actual workflow sequence — what was navigated, what data was collected, what files were written.
4. Map to TSL stages:
   - `browser` calls → `COLLECT` or `EXECUTE`
   - `read` / `write` calls → `STORE` / `LOAD`
   - `sessions_spawn` → `SPAWN`
5. Confirm the skill name and scope with the user before writing.
6. Write the `.tskill` file — compiler picks it up automatically.

**Session log line format:**
```jsonl
{"event":"session.message","payload":{"message":{"role":"assistant","content":[
  {"type":"toolCall","name":"browser","arguments":{"action":"open","url":"...","profile":"Twixy"}},
  {"type":"toolCall","name":"write","arguments":{"path":"...","content":"..."}}
]}}}
```

**Note:** Logs accumulate from the moment the session key is established. Previous sessions are available in `logs/sessions/` by date. Paths in log entries may show full absolute paths — strip the workspace root to get the relative path.
