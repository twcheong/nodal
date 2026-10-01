# TSL — Twixy Skill Language

**Version 1.0**

TSL (Twixy Skill Language) is a declarative, pipeline-oriented language for writing marketing intelligence skills on the Twixy platform. A **skill** is a reusable, executable unit of marketing work — it can collect data, generate strategy, publish content, or track results.

TSL is not a general-purpose programming language. It does one thing exceptionally well: it expresses what a marketing agent should do, in what order, with what data, and why.

---

## Design Principles

**1. Pipeline-first.**
Marketing work is inherently sequential. TSL enforces this. The six pipeline stages are not optional organizational boxes — they are language constructs that the compiler validates in order.

**2. Intent over implementation.**
`EXTRACT posts FROM instagram LIMIT 50` is a complete statement. You do not wire up API clients or parse JSON. The agent handles that.

**3. Human-in-the-loop by default.**
Publishing, sending, or any action that reaches the world requires an explicit `APPROVE` gate. An agent will never post to social media without a human confirming. This is a language-level requirement, not a feature.

**4. Transparent and auditable.**
Every TSL skill compiles to a readable SKILL.md file. The source `.tskill` file is the source of truth. SKILL.md is the build artifact.

**5. Twixy-native.**
`@workspace twixy` is required in every file. TSL makes no attempt to be a portable marketing DSL. That focus is what makes it precise.

---

## The Six Pipeline Stages

Every skill is built around the six stages of the marketing loop. Stages must appear in order. You may omit stages you don't need.

| # | Stage Keyword | Korean | What happens here |
|---|---|---|---|
| 1 | `GOAL` | 행동 전략 | Declare the objective, KPIs, and success criteria |
| 2 | `COLLECT` | 데이터 수집 | Gather raw signals from platforms and apps |
| 3 | `ANALYZE` | 데이터 분석 | Find patterns, score content, generate insights |
| 4 | `STRATEGIZE` | 디테일한 행동 전략 | Form a hypothesis, build a specific plan |
| 5 | `EXECUTE` | 실행 | Take action in the world |
| 6 | `TRACK` | 결과 추적 및 분석 | Measure outcomes and learn |

Each stage takes a quoted name and opens a `{ }` block:

```tskill
COLLECT "Instagram reels — last 30 days" {
  USE instagram AS ig
  EXTRACT Post FROM ig
    WHERE type = "REEL"
    SINCE 30 days
    INTO $raw_reels
  STORE $raw_reels AS "reels_raw" IN $RAW
}
```

---

## The Six Primitive Actions

These are the atomic things a Twixy agent can do. Everything inside a pipeline stage is ultimately one of these six primitives, or a composition of them.

### `USE` — Open and interact with an app

```tskill
USE app_name [AS alias]
  [WITH OPTION = value]
```

Initializes a connection to a platform. The agent handles authentication.

```tskill
USE instagram AS ig
USE google_analytics AS ga WITH property = "UA-123456"
```

---

### `EXTRACT` — Pull data from an app

```tskill
EXTRACT data_shape FROM source
  [WHERE condition]
  [LIMIT n]
  [SINCE duration | BETWEEN date AND date]
  [ORDER BY field ASC | DESC]
  [INTO $variable]
```

Reads data from a platform opened with `USE`. Always produces a typed collection.

```tskill
EXTRACT Post FROM ig
  WHERE type = "REEL"
  LIMIT 100
  SINCE 30 days
  INTO $raw_reels
```

---

### `STORE` — Save data to the workspace

```tskill
STORE $variable AS "filename" [IN folder_alias]
```

Writes data to the Twixy workspace. Files persist between skill runs and are accessible by other skills.

```tskill
STORE $raw_reels AS "reels_raw" IN $RAW
```

---

### `LOAD` — Read data from the workspace

```tskill
LOAD "filename" [FROM folder_alias] AS $variable
```

Reads a previously stored file from the workspace.

```tskill
LOAD "reels_raw" FROM $RAW AS $posts
```

---

### `HYPOTHESIZE` / `PLAN` — Generate strategy

