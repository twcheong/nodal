# P1 — 파일/IPC 신뢰 경계 inventory (Track B · leg 1)

렌더러가 넘긴 경로·이름·id·URL 로 main 이 파일시스템이나 OS 셸을 건드리는 IPC 전수 조사.
**줄 번호는 기준 commit `4305e25` 의 것** — 이후 커밋에서 밀린다. 채널명으로 grep 할 것.

- 조사 범위: `electron/**` 의 `ipcMain.handle|on` 219개 (main.ts 213 · guardrail 3 · designated-paths 2 · product-ipc 1)
- 호출부: `src/**` 에서 preload 메서드명으로 grep. HTML entry 6개 중 **이 문서의 채널을 부르는 건 메인 창뿐**이다
  (`index.html` 과 `twixy-enterprise.html` 은 같은 `src/App.tsx` 번들). sidetab · composer · guardrail · test-overlay 는 0건.
- 그러나 **5개 BrowserWindow 가 전부 같은 `preload.js` 를 쓴다** → 어느 창의 렌더러든 아래 채널을 전부 부를 수 있다.
  "어느 창이 부르나" 는 현재 관례일 뿐 강제되지 않는다 (§6, leg 2).

## 0. 위협 모델 (이 문서가 막으려는 것)

렌더러는 LLM 출력·스크랩한 웹 페이지·드롭한 파일을 `dangerouslySetInnerHTML` 로 그린다 (DOMPurify 통과).
XSS 하나면 `window.twixy.*` 전체가 공격자 손에 들어간다. 그때 main 이 마지막 방어선이다.
기존 검사 `abs.startsWith(getWorkspace())` 의 구멍:

| # | 구멍 | 예 |
|---|---|---|
| 1 | 형제 prefix | 워크스페이스 `…\users\abc` → `…\users\abc-evil\secret` 통과 (다른 사용자 uid 가 prefix 를 공유하면 남의 워크스페이스) |
| 2 | 링크 미해석 | `<ws>\data\x` 가 `C:\Users\me\.ssh` 로 가는 junction 이면 문자열은 "안", 실제 I/O 는 밖. 에이전트는 `bash` 툴로 링크를 만들 수 있다 |
| 3 | 루트 자체 | `delete-file('.')` → `fs.rmSync(<workspace>, {recursive})` |
| 4 | 대소문자 (win32) | deny-list 비교가 `C:\Users\x\.OPENCLAW` 를 놓친다 |
| 5 | id → 경로 | `plan-delete('..')` → `rmSync(<workspace>)`, `'../../..'` → 프로젝트 폴더의 부모 |

## 1. 경로·이름을 받는 채널

`밖?` = 워크스페이스(`<projectRoot>/users/<uid>`) 밖에 닿는 게 **의도된 제품 동작**인가.
`조치` = leg 1 에서 한 일. **M** = prefix 매칭을 `isInside()` 로 기계적 교체 (`electron/trustBoundary.ts`), **R** = 루트 거부 추가,
**C** = 없던 검사 추가, **—** = 변경 없음.

### 1-A. 기존에 `startsWith` 류 검사가 있던 곳

