# Twixy 기능 갭 분석 — Claude Code / OpenClaw 대비

> 기준: `integration/connections-x-skillvocab` 브랜치 (모든 기능 통합본), 2026-06
> 목적: Twixy에 **없는 기능**을 Claude Code와 OpenClaw 각각에 비교해 목록화
> 표기: ❌ 없음 · 🔸 부분만 있음(개념은 다름/일부만)

---

## 들어가기 전에 — Twixy가 이미 가진 것 (갭 아님)

비교 혼선을 막기 위해 먼저 정리. 아래는 **이미 있으므로 갭이 아님**:
브라우저 자동화(chrome), 파일 읽기/쓰기/편집, 웹 검색·페치(web_search/web_fetch), 서브에이전트(4종 로스터), 사용량·비용 표시, 모델 선택, 승인 가드레일(bypass/standard/strict), 문서 생성(PDF/XLSX/PPTX/GDoc/GSheet), Gmail 전송, Planning Mode(L6/L7/L8)·Workflow IDE·TSL 스킬(이건 Twixy 고유 강점).

---

# A. Claude Code 대비 없는 기능

Claude Code는 "개발자용 범용 에이전트 플랫폼", Twixy는 "마케팅 특화 데스크톱 앱"이라, 아래는 주로 **확장성·세션관리·개발 도구** 영역의 갭이다.

## A-1. 확장성 / 커스터마이징

| 기술명 | 무슨 기능을 수행 | 상태 |
|---|---|---|
| 슬래시 커맨드 (Slash Commands) | `/명령어`로 사용자 정의 동작·프롬프트 템플릿을 즉시 호출. Twixy는 고정된 QuickActions 버튼만 있고 사용자가 커맨드를 등록 불가 | ❌ |
| 훅 (Hooks) | PreToolUse/PostToolUse/SessionStart 등 실행 사이클 전·후에 사용자 스크립트를 끼워넣기(포맷·검증·알림). Twixy는 내부 guardrail용으로만 쓰고 사용자에게 안 엶 | ❌ |
| 플러그인 / 마켓플레이스 | 스킬·MCP·훅·테마를 묶어 설치/배포. Twixy엔 외부 플러그인 설치 개념 없음 | ❌ |
| 출력 스타일 (Output Styles) | 응답 포맷·말투를 Concise/Verbose/Tutorial 등으로 전환 | ❌ |
| 커스텀 status line / 테마 / 키바인딩 | 상태줄·색테마·단축키를 사용자가 재정의. Twixy는 고정 GUI | ❌ |

## A-2. 외부 연동 (MCP)

| 기술명 | 무슨 기능을 수행 | 상태 |
|---|---|---|
| MCP 클라이언트 | stdio/SSE/HTTP로 외부 MCP 서버에 붙어 그 도구·리소스·프롬프트를 사용. Twixy는 12개 자체 브릿지 도구만 쓰고 MCP 미지원 → 제3자 도구 생태계 연결 불가 | ❌ |

## A-3. 세션 / 메모리 / 영속성

| 기술명 | 무슨 기능을 수행 | 상태 |
|---|---|---|
| 세션 재개 (resume/continue) | 앱·터미널 재시작 후 이전 대화를 그대로 이어가기. Twixy 일반 채팅은 메모리에만 있어 재시작 시 소실 (Plan run.md만 부분 영속) | 🔸 |
| 메모리 (CLAUDE.md / Auto Memory) | 프로젝트 규칙·사용자 선호·세션 발견을 영속 저장해 매 세션 자동 주입. Twixy엔 장기 메모리 개념 없음(Plan/Module Spec이 가장 근접) | ❌ |
| 체크포인트 / 되감기 (rewind) | 특정 과거 지점으로 코드+대화를 롤백. Twixy는 Plan 일시정지/재개만 있고 되감기 없음 | ❌ |
| 컨텍스트 시각화 (/context) | 현재 컨텍스트 사용량·최적화 제안 표시 (Twixy는 워크플로우 테스트의 ContextChip만 부분 제공) | 🔸 |