```tskill
HYPOTHESIZE Hypothesis AS $variable
  FROM $data_source
  ABOUT "question"
  [CONTEXT "additional context"]

PLAN Strategy AS $variable
  FROM $hypothesis
  ABOUT "action plan description"
```

Instructs the agent to reason over a dataset and produce a typed `Hypothesis` or `Strategy` object — a testable prediction with a rationale, confidence score, and supporting evidence.

```tskill
HYPOTHESIZE Hypothesis AS $h1
  FROM $insights
  ABOUT "which content format drives the highest engagement for our audience"
  CONTEXT "we have 30 days of reel data across 4 content formats"

PLAN Strategy AS $weekly_plan
  FROM $h1
  ABOUT "3-post test for this week targeting the winning format"
```

---

### `SPAWN` — Create a sub-agent for a task

```tskill
SPAWN agent_name
  TASK "task description in plain English"
  [USING $data_source]
  [OUTPUT $variable]
  [AWAIT | ASYNC]
```

Creates a child agent to handle a discrete unit of work. `AWAIT` pauses the parent skill until the sub-agent finishes. `ASYNC` lets it run in parallel.

```tskill
SPAWN caption_writer
  TASK "write 3 caption variants for this reel with a strong hook and clear CTA"
  USING $top_performing_post
  OUTPUT $caption_variants
  AWAIT
```

---

## File Header

Every `.tskill` file begins with a mandatory header. The compiler rejects files without it.

```tskill
@workspace twixy

SKILL "Skill Name"
  version: 1.0
  author: "your@email.com"
  description: "One sentence describing what this skill does"
  tags: [tag1, tag2, tag3]
  schedule: "every monday 09:00"    // optional — runs on a cron schedule
  LISTENS TO "signal_name" FROM SKILL "Other Skill"  // optional — event trigger
```

`@workspace twixy` is the platform lock. Any other value is a compile error.

---

## Platform Declarations

Declare which platforms the skill accesses. This is a compile-time hint that validates your workspace credentials are configured.

```tskill
PLATFORMS {
  INSTAGRAM
  TIKTOK
  YOUTUBE
  LINKEDIN
  TWITTER
  GOOGLE_ANALYTICS
  META_ADS
  NOTION
}
```

---

## Variables and Path Aliases

Custom variables are declared with `LET`:

```tskill
LET $cutoff_date = TODAY - 30 days
LET $min_views = 5000
LET $is_top_performer = $post.metrics.engagement_rate > 0.05
```

**Reserved workspace aliases** resolve to fixed paths in the Twixy workspace:

| Alias | Contents |
|---|---|
| `$RAW` | Raw collected data |
| `$INSIGHTS` | Processed analytics and insights |
| `$STRATEGIES` | Strategy documents and hypotheses |
| `$DRAFTS` | Content drafts awaiting approval |
| `$PUBLISHED` | Published content and post records |
| `$REPORTS` | Analytics and performance reports |

---

## Approval Gates

Any action in `EXECUTE` that reaches the outside world must be preceded by `APPROVE`. This is a compiler-enforced rule — it is a compile error to `POST` without an approval gate.

```tskill
APPROVE "Review and approve 3 posts for publishing this week" {
  show: $scheduled_posts
  timeout: 24 hours
  on_timeout: CANCEL
}

// Only runs after a human approves in the Twixy UI
FOR EACH $post IN $scheduled_posts {
  POST $post TO instagram AT $post.schedule.time
}
```

`on_timeout` options: `CANCEL` (default) | `ESCALATE` | `PROCEED`

> `PROCEED` on timeout requires `@auto_approve allowed` in the workspace settings. Use with caution.

---

## Control Flow

### Conditions

```tskill
IF $avg_engagement_rate > 0.05 {
  // actions
} ELSE IF $avg_engagement_rate > 0.03 {
  // actions
} ELSE {
  // actions
}

// WHEN is an alias for IF in event-driven contexts
WHEN $post.views > $min_views {
  STORE $post AS "top_performer" IN $INSIGHTS
}
```

### Loops