| 채널 | main.ts | 렌더러가 주는 것 | 기존 검사 | src 호출부 (전부 메인 창) | 밖? | 조치 |
|---|---|---|---|---|---|---|
| `admin-reveal` | 3099 | 절대경로 | `startsWith(projectRoot)` (sep 없음 → 구멍 1) | `AdminPanel.tsx:329` — `admin-stats` 가 준 shared/user/.twixy 경로 | 프로젝트 루트 안 (shared/, .twixy/) — 의도 | M (루트 허용) |
| `workflow-raw-scratch-clear` | 3807 | 상대 폴더 | 정규식 `^data/raw/[A-Za-z0-9_.-]+$` + `startsWith(jail+sep)` | `CopilotView.tsx:712` — 앱이 만든 `data/raw/tab-xxxx` | 아니오 | M (**삭제** — 링크면 거부) |
| `recent-files` | 4079 | `dirs[]` (preload 는 `limit` 만 넘김) | `startsWith(ws)` | `ChatPanel.tsx:863`, `CopilotView.tsx:1640` | 아니오 | M |
| `delete-file` | 4110 | 상대/절대 | `startsWith(ws)` — **루트 통과, 폴더면 재귀 삭제** | `DataPanel.tsx:849` — `listDir` 결과 | 아니오 | M + **R** |
| `write-watch-file` | 4129 | 이름 | 정규식 + `startsWith(watches)` | 0건 (미사용) | 아니오 | M |
| `import-dropped-file` | 4145 | 이름 + bytes | basename + 문자 제거 + `startsWith(dest)` | `ChatPanel.tsx:996`, `CopilotView.tsx:1692` | 아니오 (밖의 파일을 **복사해 들여온다**) | M |
| `move-file` | 4182 | from, toDir (상대/절대) | 둘 다 `startsWith(ws)` — **from 에 루트 통과** | `DataPanel.tsx:919` — `(entry.path, 'data/saved')` | 아니오 | M + **R** (from 만; toDir 은 루트 허용) |
| `reveal-in-finder` | 4211 | 상대/절대 | `startsWith(ws)` | `CopilotView.tsx:910,2594`, `DataPanel.tsx:843`, `WorkflowNodeCard.tsx:327` (**LLM 출력에서 정규식으로 뽑은 경로**), `usePlans.ts:1145` (절대) | 아니오 | M (루트 허용) |
| `read-file` | 4521 | 상대 | `startsWith(ws)` | `DataPanel.tsx` 5곳, `SkillsPanel.tsx:842-3`, `SkillReader.tsx:44`, `WorkflowNodeCard.tsx:333` (**LLM 출력 경로**) | 아니오 | M |
| `read-file-bytes` | 4533 | 상대 | `startsWith(ws)` | `DataPanel.tsx:895` | 아니오 | M |
| `write-file` | 4541 | 상대 + 내용 | `startsWith(ws)` | `DataPanel.tsx:817,1153,1292` | 아니오 | M |
| `export-pdf-to` | 4600 | srcPath (상대/절대) + html | `startsWith(ws+sep)` — **쓰는 경로(out)는 검사 안 함** | `WorkflowNodeCard.tsx:336,340` (**LLM 출력 경로**) | 아니오 | M (src·out 둘 다) |
| `dashboard-snapshot` | 5066 | 없음 (상수 경로 3곳) | `startsWith(ws)` ×3 | `DashboardPanel.tsx:796` (어디서도 import 안 되는 컴포넌트 — 사실상 0건) | 아니오 | M |
| `read-image` | 5242 | 상대 | `startsWith(ws)` | `CopilotView.tsx:3220`, `useSlideImages.ts:60` (**LLM 이 쓴 deck-spec 안의 경로**), `DataPanel.tsx:656,751` | 아니오 | M |
| `read-skill-source` | 5262 | 스킬 이름 | `startsWith(skills+sep)` | `SkillsPanel.tsx:794`, `SkillReader.tsx:51` (LLM 이 쓴 `skillHint`) | 아니오 | M |
| `delete-skill` | 5321 | 스킬 이름 | `startsWith(skills+sep)` + `.twixy-custom` 마커 | `SkillsPanel.tsx:802` | 아니오 | M (**삭제**) |
| `read-session-log` | 5541 | 절대경로 | `startsWith(logs/sessions)` (sep 없음 → `logs/sessions-x` 통과) | `ChatPanel.tsx:663` — `list-session-logs` 결과 | 아니오 | M |
| `list-dir` | 5903 | 상대 (`''` = 루트) | `startsWith(ws)` | `DataPanel.tsx:702,714`, `FilesPanel.tsx:52`, `useCopilotChat.ts:206` | 아니오 | M (루트 허용) |
| `list-shared-dir` | 5917 | 상대 | `startsWith(sharedRoot)` | `FilesPanel.tsx:59` | `<projectRoot>/shared` — 의도 | M (루트 허용) |
| `open-file` | 6517 | 상대/절대 | `startsWith(ws+sep)` → `shell.openPath` | `CopilotView.tsx:906`, `WorkflowNodeCard.tsx:323` (**LLM 출력 경로**), `:343` | 아니오 | M |
| `memory-read-note` | 6714 | 이름 | 정규식 + `path.relative` | `SettingsPanel.tsx:2360` | 아니오 | M (링크 해석 추가) |
| `pick-output-dir` | 6759 | 없음 (네이티브 다이얼로그 결과) | `startsWith(data+sep)` | `NodeCanvas.tsx:157` | 아니오 | M |
| `set-project-dir` | 4032 | 절대경로 | **deny-list** 문자열 비교 | `useProjectDir.ts:49` — `pick-project-dir` 결과 | **예 — 사용자가 고른 임의 폴더** | 부분: 상태 폴더(`OPENCLAW_DIR`)만 실제 경로로 재검사. 나머지는 §7-D1 |

`tools/files/safePath.ts` 의 `resolveInsideWorkspace()` 도 같은 prefix 매칭이었다 → 안에서 `isInside()` 를 부르게 바꿨다.
아래 채널과 **에이전트 툴 브릿지**(`agent-tool-bridge.ts`, LLM → main HTTP)가 전부 이 함수를 지난다:

| 채널 | main.ts | 경로 규칙 | src 호출부 |
|---|---|---|---|
| `tool-read-pptx` · `tool-read-xlsx` · `extract-file-text` · `pptx-render-sketch` | 4664 · 4745 · 4760 · 4711 | 읽기 = 워크스페이스 안 아무 곳 | `CopilotView.tsx:320,358,847`, `useCopilotChat.ts:257`, `useWorkflowTest.ts:829` (**사용자/LLM 텍스트에서 긁은 경로**) |
| `tool-write-pdf` · `tool-write-xlsx` · `tool-write-pptx` · `tool-fetch-to-file` | 4638 · 4649 · 4796 · 4777 | 쓰기 = designated 버킷만 | 0건 (브릿지 전용) |
| `tool-edit-pptx` | 4681 | src 워크스페이스, 다른 이름 저장은 버킷 | `CopilotView.tsx:1741` |
| `tool-query-data` | 4787 | 입력 워크스페이스, 출력 버킷 | 0건 |
| `deck-render-sheet` | 4818 | spec 안의 이미지 경로 → `deckImages.resolveImagePath` (같이 교체) | 0건 |

> **designated paths 는 워크스페이스 밖이 아니다.** `roots` 는 워크스페이스 **상대** 경로이고 `..`·절대·`~` 는 정규화에서 버려진다
> (`designated-paths/config.ts:normalizeRel`). "에이전트 쓰기를 워크스페이스 **안의** 허용 폴더로 좁히는" 기능이다.
> 그래서 이 변경으로 막히는 designated 흐름은 "버킷 폴더가 밖을 가리키는 링크인 경우" 하나뿐이다.

### 1-B. 검사가 아예 없던 곳

