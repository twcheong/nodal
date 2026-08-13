# 개발 환경

이 문서는 **로컬에서 무엇을 실행하는지**만 다룬다.
규칙과 기술 스택은 `../AGENTS.md`에 있다 — 여기에 복사하지 않는다.

## 요구 사항

버전은 저장소가 스스로 선언한다. 여기에 옮겨 적지 않는다 — 옮겨 적는 순간 어긋난다.

| 도구 | 어디에 선언되어 있나 |
|---|---|
| Python | `pyproject.toml` 의 `requires-python` (`uv` 가 알아서 받아온다) |
| Node | `package.json` 의 `engines.node` |
| `pnpm` | `package.json` 의 `packageManager` (`corepack` 이 맞춰준다) |
| `uv` | 최신 안정판 |

## 설치

```bash
uv sync          # Python 워크스페이스 (core · server · nodes-core)
pnpm install     # JS 워크스페이스 (apps/web)
```

## 일상 명령

```bash
uv run pytest                              # Python 테스트
uv run ruff check . && uv run ruff format . # lint · format
uv run mypy                                # 타입 체크
pnpm -r test                               # 프론트 테스트
pnpm -r lint && pnpm -r typecheck          # 프론트 lint · 타입 체크
pnpm --filter @nodal/web dev               # 개발 서버
```

## 캐논 스키마 재생성

`packages/core` 의 pydantic 모델이 캐논 그래프 포맷의 **단일 소스**다.
모델을 고쳤으면 스키마 산출물을 다시 만들고 함께 커밋한다.

```bash
uv run python tools/export_schema.py
```

`schemas/graph.schema.json` 은 산출물이다 — 손으로 고치지 않는다. CI 가
`--check` 로 drift 를 잡고, `packages/core/tests/test_schema_export.py` 와
`apps/web/src/graph/schema.test.ts` 가 양쪽 판정이 일치하는지 검사한다.

## 커밋

모든 커밋에 `Signed-off-by` 가 필요하다 (DCO — `../AGENTS.md` 코딩 컨벤션, 근거는 `license.md`).
저장소를 새로 clone 했다면 커밋 템플릿을 한 번 걸어둔다.

```bash
git config commit.template .gitmessage
git commit -s
```

## 디렉토리 ↔ 임포트 이름

의존성 **규칙**은 `../AGENTS.md` "아키텍처 — 의존성 규칙"에 있다. 아래는 그 규칙이
이 저장소에서 어떤 이름으로 나타나는지에 대한 대응표일 뿐이다.

| 디렉토리 | 임포트 이름 | 상태 |
|---|---|---|
| `packages/core` | `nodal` | M0 완료 |
| `packages/server` | `nodal_server` | M2 |
| `packages/nodes-core` | `nodal_nodes_core` | M1 |
| `apps/web` | `@nodal/web` | M2 |
| `schemas/` | — | 생성된 JSON Schema, 프론트가 소비 |
| `tools/` | — | 개발 스크립트 |

규칙 위반은 사람이 아니라 도구가 잡는다: ruff `banned-api` 가 `core`/`server` 의
torch import 를 거부한다 (`pyproject.toml`).
