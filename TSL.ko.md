# TSL — Twixy Skill Language

**버전 1.0**

TSL(Twixy Skill Language)은 Twixy 플랫폼에서 마케팅 인텔리전스 스킬을 작성하기 위한, 파이프라인 지향의 선언형 언어입니다. **스킬(skill)** 이란 재사용 가능하고 실행 가능한 마케팅 작업 단위로 — 데이터 수집·전략 생성·콘텐츠 게시·결과 추적 등을 수행할 수 있습니다.

TSL 은 범용 프로그래밍 언어가 아닙니다. 대신 한 가지를 탁월하게 해냅니다: 마케팅 에이전트가 무엇을·어떤 순서로·어떤 데이터를·왜 수행해야 하는지를 표현하는 것.

---

## 설계 원칙 (Design Principles)

**1. 파이프라인 우선.**
마케팅 작업은 본질적으로 순차적입니다. TSL 은 이를 강제합니다. 6개 파이프라인 스테이지는 임의의 조직 박스가 아니라, 컴파일러가 순서까지 검증하는 언어적 구성요소입니다.

**2. 구현보다 의도.**
`EXTRACT posts FROM instagram LIMIT 50` 한 문장으로 끝입니다. API 클라이언트를 연결하거나 JSON 을 파싱하지 않습니다. 에이전트가 처리합니다.

**3. 기본값은 Human-in-the-loop.**
게시·전송 또는 세상에 도달하는 모든 액션은 명시적인 `APPROVE` 게이트가 필요합니다. 에이전트는 사람의 확인 없이 소셜 미디어에 절대 게시하지 않습니다. 이는 기능이 아니라 언어 레벨의 요구사항입니다.

**4. 투명하고 감사 가능.**
모든 TSL 스킬은 사람이 읽을 수 있는 SKILL.md 로 컴파일됩니다. 소스 `.tskill` 파일이 진리 원본, SKILL.md 는 빌드 산출물입니다.

**5. Twixy 네이티브.**
모든 파일에 `@workspace twixy` 가 필수입니다. TSL 은 이식 가능한 마케팅 DSL 이 되려 하지 않습니다. 그 집중이 TSL 을 정밀하게 만듭니다.

---

## 6 단계 파이프라인 스테이지

모든 스킬은 마케팅 루프의 6 단계를 중심으로 구성됩니다. 스테이지는 반드시 순서대로 나타나야 합니다. 필요 없는 스테이지는 생략할 수 있습니다.

| # | 스테이지 키워드 | 한글 | 이 단계에서 하는 일 |
|---|---|---|---|
| 1 | `GOAL` | 행동 전략 | 목표·KPI·성공 기준 선언 |
| 2 | `COLLECT` | 데이터 수집 | 플랫폼/앱에서 원시 신호 수집 |
| 3 | `ANALYZE` | 데이터 분석 | 패턴 발견·콘텐츠 스코어링·인사이트 생성 |
| 4 | `STRATEGIZE` | 디테일한 행동 전략 | 가설 수립·구체적 실행 플랜 구성 |
| 5 | `EXECUTE` | 실행 | 실제 세상에서 액션 수행 |
| 6 | `TRACK` | 결과 추적 및 분석 | 결과 측정 및 학습 |

각 스테이지는 따옴표로 감싼 이름을 받고 `{ }` 블록을 엽니다:

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

## 6 가지 원시 액션 (Primitive Actions)

Twixy 에이전트가 수행할 수 있는 원자 단위 작업입니다. 모든 파이프라인 스테이지 내부는 궁극적으로 이 6가지 중 하나이거나 그 조합으로 표현됩니다.

### `USE` — 앱을 열고 상호작용

```tskill
USE app_name [AS alias]
  [WITH OPTION = value]
```

플랫폼에 대한 연결을 초기화합니다. 인증은 에이전트가 담당합니다.

```tskill
USE instagram AS ig
USE google_analytics AS ga WITH property = "UA-123456"
```

---

### `EXTRACT` — 앱에서 데이터 가져오기