## A-4. 개발자 도구

| 기술명 | 무슨 기능을 수행 | 상태 |
|---|---|---|
| 사용자 터미널 / Bash 노출 | 사용자가 직접 셸 명령 실행·관찰. Twixy는 bash를 LLM 내부에서만 쓰고 터미널 UI 없음 | 🔸 |
| Grep / Glob 도구 | 정규식 코드 검색·파일 패턴 매칭을 에이전트 도구로 제공. Twixy는 read 위주 | 🔸 |
| LSP 통합 | 타입정보·심볼 정의/참조·실시간 타입에러 | ❌ |
| 원격 VCS (GitHub/GitLab) PR·이슈 | 원격 저장소에 PR 생성·리뷰·이슈 연동. Twixy는 로컬 파일 기반 MR만 있고 원격 VCS·CI 훅 없음 | 🔸 |
| IDE 확장 (VS Code/JetBrains) | 에디터 안에서 에이전트 구동. Twixy는 독립 앱이라 해당 없음 | ❌ |
| 웹/원격 실행 (web, remote-control, teleport) | 클라우드 환경 실행·기기 간 세션 이동 | ❌ |
| 이미지 입력 | 사용자가 이미지를 직접 첨부해 분석 요청 (OpenClaw image 도구는 있으나 Twixy UI 미노출) | 🔸 |

---

# B. OpenClaw 대비 없는(노출 안 한) 기능

OpenClaw는 Twixy의 **런타임 토대**다. 따라서 아래는 "런타임엔 이미 있는데 Twixy가 제품으로 안 켠" 것 — **추가 코드 거의 없이 노출 확장 가능한 후보**가 많다.

## B-1. 멀티채널 인박스 (가장 큰 미사용 영역)

| 기술명 | 무슨 기능을 수행 | 상태 |
|---|---|---|
| 24종 채널 연동 | WhatsApp·Telegram·Slack·Discord·Signal·iMessage·Teams·LINE·KakaoTalk류 등 메신저로 에이전트를 직접 운용(DM 페어링·그룹 라우팅·멘션 게이팅). Twixy는 `--allow-unconfigured`로 채널을 비운 채 로컬 단일 챗만 사용 | ❌ |
| message 도구 | 에이전트가 임의 채널로 메시지 송신. Twixy 미노출 (현재 Gmail 전송만 자체 구현) | ❌ |

> 참고: 사용자가 요청한 **Slack/Discord/Notion/Kakao 연동**은 OpenClaw 채널 스택으로 상당 부분 즉시 충족 가능 — Connections에서 "준비 중"인 항목들의 빠른 경로.

## B-2. 자동화 스택

| 기술명 | 무슨 기능을 수행 | 상태 |
|---|---|---|
| Cron 스케줄러 | 정밀 스케줄·일회성(`--at`)·웹훅 트리거로 정기 작업 실행. Twixy는 미사용(자체 execution-plan으로 대체) | ❌ |
| Heartbeat | 주기적으로 main 세션 턴을 자동 발사(상시 모니터링). 미사용 | ❌ |
| Hooks (라이프사이클) | compaction/tool-call 이벤트에 스크립트 연결. Twixy는 guardrail 내부용만 | ❌ |
| Standing Orders | `AGENTS.md`로 상시 지시 주입 (Twixy도 AGENTS/SOUL 주입은 함 — 부분) | 🔸 |
| Task Flow | durable 멀티스텝 플로우 엔진. Twixy는 자체 Planning Mode 사용 | 🔸 |
| Webhook / Gmail Pub/Sub | 외부 이벤트로 에이전트 트리거 | ❌ |

> 참고: **마케팅 정기 리포트 자동화**(예: 매주 KPI 요약 메일)는 Cron+message로 바로 구현 가능. Watchtower 에이전트가 있지만 스케줄 트리거는 OpenClaw cron에 의존.

