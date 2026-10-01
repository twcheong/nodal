# .tskill 작성 가이드

Twixy Skill Language(TSL) 파일 작성을 위한 빠른 참고서.
전체 스펙은 `TSL.md` — 컴파일러 소스는 `dist-electron/tsl-compiler.js`.

---

## 파일 뼈대 (skeleton)

```tskill
@workspace twixy                    ← 필수, 반드시 "twixy"

SKILL "Skill Name"
  version: 1.0
  summary: "한 줄 요약 — SKILLS.md 인덱스에 표시됨"
  description: "Full description. Include trigger phrases here."
  tags: [tag1, tag2]
  trigger: "user asks to analyze instagram performance"
  output: "engagement report, top post list"
  schedule: "0 9 * * *"            ← 선택: 크론 스케줄
  LISTENS TO "signal" FROM SKILL "Other Skill"  ← 선택: 이벤트 트리거

PLATFORMS {
  INSTAGRAM
  YOUTUBE
}

GOAL "label" {
  objective: "one sentence"
  kpi: engagement_rate
  target: 0.06                      ← 선택
  window: 30 days                   ← 선택
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

## SKILL 헤더 필드

| 필드 | 필수 | 설명 |
| ------------- | -------- | -------------------------------------------- |
| `version` | 예 | Semver 문자열 |
| `summary` | 예 | SKILLS.md 인덱스용 한 줄 요약 |
| `description` | 예 | 전체 설명 + 트리거 문구 |
| `tags` | 예 | 주제 태그 배열 |
| `trigger` | 예 | 이 스킬을 활성화하는 명시적 조건 |
| `output` | 예 | 이 스킬이 생성하는 산출물 |
| `schedule` | 아니오 | 스케줄 실행용 크론 표현식 |
| `LISTENS TO` | 아니오 | 다른 스킬발 이벤트 트리거 |


### `trigger` vs `description`

- `description` — Codex 가 스킬을 이해하는 데 사용하는 풀 산문
- `trigger` — Twixy 디스패처가 스킬을 활성화하는 데 쓰는 짧고 구체적인 문구

```tskill
description: "Analyzes the last 30 days of Instagram reels to surface top-performing content patterns."
trigger: "analyze instagram, reel performance, what's working on instagram"
```

### `output`

스킬이 디스크에 쓰거나 방출하는 산출물의 쉼표 구분 목록.

```tskill
output: "insights report ($INSIGHTS), top post list ($RAW), signal: insights_ready"
```

---

## PHASE

PHASE 는 파이프라인 스테이지들의 명명된 묶음입니다. 탑레벨에 바로 스테이지를 두는 것을 대체합니다.
모든 스테이지는 반드시 PHASE 안에 있어야 합니다. PHASE 내부의 스테이지도 여전히 파이프라인 순서를 지켜야 합니다.

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

PHASE 자체도 파이프라인 순서대로 나타나야 합니다 (모든 PHASE 를 통틀어 COLLECT 가 ANALYZE 보다 먼저 등).
PHASE 이름은 자유 형식 — 스킬에 의미 있는 이름을 쓰세요.

---

## 파이프라인 스테이지

모든 PHASE 를 통틀어 아래 순서대로 나타나야 합니다. 필요 없는 스테이지는 생략 가능.

| # | 스테이지 | 용도 |
| --- | ------------ | ----------------------------------------------- |
| — | `GOAL` | 목표 + KPI (Behavior 스텝 카운트에서 제외) |
| 1 | `COLLECT` | 플랫폼 열기, 원본 데이터 수집 |
| 2 | `ANALYZE` | 패턴 발견, 스코어링, 가설 평가 |
| 3 | `STRATEGIZE` | 가설 수립, 플랜 구성 |
| 4 | `EXECUTE` | 실제 세상에서 액션 수행 |
| 5 | `TRACK` | 결과 측정, 리포트 작성, 시그널 방출 |


---

## 액션 (스테이지 내부)

### USE — 플랫폼 세션 열기

```tskill
USE instagram AS ig
USE google_analytics AS ga WITH property = "UA-123456"
```

### EXTRACT — 데이터 가져오기

```tskill
EXTRACT Post FROM ig
  WHERE type = "REEL"
  LIMIT 30
  SINCE 30 days
  ORDER BY published_at DESC
  INTO $raw_posts
```

### STORE — 워크스페이스에 저장

```tskill
STORE $raw_posts AS "instagram_posts_{date}" IN $RAW
```

### LOAD — 워크스페이스에서 읽기

```tskill
LOAD "instagram_posts_{date}" FROM $RAW AS $posts
```

### HYPOTHESIZE — 가설 생성

```tskill
HYPOTHESIZE Hypothesis AS $h1
  FROM $insights
  ABOUT "which content format drives highest engagement"
  CONTEXT "we have 30 days of reel data"