```tskill
EXTRACT data_shape FROM source
  [WHERE condition]
  [LIMIT n]
  [SINCE duration | BETWEEN date AND date]
  [ORDER BY field ASC | DESC]
  [INTO $variable]
```

`USE` 로 연결된 플랫폼에서 데이터를 읽습니다. 언제나 타입이 있는 컬렉션을 생성합니다.

```tskill
EXTRACT Post FROM ig
  WHERE type = "REEL"
  LIMIT 100
  SINCE 30 days
  INTO $raw_reels
```

---

### `STORE` — 워크스페이스에 데이터 저장

```tskill
STORE $variable AS "filename" [IN folder_alias]
```

Twixy 워크스페이스에 데이터를 기록합니다. 파일은 스킬 실행 간 유지되며 다른 스킬에서도 접근할 수 있습니다.

```tskill
STORE $raw_reels AS "reels_raw" IN $RAW
```

---

### `LOAD` — 워크스페이스에서 데이터 읽기

```tskill
LOAD "filename" [FROM folder_alias] AS $variable
```

이전에 저장한 파일을 워크스페이스에서 읽습니다.

```tskill
LOAD "reels_raw" FROM $RAW AS $posts
```

---

### `HYPOTHESIZE` / `PLAN` — 전략 생성

```tskill
HYPOTHESIZE Hypothesis AS $variable
  FROM $data_source
  ABOUT "question"
  [CONTEXT "additional context"]

PLAN Strategy AS $variable
  FROM $hypothesis
  ABOUT "action plan description"
```

데이터를 근거로 추론해 타입이 지정된 `Hypothesis` 또는 `Strategy` 객체를 생성하도록 에이전트에 지시합니다. 근거·확신도·지지 증거가 포함된 검증 가능한 예측입니다.

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

### `SPAWN` — 작업용 서브 에이전트 생성

```tskill
SPAWN agent_name
  TASK "task description in plain English"
  [USING $data_source]
  [OUTPUT $variable]
  [AWAIT | ASYNC]
```

분리된 작업 단위를 처리할 자식 에이전트를 생성합니다. `AWAIT` 는 서브 에이전트가 끝날 때까지 부모 스킬을 일시정지. `ASYNC` 는 병렬 실행.

```tskill
SPAWN caption_writer
  TASK "write 3 caption variants for this reel with a strong hook and clear CTA"
  USING $top_performing_post
  OUTPUT $caption_variants
  AWAIT
```

---

## 파일 헤더 (File Header)

모든 `.tskill` 파일은 필수 헤더로 시작합니다. 헤더가 없으면 컴파일러가 거부합니다.

```tskill
@workspace twixy

SKILL "Skill Name"
  version: 1.0
  author: "your@email.com"
  description: "One sentence describing what this skill does"
  tags: [tag1, tag2, tag3]
  schedule: "every monday 09:00"    // 선택 — 크론 스케줄로 실행
  LISTENS TO "signal_name" FROM SKILL "Other Skill"  // 선택 — 이벤트 트리거
```

`@workspace twixy` 는 플랫폼 락입니다. 다른 값은 컴파일 에러.

---

## 플랫폼 선언 (Platform Declarations)

스킬이 접근할 플랫폼을 선언합니다. 워크스페이스 자격 증명이 설정되어 있는지 컴파일 타임에 검증하는 힌트 역할을 합니다.

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

## 변수 및 경로 별칭 (Variables and Path Aliases)

사용자 정의 변수는 `LET` 으로 선언합니다:

```tskill
LET $cutoff_date = TODAY - 30 days
LET $min_views = 5000
LET $is_top_performer = $post.metrics.engagement_rate > 0.05
```

**예약된 워크스페이스 별칭** 은 Twixy 워크스페이스 내 고정 경로로 해석됩니다:

| 별칭 | 내용 |
|---|---|
| `$RAW` | 수집한 원본 데이터 |
| `$INSIGHTS` | 가공된 분석/인사이트 |
| `$STRATEGIES` | 전략 문서·가설 |
| `$DRAFTS` | 승인 대기 콘텐츠 드래프트 |
| `$PUBLISHED` | 게시된 콘텐츠·기록 |
| `$REPORTS` | 분석·성과 리포트 |

