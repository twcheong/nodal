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

### 2026-08-13 · Claude Code · M2 서버 구현 — 합성 지점과 인메모리 에셋

- **결정 1 (합성 지점)**: `create_app(registry)` 로 레지스트리를 **주입받는다.**
  `packages/server` 는 어떤 노드 팩도 import 하지 않는다. 둘을 붙이는
  `nodal serve` 는 노드 팩 CLI 에 두고, `nodal-nodes-core[serve]` 선택적 extra 로
  `nodal-server` 를 건다
- **이유**: AGENTS.md 의 의존성 화살표는 `server → core`, `nodes-* → core` 두 개뿐이다.
  서버가 노드 팩을 알면 §8 의 플러그인 구조가 처음부터 무너진다. 반대로 노드 팩이
  서버를 **필수로** 의존해도 같은 문제라, 필수가 아닌 extra 로 뒀다
- **결정 2 (에셋)**: `POST/GET /api/assets` 를 인메모리 저장소로 구현했다
- **이유**: 계약상 M2 엔드포인트지만 `AssetStore` 의 제대로 된 설계는 M3 다
  (roadmap M3). 지금 디스크 레이아웃을 정하면 M3 가 그것을 물려받게 되므로,
  엔드포인트가 실제로 동작하는 데까지만 하고 저장 방식은 M3 에 넘긴다
- **영향 범위**: `packages/server/src/nodal_server/{app,assets}.py`,
  `packages/nodes-core/{pyproject.toml,src/nodal_nodes_core/cli.py}`
- **되돌릴 수 있나**: 예

### 2026-08-13 · Claude Code · WS 브로드캐스트 — 느린 구독자는 이벤트를 잃는다

- **결정**: 구독자마다 유한 버퍼(256)를 두고, 차면 **가장 오래된 이벤트를 버린다.**
  `EventHub.emit` 은 절대 블록하지 않고 절대 예외를 던지지 않는다
- **이유**: core 의 `EventSink.emit` 은 동기이고 실행 루프 한가운데서 불린다.
  여기서 네트워크를 기다리면 느린 클라이언트 하나가 노드 실행을 멈춘다.
  잃어도 되는 이유는 놓친 클라이언트가 `GET /api/runs/{id}` 로 최종 상태를 다시
  얻을 수 있기 때문이다 — `RunDetail` 에 `executed`·`cached` 를 둔 것이 이 설계와 짝이다
- **영향 범위**: `packages/server/src/nodal_server/hub.py`
- **되돌릴 수 있나**: 예 — 버퍼 크기와 축출 방향은 상수 하나다

### 2026-08-13 · Claude Code · M2 API 계약 (사용자 확인 후 확정)

`docs/design.md` §6 이 답을 주지 않는 지점 4개를 **사용자에게 물어 확정**했다. 임의 해석하지 않았다.
확정 내용은 `design.md` §6 에 반영했고 `schemas/openapi.json` 이 산출물이다.

- **`OutputRef` 도입**: §6 이 `node.done`의 `outputs: OutputRef[]`를 약속했지만 `OutputRef`가
  문서 어디에도 정의된 적이 없었다. `{socket, type, inline?, asset?}`로 확정 — 값이 아니라
  참조다. M3에서 이미지가 오면 WS로 메가바이트를 흘릴 수 없기 때문이다.
- **모든 이벤트에 `run_id`**: §6의 TS 정의는 `run.started`·`node.started`에만 `run_id`가
  있었다. `/ws`가 전역 스트림이므로 나머지도 필요하다 (`queue`만 예외 — 실행에 속하지 않는다).
- **에러 응답 형식**: §6에 아예 없었다. HTTP 상태 + `{error: {code, message, issues[]}}`.
  `issues[]`는 M1 `GraphIssue`를 그대로 직렬화해 에러 어휘를 하나로 유지한다.
  단 `POST /api/graph/validate`는 무효한 그래프도 200 — 검증은 질의이지 명령이 아니다.
- **실행 상태 5개**: `queued`·`running`·`succeeded`·`failed`·`cancelled`.
  `GET /api/runs` → `{running, queued[], history[], limit}`.

