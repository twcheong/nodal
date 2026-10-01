# 리팩토링 기준선 inventory

> 자동 생성: `node scripts/refactor-baseline.mjs`. 손으로 고치지 말 것. 집계 정의는 스크립트 머리말 참고.

- commit `ebabb58090c1b708b42184a3dfc6ec37b04b6574` (refactor/b-host, **작업트리 변경 있음**) · win32 x64 · node v24.13.0 · npm 11.6.2
- 생성: 2026-09-21T11:19:39.168Z

## LOC
| 파일 | 줄 |
|---|---|
| electron/main.ts | 2216 |
| electron/preload.ts | 782 |
| electron/planning.ts | 3129 |
| src/global.d.ts | 1212 |
| src/hooks/useOpenClaw.ts | 1935 |
| src/hooks/useCopilotChat.ts | 940 |
| src/hooks/useWorkflowTestSession.ts | 613 |
| src/hooks/useOrchestrationGateway.ts | 249 |
| src/hooks/useWorkflowClaw.ts | 211 |
| src/hooks/useDashboardClaw.ts | 202 |
| src/hooks/useOrchestrationClaw.ts | 151 |
| **게이트웨이 훅 7개 합계** | **4301** |

## IPC 등록 (ipcMain.handle|on|once) — 총 220
| 파일 | 등록 수 |
|---|---|
| electron/main.ts | 42 |
| electron/overlayIpc.ts | 22 |
| electron/integrationsIpc.ts | 19 |
| electron/workflowIpc.ts | 17 |
| electron/accountIpc.ts | 16 |
| electron/planIpc.ts | 16 |
| electron/mrIpc.ts | 12 |
| electron/orchestrationIpc.ts | 12 |
| electron/fileToolsIpc.ts | 11 |
| electron/aiAgentIpc.ts | 9 |
| electron/setupIpc.ts | 8 |
| electron/browserPreviewIpc.ts | 7 |
| electron/sessionLogs.ts | 7 |
| electron/skills.ts | 5 |
| electron/memoryIpc.ts | 4 |
| electron/enterpriseIpc.ts | 4 |
| electron/guardrail/ipc.ts | 3 |
| electron/languageCorrection.ts | 2 |
| electron/designated-paths/ipc.ts | 2 |
| electron/dashboard.ts | 1 |
| electron/product-ipc.ts | 1 |

- 중복 등록 채널: 없음

## preload 노출 API — 함수 218개 (값 프로퍼티 1개 별도)
- `window.twixy`: 212
- `window.twixyTestOverlay`: 6

## 교차 검증
- preload 가 호출하는데 main 등록이 없는 채널 (0): 없음
- main 에 등록됐는데 preload invoke/send 가 없는 채널 (29): `aiagent-get`, `aiagent-restore`, `aiagent-run-clear`, `aiagent-run-load`, `aiagent-run-save`, `check-node22`, `deck-render-sheet`, `get-analysis-meta`, `get-openclaw-status`, `get-project-root`, `get-tool-permissions`, `mark-analysis-done`, `mr-get`, `node-install-progress`, `orchestration-get`, `pick-folder`, `plan-mark-aborted`, `tool-fetch-to-file`, `tool-query-data`, `tool-read-gdoc`, `tool-read-gsheet`, `tool-read-xlsx`, `tool-send-email`, `tool-write-gdoc`, `tool-write-gsheet`, `tool-write-pdf`, `tool-write-xlsx`, `workflow-get`, `write-watch-file`
  - (main→renderer 단방향 이벤트, 다른 창 전용 채널일 수 있음 — 삭제 근거 아님)

## 렌더러 텍스트 참조 0 — 삭제 "검증 후보" (10)
동적 접근·별도 entry·테스트·지원 계약을 확인하기 전에는 dead code 로 단정하지 않는다 (가이드 C2).

- `twixy.browserPreviewRefresh` (preload.ts:654) → invoke:browser-preview:refresh
- `twixy.browserPreviewSetViewport` (preload.ts:659) → invoke:browser-preview:set-viewport
- `twixy.browserPreviewStart` (preload.ts:652) → invoke:browser-preview:start
- `twixy.browserPreviewStop` (preload.ts:653) → invoke:browser-preview:stop
- `twixy.closeTestOverlay` (preload.ts:632) → invoke:close-test-overlay
- `twixy.onBrowserPreviewFrame` (preload.ts:663) → on:browser-preview-frame, removeListener:browser-preview-frame
- `twixy.onBrowserPreviewTargetList` (preload.ts:668) → on:browser-preview-target-list, removeListener:browser-preview-target-list
- `twixy.productInvoke` (preload.ts:361) → invoke:product-invoke
- `twixyTestOverlay.onSync` (preload.ts:733) → on:test-overlay-sync, removeListener:test-overlay-sync
- `twixyTestOverlay.requestSync` (preload.ts:732) → invoke:test-overlay-request-sync

## main.ts 지표
- fs.writeFileSync: 12
- CONFIG_PATH 직접 읽기/쓰기: 3 / 1
- `startsWith(getWorkspace()|root)` 경로 검사 (P1 대상): 0

## 기타
- SOUL `?raw` import: 0
- openclaw 패치: 82035 bytes
- HTML entry (6): composer.html, guardrail.html, index.html, sidetab.html, test-overlay.html, twixy-enterprise.html

_dist 없음 — 청크 크기 미기록._