---

## 승인 게이트 (Approval Gates)

`EXECUTE` 안에서 외부 세상에 영향을 미치는 모든 액션은 반드시 `APPROVE` 게이트를 선행해야 합니다. 컴파일러 강제 규칙으로, 승인 없는 `POST` 는 컴파일 에러입니다.

```tskill
APPROVE "Review and approve 3 posts for publishing this week" {
  show: $scheduled_posts
  timeout: 24 hours
  on_timeout: CANCEL
}

// 사람이 Twixy UI 에서 승인해야만 아래 실행
FOR EACH $post IN $scheduled_posts {
  POST $post TO instagram AT $post.schedule.time
}
```

`on_timeout` 옵션: `CANCEL` (기본) | `ESCALATE` | `PROCEED`

> 타임아웃 시 `PROCEED` 는 워크스페이스 설정에 `@auto_approve allowed` 가 있어야 합니다. 신중히 사용하세요.

---

## 제어 흐름 (Control Flow)

### 조건 (Conditions)

```tskill
IF $avg_engagement_rate > 0.05 {
  // 액션
} ELSE IF $avg_engagement_rate > 0.03 {
  // 액션
} ELSE {
  // 액션
}

// 이벤트 구동 문맥에서는 WHEN 이 IF 의 별칭
WHEN $post.views > $min_views {
  STORE $post AS "top_performer" IN $INSIGHTS
}
```

### 반복 (Loops)

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

## 시그널 시스템 (The Signal System)

스킬끼리는 시그널을 통해 통신합니다. 여러 스킬의 파이프라인은 시그널을 엮어 구성됩니다.

**시그널 방출:**

```tskill
EMIT "insights_ready"
  WITH payload = $insights
  TO SKILL "Weekly Strategy Generator"
```

**시그널 구독** (스킬 헤더에서):

```tskill
SKILL "Weekly Strategy Generator"
  LISTENS TO "insights_ready" FROM SKILL "Instagram Reel Collector"
```

시그널이 도착하면 Twixy 가 구독 스킬을 자동 실행하고 페이로드를 `$incoming` 으로 주입합니다.

```tskill
COLLECT "Load incoming insights" {
  LOAD $incoming AS $fresh_insights
}
```

---

## 타입 시스템 (Type System)

TSL 에는 6 가지 명명 타입이 있습니다. 타입은 "모양(shape)" 입니다 — 필드를 갖지만 메서드는 없습니다.

### `Post`
모든 플랫폼의 콘텐츠 1 건.

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
특정 시점의 측정값.

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
`HYPOTHESIZE` 가 생성하는 검증 가능한 예측.

```
Hypothesis {
  id:          String
  statement:   String          // "We believe that X will lead to Y"
  rationale:   String          // 데이터가 이 가설을 지지하는 이유
  confidence:  Float           // 0.0–1.0
  based_on:    [Post | Metric]
  test_plan:   String
  created_at:  DateTime
}
```

### `Strategy`
`Hypothesis` 에서 파생된 구체적 실행 플랜.

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
하나의 목표를 공유하는 관련 실행들의 명명된 집합.

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
`TRACK` 블록의 출력.

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

## 주석 (Comments)

```tskill
// 한 줄 주석

/*
  여러 줄 주석.
  스킬 레벨 문서화에 사용.
*/
```

---

## 전체 예제 (Complete Examples)

### 예제 1 — 데이터 수집

매주 월요일 실행. 지난 30일 인스타그램 릴스 데이터를 수집하고 다운스트림 스킬에 시그널을 보냅니다.

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

### 예제 2 — 전략 생성

`reel_data_ready` 시그널을 수신해 가설을 수립하고 주간 콘텐츠 플랜을 작성합니다.

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

### 예제 3 — 게시 및 추적

승인된 전략을 받아 캡션을 작성하고, 사람 승인 받고, 게시하고, 48시간 후 결과를 측정합니다.

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