```tskill
FOR EACH $post IN $top_posts {
  SPAWN caption_analyzer
    TASK "score the hook and CTA quality of this post"
    USING $post
    OUTPUT $post.scores
    AWAIT
}
```

---

## The Signal System

Skills communicate with each other through signals. A pipeline of skills is composed by chaining signals.

**Emitting a signal:**

```tskill
EMIT "insights_ready"
  WITH payload = $insights
  TO SKILL "Weekly Strategy Generator"
```

**Subscribing to a signal** (in the skill header):

```tskill
SKILL "Weekly Strategy Generator"
  LISTENS TO "insights_ready" FROM SKILL "Instagram Reel Collector"
```

When the signal arrives, Twixy runs the subscribing skill automatically and injects the payload as `$incoming`.

```tskill
COLLECT "Load incoming insights" {
  LOAD $incoming AS $fresh_insights
}
```

---

## Type System

TSL has six named types. Types are shapes — they have fields, not methods.

### `Post`
A piece of content from any platform.

```
Post {
  id:           String
  platform:     Platform
  type:         "REEL" | "PHOTO" | "CAROUSEL" | "STORY" | "SHORT" | "VIDEO" | "TWEET" | "ARTICLE"
  url:          String
  caption:      String?
  published_at: DateTime
  metrics:      Metric
  tags:         [String]
  author:       String?
}
```

### `Metric`
A measurement at a point in time.

```
Metric {
  views:            Number
  likes:            Number
  comments:         Number
  shares:           Number
  saves:            Number
  reach:            Number
  impressions:      Number
  engagement_rate:  Float       // (likes + comments + shares + saves) / reach
  click_through:    Float?
  conversions:      Number?
  recorded_at:      DateTime
}
```

### `Hypothesis`
A testable prediction produced by `HYPOTHESIZE`.

```
Hypothesis {
  id:          String
  statement:   String          // "We believe that X will lead to Y"
  rationale:   String          // why the data supports this
  confidence:  Float           // 0.0–1.0
  based_on:    [Post | Metric]
  test_plan:   String
  created_at:  DateTime
}
```

### `Strategy`
A concrete plan of action, derived from a `Hypothesis`.

```
Strategy {
  id:         String
  title:      String
  hypothesis: Hypothesis?
  actions:    [String]
  platforms:  [Platform]
  timeline:   Duration
  kpis:       [String]
  created_at: DateTime
}
```

### `Campaign`
A named collection of related executions sharing a goal.

```
Campaign {
  id:          String
  name:        String
  strategy:    Strategy
  posts:       [Post]
  start_date:  DateTime
  end_date:    DateTime?
  status:      "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETE"
  results:     Metric
}
```

### `Report`
The output of a `TRACK` block.

```
Report {
  id:           String
  skill:        String
  campaign:     Campaign?
  hypothesis:   Hypothesis?
  summary:      String
  findings:     [String]
  next_steps:   [String]
  data:         [Metric]
  generated_at: DateTime
}
```

---

## Comments

```tskill
// Single line comment

/*
  Multi-line comment.
  Use for skill-level documentation.
*/
```

---

## Complete Examples

### Example 1 — Data Collection

Runs every Monday. Collects 30 days of Instagram reel data and signals downstream skills.