| 채널 | main.ts | 렌더러가 주는 것 | 문제 | 조치 |
|---|---|---|---|---|
| `install-skill` | 5286 | name + source | `path.join(ws,'skills',name)` — name 검증 없음 (렌더러만 정규화). `name='../../x'` → 밖에 3개 파일 기록. 형제 핸들러(`read-skill-source`·`delete-skill`)는 검사함 | **C** |
| `guardrail-overwrite-redirect` | 3474 | id, originalRel, fileName | fileName 은 basename 강제지만 `originalRel` 은 절대경로 허용 → 게이트웨이에 `..\..` 리다이렉트를 적을 수 있다. 주석의 의도("버킷 밖으로 못 나가게")와 어긋남 | **C** |
| `mr-merge` (`mr.ts:mergeMR`) | 3190 | MR id | `changes[].path` 를 **디스크의 meta.json 에서** 읽어 그대로 쓴다. shared-folder 모드에서 meta.json 은 팀원이 쓸 수 있는 파일 → 팀원이 만든 `path:'../../x'` 가 **내 PC** 에 쓰인다. 생성 시에만 `assertSharedPath` | **C** (병합 시 재검증) |
| `twixy-enterprise-read-run` · `twixy-enterprise-admin-load` | 6610 · 6782 | **임의 projectRoot** (+ uid, planId) | 검사 없음. `<아무 경로>/users/<uid>/plans/<id>/run.md`, `plan.json`, `shared/skills` 를 읽는다 | — (§7-D2) |

### 1-C. id 로 경로를 조립하는 채널 (49개)

`planning.ts` 의 `planDir` · `workflowDir` · `orchestrationDir` · `aiAgentDir` · `stepRawDir`, `mr.ts` 의 `mrDir` · `blobPath` 가
`path.join(root, id)` 를 검증 없이 한다. id 는 main 이 `generateId()` 로 만든 단일 세그먼트(`wf_…`)지만 **IPC 로 들어오는 id 는 렌더러 입력**이다.

- plan (13): `plan-get|update|delete|begin-run|step-start|step-end|step-compact|step-read-raw|request-pause|mark-paused|mark-aborted|finalize|read-run`
- workflow (13): `workflow-get|update|delete|restore|chat-load|chat-append|chat-clear|test-run-load|test-run-save|test-run-clear|run-history-append|run-detail-save|run-detail-load`
- orchestration (10): `orchestration-get|update|delete|restore|chat-load|chat-append|chat-clear|run-load|run-save|run-clear`
- aiagent (7): `aiagent-get|update|delete|restore|run-load|run-save|run-clear`
- mr (6): `mr-get|review|comment|cancel|merge|read-blob`

가장 나쁜 것: `*-delete` 4개가 `fs.rmSync(dir, { recursive: true, force: true })` — `id='..'` 이면 워크스페이스 전체.
**조치: C** — 경로 조립 함수 7곳 + run 상세 파일명(`${startedAt}.json`, 타입은 number 지만 런타임엔 렌더러 값) 2곳에서
"정확히 한 세그먼트" 를 강제 (`safeSegment`). 호출부 49개는 손대지 않는다. 거부 시 반환은 기존 형태 그대로:
읽기 계열은 경로를 `try` 안에서 만들기 때문에 기존 "없음"(`null` · `''` · `[]`), 쓰기·삭제는 `{ ok:false, error }`.

### 1-D. 경로가 고정이거나 main 이 만든 것 (입력 영향 없음 → 변경 없음)