## 문법 레퍼런스 (BNF)

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

## 컴파일러 (Compiler)

TSL 은 Twixy 에이전트가 실행할 평이한 영문 지시문 파일인 SKILL.md 로 컴파일됩니다.

```
source.tskill
  → TSL Compiler (Twixy 내장)
  → SKILL.md (빌드 산출물 — 직접 편집 금지)
```

컴파일러는 Twixy 앱에 내장되어 있습니다. `.tskill` 파일이 진리 원본입니다. 생성된 SKILL.md 는 다음과 같은 헤더 주석을 포함합니다:

```
<!--
  Generated by Twixy Skill Language Compiler v1.0
  Source: instagram-reel-collector.tskill
  Workspace: twixy
  DO NOT EDIT — edit the .tskill source and recompile
-->
```

### 컴파일 에러 (Compile Errors)

| 에러 | 원인 | 해결 |
|---|---|---|
| `invalid workspace` | `@workspace` 가 `twixy` 가 아님 | `@workspace twixy` 로 변경 |
| `missing SKILL declaration` | 파일에 `SKILL` 블록 없음 | `SKILL "name" { ... }` 추가 |
| `PUBLISH without APPROVE` | `POST` 액션에 `APPROVE` 게이트 없음 | `POST` 앞에 `APPROVE { }` 추가 |
| `unknown platform` | 지원되지 않는 플랫폼 이름 | 플랫폼 목록 확인 |
| `stage out of order` | 파이프라인 스테이지 순서 오류 | GOAL → COLLECT → ANALYZE → STRATEGIZE → EXECUTE → TRACK 순으로 재배치 |
| `unknown path alias` | `$SOMETHING` 이 예약 별칭이 아님 | 사용자 변수는 `LET $var = ...` 로 선언 |

---

## 키워드 인덱스 (Keyword Index)

| 키워드 | 종류 | 용도 |
|---|---|---|
| `@workspace` | 선언 | 플랫폼 락 — `twixy` 여야 함 |
| `SKILL` | 선언 | 루트 스킬 정의 |
| `PLATFORMS` | 선언 | 플랫폼 의존성 선언 |
| `GOAL` | 스테이지 | 목표·KPI 정의 |
| `COLLECT` | 스테이지 | 데이터 수집 |
| `ANALYZE` | 스테이지 | 패턴 발견 |
| `STRATEGIZE` | 스테이지 | 플랜·가설 수립 |
| `EXECUTE` | 스테이지 | 액션 실행 |
| `TRACK` | 스테이지 | 결과 측정 |
| `USE` | 액션 | 앱 열기 |
| `EXTRACT` | 액션 | 앱에서 데이터 가져오기 |
| `STORE` | 액션 | 워크스페이스에 데이터 저장 |
| `LOAD` | 액션 | 워크스페이스에서 데이터 읽기 |
| `HYPOTHESIZE` | 액션 | 가설 생성 |
| `PLAN` | 액션 | 전략 생성 |
| `SPAWN` | 액션 | 서브 에이전트 생성 |
| `POST` | 액션 | 플랫폼에 게시 |
| `EMIT` | 액션 | 다른 스킬에 시그널 전송 |
| `APPROVE` | 게이트 | 사람 승인을 위해 일시정지 |
| `LET` | 플로우 | 변수 선언 |
| `IF` / `ELSE IF` / `ELSE` | 플로우 | 조건 실행 |
| `WHEN` | 플로우 | 이벤트 구동 조건 |
| `FOR EACH ... IN` | 플로우 | 컬렉션 반복 |
| `AWAIT` | 수식자 | 서브 에이전트 완료까지 대기 |
| `ASYNC` | 수식자 | 서브 에이전트 병렬 실행 |
| `LISTENS TO` | 헤더 | 시그널 구독 |

---

*TSL 은 Twixy 독자 언어입니다. TSL 로 작성된 스킬은 오직 Twixy 플랫폼에서만 실행됩니다.*

*© Twixy — tsl/1.0*