```tskill
@workspace twixy

SKILL "Instagram Reel Collector"
  version: 1.0
  description: "Collects last 30 days of reel data and stores it for analysis"
  tags: [instagram, reels, data-collection]
  schedule: "every monday 08:00"

PLATFORMS { INSTAGRAM }

GOAL "Collect fresh reel performance data" {
  objective: "Capture all reel posts from the past 30 days with full metrics"
  kpi: engagement_rate
  window: 30 days
}

COLLECT "Instagram reels — last 30 days" {
  USE instagram AS ig

  EXTRACT Post FROM ig
    WHERE type = "REEL"
    SINCE 30 days
    ORDER BY published_at DESC
    INTO $raw_reels

  IF $raw_reels.count = 0 {
    EMIT "collection_failed"
  }

  FOR EACH $reel IN $raw_reels {
    EXTRACT Metric FROM ig
      WHERE post_id = $reel.id
      INTO $reel.metrics
  }

  STORE $raw_reels AS "reels_with_metrics" IN $RAW
}

ANALYZE "Score and rank reels" {
  LOAD "reels_with_metrics" FROM $RAW AS $reels

  SPAWN engagement_scorer
    TASK "calculate engagement rate per reel and flag outliers above 1.5x average"
    USING $reels
    OUTPUT $scored_reels
    AWAIT

  LET $top_reels = $scored_reels WHERE engagement_rate > 0.05 LIMIT 10

  STORE $top_reels AS "top_reels_30d" IN $INSIGHTS
}

TRACK "Confirm collection and notify" {
  LOAD "top_reels_30d" FROM $INSIGHTS AS $top

  SPAWN report_writer
    TASK "summarize what was collected: total posts, top 3 reels, and average engagement"
    USING $top
    OUTPUT $summary
    AWAIT

  STORE $summary AS "collection_report" IN $REPORTS

  EMIT "reel_data_ready"
    WITH payload = $top
    TO SKILL "Instagram Strategy Generator"
}
```

---

### Example 2 — Strategy Generation

Listens for `reel_data_ready`, forms a hypothesis, builds a weekly content plan.

```tskill
@workspace twixy

SKILL "Instagram Strategy Generator"
  version: 1.0
  description: "Analyzes reel data and generates a hypothesis-backed content strategy"
  tags: [instagram, strategy, hypothesis]
  LISTENS TO "reel_data_ready" FROM SKILL "Instagram Reel Collector"

PLATFORMS { INSTAGRAM }

GOAL "Generate a data-backed strategy for the coming week" {
  objective: "Identify the highest-leverage content format and produce a 3-post plan"
  kpi: engagement_rate
  target: 0.06
  window: 7 days
}

COLLECT "Load incoming reel data" {
  LOAD $incoming AS $top_reels
}

ANALYZE "Identify winning formats and timing" {
  SPAWN pattern_analyst
    TASK "identify which content formats have the highest average engagement rate
          and the most common topics in the top 20% of posts"
    USING $top_reels
    OUTPUT $format_insights
    AWAIT

  SPAWN timing_analyst
    TASK "identify the best posting days and times based on when top performers went live"
    USING $top_reels
    OUTPUT $timing_insights
    AWAIT

  STORE $format_insights AS "format_analysis" IN $INSIGHTS
  STORE $timing_insights AS "timing_analysis" IN $INSIGHTS
}

STRATEGIZE "Form hypothesis and build plan" {
  LOAD "format_analysis" FROM $INSIGHTS AS $formats
  LOAD "timing_analysis" FROM $INSIGHTS AS $timing

  HYPOTHESIZE Hypothesis AS $h_format
    FROM $formats
    ABOUT "which content format will generate the highest engagement this week"

  HYPOTHESIZE Hypothesis AS $h_timing
    FROM $timing
    ABOUT "which posting days and times will maximize reach"

  PLAN Strategy AS $weekly_plan
    FROM $h_format
    ABOUT "produce 3 reels targeting our highest-performing format at optimal times"

  STORE $h_format AS "hypothesis_format" IN $STRATEGIES
  STORE $h_timing AS "hypothesis_timing" IN $STRATEGIES
  STORE $weekly_plan AS "weekly_content_plan" IN $STRATEGIES
}

TRACK "Log strategy and notify" {
  LOAD "weekly_content_plan" FROM $STRATEGIES AS $plan

  SPAWN report_writer
    TASK "write a 3-bullet strategy summary: hypothesis, 3-post plan, and success criteria"
    USING $plan
    OUTPUT $summary
    AWAIT

  STORE $summary AS "strategy_summary" IN $REPORTS

  EMIT "strategy_ready"
    WITH payload = $weekly_plan
    TO SKILL "Instagram Content Publisher"
}
```

---

### Example 3 — Publish and Track

Receives an approved strategy, drafts captions, gets human sign-off, publishes, and measures results 48 hours later.

