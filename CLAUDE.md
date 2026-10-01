# CLAUDE.md — Twixy 개발 하네스

> 이 파일은 **개발 도구 Claude Code**용이다. 제품 런타임(OpenClaw)의 서브에이전트 라우팅은 `AGENTS.md`, 시스템 프롬프트는 `SOUL.md`를 본다 — 혼동하지 말 것.

## 하네스: Twixy 개발 (Electron + React 마케팅 코파일럿)

**목표:** Electron main ↔ renderer IPC 경계와 LLM↔툴브릿지 경계에서 발생하는 정합성 버그를 막으며 기능을 안전하게 개발한다.

**트리거:** Twixy 개발 작업(기능 추가/수정, 에이전트 툴 추가, IPC, React 패널/훅, .tskill 제품 스킬 저작, 경계면 QA) 요청 시 `twixy-dev` 스킬을 사용하라. 후속 요청(다시 실행/보완/이 부분만 다시)도 포함. 단순 질문·단일 파일 조회는 직접 응답 가능.

**핵심 리스크(왜 하네스인가):** 에이전트 툴 추가는 `내부함수→IPC핸들러→브릿지핸들러→openclaw패치(patch-package)→preload→global.d.ts` **6지점**을 모두 거쳐야 한다. 하나라도 빠지면 "LLM에게 보이지 않는 툴" 또는 렌더러 타입 오류. 상세: `docs/ADDING_A_NEW_AGENT_TOOL.md`.

**제품 변형(한 레포, 여러 제품):** `APP_MODE=twixy|twixy-enterprise|nodal` 로 빌드 대상을 고른다. 제품마다 다른 값(appId·포트·상태 폴더·Supabase·웹 URL·켜진 기능)은 **`products/<id>/profile.ts` 에만** 적는다 — 코어(`electron/`·`src/`·`shared/`)에 리터럴로 적거나 제품 id 로 분기하지 않는다. 코어는 `shared/product/current.generated`(빌드 시 `scripts/write-product.ts` 가 생성)의 `PRODUCT` 만 읽는다. `products/nodal/` 은 Nodal 팀 소유, 그 밖은 Twixy 팀. `npm run check:boundary` 가 강제한다.

**구성:** 에이전트 5종(`.claude/agents/`) + 전문 스킬 5종 + 오케스트레이터 1종(`.claude/skills/`). 상세 로스터·데이터 흐름은 `twixy-dev` 스킬이 관리한다.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-07-03 | 초기 구성 (에이전트 5 + 스킬 5 + 오케스트레이터 1) | 전체 | 하네스 최초 구축 |
| 2026-09-18 | 제품 프로필 도입 + `products/` 폴더 + 경계 검사 | 전체 | Nodal(영상 생성 B2C) 스핀오프를 같은 레포 빌드 변형으로 |
