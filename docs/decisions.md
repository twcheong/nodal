# 설계 결정 로그

에이전트가 `AGENTS.md`의 "핵심 설계 결정" 범위를 벗어나는 판단을 내렸을 때 여기에 한 줄 남긴다.
**두 에이전트가 서로에게 남기는 유일한 비동기 메시지 채널이다.**

## 기록 형식

```
### YYYY-MM-DD · <에이전트> · <영역>
- **결정**: 
- **이유**: 
- **영향 범위**: (어떤 파일/모듈)
- **되돌릴 수 있나**: 예 / 아니오 — 이유
```

## 언제 기록하나

| 기록한다 | 기록 안 한다 |
|---|---|
| `AGENTS.md` 핵심 설계 결정 6개에서 벗어남 | 평범한 구현 세부사항 |
| 인터페이스(`types.json`, 그래프/API 스키마) 변경 | 내부 함수 리팩터링 |
| 다른 에이전트의 코드를 대폭 재작성 | 오타·포맷 수정 |
| 스펙(`docs/design.md`)이 모호해서 임의 해석 | 스펙대로 구현 |
| 의존성 추가 | 이미 있는 의존성 사용 |

## 언제 기록 대신 **사용자에게 물어보나**

- 라이선스 관련 무엇이든
- ComfyUI 소스를 봐야겠다는 판단
- `types.json` · 캐논 그래프 스키마 · API 스키마 변경
- 마일스톤 순서 변경

---

## 기록

### 2026-08-11 · (초기) · 프로젝트 설정
- **결정**: `AGENTS.md`를 공용 헌법으로 두고 `CLAUDE.md`는 `@AGENTS.md` import + Claude 전용 메모만 유지
- **이유**: Codex는 `AGENTS.md`를, Claude Code는 `CLAUDE.md`를 읽는다. 규칙을 양쪽에 복사하면 반드시 어긋난다
- **영향 범위**: `AGENTS.md`, `CLAUDE.md`
- **되돌릴 수 있나**: 예

<!-- 새 항목을 이 아래에 추가 -->

### 2026-08-13 · Claude Code · M0
- **결정**: M0를 `AGENTS.md` 도입 이전 문서 세트로 단독 진행
- **이유**: 멀티 에이전트 구성 전에 스캐폴딩이 먼저 필요했음
- **영향 범위**: 저장소 전체 초기 구조
- **되돌릴 수 있나**: 예

### 2026-08-13 · Claude Code · M1 계약 (사용자 확인 후 확정)

`docs/design.md`가 답을 주지 않는 지점 4개를 **사용자에게 물어 확정**했다. 임의 해석하지 않았다.

- **출력 소켓 이름**: `returns = {"image": Image}` 딕셔너리 + 축약형(`returns = Image`) 병행.
  §4.1의 링크가 출력을 이름으로 참조하는데 §4.2의 `returns = Image`에는 이름이 없었다.
  축약형의 이름은 타입 이름을 소문자로 파생(`(Model, CLIP, VAE)` → `model`, `clip`, `vae`).
- **`types.json` 범위**: 호환 규칙 + 내장 타입 카탈로그. 규칙만 담으면 타입 정의가 Python/TS
  양쪽에 생겨 "규칙을 두 번 쓰지 않는다"가 무너진다.
- **§4.3에 없던 호환 규칙**: Union 넓힘/좁힘, List 공변, Tensor dtype·랭크, Any 양방향을
  확정하고 `design.md` §4.3 표에 행으로 추가했다.
- **`ctx` 주입**: `run` 시그니처에 `ctx` 파라미터가 있을 때만 주입(이름 옵트인).
  §4.2의 ctx 없는 예제와 §9의 ctx 있는 예제가 둘 다 그대로 유효하다.

**영향 범위**: `docs/design.md` §4.2·§4.3, `packages/core/src/nodal/types.json`,
`nodal/{types,schema,registry,executor,cache,events}.py`, `apps/web/src/graph/typesystem.ts`
**되돌릴 수 있나**: 아니오 — 다른 에이전트가 이 시그니처로 테스트를 작성하면 양쪽이 함께 깨진다.
바꾸려면 사용자 확인이 필요하다 (AGENTS.md 협업 규칙 7).

### 2026-08-13 · Claude Code · `nodal.Any` 이름 유지 + star import 금지

- **결정**: `nodal.Any` 이름을 그대로 둔다 (`design.md` §4.3 이 규정한 1급 와일드카드 타입).
  대신 `pyproject.toml` 의 ruff select 에 `F403`·`F405` 를 이름으로 명시해 star import 를 막는다