**영향 범위**: `docs/design.md` §6, `packages/server/src/nodal_server/{schemas,app}.py`,
`packages/core/src/nodal/events.py`(M1 이벤트 변경), `tools/export_openapi.py`,
`schemas/openapi.json`, `apps/web/src/api/*`
**되돌릴 수 있나**: 아니오 — M2 프론트를 다른 에이전트가 이 산출물로 작성한다.
바꾸려면 사용자 확인이 필요하다 (AGENTS.md 협업 규칙 7).

### 2026-08-13 · Claude Code · M1 이벤트를 M2 계약에 맞춰 변경

- **결정**: 완성된 `nodal/events.py`의 이벤트에 `run_id`를 추가하고 `NodeDone.outputs`를
  `Mapping[str, Any]` → `tuple[OutputRef, ...]`로 바꿨다. M1 시그니처 동결의 예외다
- **이유**: 위 M2 계약 결정이 요구한다. 서버가 core 이벤트를 번역하지 않고 직렬화만 하므로
  (변환 레이어 없음), 전송 형태가 바뀌면 core 이벤트도 바뀌어야 한다. 서버에서만 변환하는
  선택지도 사용자에게 제시했으나 채택되지 않았다
- **확인**: Codex의 M1 테스트 80개는 `node_ids(NodeDone)`와 `RunResult.outputs`만 보므로
  영향이 없었다. 변경 후 80개 전부 통과를 확인했다. `RunResult`는 **바꾸지 않았다** —
  엔진 내부 결과이지 전송 형태가 아니다
- **영향 범위**: `packages/core/src/nodal/{events,executor}.py`,
  `packages/nodes-core/src/nodal_nodes_core/cli.py`
- **되돌릴 수 있나**: 예 — 다만 M2 계약과 함께 되돌려야 한다

### 2026-08-13 · Claude Code · mypy 검사 범위를 전 패키지로 확대

- **결정**: `packages = ["nodal"]` → `["nodal", "nodal_server", "nodal_nodes_core"]`
- **이유**: 위 이벤트 변경이 CLI를 깨뜨렸는데 (`event.outputs.items()`) 테스트가 CLI를
  다루지 않아 아무도 잡지 못했다. 범위를 넓히자마자 mypy가 즉시 지목했다.
  계약 파일이 늘어날수록 타입 검사 범위가 좁은 것이 위험해진다
- **영향 범위**: `pyproject.toml`
- **되돌릴 수 있나**: 예

### 2026-08-13 · Claude Code · 캐시 해시를 blake3 대신 blake2b 로

- **결정**: `design.md` §5.3 은 `blake3(...)` 라고 적혀 있지만 표준 라이브러리의
  `hashlib.blake2b` (digest_size=16) 를 쓴다
- **이유**: `blake3` 는 Rust 확장 의존성이다. `packages/core` 의 런타임 의존성은
  현재 `pydantic` 하나뿐이고, 도메인 중립 그래프 엔진을 유지하려면 이 목록이
  짧을수록 좋다. 캐시 키는 암호학적 보증이 필요 없다 — 필요한 것은 결정성과
  충돌 회피뿐이고 blake2b 로 충분하다. 속도 차이는 노드 실행 시간에 묻힌다
- **영향 범위**: `packages/core/src/nodal/cache.py`
- **되돌릴 수 있나**: 예 — `cache_key` 안의 한 줄이다. 다만 바꾸면 기존 캐시가
  전부 무효가 된다 (키가 달라지므로). 인메모리 캐시라 실질 영향은 없다

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

### 2026-08-13 · Codex · M1 테스트 스펙 모호
- **결정**: Union→Union은 각 source 멤버가 target Union의 멤버 중 하나에 호환되면
  허용하는 집합 포함 의미로 테스트한다. 즉 `Union[INT, STRING] → Union[FLOAT, STRING]`은
  허용하고 역방향은 거부한다. 이 기대값을 `design.md` §4.3만 보고 먼저 작성한 뒤
  `types.json` conformance와 대조했으며 불일치는 없었다.