```tskill
@workspace twixy

SKILL "Instagram Content Publisher"
  version: 1.0
  description: "Drafts, approves, publishes, and tracks a weekly Instagram content plan"
  tags: [instagram, publish, execute, track]
  LISTENS TO "strategy_ready" FROM SKILL "Instagram Strategy Generator"

PLATFORMS { INSTAGRAM }

GOAL "Publish this week's content and measure results" {
  objective: "Execute 3 scheduled posts and determine if the hypothesis was validated"
  kpi: engagement_rate
  target: 0.06
  window: 7 days
}

COLLECT "Load strategy and video assets" {
  LOAD $incoming AS $strategy
  LOAD "hypothesis_format" FROM $STRATEGIES AS $format_hypothesis
  LOAD "reel_assets_this_week" FROM $DRAFTS AS $video_assets

  IF $video_assets.count < 3 {
    EMIT "assets_missing"
  }
}

STRATEGIZE "Draft captions and build schedule" {
  LOAD "top_reels_30d" FROM $INSIGHTS AS $top_reels
  LOAD "hypothesis_timing" FROM $STRATEGIES AS $timing

  FOR EACH $asset IN $video_assets {
    SPAWN caption_writer
      TASK "write 3 caption variants with a strong hook, clear value prop, and CTA.
            Match the tone of the top-performing reels provided."
      USING $top_reels
      OUTPUT $asset.caption_variants
      AWAIT
  }

  SPAWN caption_selector
    TASK "select the strongest caption per reel based on hook clarity and CTA strength"
    USING $video_assets
    OUTPUT $final_captions
    AWAIT

  SPAWN scheduler
    TASK "assign optimal posting times from the timing hypothesis.
          Space posts at least 24 hours apart."
    USING $timing
    OUTPUT $post_schedule
    AWAIT

  LET $scheduled_posts = $video_assets WITH captions = $final_captions
                                        AND schedule  = $post_schedule

  STORE $scheduled_posts AS "posts_ready_for_approval" IN $DRAFTS
}

EXECUTE "Publish approved posts" {
  LOAD "posts_ready_for_approval" FROM $DRAFTS AS $scheduled_posts

  APPROVE "Review and approve 3 posts for publishing this week" {
    show: $scheduled_posts
    timeout: 24 hours
    on_timeout: CANCEL
  }

  FOR EACH $post IN $scheduled_posts {
    POST $post TO instagram
      AT $post.schedule.time
      WITH caption = $post.caption

    STORE $post AS "published_post" IN $PUBLISHED
  }

  EMIT "posts_published"
}

TRACK "Measure results 48 hours after publishing" {
  USE instagram AS ig
  LOAD "posts_ready_for_approval" FROM $DRAFTS AS $posts

  FOR EACH $post IN $posts {
    EXTRACT Metric FROM ig
      WHERE post_id = $post.id
      SINCE 48 hours
      INTO $post.results
  }

  STORE $posts AS "posts_with_results" IN $PUBLISHED

  SPAWN hypothesis_evaluator
    TASK "compare actual engagement rates against the 6% hypothesis target.
          State whether each post validated, partially validated, or refuted the hypothesis."
    USING $format_hypothesis
    OUTPUT $evaluation
    AWAIT

  HYPOTHESIZE Hypothesis AS $next_hypothesis
    FROM $evaluation
    ABOUT "what to adjust next week based on these results"

  STORE $evaluation AS "hypothesis_evaluation" IN $REPORTS
  STORE $next_hypothesis AS "next_week_hypothesis" IN $STRATEGIES

  SPAWN report_writer
    TASK "write a post-campaign report: posts published, engagement vs target,
          hypothesis verdict, and recommended next steps. One page max."
    USING $evaluation
    OUTPUT $weekly_report
    AWAIT

  STORE $weekly_report AS "weekly_performance_report" IN $REPORTS

  EMIT "tracking_complete"
    WITH payload = $next_hypothesis
    TO SKILL "Instagram Strategy Generator"
}
```

---

## Grammar Reference (BNF)

