# 개발 환경

저장소는 비공개 전제다 (`../CLAUDE.md`). 이 문서는 로컬 작업용이다.

## 요구 사항

| 도구 | 버전 |
|---|---|
| Python | 3.11+ (`uv` 가 알아서 받아온다) |
| `uv` | 0.5+ |
| Node | 20+ |
| `pnpm` | 10+ |

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

모든 커밋에 `Signed-off-by` 가 필요하다 (DCO). 근거는 `license.md`.

```bash
git config commit.template .gitmessage
git commit -s
```

## 구조

```
packages/core          nodal          그래프 엔진 (torch 없음)
packages/server        nodal_server   FastAPI (M2)
packages/nodes-core    nodal_nodes_core  기본 노드 팩 (M1)
apps/web               @nodal/web     Vite + React 캔버스 (M2)
schemas/               생성된 JSON Schema — 프론트가 소비
tools/                 개발 스크립트
```

의존성 방향은 한쪽뿐이다: `web → server → core`, `nodes-* → core`.
`core` 는 그 누구도 import 하지 않는다. ruff 가 `core`/`server` 의 torch
import 를 차단한다 (`pyproject.toml` 의 `banned-api`).
