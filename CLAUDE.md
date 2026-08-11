# nodal

로컬 실행형 노드 기반 이미지 생성 워크스테이션. ComfyUI와 유사한 도구를 처음부터 다시 설계한다.

---

## 🚫 절대 규칙 — 위반 시 프로젝트 전체가 망가짐

### 1. ComfyUI 코드를 절대 복사하지 않는다

ComfyUI(`Comfy-Org/ComfyUI`)는 **GPL-3.0**이다. 코드를 복사·각색하면 nodal 전체가 GPL-3.0으로 강제되고, 되돌릴 수 없다. **nodal의 라이선스는 아직 미정이며, 모든 선택지를 열어두는 것이 현재 최우선 제약이다.**

| 허용 | 금지 |
|---|---|
| ComfyUI 소스를 읽고 아키텍처·알고리즘을 이해하는 것 | 함수·클래스를 복사해서 이름만 바꾸는 것 |
| "출력 노드 우선 위상 정렬"같은 **아이디어**를 직접 구현 | 코드 구조를 그대로 따라 치는 것 |
| `docs/design.md`의 서술을 보고 백지에서 구현 | ComfyUI 파일을 열어놓고 보면서 옮겨 쓰는 것 |

**특히 위험한 파일** (여기서 가져오고 싶은 유혹이 가장 큼):
`comfy/model_management.py`, `comfy/ldm/**`, `execution.py`, `comfy_execution/caching.py`

**구현 시 원칙**: 필요한 개념은 이미 `docs/design.md`에 서술되어 있다. 그 문서를 스펙으로 삼아 구현하라. ComfyUI 저장소를 clone하거나 파일을 fetch할 필요가 없다. 정말 필요하면 먼저 사용자에게 물어보고, `NOTICE-provenance.md`에 기록하라.

### 2. 라이선스 파일을 만들지 않는다

LICENSE 파일은 M3 이후 사용자가 직접 결정한다. `pyproject.toml` / `package.json`의 `license` 필드는 비워두거나 `"LicenseRef-UNDECIDED"`로 둔다. 임의로 MIT 등을 넣지 말 것.

### 3. 저장소는 비공개 전제

공개 배포용 문구(배지, 기여 가이드, 공개 URL)를 미리 만들지 않는다.

---

## 기술 스택

| 영역 | 선택 |
|---|---|
| 백엔드 | Python 3.11+, FastAPI, uvicorn, pydantic v2 |
| 패키지 관리 | `uv` (Python), `pnpm` (JS) |
| 프론트엔드 | Vite + React 18 + TypeScript |
| 노드 캔버스 | `@xyflow/react` (React Flow, MIT) |
| 상태 | Zustand + Yjs (undo/redo) |
| Diffusion | `diffusers` (Apache-2.0) — **모델을 직접 구현하지 않는다** |
| 린트/포맷 | `ruff` (Python), `eslint` + `prettier` (JS) |
| 테스트 | `pytest`, `vitest` |

의존성은 전부 허용적 라이선스(MIT/Apache-2.0/BSD)로 유지한다. GPL/AGPL 의존성을 추가하지 말 것.

---

## 아키텍처 — 의존성 규칙

```
apps/web            →  packages/server  →  packages/core
packages/nodes-*    →  packages/core
```

**절대 위반 금지**

- `packages/core`는 **torch를 import하지 않는다.** 도메인 중립 그래프 엔진이다.
- `packages/core`는 `server`나 노드 패키지를 import하지 않는다.
- 순환 import 없음. (ComfyUI가 `nodes.py` ↔ `execution.py` ↔ `server.py`에서 겪는 문제를 피하는 것이 목적)
- torch는 오직 `packages/nodes-diffusion`에서만 등장한다.

---

## 핵심 설계 결정 (변경 시 사용자 확인 필요)

1. **캐논 그래프 포맷은 하나.** 실행용/UI용 포맷을 분리하지 않는다. UI 상태는 같은 문서의 `ui` 필드에 격리하고 백엔드는 무시한다.
2. **소켓 타입은 구조화된 서술자.** 자유 문자열(`"IMAGE"`)이 아니다. 와일드카드는 1급 `Any` 타입이지 해킹이 아니다.
3. **노드 스키마는 선언형 + 타입 힌트.** 딕셔너리-튜플 스키마를 쓰지 않는다.
4. **노드 ID는 UUID.** 순번 문자열(`"3"`, `"7"`)이 아니다.
5. **캐시 키는 입력 시그니처 기반.** 노드 ID 기반이 아니다.
6. **모델 계층은 `diffusers`에 위임.** 직접 구현하지 않는다.

상세 근거는 `docs/design.md` §1, §4 참조.

---

## 현재 단계

**M0 — 뼈대.** 모노레포 스캐폴딩, 툴링, CI, 캐논 그래프 pydantic 모델.

다음 단계와 완료 기준은 `docs/roadmap.md` 참조. 마일스톤을 건너뛰지 말 것 — 특히 **M1(실행 엔진)은 UI도 GPU도 없이 CLI만으로 완성**해야 한다. 여기서 프로젝트의 성패가 갈린다.

---

## 코딩 컨벤션

- Python: 타입 힌트 필수. `ruff` 기본 규칙 준수. 함수는 짧게, 부수효과는 명시적으로.
- 노드 실행 함수(`run`)는 **평범한 함수 시그니처**를 유지한다. 엔진 객체 없이 단위 테스트가 가능해야 한다.
- 타입 호환성 규칙은 `types.json` 단일 소스에 정의하고 Python/TS 양쪽에서 로드한다. **규칙을 두 번 쓰지 않는다.**
- 에러는 항상 **어느 노드의 어느 소켓**인지 지목한다. 익명 에러 금지.
- 커밋은 `Signed-off-by` (DCO) 포함.

## 테스트 원칙

M1 실행 엔진은 다음 케이스를 **명시적 테스트로 고정**한다. 이 셋이 상호작용하며 버그가 나는 것이 이 프로젝트의 최대 기술 리스크다.

- 사이클 탐지 / 다이아몬드 의존성
- 캐시 무효화 전파 (입력 하나 변경 → 하위만 재실행)
- 실행 중 취소
- lazy 입력 + 노드 확장 + 캐시가 겹치는 경우

---

## 문서

| 파일 | 내용 |
|---|---|
| `docs/design.md` | 아키텍처, 데이터 모델, 실행 엔진, API 스펙 — **구현 스펙** |
| `docs/roadmap.md` | M0~M6 마일스톤과 완료 기준 |
| `docs/license.md` | 라이선스 선택지와 미결정 상태의 근거 |
| `NOTICE-provenance.md` | 외부 프로젝트 참조 기록 — 참조할 때마다 추가 |