`memory-read|write|list-notes` (고정 파일) · `session-log-append` (sessionId 를 `sanitizeSessionIdForFilename` 으로 정제) ·
`generate-session-summary` (디렉토리 스캔 결과의 basename) · `list-session-logs` · `list-skills` · `pull-shared` · `admin-stats` ·
`open-log-file` (고정 경로 `shell.openPath`) · `pptx-render-sketch`/`deck-render-sheet` 의 출력 PNG (convId 에서 `/ \` 제거) ·
`designated-paths-*` · `guardrail-*-config` · `google-*` · `connections-*` · `mcp-*` (고정 상태 파일).

## 2. 워크스페이스 밖으로 나가는 게 **정상**인 흐름 (건드리지 않음)

| 흐름 | 채널 | 왜 밖인가 | 신뢰 근거 |
|---|---|---|---|
| 내보내기 "Save as" | `export-pdf`, `export-md` | 기본 위치 = 다운로드 폴더 | 경로는 **main 이 띄운 네이티브 저장 다이얼로그**가 준다. 렌더러는 파일명 힌트만 |
| 프로젝트 폴더 선택 | `pick-project-dir` → `set-project-dir` | 팀 공유 폴더·외장 드라이브 등 임의 위치 | 다이얼로그 결과를 **렌더러가 되돌려준다** → 렌더러가 다른 경로를 넣을 수 있음 (§7-D1) |
| 폴더 선택 | `pick-folder`, `twixy-enterprise-pick-folder` | 임의 위치 | 다이얼로그. 경로 문자열만 반환, main 은 아무것도 안 함 |
| Enterprise admin 대시보드 | `twixy-enterprise-admin-load`, `-read-run` | 다른 프로젝트 폴더를 읽기 전용으로 열람 | 없음 (§7-D2) |
| 팀 공유 영역 | `list-shared-dir`, `mr-*`, `admin-reveal`, `pull-shared` | `<projectRoot>/shared`, `.twixy` | 프로젝트 루트 기준으로 검사 |
| 드롭한 파일 | `import-dropped-file` | 원본은 밖 | 렌더러가 **bytes 를 넘기고** main 은 `data/raw/` 에 쓴다. 밖의 경로는 main 에 오지 않는다 |
| 브라우저 다운로드 정리 | (IPC 아님) `startDownloadWatcher` | `%TEMP%/openclaw/downloads` → `data/raw/` | main 내부 |
| 상태 폴더 | (IPC 아님) `~/<stateDirName>/*` | 설정·세션·로그 | main 내부, 경로 고정 |

## 3. 외부 URL · 셸

| 싱크 | 위치 | URL 출처 | 기존 검사 | 조치 |
|---|---|---|---|---|
| `open-external` IPC | 4077 | 렌더러. 호출부 10곳: 하드코딩 https (Settings·Setup·HelpLink), `PRODUCT.pricingUrl` (**nodal 은 `''`**), `release.download_url` (**Supabase 행 — 원격 제공**), 채팅/파일 미리보기의 `a.href` 3곳 (**LLM·스크랩 텍스트**), `LiveBrowserPreview.tsx:291` `active.url` (**에이전트가 모는 Chrome 의 현재 URL**) | **없음** | http · https · mailto 만 (`isAllowedExternalUrl`) |
| `setWindowOpenHandler` / `will-navigate` | 2547-2558 | 렌더러 내 링크 클릭 | 정규식 `^https?:\|^mailto:` | 같은 함수로 통일 |
| MCP OAuth | `connections/mcp-oauth.ts:312` | **원격 MCP 서버의 메타데이터** `authorization_endpoint` | 없음 | 같은 allowlist |
| Google OAuth | `google/oauth.ts:243` | googleapis 가 만든 https URL | — | — |
| `auth-sign-in` | 4285 | `WEB_URL` 상수 | — | — |
| macOS 권한 안내 | 6304 | 리터럴 `x-apple.systempreferences:` | — | — (IPC 를 안 거친다) |
| `open-file` → `shell.openPath` | 6528 | 워크스페이스 안 파일 | §1-A | 확장자 제한 없음 — §7-D3 |
| `open-log-file` → `shell.openPath` | 6487 | 고정 | — | — |

`a.href` 3곳이 중요한 이유: DOMPurify 기본값은 `javascript:`·`file:` 리터럴은 지우지만 **상대 링크는 남긴다**.
패키지 앱에서 `[x](docs/a.md)` 의 `a.href` 는 `file:///…/dist/docs/a.md` 로 풀려 그대로 `openExternal` 에 간다.

## 4. 토큰 노출 목록 (문서만 — leg 1 에서 변경 없음)

| 채널 / 이벤트 | 렌더러로 넘어가는 비밀 | 렌더러가 하는 일 | 필요한 창 | 줄일 수 있나 |
|---|---|---|---|---|
| `get-gateway-token` | 게이트웨이 auth 토큰 (openclaw.json) | 훅 7개가 WS `connect` 프레임의 `auth.token` 에 싣는다 (`useOpenClaw:695`, `useCopilotChat:478`, `useDashboardClaw:117`, `useOrchestrationClaw:71`, `useOrchestrationGateway:96`, `useWorkflowClaw:88`, `useWorkflowTestSession:292`). state·DOM 에는 안 남김 | 메인 | 렌더러가 WS 를 직접 여는 한 필요. 줄이려면 main 이 WS 를 프록시 (B5 게이트웨이 범위) |
| `auth-get-session` · 이벤트 `auth-session` | Supabase `access_token` + **`refresh_token`** | `supabase.auth.setSession()` (`useAuth.ts:37,58,90`) | 메인 | 렌더러의 supabase-js 가 세션 주인인 한 필요. main 이 주인이 되면 (B2) access_token 만 |
| `auth-save-session` (렌더러→main) | 회전된 토큰 쌍 | supabase-js 갱신분을 디스크에 미러 | 메인 | 위와 같음. **임의 세션 주입 가능** → uid 가 바뀌면 `getWorkspace()` 가 바뀐다 (§6) |
| ~~`get-auth-profiles`~~ **(해결 — §11 D5)** | ~~BYOK API 키 평문~~ → 마스크(끝 4자) | Settings 입력칸에 채움 (`SettingsPanel.tsx:755`, password 타입 + 눈 토글) | 메인 | **가능** — `{ hasKey, last4 }` 만 주고, 저장은 기존 `save-api-keys` (쓰기 전용) |
| ~~`get-channels`~~ **(해결 — §11 D5)** | ~~메신저 토큰 평문~~ → 마스크(끝 4자) | Settings 폼 state (`SettingsPanel.tsx:224`) | 메인 | **가능** — 마스킹해서 주고, 빈 값 = "변경 없음" 으로 저장 |
| `save-api-keys` · `save-channels` · `google-set-client` · `connections-set-token` · `mcp-upsert` (렌더러→main) | 사용자가 입력한 키 | 쓰기 전용 | 메인 | 입력 경로라 불가피 |
| `google-get-client` | clientId 만 (secret 은 안 줌) | 입력칸 prefill | 메인 | 이미 최소 |
| `connections-list` · `mcp-list` | 없음 (`connected`/`hasToken` bool) | — | 메인 | 이미 최소 |
| `get-openclaw-log` | 로그 (`maskSecrets` 적용) | Setup 화면 | 메인 | 이미 마스킹 |

main 밖으로 안 나가는 것 (확인만): OpenRouter 핸드아웃 키, Tavily 토큰, 툴 브릿지 Bearer, Execution Plan API 토큰 —
전부 main ↔ 게이트웨이 자식 프로세스 env / 상태 파일. 렌더러로 가는 IPC 없음.

## 5. 이번에 **막히는** 동작 (회귀 판단용)

정상 호출부(§1 의 src 열)는 전부 워크스페이스 상대경로거나 main 이 돌려준 경로라 영향 없음. 막히는 것:

1. 워크스페이스와 prefix 만 같은 형제 폴더 접근 (`…\users\abc` ↔ `…\users\abc-evil`, `logs/sessions-x`, `<projectRoot>-backup`).
2. **워크스페이스 안의 링크/junction 이 밖을 가리키는 경우** 그 너머의 읽기·쓰기·삭제·열기·reveal 전부. 링크가 안을 가리키면 그대로 된다.
   - 사용자가 일부러 `data/raw` 를 외장 드라이브로 junction 해 둔 경우가 **유일한 정상 사용 회귀 후보**. 앱은 링크를 만들지 않는다 (`symlink` grep 0건).
   - 대상이 없는 dangling 링크도 거부 (쓰면 링크 너머에 파일이 생긴다).
3. 루트 자체에 대한 파괴 연산: `delete-file('.')` / `delete-file(<ws 절대경로>)`, `move-file({from:'.'})`.
4. id·이름에 경로 구분자나 `.`·`..`: `plan|workflow|orchestration|aiagent-*`, `mr-*`, `install-skill`.
5. `guardrail-overwrite-redirect` 의 `originalRel` 이 워크스페이스 밖.
6. 디스크의 MR meta.json 에 `shared/` 밖 경로가 있으면 `mr-merge` 가 실패 (`invalid path`).
7. `open-external`: http · https · mailto 외 전부. 실제로 걸리는 호출부 —
   `LiveBrowserPreview` 의 "브라우저에서 열기" 가 `about:blank`·`chrome://`·`file://` 탭일 때 (조용히 무시),
   채팅 마크다운의 **상대 링크**·`tel:`·`ftp:` (무시), nodal 의 빈 `pricingUrl` (예전엔 reject, 이제 무시).
8. MCP OAuth: 서버가 http(s) 가 아닌 `authorization_endpoint` 를 주면 연결 실패.
9. `set-project-dir`: 대소문자만 바꾸거나 링크로 우회한 상태 폴더(`~/.openclaw*`) 경로.

반환 형태는 핸들러마다 기존 거부 분기 그대로 (`return` · `false` · `null` · `[]` · `{ ok:false }` · `{ ok:false, error }`).

## 6. sender / frame 검증이 필요한 채널 (leg 2 — 이번엔 기록만)

전 창이 같은 preload 를 쓰고 `ipcMain.handle` 은 `event.senderFrame` 을 보지 않는다. 우선순위:

| 등급 | 채널 | 이유 | 허용해야 할 창 |
|---|---|---|---|
| S | `get-gateway-token`, `auth-get-session`, `auth-save-session`, `get-auth-profiles`, `get-channels`, `save-api-keys`, `save-channels`, `connections-set-token`, `mcp-upsert`, `mcp-oauth-connect`, `google-set-client` | 비밀을 주거나 바꾼다 | 메인만 |
| S | `set-project-dir`, `set-twixy-mode`, `guardrail-set-config`, `guardrail-remove-allowlist-entry`, `designated-paths-set-config`, `set-project-config`, `claim-project-ownership` | 샌드박스 경계·가드레일 자체를 바꾼다 | 메인만 |
| S | `guardrail-popup-decide`, `guardrail-overwrite-redirect`, `test-overlay-review-decision` | **승인 결정.** 팝업 창만 보낼 수 있어야 하는데 지금은 어느 창이든 "approve" 를 위조할 수 있다 | guardrail 팝업 / test-overlay |
| A | §1 의 파일 채널 전부, `open-external`, `open-file`, `install-skill`, `delete-skill`, `mr-merge`, `*-delete` | 파일 변경·셸 | 메인만 |
| A | `overlay-send`, `overlay-start`, `overlay-stop`, `overlay-resume` | 에이전트에 메시지를 주입 | sidetab · composer |
| B | `twixy-enterprise-*` | 임의 폴더 읽기 | enterprise 빌드의 메인만 |
| B | `browser-preview:*` (`cdpPort` 를 렌더러가 지정) | 임의 로컬 포트에 CDP 연결 | 메인만 |

검증 방식 제안: `event.senderFrame.url` 의 origin+pathname 이 그 창의 entry (`file://…/dist/<entry>.html` 또는 dev 의
`http://localhost:5173/<entry>`) 와 같은지 + `event.sender === <그 창>.webContents`. 서브프레임은 거부.
`will-navigate` 가 이미 다른 origin 이동을 막고 있어 메인 프레임 URL 은 신뢰할 수 있다.

## 7. DECISIONS NEEDED

**D1 — 처리됨 (§11). 아래는 결정 당시의 기록이다.** `set-project-dir` 가 렌더러가 준 임의 절대경로를 받는다.
정상 흐름은 `pick-project-dir`(다이얼로그) → 렌더러 → `set-project-dir` 인데, 중간의 렌더러가 경로를 바꿔치기할 수 있다.
프로젝트 폴더가 곧 샌드박스 루트라서, 이게 뚫리면 §1 의 검사가 전부 "공격자가 고른 폴더 기준" 이 된다.
deny-list 는 Windows 에서 사실상 상태 폴더 하나만 막는다 (`/etc` 류 POSIX 리터럴은 Windows 에서 무의미, `C:\Windows` 없음).
- (a) **권장**: main 이 마지막 다이얼로그 결과를 기억하고 `set-project-dir` 는 그 값(또는 현재 값)과 일치할 때만 수락. 렌더러 변경 불필요, deny-list 도 필요 없어진다.
- (b) deny-list 를 OS 별로 보강 (`%SystemRoot%`, `%ProgramFiles%`, 홈 폴더 자체, 드라이브 루트 …). 끝이 없는 목록.
- (c) 현행 유지.

**D2 — 미결정. 여전히 열려 있다.** `twixy-enterprise-admin-load` / `-read-run` 이 임의 `projectRoot` 를 읽는다.
Enterprise admin 이 다른 프로젝트 폴더를 열람하는 기능이라 밖 접근 자체는 의도. 다만 (1) 일반 Twixy 빌드에도 등록돼 있고
(2) 경로가 렌더러 `localStorage` 에서 온다. 읽는 파일명은 고정(`plan.json`, `run.md`, 스킬 폴더)이라 피해 범위는 좁다.
- (a) **권장**: D1 과 같은 방식 — `twixy-enterprise-pick-folder` 로 고른 폴더들을 main 이 상태 파일에 기억하고 그 안만 허용. `uid`/`planId` 는 `safeSegment`.
  + `PRODUCT.features` 로 enterprise 빌드에서만 등록.
- (b) `uid`/`planId` 세그먼트 검사만 추가하고 projectRoot 는 현행.
- (c) 현행 유지.

**D3 — 처리됨 (§11). 아래는 결정 당시의 기록이다.** `open-file` 이 확장자 제한 없이 `shell.openPath` 한다.
에이전트는 워크스페이스 안에 `.bat`·`.lnk`·`.hta` 를 쓸 수 있고(designated 가드는 셸 경유 쓰기를 못 막는다), 호출부 하나는
LLM 출력에서 뽑은 경로를 그대로 넘긴다 → "Open" 클릭 한 번에 실행. 경계 검사로는 못 막는다.
- (a) **권장**: 문서류 확장자 allowlist (`shared/fileTypes.ts` 에 이미 분류가 있다) — 그 외는 `showItemInFolder` 로 대체.
- (b) 실행형 확장자 deny-list.
- (c) 현행 유지.

**D4. 워크스페이스 안 링크를 일부러 쓰는 사용자가 있나.** (§5-2) 있다면 "허용 링크 대상" 을 designated-paths 설정에 추가하는
방식으로 풀 수 있다. 없다고 보고 이번엔 전부 막았다. 되돌릴 필요가 있으면 `isInside` 한 곳만 고치면 된다.

## 8. 범위 밖 발견 (고치지 않음)

- **TOCTOU**: 검사와 사용 사이에 링크를 바꿔치면 통과한다. 같은 사용자 권한의 로컬 프로세스가 필요해 우선순위 낮음.
  제대로 막으려면 `O_NOFOLLOW` 류 fd 기반 I/O 가 필요 — Windows 에서는 현실적이지 않다.
- `browser-preview:*` 가 렌더러가 준 `cdpPort` 로 로컬 CDP 에 붙는다 (§6-B).
- `mr.ts:assertSharedPath` 는 문자열 검사만 한다 — `shared/` 안의 링크는 안 본다. 팀원은 어차피 공유 폴더 쓰기 권한이 있어 실익이 작다.
- `export-pdf*` / `pdf.ts` 가 렌더러·LLM 이 준 HTML 을 숨은 BrowserWindow 에 `data:` URL 로 로드한다 (preload 없음, 기본 sandbox).
  원격 리소스 로드는 가능 → 필요하면 `webRequest` 로 차단.
- `vitest.config.ts` 의 include 에 `electron/**` 이 없어 main 쪽 테스트가 0개였다 → 이번에 glob 한 줄 추가.

## 9. leg 1 결과 (이 문서를 쓴 뒤 실제로 들어간 것)

| commit | 종류 | 내용 |
|---|---|---|
| `16b8fc7` | 문서 | 이 inventory |
| `20bbc25` | 헬퍼+테스트 | `electron/trustBoundary.ts` — `isInside` · `realpathDeepest` · `isAllowedExternalUrl`. vitest include 에 `electron/**/*.test.ts` 추가 |
| `11e558a` | 헬퍼 | realpath native 실패 시 JS 구현으로 재시도 (RAM 디스크·가상 볼륨에서 전부 거부되는 걸 방지) |
| `7140add` | **동작 변경** | main.ts 22개 채널 · 검사 25곳을 `isInside` 로 기계적 교체. 루트 허용 여부는 기존 그대로 |
| `4153270` | **동작 변경** | `resolveInsideWorkspace` · `deckImages` — `tool-*` IPC 와 에이전트 툴 브릿지 공통 관문 |
| `e1165a3` | **동작 변경** | `delete-file` · `move-file(from)` 루트 거부 |
| `7434221` | **동작 변경** | `safeSegment` — id → 경로 49개 채널 + `install-skill` |
| `bb4c158` | **동작 변경** | `open-external` allowlist, `wireExternalLinks` 통일(동작 동일), MCP OAuth |
| `c023a63` | **동작 변경** | `export-pdf-to` 출력 경로, `guardrail-overwrite-redirect`, `set-project-dir` 상태 폴더 |
| `457a172` | **동작 변경** | `mergeMR` 경로 재검증 |
| `6dec8b1` | move-only (B1) | `electron/tray.ts` |
| `348c880` | move-only (B1) | `electron/authDeeplink.ts` + 테스트 11개 |
| `67ee0e0` | 문서 | 기준선 inventory 재생성 — 채널 집합 불변 |

### 자동 테스트가 덮는 것 / 못 덮는 것

덮는 것 (전부 OS temp 의 mkdtemp 폴더, 실제 junction 사용 — Windows 에서 skip 0건):
`isInside` · `realpathDeepest` · `isAllowedExternalUrl` · `safeSegment` · `resolveInsideWorkspace` · `resolveInsideDesignated` ·
`planning.ts` 의 삭제/읽기/쓰기 경로 · `mr.ts` 의 id/sha 경로와 `mergeMR` 재검증(mutation 확인) · `decodeJwtPayload` · `parseAuthDeeplink`.

**못 덮는 것: main.ts 안의 IPC 핸들러 본체.** main.ts 는 `electron` 을 import 하고 import 시점에 IPC 등록·프로세스 기동을
하므로 vitest 에 올릴 수 없다. 즉 "핸들러가 헬퍼를 **올바른 인자로** 불렀는가"(루트를 뭘로 줬는지, allowRoot 를 맞게 줬는지,
거부 시 반환 형태)는 코드 리뷰와 패키지 앱 수동 확인에 달려 있다. 해당 채널: §1-A 전부, `install-skill`,
`guardrail-overwrite-redirect`, `set-project-dir`, `open-external`. B6(IPC 재편)에서 핸들러를 electron 비의존 함수로
빼면 이 공백이 닫힌다.

## 10. leg 2 — 발신자(창) 검증과 CDP 포트 제한

§6 에 "leg 2 에서 할 것" 으로 적어 둔 것 중 상위 등급을 실제로 걸었다. 파일 채널(등급 A 의 나머지)은
아직 아니다 — 호출부가 많아 별도 leg.

### 10-1. 지금 강제되는 창 × 채널 (16개)

검사: `event.sender` 가 허용 창의 webContents 인가 · **메인 프레임**인가 · 프레임 URL 이 **그 창 자신의**
진입 페이지인가 (query·hash 무시). 판정은 순수 모듈 `electron/windowEntry.ts`, main.ts 의 `senderBlocked()`
는 Electron 이벤트에서 사실만 뽑아 넘기는 어댑터. 확인 불가(프레임 폐기 중 등)는 거부.

| 채널 | 허용 창 | 왜 | 거부 시 반환 |
|---|---|---|---|
| `guardrail-popup-decide` | guardrail | 승인 위조 | `{ok:false,error:'forbidden_sender'}` |
| `test-overlay-review-decision` | testOverlay | Human Review 위조 | `{ok:false,…}` |
| `guardrail-overwrite-redirect` | main | 승인창 결정을 메인이 받아 호출 | `{ok:false,…}` |
| `get-gateway-token` | main | 게이트웨이 토큰 | `null` |
| `auth-get-session` | main | access + refresh 토큰 | `null` |
| `get-auth-profiles` | main | BYOK API 키 (이제 마스크) | `null` |
| `get-channels` | main | 메신저 봇 토큰 (이제 마스크) | `{}` |
| `set-project-dir` | main | 샌드박스 루트 | `{ok:false,…}` |
| `set-twixy-mode` | main | LLM 키 출처 | `{ok:false,…}` |
| `guardrail-set-config` | main | 가드레일 mode·allowlist | `{ok:false,error,config:current}` |
| `designated-paths-set-config` | main | 에이전트 쓰기 허용 폴더 | `{ok:false,error,config:current}` |
| `overlay-send` · `-start` · `-resume` · `-stop` · `-toggle-plan-mode` | sidetab + composer | 에이전트 세션에 의도 주입 | `{ok:false,…}` |

허용 창은 각 창 entry 의 **import closure** 를 계산해 정했다 (그 창 번들에 호출부가 있는가).
사이드탭 closure 에 `useOpenClaw.ts` 가 잡히지만 `import type` 뿐이고, `useOpenClaw()` 호출은 `App.tsx:162`
하나다. 보조 창 4개의 closure 에 tier 2·3 채널의 호출은 0건.

일부러 안 건 것: `guardrail-remove-allowlist-entry` (권한을 **좁히는** 방향), `overlay-sync-push`(메인이 부름) ·
`overlay-request-sync` · `overlay-set-opacity` (상태 미러링·표시).

### 10-2. 진입 페이지의 단일 출처

창을 **여는 쪽**과 **검증하는 쪽**이 경로를 따로 계산하면 언젠가 어긋나고, 어긋나는 순간 정상 창이
거부된다 (패키지 앱에서 승인이 안 눌리거나 게이트웨이에 못 붙는다 — 구멍보다 나쁜 고장).
그래서 `windowEntry(kind, env)` 하나가 두 역할의 출처다:

- 로더: `createWindow` 등 5곳이 `loadWindowEntry(win, kind)` → 같은 함수의 결과로 `loadURL`/`loadFile`.
- 검증기: `senderBlocked` 가 같은 함수로 "이 창이 원래 여는 페이지" 를 만들어 프레임 URL 과 대조.

dev 는 `http://localhost:5173[/<html>]`, 패키지는 `<dist>/<html>`. 메인 창의 html 만 제품별
(`PRODUCT.htmlEntry`: `index.html` · `twixy-enterprise.html` · `products/nodal/index.html`), 보조 4개는 공통.
`file:` 비교는 URL 문자열이 아니라 **경로로 되돌려서** 한다 — 한글 사용자명·공백 든 앱 이름의
percent-encoding 차이로 정상 창을 거부하지 않도록. win32 는 대소문자 무시, NFC 정규화.

### 10-3. CDP 포트

`browser-preview:*` 7개는 `cdpPort` 를 payload 로 받아 `127.0.0.1:<port>` 에 붙는다. CDP 는 인증이 없어서
사용자가 디버그 포트로 띄워 둔 개인 브라우저에 붙으면 화면을 긁고 입력까지 넣을 수 있었다.
이제 `[PRODUCT.cdpPort, ...PRODUCT.workflowCdpPorts]` 만 (twixy 18800·18801~18803, nodal 18900).
값 없음 = 기존처럼 기본 포트. 밖이면 `{ok:false,error:'invalid_cdp_port'}`.

### 10-4. 새로 막히는 것

1. 보조 창에서의 승인·리뷰 결정 위조, 토큰·키 조회, 샌드박스 설정 변경.
2. 메인·guardrail·테스트 오버레이 창에서의 `overlay-*` 의도 주입.
3. 창이 자기 진입 페이지가 아닌 곳으로 이동한 뒤의 위 채널 호출, 서브프레임에서의 호출.
4. 제품이 쓰지 않는 CDP 포트로의 프리뷰 연결.
5. `safeSegment`: 끝이 점·공백인 id·이름(`'.. '`, `'x.'`) — Win32 정규화가 떼어 내 다른 경로가 된다.

**막지 못하는 것(그대로):** 메인 렌더러 자체가 장악되면 위 검증은 도움이 안 된다. 승인도 토큰도 결국
메인이 쥐고 있다. 이번에 막은 것은 **나머지 4개 창**을 통한 우회다.

### 10-5. 테스트가 덮는 것 / 못 덮는 것

`windowEntry.test.ts` 73개: dev/패키지 × 제품 3 × 창 5 × OS 2 × URL 표기 변형(소문자 드라이브, 경로
대소문자, 미인코딩 한글, 소문자 hex, query/hash)이 **전부 통과**하고, 다른 창 페이지·이웃 파일·다른
origin/호스트/드라이브/스킴·서브프레임·`about:blank`·`data:`·`chrome-error://` 는 거부. mutation 4종으로
표가 실제로 구별하는지 확인(대소문자 무시 제거 → 15 실패, pathname 무시 → 3, 메인프레임 검사 제거 → 1,
자기 진입 대신 아무 허용 창 진입과 대조 → 1).

**못 덮는 것은 §9 와 같다**: main.ts 의 핸들러 본체는 vitest 에 올릴 수 없다. "핸들러가 `senderBlocked` 를
올바른 창 목록으로 불렀는가", "실제 Electron 의 `senderFrame.url` 이 `windowEntry()` 와 정확히 같은가" 는
**패키지 앱에서만** 확인된다. 특히 `e.senderFrame.parent === null` 로 메인 프레임을 판정하는 부분과
`file:` URL 의 실제 표기는 런타임 확인이 필요하다.

## 11. 사용자 결정 반영 (D3 · D1 · D5)

`§7` 의 결정 항목 중 셋이 결정되어 들어갔다. **D2 는 미결정이라 손대지 않았다** — enterprise admin 의
`twixy-enterprise-admin-load` / `-read-run` 은 지금도 임의 `projectRoot` 를 읽는다.

### D3 — `open-file` 확장자 allowlist

경로가 워크스페이스 안이어도 "여는 것" 은 별개 문제다. `shell.openPath` 는 OS 연결을 타므로
Windows 에서 `.lnk`/`.bat`/`.js`/`.hta` 는 **실행**되고, 워크스페이스 내용물은 에이전트가 쓴 것이며,
호출부 하나(`WorkflowNodeCard`)는 LLM 출력에서 뽑은 경로를 그대로 넘긴다.

- 허용 목록 `OPENABLE_EXTS` (`shared/fileTypes.ts`): 문서·데이터·오피스·이미지·PDF. 목록에 없는 확장자와
  앞으로 생길 것 전부 거부 — deny-list 가 아니라 allowlist 인 이유.
- `.html`·`.svg` 는 포함. 기본 앱이 브라우저라 네이티브 실행이 아니고, 에이전트가 크롤한 페이지와
  우리가 굽는 리포트가 실제로 그 형식이다.
- 판정은 basename 의 마지막 점 뒤를 정확히 대조 — `evil.exe ` (끝 공백, Win32 가 떼어 냄),
  `x.pdf:evil.exe` (NTFS 대체 스트림), 확장자 없는 파일이 상위 폴더의 점에 걸리는 경우 모두 거부.
- 거부 사유는 **사용자에게 보인다** (호출부가 이미 alert/패널 메시지로 띄운다): 확장자와 함께
  "Reveal in Finder 로 직접 열라" 는 대안을 준다. 조용한 무시가 아니다.

### D1 — `set-project-dir` 는 다이얼로그가 돌려준 경로만

샌드박스 루트를 바꾸는 채널이라 여기가 뚫리면 나머지 경로 검사가 전부 "공격자가 고른 폴더" 기준이 된다.
leg 2 에서 **누가** 부르는지는 좁혔지만 **무엇을** 받는지는 그대로였다.

- `pick-project-dir` 가 돌려준 경로를 main 이 기억 → `set-project-dir` 는 그 값(또는 현재 값 = no-op)만 수락.
- 비교는 realpath 기반 `samePath` — junction 으로 고르거나 win32 대소문자·구분자가 달라도 같은 폴더면 통과.
- `pick-project-dir` 자체도 메인 창만 (다이얼로그가 곧 인가 수단이다). 거부는 취소와 같은 모양.
- **깨지는 흐름 없음**: 호출 경로는 `useProjectDir.pickAndSet` 하나뿐이고, 첫 실행은 이 채널을 타지 않는다
  (`getProjectRoot()` 가 기본 워크스페이스로 떨어진다). enterprise 는 별도 채널(D2).
- 기존 forbidden 목록은 남겼다 — 목적이 다르다(사용자 오조작 방지 vs 출처 위조 방지).

### D5 — 비밀값 마스킹

`get-channels`(메신저 토큰) · `get-auth-profiles`(BYOK 키)가 평문을 렌더러로 보내던 것을 마스크(끝 4자)로.

- 규칙은 `shared/secretMask.ts` 한 곳: **마스크 → 유지 · 빈 문자열 → 삭제 · 그 외 → 교체.**
  접두사 U+2022 는 ASCII 인 진짜 키와 절대 겹치지 않는다.
- **진짜 함정은 UI 쪽이다**: 마스크를 입력칸 `value` 에 넣으면 사용자가 뒤에 이어 붙일 수 있고, 그러면
  "안 바꿨다" 로 읽혀 새 키가 조용히 무시된다. 그래서 마스크일 때 칸은 비우고 안내는 placeholder 로,
  지우기는 별도 `clear` 버튼으로 분리했다. 한 글자라도 입력하면 그게 곧 새 값이다.
- 필드 배선은 타입검사가 못 잡아서(`slack.appToken` → `botToken` 오배선도 컴파일 통과) 마스킹 함수를
  `electron/channelSecrets.ts` 로 분리해 테스트한다. mutation 3종으로 검출력 확인.
- 남은 평문 경로: `save-api-keys` · `save-channels` · `connections-set-token` · `mcp-upsert` ·
  `google-set-client` 은 **입력** 방향이라 불가피하다. `auth-get-session`(access+refresh 토큰)과
  `get-gateway-token` 은 렌더러가 실제로 그 값을 써야 해서 마스킹 대상이 아니다 — 줄이려면 B2/B5
  (main 이 세션·WS 를 쥐는 구조)가 필요하다.