```bnf
program          ::= workspace_decl skill_decl platform_decl? let_stmt* pipeline_block+

workspace_decl   ::= "@workspace" "twixy"

skill_decl       ::= "SKILL" string_lit
                     ("version" ":" version)?
                     ("author" ":" string_lit)?
                     ("description" ":" string_lit)?
                     ("tags" ":" "[" tag_list "]")?
                     ("schedule" ":" string_lit)?
                     ("LISTENS TO" string_lit "FROM SKILL" string_lit)?

platform_decl    ::= "PLATFORMS" "{" platform+ "}"
platform         ::= "INSTAGRAM" | "TIKTOK" | "YOUTUBE" | "TWITTER" | "LINKEDIN"
                   | "GOOGLE_ANALYTICS" | "GOOGLE_ADS" | "META_ADS"
                   | "NOTION" | "AIRTABLE" | "SLACK"

pipeline_block   ::= goal_block | collect_block | analyze_block
                   | strategize_block | execute_block | track_block

goal_block       ::= "GOAL" string_lit "{" goal_stmt+ "}"
goal_stmt        ::= "objective" ":" string_lit
                   | "kpi" ":" identifier
                   | "target" ":" value
                   | "window" ":" duration

collect_block    ::= "COLLECT" string_lit "{" stmt+ "}"
analyze_block    ::= "ANALYZE" string_lit "{" stmt+ "}"
strategize_block ::= "STRATEGIZE" string_lit "{" stmt+ "}"
execute_block    ::= "EXECUTE" string_lit "{" stmt+ "}"
track_block      ::= "TRACK" string_lit "{" stmt+ "}"

stmt             ::= use_stmt | extract_stmt | store_stmt | load_stmt
                   | hypothesize_stmt | plan_stmt | spawn_stmt
                   | post_stmt | emit_stmt | approve_stmt
                   | let_stmt | if_stmt | when_stmt | for_each_stmt | comment

use_stmt         ::= "USE" platform ("AS" identifier)? ("WITH" key "=" value)*

extract_stmt     ::= "EXTRACT" type "FROM" (identifier | platform)
                     ("WHERE" condition)*
                     ("LIMIT" number)?
                     ("SINCE" duration | "BETWEEN" date "AND" date)?
                     ("ORDER BY" field ("ASC" | "DESC")?)?
                     ("INTO" variable)?

store_stmt       ::= "STORE" variable "AS" string_lit ("IN" path_alias)?
load_stmt        ::= "LOAD" string_lit ("FROM" path_alias)? "AS" variable

hypothesize_stmt ::= "HYPOTHESIZE" type "AS" variable
                     "FROM" variable
                     "ABOUT" string_lit
                     ("CONTEXT" string_lit)?

plan_stmt        ::= "PLAN" type "AS" variable
                     "FROM" variable
                     "ABOUT" string_lit

spawn_stmt       ::= "SPAWN" identifier
                     "TASK" string_lit
                     ("USING" variable)?
                     ("OUTPUT" variable)?
                     ("AWAIT" | "ASYNC")

post_stmt        ::= "POST" variable "TO" platform
                     ("AT" datetime)?
                     ("WITH" key "=" value)*

emit_stmt        ::= "EMIT" string_lit
                     ("WITH" "payload" "=" variable)?
                     ("TO SKILL" string_lit)?

approve_stmt     ::= "APPROVE" string_lit "{"
                     "show" ":" variable
                     ("timeout" ":" duration)?
                     ("on_timeout" ":" ("CANCEL" | "ESCALATE" | "PROCEED"))?
                     "}" stmt+

let_stmt         ::= "LET" variable "=" expr

if_stmt          ::= "IF" condition "{" stmt* "}"
                     ("ELSE IF" condition "{" stmt* "}")*
                     ("ELSE" "{" stmt* "}")?

when_stmt        ::= "WHEN" condition "{" stmt* "}"

for_each_stmt    ::= "FOR EACH" variable "IN" variable "{" stmt* "}"

condition        ::= expr comparison_op expr
                   | condition ("AND" | "OR") condition
                   | "NOT" condition

comparison_op    ::= ">" | "<" | ">=" | "<=" | "=" | "!=" | "IS" | "CONTAINS"

expr             ::= variable | literal | field_access | arithmetic
field_access     ::= variable "." identifier
arithmetic       ::= expr ("+" | "-" | "*" | "/") expr

variable         ::= "$" identifier
path_alias       ::= "$RAW" | "$INSIGHTS" | "$STRATEGIES"
                   | "$DRAFTS" | "$PUBLISHED" | "$REPORTS"

type             ::= "Post" | "Metric" | "Hypothesis"
                   | "Strategy" | "Campaign" | "Report"

duration         ::= number ("second" | "minute" | "hour" | "day" | "week" | "month") "s"?
date             ::= "TODAY" | "YESTERDAY" | iso_date
datetime         ::= date ("at" time)?
string_lit       ::= '"' [^"]* '"'
number           ::= [0-9]+ ("." [0-9]+)?
version          ::= [0-9]+ "." [0-9]+
comment          ::= "//" [^\n]* | "/*" [^*]* "*/"
```