- **이유**: 이 이름의 실제 위험은 하나뿐이다 — 노드 저자가 `from nodal import *` 를 하면
  `typing.Any` 가 조용히 가려진다. star import 를 막으면 그 경우가 사라지므로, 이름을
  바꾸는 것보다 싼 방어다. (`F403`/`F405` 는 원래 `"F"` 에 포함돼 이미 동작하고 있었다.
  나중에 select 를 좁힐 때 방어가 조용히 사라지지 않도록 이름으로 남긴 것이다.)
- **영향 범위**: `pyproject.toml` ruff 설정. 코드 변경 없음
- **되돌릴 수 있나**: **예 — M6 전까지는 순수 rename 이다.**
  지금 `nodal.Any` 를 쓰는 곳은 이 저장소 안뿐이라, 이름을 바꾸려면 저장소 전체를
  한 번 치환하면 끝난다. 되돌릴 수 없게 되는 시점은 **외부 확장이 등장하는 M6** 이다 —
  그때부터는 남의 노드 팩이 이 이름을 import 하고 있으므로 rename 이 파괴적 변경이 된다.
  **즉 지금 확정할 필요가 없다.** M6 전에 다시 판단하면 된다

- **📌 노드 저작 가이드(M6)에 넣을 항목**: "`nodal.Any` 와 `typing.Any` 가 둘 다 필요하면
  둘 중 하나를 별칭으로 import 한다 (`from typing import Any as TypingAny`).
  `from nodal import *` 는 쓰지 않는다 — 린트가 거부한다."
  core 내부는 이미 이 방식을 쓰고 있다 (`nodal/types.py`, `nodal/schema.py`)

### 2026-08-13 · Claude Code · 계약 커밋의 구현 경계

- **결정**: `types.py`(+`types.json`, TS 로더)는 **구현**하고, `schema`·`registry`·`executor`·
  `cache`·`events`는 시그니처만 두고 본문을 `NotImplementedError`로 남겼다
- **이유**: 지시는 "본문 구현 금지"였지만 [B]는 "Python 로더와 TS 로더가 같은 파일을 읽고
  양쪽 판정이 일치하는지 확인하는 테스트"를 요구했다. 판정을 내지 못하는 스텁 로더로는
  일치를 검증할 수 없다. 그래서 타입 시스템만 동작하게 하고 나머지는 계약으로 남겼다
- **영향 범위**: `packages/core/src/nodal/types.py`, `apps/web/src/graph/typesystem.ts`
- **되돌릴 수 있나**: 예

### 2026-08-13 · Claude Code · errors.py 에 IssueCode 추가

- **결정**: 완성된 `errors.py`에 `IssueCode` 멤버 6개를 **추가만** 했다
  (`UNKNOWN_NODE_TYPE`, `UNKNOWN_INPUT_SOCKET`, `UNKNOWN_OUTPUT_SOCKET`,
  `MISSING_REQUIRED_INPUT`, `TYPE_MISMATCH`, `CYCLE`). 기존 이름·시그니처는 건드리지 않았다
- **이유**: 레지스트리를 알아야 판정할 수 있는 문제들(타입 불일치 등)에 두 번째 이슈 체계를
  만들면 프론트가 두 가지 에러 모양을 다뤄야 한다. 이슈 어휘는 하나여야 한다
- **영향 범위**: `packages/core/src/nodal/errors.py`
- **되돌릴 수 있나**: 예

### 2026-08-13 · Claude Code · 문서 동기화
- **결정**: 코드·문서에 남아 있던 `CLAUDE.md` 규칙 참조를 전부 `AGENTS.md` 참조로 교체하고,
  `docs/dev.md`가 복사해 두었던 규칙 문구(요구 버전 표 · 의존성 방향)를 삭제해 참조로 대체
- **이유**: 규칙이 `AGENTS.md`로 이동했는데 참조는 `CLAUDE.md`를 가리키고 있었다.
  Codex는 `CLAUDE.md`를 읽지 않으므로 이 참조들은 Codex에게 막다른 길이다.
  실제로 복사본은 이미 어긋나 있었다 — `dev.md`가 pnpm 10+를 요구한다고 적어둔 사이
  저장소는 pnpm 11.21로 고정됐고, 의존성 방향 설명은 화살표가 뒤집혀 있었다
  ("core는 그 누구도 import 하지 않는다" → 실제로는 모두가 core를 import 한다)
- **영향 범위**: `docs/dev.md`, `docs/design.md`, `docs/license.md`,
  `pyproject.toml`, `packages/core/src/nodal/{__init__,errors}.py`,
  `apps/web/src/graph/schema.ts`, `.github/workflows/ci.yml`
- **되돌릴 수 있나**: 예
