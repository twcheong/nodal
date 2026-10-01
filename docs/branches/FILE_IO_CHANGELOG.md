# `feature/file-io` — Branch Change Log

> **Scope:** Local document I/O — Write PDF, Read/Write Excel, Make PPTX.
> **Branch base:** `feature/twixy-enterprise` HEAD `88dd9a7` (2026-04-25).
> **Parent in stack:** none (this is Phase 1 of 3).
> **Child in stack:** `feature/google-workspace`.
>
> **Update rule:** Append a new section **before every `git push`** with the exact files/handlers/skills changed in that push. End each entry with the 7-char commit hash so `git show <hash>` recovers full context. Do **not** touch `TWIXY_ENTERPRISE_CHANGELOG.md` from this branch — that file is reserved for Twixy/Twixy Enterprise shared-branch work.
>
> **Entry template:**
> ```markdown
> ## YYYY-MM-DD — <short title> (commit <hash7>)
>
> ### 추가된 파일
> - `path/to/foo.ts` — 1-2줄 역할 설명
>
> ### 수정된 파일
> - `path/to/bar.ts`
>   - 추가/변경된 함수·핸들러·prop 단위로 bullet
>   - 동작 변화의 *이유* 한 줄
>
> ### 신규 IPC / 툴 / 스킬
> - `tool-write-pdf` (electron/tools/files/pdf.ts) — `{ relPath, payload }` → `{ relPath, bytes }`
>
> ### 검증
> - 어떤 명령으로 어떤 결과를 확인했는지 한두 줄
> ```

---

<!-- New entries go below, newest on top. -->

## 2026-04-25 — 초기 셋업: PDF/Excel/PPTX 코어 툴 + report-pack 스킬 (commit `a8ff200`)

### 추가된 파일
- `electron/tools/files/pdf.ts` — 구조화된 블록 배열을 받아 Chromium offscreen `printToPDF` 로 PDF 생성. 한글 글리프 위해 fontkit/외부 폰트 대신 Electron 내장 렌더러 재사용 (기존 `export-pdf` 핸들러와 동일 전략).
- `electron/tools/files/xlsx.ts` — `exceljs` 기반. `writeXlsx` 는 시트별 첫 행을 헤더로 굵게 처리 + 컬럼폭 자동조정. `readXlsx` 는 기본 200행 캡 + 잘림 표시.
- `electron/tools/files/pptx.ts` — `pptxgenjs` 기반. `LAYOUT_WIDE`, slide kind: `title|bullets|text|image|table`. accent 기본값은 Twixy 보라 `#7C6AFF`.
- `electron/tools/files/safePath.ts` — 워크스페이스 외부 경로(`/`, `~`, `../` 트래버설) 차단하는 단일 헬퍼. `tool-*` 핸들러 4개가 공유.
- `skills/report-pack/report-pack.tskill` — 한 인사이트를 PDF + XLSX + PPTX 세 포맷 동시 발행하는 워크플로우 스킬. 컴파일 결과 `SKILL.md` 는 워크스페이스 watcher가 자동 생성.
- `docs/branches/FILE_IO_CHANGELOG.md` — 본 문서 (브랜치별 푸시 로그 규칙 도입).

### 수정된 파일
- `electron/main.ts`
  - 상단 import 4종 추가 (`writePdf`, `readXlsx`/`writeXlsx`, `writePptx`, `resolveInsideWorkspace`).
  - `// ── Document tools (file-io)` 섹션 신설: `tool-write-pdf`, `tool-write-xlsx`, `tool-read-xlsx`, `tool-write-pptx` 4개 IPC 핸들러. 모두 `{ ok, relPath, bytes }` (또는 `{ ok:false, error }`) 반환으로 시그니처 통일 — Phase 3 dashboard 가 단일 모양으로 메타 소비할 수 있도록.
  - 동작 변화 이유: 마케팅 산출물 자동화 파이프라인의 "출력" 구간이 비어있던 것을 메우기 위함.
- `electron/preload.ts`
  - contextBridge 에 `tools: { writePdf, writeXlsx, readXlsx, writePptx }` 네임스페이스 추가.
  - 기존 평탄한 IPC 표면과 분리한 이유: 새 툴군은 LLM 이 직접 호출할 가능성이 높아 네임스페이스로 묶어 식별성 확보.
- `src/global.d.ts`
  - `TwixyAPI` 에 `tools` 멤버 추가.
  - `TwixyToolResult`, `TwixyWritePdfPayload`, `TwixyWriteXlsxPayload`, `TwixyReadXlsxResult`, `TwixyWritePptxPayload` 등 페이로드 타입 신설 — `electron/tools/files/*` 의 export 와 동치.
- `package.json` / `package-lock.json`
  - dependencies: `pdf-lib`, `exceljs`, `pptxgenjs` 추가. (pdf-lib 는 v1 에서는 미사용이지만 Phase 추후 PDF 머지/폼필링 작업 대비 유지.)

### 신규 IPC / 툴 / 스킬
- `tool-write-pdf` (electron/tools/files/pdf.ts) — `{ relPath, payload: { title?, blocks } }` → `{ ok, relPath, bytes }`
- `tool-write-xlsx` (electron/tools/files/xlsx.ts) — `{ relPath, payload: { sheets } }` → `{ ok, relPath, bytes }`
- `tool-read-xlsx`  (electron/tools/files/xlsx.ts) — `{ relPath, maxRowsPerSheet? }` → `{ ok, relPath, sheets[] }`
- `tool-write-pptx` (electron/tools/files/pptx.ts) — `{ relPath, payload: { title?, accent?, slides } }` → `{ ok, relPath, bytes }`
- 스킬: `report-pack` — 위 3개 툴을 묶어 한 인사이트를 PDF+XLSX+PPTX 동시 발행. signal `report_pack_ready` 발화.

### 검증
- `npx tsc -p tsconfig.electron.json --noEmit` → 0 에러.
- `npx tsc -p tsconfig.electron.json` → `dist-electron/tools/files/{pdf,xlsx,pptx,safePath}.js` 정상 emit.
- `npx tsc -p tsconfig.json --noEmit` → 본 변경에서 새 에러 0건. 기존 4건(ChatPanel duplicate styles, DashboardPanel `M`, SkillsPanel `getSkillStats`, useOpenClaw `usdActual`) 은 base `feature/twixy-enterprise @ 88dd9a7` 에 이미 존재하던 프리-existing 이슈.
