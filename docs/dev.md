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
uv sync          # Python 워크스페이스 (core · server · nodes-core · nodes-image)
pnpm install     # JS 워크스페이스 (apps/web)
```

### diffusion 노드 팩 (M4) — 옵트인

기본 `uv sync` 에는 **torch 가 들어 있지 않다.** 리눅스 휠이 191.8 MB 라서,
lint · 타입 체크 · 프론트만 만지는 사람이 그 값을 치를 이유가 없다.

```bash
uv sync --group diffusion   # CPU 휠 — 맥 개발 · CI
uv sync --extra cuda        # CUDA 휠 — NVIDIA 리눅스/윈도우 장비
```

**둘은 동시에 켤 수 없다.** 같은 이름·같은 버전의 torch 가 서로 다른 인덱스에
있어서 uv 가 `conflicts` 로 배타 관계를 강제한다 (루트 `pyproject.toml`).
바꿔 켤 때는 그냥 다른 명령을 돌리면 된다 — `uv` 가 환경을 맞춰 준다.

맥에서 `--extra cuda` 를 돌리면 **에러로 거부된다.** CUDA 휠에 macOS 빌드가
없기 때문이고, 조용히 CPU 로 떨어지는 것보다 낫다 — cuda 를 지정했는데 cpu 로
도는 것은 거의 언제나 사고다.

디바이스는 `NODAL_DEVICE` 로 덮어쓴다 (`auto` · `cuda` · `mps` · `cpu`).
기본값 `auto` 는 cuda → mps → cpu 순으로 찾는다. 명시한 백엔드가 없으면
실패한다 (같은 이유).

```bash
NODAL_DEVICE=cpu uv run pytest packages/nodes-diffusion/tests
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

## 커밋 전 — CI 를 로컬에서 재현

**위 "일상 명령"은 CI 의 일부일 뿐이다.** 그것만 돌리고 통과라고 판단하지 말 것.

```bash
tools/ci-local.sh              # 재현 가능한 검사 전부
tools/ci-local.sh python web   # 지정한 잡만
```

이 스크립트는 `.github/workflows/ci.yml` 의 **복사본이 아니다.** 워크플로를 파싱해서
거기 있는 `run:` 블록을 그대로 꺼내 실행한다. 그래서 CI 에 검사를 추가하면 이 스크립트를
고치지 않아도 즉시 로컬에서도 돈다 — **검사 목록을 두 번 쓰지 않는다** (`types.json` 을
단일 소스로 두는 것과 같은 원칙).

로컬에 대응물이 없는 단계는 건너뛰고 **무엇을 왜 건너뛰었는지 끝에 나열한다.** 현재는
액션 단계(`actions/checkout` 등)와 `dco` 잡이다. `dco` 는 PR 이벤트 전용이라
(`if: github.event_name == 'pull_request'`) 로컬은 물론 push 에서도 돌지 않는다 —
**첫 PR 을 열 때 처음 실행된다.**

> 왜 있는가: 2026-08-14 에 로컬에서 일부 명령만 돌리고 "통과"라고 판단한 결과
> `pnpm format:check` 실패가 12개 파일까지 누적됐다. 사람의 기억이 아니라 파일이
> 검사 목록을 갖게 하는 것이 목적이다.

## 캐논 스키마 재생성

`packages/core` 의 pydantic 모델이 캐논 그래프 포맷의 **단일 소스**다.
모델을 고쳤으면 스키마 산출물을 다시 만들고 함께 커밋한다.

```bash
uv run python tools/export_schema.py
```

`schemas/graph.schema.json` 은 산출물이다 — 손으로 고치지 않는다. CI 가
`--check` 로 drift 를 잡고, `packages/core/tests/test_schema_export.py` 와
`apps/web/src/graph/schema.test.ts` 가 양쪽 판정이 일치하는지 검사한다.

## 타입 시스템 (`types.json`)

`packages/core/src/nodal/types.json` 이 타입 호환 규칙과 내장 타입 카탈로그의
**단일 소스**다. 생성물이 아니라 손으로 쓰는 원본이며, 두 에이전트 사이의
계약이다 — 변경 전 사용자 확인이 필요하다 (`../AGENTS.md` 협업 규칙 7).

