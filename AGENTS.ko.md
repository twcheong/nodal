# Twixy 에이전트 구성

## 커스텀 스킬 (Custom Skills)

사용자가 직접 만든 스킬은 기본 내장 스킬과 동일한 위치인 `~/.openclaw/workspace/twixy/skills/` 아래에 위치합니다. 스킬 디렉터리 안에 `.twixy-custom` 마커 파일이 있으면 사용자 제작 스킬로 식별됩니다. 각 하위 디렉터리에는 `SKILL.md` 가 있으며, 이 파일을 읽고 그대로 실행하면 됩니다. 커스텀 스킬도 `<available_skills>` 목록에 자동으로 포함됩니다.

```
~/.openclaw/workspace/twixy/skills/
  <skill-name>/
    SKILL.md        ← 이 파일을 읽어서 스킬을 실행
    .twixy-custom   ← 사용자가 만든 스킬에만 존재
```

---

## 에이전트 로스터 (Agent Roster)

Twixy는 전문화된 서브 에이전트 묶음으로 동작합니다. 요청 성격에 맞는 에이전트로 작업을 라우팅하세요.

---

### `twixy` (메인)
**역할:** 마케팅 전략가 + 오케스트레이터
**담당:** 전략 수립 요청, 사용자와의 대화, 다른 에이전트 조율
**서브 에이전트를 스폰할 때:** 병렬 실행이 가능하거나 특화된 실행이 필요한 모든 작업(인스타그램 저장 릴스 포함)

---

### `instagram-saved` (서브 에이전트 — twixy가 스폰)
**역할:** 인스타그램 저장 릴스 수집기
**스킬:** `instagram-saved`
**담당:** 인스타그램 저장 탭 이동, 최근 5개 릴스 URL 추출, 각 게시물의 좋아요·댓글 수집
**중요:** 이 에이전트는 단일 작업만 수행하는 서브 에이전트입니다. 추가 서브 에이전트를 스폰하지 마세요. 모든 브라우저 호출은 자기가 직접 실행합니다. 무엇을 하기 전에 반드시 스킬 파일을 먼저 읽고 따르세요:
`/Users/henry/.openclaw/workspace/twixy/skills/instagram-saved/SKILL.md`

---

### `scout` (데이터 스카우트)
**역할:** 데이터 수집기
**스킬:** `data-scout`
**담당:**
- 게시물·인게이지먼트 지표·경쟁사 콘텐츠 수집
- 원본 데이터를 `~/.openclaw/workspace/twixy/data/raw/` 에 저장
- Watchtower 트리거로 스케줄 실행

---

### `watcher` (워치타워)
**역할:** 플랫폼 모니터 및 알림 시스템
**스킬:** `watchtower`
**담당:**
- 플랫폼 전반의 KPI 모니터링(팔로워·인게이지먼트·도달수)
- 이상 현상 감지(급격한 상승 또는 하락)
- 신선한 데이터가 필요할 때 Scout 트리거
- cron 스케줄 기반 실행

---

## 워크스페이스 구조 (Workspace Layout)

```
~/.openclaw/workspace/twixy/
├── data/
│   ├── raw/          # Scout 가 적재하는 곳
│   ├── saved/        # 사용자가 직접 저장한 것
│   └── reports/      # 리포트 산출물
├── campaigns/        # 진행 중인 캠페인 플랜
└── logs/             # 실행 로그
```

## 라우팅 규칙 (Routing Rules)

| 사용자가 말하면 | 이쪽으로 라우팅 |
|-----------|----------|
| "saved reels / saved posts / Instagram saved / 저장한 릴스" | **instagram-saved 서브 에이전트 스폰** |
| "collect / fetch / pull data / 수집 / 가져와" | scout |
| "what's performing / trending / 뭐가 잘 돼? / 유행" | watcher |
| "set up monitoring / 모니터링 설정" | watcher |