---

## Compiler

TSL compiles to SKILL.md — a plain-English instruction file that Twixy agents execute.

```
source.tskill
  → TSL Compiler (built into Twixy)
  → SKILL.md (build artifact — do not edit directly)
```

The compiler ships inside the Twixy app. `.tskill` files are the source of truth. Generated SKILL.md files include a header comment:

```
<!--
  Generated by Twixy Skill Language Compiler v1.0
  Source: instagram-reel-collector.tskill
  Workspace: twixy
  DO NOT EDIT — edit the .tskill source and recompile
-->
```

### Compile Errors

| Error | Cause | Fix |
|---|---|---|
| `invalid workspace` | `@workspace` is not `twixy` | Change to `@workspace twixy` |
| `missing SKILL declaration` | No `SKILL` block in file | Add `SKILL "name" { ... }` |
| `PUBLISH without APPROVE` | `POST` action has no `APPROVE` gate | Add `APPROVE { }` before `POST` |
| `unknown platform` | Platform name not in supported list | Check the platform list |
| `stage out of order` | Pipeline stages appear in wrong order | Reorder to GOAL → COLLECT → ANALYZE → STRATEGIZE → EXECUTE → TRACK |
| `unknown path alias` | `$SOMETHING` is not a reserved alias | Use `LET $var = ...` for custom variables |

---

## Keyword Index

| Keyword | Type | Purpose |
|---|---|---|
| `@workspace` | Declaration | Platform lock — must be `twixy` |
| `SKILL` | Declaration | Root skill definition |
| `PLATFORMS` | Declaration | Declare platform dependencies |
| `GOAL` | Stage | Define objective and KPIs |
| `COLLECT` | Stage | Gather data |
| `ANALYZE` | Stage | Find patterns |
| `STRATEGIZE` | Stage | Build plans and hypotheses |
| `EXECUTE` | Stage | Take action |
| `TRACK` | Stage | Measure results |
| `USE` | Action | Open an app |
| `EXTRACT` | Action | Pull data from an app |
| `STORE` | Action | Save data to workspace |
| `LOAD` | Action | Read data from workspace |
| `HYPOTHESIZE` | Action | Generate a hypothesis |
| `PLAN` | Action | Generate a strategy |
| `SPAWN` | Action | Create a sub-agent |
| `POST` | Action | Publish to a platform |
| `EMIT` | Action | Send a signal to another skill |
| `APPROVE` | Gate | Pause for human approval |
| `LET` | Flow | Declare a variable |
| `IF` / `ELSE IF` / `ELSE` | Flow | Conditional execution |
| `WHEN` | Flow | Event-driven condition |
| `FOR EACH ... IN` | Flow | Loop over a collection |
| `AWAIT` | Modifier | Wait for sub-agent to finish |
| `ASYNC` | Modifier | Run sub-agent in parallel |
| `LISTENS TO` | Header | Subscribe to a signal |

---

*TSL is a Twixy-proprietary language. Skills written in TSL run exclusively on the Twixy platform.*

*© Twixy — tsl/1.0*