읽는 쪽은 둘뿐이다: `nodal.types`(Python), `apps/web/src/graph/typesystem.ts`(TS).

```bash
uv run python tools/check_types.py     # 구조 + Python 판정
pnpm --filter @nodal/web test          # TS 판정 (같은 conformance 케이스)
```

규칙을 고쳤으면 **양쪽을 다 돌린다.** 한쪽만 통과하면 규칙이 하나가 아니라는 뜻이다.

## API 계약 (`schemas/openapi.json`)

`packages/server` 의 pydantic 모델이 단일 소스다. 산출물을 손으로 고치지 않는다.

```bash
uv run python tools/export_openapi.py          # 백엔드에서 산출물 재생성
pnpm --filter @nodal/web gen:api               # 프론트 타입 재생성
uv run python tools/export_openapi.py --check  # drift 검사
pnpm --filter @nodal/web gen:api:check         # 프론트 쪽 drift 검사
```

모델을 고쳤으면 **둘 다 재생성해서 함께 커밋한다.** 한쪽만 하면 CI 가 잡는다.

WS 이벤트는 OpenAPI 가 다루지 않으므로 `tools/export_openapi.py` 가
`components.schemas` 에 주입한다. core 의 dataclass 와 서버 pydantic 미러가
어긋나지 않는지는 `packages/server/tests/test_openapi_export.py` 가 검사한다.

## 서버 (M2)

```bash
uv run nodal serve                  # http://127.0.0.1:8188 (--port 로 변경)
uv run nodal serve --port 8199
uv run nodal serve --assets ./assets   # Save 결과를 디스크에 남긴다
```

`/docs` 에 OpenAPI UI 가 뜬다. WS 는 `ws://호스트/ws` 하나이고 전역 스트림이다.

서버는 노드 팩을 import 하지 않는다 — `create_app(registry)` 가 레지스트리를
주입받는다. `nodal serve` 가 그 둘을 붙이는 유일한 지점이다.

`--assets` 를 주지 않으면 에셋이 **메모리에만** 있어서 서버를 끄면 사라진다.
시작할 때 어느 쪽인지 찍어준다.

## 노드 팩

설치되어 있는 1st-party 팩(`nodal_nodes_image`)은 `run`·`validate`·`nodes`·`serve`
**모든 명령에서 자동으로** 올라간다. 서드파티 팩은 이름을 댄다.

```bash
uv run nodal nodes                          # 등록된 노드 18개
uv run nodal serve --pack my_custom_pack
```

명령마다 레지스트리가 다르면 안 된다 — `nodes` 에는 보이는데 `run` 이 "등록되지 않은
노드 타입"으로 실패하거나, CLI 로는 되는데 브라우저 팔레트에는 없는 상태가 그 증상이다
(`decisions.md` 2026-08-16). 팔레트는 `/api/nodes` 가 유일한 출처다.

## 프론트 개발 서버

```bash
pnpm --filter @nodal/web dev                          # 실서버에 붙는다 (기본)
VITE_NODAL_API_MODE=mock pnpm --filter @nodal/web dev # 백엔드 없이 프론트만
```

기본값은 `apps/web/.env` 에 있고 **live** 다. `vite.config.ts` 가 `/api` 와 `/ws` 를
`127.0.0.1:8188` 로 프록시하므로 `nodal serve` 를 먼저 띄워야 한다. 화면 우상단
`LIVE API` 배지로 어느 쪽인지 확인한다.

## 그래프 실행 (M1)

```bash
uv run nodal run examples/arithmetic.nodal.json          # 실행
uv run nodal run examples/arithmetic.nodal.json --twice  # 두 번 — 2회차는 전부 캐시
uv run nodal run examples/arithmetic.nodal.json --twice --set offset.value=10
uv run nodal validate examples/arithmetic.nodal.json     # 실행 없이 검증만
uv run nodal nodes 곱하기                                 # 노드 검색 (별칭·한글)
```

`--twice --set` 이 M1 완료 기준을 보여준다. 1회차는 전부 실행하고, 2회차는
바꾼 입력의 **하위만** 재실행한다. `◌` 가 캐시 히트, `●` 가 실행이다.

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