```

### PLAN — 전략 생성

```tskill
PLAN Strategy AS $weekly_plan
  FROM $h1
  ABOUT "3-post test targeting winning format"
```

### SPAWN — 서브 에이전트에 위임

```tskill
SPAWN caption_writer
  TASK "write 3 caption variants with strong hook and CTA"
  USING $top_posts
  OUTPUT $captions
  AWAIT            ← 또는 병렬은 ASYNC
```

### POST — 콘텐츠 게시 (EXECUTE 전용)

```tskill
POST $draft TO instagram
  AT $draft.schedule_time
  WITH caption = $draft.body
```

⚠ `APPROVE` 없는 `POST` = 컴파일 에러.

### APPROVE — 사람 승인 게이트 (POST 전 필수)

```tskill
APPROVE "Review drafts before publishing" {
  show: $drafts
  timeout: 24 hours
  on_timeout: CANCEL    ← CANCEL | ESCALATE | PROCEED
}
```

### EMIT — 다른 스킬에 시그널 전송

```tskill
EMIT "scout_complete"
  WITH payload = $posts
  TO SKILL "Analytics"
```

### LET — 변수 선언

```tskill
LET $cutoff = TODAY - 30 days
LET $top = $scored_posts WHERE engagement_rate > 0.05 LIMIT 10
```

---

## 제어 흐름 (Control flow)

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

## 예약된 경로 별칭


| 별칭 | 실제 경로 |
| ------------- | -------------------- |
| `$RAW` | `data/raw/` |
| `$INSIGHTS` | `data/insights/` |
| `$STRATEGIES` | `strategies/` |
| `$DRAFTS` | `content/drafts/` |
| `$PUBLISHED` | `content/published/` |
| `$REPORTS` | `data/reports/` |


사용자 정의 변수는 `LET $myVar = ...` (소문자 권장).

---

## 시그널 시스템

시그널을 방출/수신해 스킬을 체이닝합니다.

```tskill
// 발신 스킬 (TRACK 스테이지)
EMIT "insights_ready"
  WITH payload = $insights
  TO SKILL "Strategy Gen"

// 수신 스킬 (헤더)
SKILL "Strategy Gen"
  LISTENS TO "insights_ready" FROM SKILL "Analytics"

// 수신 스킬 (COLLECT 스테이지) — 페이로드는 $incoming 으로 도착
COLLECT "Load incoming data" {
  LOAD $incoming AS $fresh_insights
}
```

---

## 지원 플랫폼

```
INSTAGRAM  TIKTOK  YOUTUBE  TWITTER  LINKEDIN
GOOGLE_ANALYTICS  GOOGLE_ADS  META_ADS
NOTION  AIRTABLE  SLACK
```

---

## TSL 타입


| 타입 | 생성 주체 |
| ------------ | ------------------------------- |
| `Post` | `EXTRACT Post FROM ...` |
| `Metric` | `EXTRACT Metric FROM ...` |
| `Hypothesis` | `HYPOTHESIZE Hypothesis AS ...` |
| `Strategy` | `PLAN Strategy AS ...` |
| `Campaign` | 수동 / executor |
| `Report` | `TRACK` 출력 |


---

## 피해야 할 컴파일 에러


| 에러 | 원인 |
| --------------------------- | ----------------------------------------------------------------- |
| `invalid workspace` | `@workspace` ≠ `twixy` |
| `missing SKILL declaration` | `SKILL "..."` 블록 없음 |
| `missing summary` | `summary` 필드 미설정 |
| `missing trigger` | `trigger` 필드 미설정 |
| `missing output` | `output` 필드 미설정 |
| `stage outside PHASE` | PHASE 블록이 아닌 탑레벨에 스테이지 선언 |
| `PUBLISH without APPROVE` | EXECUTE 내부의 `POST` 에 `APPROVE {}` 없음 |
| `stage out of order` | 스테이지가 GOAL→COLLECT→ANALYZE→STRATEGIZE→EXECUTE→TRACK 순이 아님 |
| `unknown path alias` | 예약 목록에 없는 `$SOMETHING` 을 `LET` 없이 사용 |


---

## 작성 후

1. `skills/<name>/<name>.tskill` 로 저장
2. Twixy 앱이 파일 저장 시 자동으로 `SKILL.md` 로 컴파일 (watchSync)
3. `summary` 필드가 `SKILLS.md` 인덱스의 스킬 항목을 자동 채움