## B-3. 메모리 / 데이터

| 기술명 | 무슨 기능을 수행 | 상태 |
|---|---|---|
| 메모리 도구 (memory_search / memory_get) | honcho·lancedb·qmd 백엔드로 장기 기억 검색·조회. Twixy는 `coding` 프로파일에서 미노출(라벨 포맷터만 존재) | ❌ |
| MCP 연동 (openclaw mcp) | 외부 MCP 서버를 런타임에서 연결. 미사용 | ❌ |
| code_execution | 샌드박스 원격 Python 데이터 분석. Twixy가 `tools.deny`로 명시적 차단 | ❌(의도적) |
| x_search | X(트위터) 전용 검색. Twixy가 `tools.deny`로 차단 | ❌(의도적) |

## B-4. UI / 디바이스 / 음성

| 기술명 | 무슨 기능을 수행 | 상태 |
|---|---|---|
| Canvas / A2UI | 에이전트가 라이브 캔버스 UI를 그려 제시(present/eval/snapshot). Twixy는 `canvas`를 advertise만 하고 surface 없음 | 🔸 |
| Nodes / 디바이스 페어링 | iOS·Android·macOS 노드를 페어링해 카메라·화면녹화·알림·위치 등 제어 | ❌ |
| Voice Wake / Talk Mode | 음성 호출·음성 대화 | ❌ |
| image / image_generate | 이미지 분석·생성 도구 | ❌ |

## B-5. 게이트웨이 / 인프라

| 기술명 | 무슨 기능을 수행 | 상태 |
|---|---|---|
| 원격 게이트웨이 (Tailscale / SSH 터널) | 외부에서 게이트웨이 접속·운용. Twixy는 `gateway.mode:'local'` loopback 전용 | ❌ |
| OpenAI 호환 HTTP API | 외부 클라이언트가 OpenClaw를 OpenAI API처럼 호출. 미노출 | ❌ |
| Model Failover (OAuth↔API키 로테이션) | 모델/자격 실패 시 자동 폴백·로테이션. Twixy는 OpenRouter 경로 고정 위주(부분) | 🔸 |
| Plugin SDK | 채널·모델 provider·도구·speech를 코드로 등록. Twixy는 자체 패치(`createOpenClawTools` append)로 도구만 주입 | 🔸 |
| ClawHub 스킬 레지스트리 / 플러그인 설치 | 원격 레지스트리에서 스킬 자동 검색·설치. Twixy는 자체 `.tskill` 컴파일러 사용 | ❌ |

---

# C. 요약 — 우선순위 관점

**Claude Code 대비 갭**은 대체로 "개발자 플랫폼 기능"이라 마케팅 제품 Twixy엔 우선순위가 낮음. 단 **세 가지는 제품 가치에 직결**:
1. **세션 영속성/메모리** — 대화가 재시작 시 사라지는 건 일상 사용성 문제.
2. **MCP 클라이언트** — 제3자 도구(노션/슬랙 등) 연결의 표준 경로. 사용자가 요청한 "설정에서 버튼으로 연동"의 정석.
3. **슬래시 커맨드** — 반복 마케팅 작업을 사용자 단축 명령으로.

**OpenClaw 대비 갭**은 "런타임엔 있으나 안 켠 것"이라 **투자 대비 효과가 가장 큼**:
1. **채널 연동(24종)** — Slack/Discord/Kakao 등 사용자가 원한 연동을 런타임이 이미 제공. Connections "준비 중" 항목의 최단 경로.
2. **Cron/Hooks 자동화** — 정기 리포트·KPI 알림 자동화의 토대.
3. **MCP 연동 + 메모리 도구** — 외부 데이터 소스 연결과 장기 기억.

> 즉, Claude Code 대비 갭은 "새로 만들 것", OpenClaw 대비 갭은 "이미 깔린 걸 켤 것"에 가깝다.
