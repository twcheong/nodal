# 리팩토링 기준선 (Stage 0 / P0)

기술 부채 실행 가이드 v2 의 첫 단계. **코드 변경 없이** 현재 상태를 재현 가능하게 기록한다.
이후 모든 단계 게이트는 이 문서의 결과와 비교한다 — "기존 실패" 와 "신규 실패" 를 구분하는 기준.

- 기준 commit: `10ae6b6` (main, 2026-09-19) — ppt 브랜치 병합 + 빌드 수정 직후
- 환경: Windows 11 x64 · node v24.13.0 · npm 11.6.2
- **아직 nodal 병합 전.** Stage 0.5(nodal 병합) 뒤에 아래 절차를 그대로 다시 돌려 비교한다.

## 산출물

| 파일 | 내용 | 갱신 방법 |
|---|---|---|
| `inventory.md` / `inventory.json` | LOC, IPC 등록 217개, preload API 244개, preload↔main 교차검증, 미참조 후보, dist 청크 | `node scripts/refactor-baseline.mjs` |
| `gateway-hooks-contract.md` | 게이트웨이 훅 7개 세션 계약표 (A0) | 수동 — 훅을 옮길 때마다 해당 열 갱신 |
| 이 문서 | 검증 결과 + 회귀 시나리오 | 수동 |

코드 이동 PR 은 `inventory.json` 을 다시 생성해 diff 를 붙인다. `ipcMain[].channel` 집합과
`preloadApi[].path` 집합이 그대로면 계약이 유지된 것 (file/line 만 바뀜).

## 자동 검증 결과 @ 10ae6b6

| 검증 | 명령 | 결과 |
|---|---|---|
| 단위 테스트 | `npx vitest run` | **20 files / 268 tests 통과** |
| 타입검사 (electron) | `npx tsc -p tsconfig.electron.json --noEmit` | **오류 0** |
| 타입검사 (renderer) | `npx tsc -p tsconfig.json --noEmit` | **기존 오류 5** (아래) |
| 토큰 검사 | `npm run check:tokens` | 통과 |
| 덱 프롬프트 검사 | `npm run check:deck` | **Windows 에서 기존 실패** (아래) |
| eslint | `npx eslint src electron` | **오류 0 / 경고 15** (exhaustive-deps 9 + 미사용 disable 등) |
| 패키지 smoke | `node scripts/smoke-packaged.mjs` | **4/4 통과** (listen 38s) |

### 기존 실패 — 신규 실패로 오인하지 말 것

1. **renderer tsc 5건, 전부 테스트 파일.** vitest 는 타입검사를 안 해서 테스트 자체는 통과한다.
   - `src/lib/orchestrationSoul.test.ts:5` TS2537
   - `src/lib/orchestrationTree.test.ts:33, :49, :60` TS2532
   - `src/lib/sharedWorkflows.test.ts:45` TS2322
2. **`npm run lint` 가 Windows 에서 `check:deck` 단계에서 멈춘다.** `CONTENT_SOUL.md`,
   `skills/pptx/pptx.tskill` 이 `core.autocrlf=true` 로 CRLF 체크아웃되는데 생성기는 LF 를 내서
   "marked region is stale" (expected/found 가 눈으로는 같음). `&&` 체인이라 eslint 까지 못 간다 →
   Windows 에서는 eslint 를 위 명령으로 따로 돌린다. macOS 에서는 재현 안 될 것으로 추정(미확인).
   수정은 별도 티켓 (`.gitattributes` 에 해당 파일 `eol=lf`, 또는 비교 시 줄끝 정규화).

## 패키지 smoke 가 필요한 이유

2026-09 의 회귀 4건이 **전부 패키지 빌드에서만** 났다. dev 는 `http://localhost:5173` (secure context)
+ `isDev` 분기라 같은 버그를 숨긴다.

| 사고 | 원인 | smoke 가 잡는 항목 |
|---|---|---|
| 패키지 앱이 게이트웨이에 못 붙음 (1008 device identity) | prod 에서 `allowInsecureAuth=false`, 렌더러는 토큰만 보냄 | `file://` 핸드셰이크 |
| 재로그인 시 게이트웨이 재시작 루프 | `ensureWorkspace` 가 `gateway.auth.token` 을 매번 떨굼 | 기동 전후 토큰 보존 |
| `dist:win` 실패 | 패치에 macOS `.DS_Store` 바이너리 블록 | (빌드 자체가 실패 → exe 없음) |
| 설치 직후 크래시 (sharp 누락) | 설치를 중간에 강제 종료 | 프로세스 생존 |

`smoke-packaged.mjs` 옵션: `--exe <path> --state-dir <dir> --port <n>`. nodal 병합 뒤에는 제품별
`stateDirName` 이 달라지므로 `--state-dir` 로 제품마다 따로 돌린다.

## 수동 회귀 시나리오 (자동화 안 된 것)

단계 게이트마다 **패키지 빌드에서** 확인. dev 에서만 확인한 것은 통과로 치지 않는다.

- [ ] 로그인 (브라우저 → `twixy://` 딥링크 → 앱 언락)
- [ ] **로그아웃 → 재로그인.** 게이트웨이 로그에 `requires gateway restart` / `auth token was missing` 이 **안 떠야** 한다
- [ ] 기본 대화: 메시지 전송 → 응답 + 마크다운/표/코드 렌더
- [ ] Copilot: 대화 탭 2개 + 모드 전환, 응답이 맞는 탭에 붙는지
- [ ] 워크플로 설계 채팅 (builder)
- [ ] 워크플로 테스트 실행 1개 (비-브라우저: SEO Action Plan) → `data/reports/` 에 파일
- [ ] 워크플로 테스트 실행 1개 (브라우저 사용) → 크롤 산출
- [ ] 오케스트레이션 병렬 실행
- [ ] 실행 중 다른 탭으로 갔다가 복귀 — 실행이 끊기지 않고 상태가 맞는지
- [ ] 게이트웨이 재연결 (설정에서 모드 전환 등 `ensureWorkspace` 를 유발하는 동작 후에도 연결 유지)
- [ ] 앱 종료 후 `:18789` 를 잡은 고아 프로세스가 없는지
- [ ] twixy-enterprise entry 기동

워크플로 품질·비용 기준선은 `node scripts/wf-eval.mjs` (라이브 모델 호출 = 비용 발생, 단계 게이트에서만).
`AB_ORIGIN=file://` 로 패키지 조건을 재현할 수 있다.

## 아직 기준선에 없는 것

- 콜드 스타트 시간, 첫 패널 진입 지연, 메모리 — 측정 절차 미정 (Stage 6 전에 확정)
- 초기 진입점이 실제로 가져오는 JS 총량 — `inventory.md` 의 dist 청크는 파일별 raw bytes 일 뿐
- macOS 빌드/패키지 결과 — 이 기준선은 Windows 한 대에서만 측정