- **이유**: §4.3은 source Union에는 `all`, target Union에는 `any`라고 각각 설명하지만 양쪽이
  모두 Union일 때 어느 규칙을 먼저 적용할지는 쓰지 않았다. target 규칙을 바깥에서 먼저
  적용하면 위 안전한 연결이 거부되므로, 모든 실제 source 값이 target의 어느 경우엔가
  수용되는지를 기준으로 삼았다.
- **영향 범위**: `packages/core/tests/test_types.py`
- **되돌릴 수 있나**: 예 — Union→Union의 별도 규칙이 확정되면 기대값을 바꿀 수 있다.

### 2026-08-13 · Codex · M1 테스트 스펙 모호 — 사용하지 않는 사이클
- **결정**: 요청 출력의 조상에 포함된 사이클만 테스트하고, 요청과 무관한 분기의 사이클을
  전체 실행 검증에서 거부할지는 테스트로 고정하지 않는다.
- **이유**: §5.1은 요청 출력의 필요한 조상만 역방향 수집한다고 하지만, 같은 절과 §2는 실행 전
  "전체 그래프 검증"도 요구한다. 사이클이 구조 검증 대상인지 실행 목록 대상인지에 따라
  사용하지 않는 분기의 판정이 달라진다.
- **영향 범위**: `packages/core/tests/test_topology.py`
- **되돌릴 수 있나**: 예 — 전체 그래프와 실행 부분 그래프 중 검증 범위가 확정되면 케이스를 추가한다.

### 2026-08-13 · Codex · M1 테스트 스펙 모호 — 캐시 키 직렬화
- **결정**: 캐시 키 테스트는 타입·스키마 버전·재귀 입력·`IS_CHANGED` 토큰 참여, 매핑 순서
  독립성, 노드 ID/UI 제외를 고정하되 특정 다이제스트 문자열은 고정하지 않는다.
- **이유**: §5.3은 BLAKE3 구성 요소를 정하지만 각 값을 바이트로 정규화하는 방식, 링크의 upstream
  키 문자열과 같은 내용의 리터럴 문자열을 구별하는 태그 방식, 숫자 정규화는 정하지 않았다.
  직렬화가 확정되지 않은 상태에서 골든 다이제스트를 만들면 테스트가 새 계약을 임의로 만든다.
- **영향 범위**: `packages/core/tests/test_cache.py`
- **되돌릴 수 있나**: 예 — 캐논 바이트 인코딩이 확정되면 골든 벡터를 추가할 수 있다.

### 2026-08-13 · Codex · M1 테스트 스펙 모호 — 에러 소켓 귀속
- **결정**: 입력 검증·입력 해석 실패는 소비 노드와 입력 소켓을 모두 요구하고, 노드 `run` 내부의
  일반 예외는 실패 노드만 요구한다.
- **이유**: roadmap M1은 실패가 "어느 노드·어느 소켓"인지 지목하라고 요약하지만 §5.1 계약은
  입력 하나가 원인일 때만 `socket`을 채운다. 일반 예외에 근거 없는 소켓을 붙일 수는 없다.
- **영향 범위**: `packages/core/tests/test_execution_errors.py`
- **되돌릴 수 있나**: 예 — 런타임 예외가 소켓 정보를 전달하는 별도 계약이 생기면 강화할 수 있다.

### 2026-08-13 · Codex · M1 통합 — Combo 공급자 공개 API
- **결정**: 사용자가 M1 통합 진행을 확인한 뒤 `register_combo_provider()`를 최상위 `nodal`
  공개 API로 노출하고 계약 테스트를 추가했다.
- **이유**: `Combo.from_provider()`가 공개 API인데 공급자를 등록할 경로가 `nodal.schema` 내부에만
  있으면 노드 패키지가 내부 모듈 경로에 의존한다. 등록과 사용을 같은 공개 표면에 둔다.
- **영향 범위**: `packages/core/src/nodal/__init__.py`, `packages/core/tests/test_schema.py`,
  `docs/design.md` §4.2
- **되돌릴 수 있나**: 예 — M6 확장 생태계가 이 API를 쓰기 전까지는 이름을 바꿀 수 있다.
