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

### 원클릭 런처

공유받은 체크아웃을 설치·빌드·실행하는 진입점은 운영체제별 래퍼다.

| 운영체제 | 파일 |
|---|---|
| macOS | `launch-nodal.command` |
| Windows | `launch-nodal.bat` |
| Linux | `launch-nodal.sh` |

세 파일은 모두 `tools/launch.py` 하나를 호출한다. 공통 부트스트랩이 `uv sync`,
`pnpm install`, 프론트 빌드를 한 뒤 `nodal launch`를 실행하므로 플랫폼별 설치
논리가 따로 자라지 않는다. `nodal launch`는 빌드된 UI와 API·WS·MCP를 같은
`127.0.0.1:8188` 프로세스에서 내고 `~/.nodal/{assets,models,templates,extensions}`를
명시적으로 사용한다.

```bash
./launch-nodal.command --runtime core
./launch-nodal.command --runtime cpu
./launch-nodal.command --runtime cuda
```

`core`는 torch 없음, `cpu`는 `uv sync --group diffusion`, `cuda`는
`uv sync --extra cuda`와 정확히 대응한다. 선택은 `~/.nodal/runtime`에 저장되고
시작 로그가 무엇을 설치했는지 항상 출력한다. `NODAL_RUNTIME=core|cpu|cuda`로 한 번만
덮어쓸 수도 있다. 이 런처는 서명된 독립 실행 파일이 아니므로 uv와 Node.js가 필요하다.

#### Windows GPU 장비 판정 절차

M7 패키징 완료 판정은 Mac 보고만으로 하지 않는다. Windows GPU 장비의 깨끗한
체크아웃에서 다음 원시 결과를 확인한다.

```powershell
.\launch-nodal.bat --runtime cuda --no-browser
```

서버가 뜬 뒤 다른 PowerShell에서:

```powershell
uv run --no-sync python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
(Invoke-RestMethod http://127.0.0.1:8188/api/nodes).nodes.Count
uv run python tools\smoke_node_pack.py
```

확인할 값은 CUDA 빌드 버전, `torch.cuda.is_available() == True`, 0보다 큰 노드 수,
그리고 스모크 출력의 `node=guide.InvertBoolean`이다. 에이전트 보고가 아니라 장비에서
나온 이 값을 사람이 보고 판정한다.

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

### 모델 디렉토리

```
models/
  checkpoints/   *.safetensors · *.ckpt · diffusers 폴더
  loras/         *.safetensors
  vae/
  controlnet/
```

위치는 `nodal serve --models DIR` 또는 `NODAL_MODELS_DIR` 로 준다. 스캔은
**요청마다 새로 돈다** — 파일을 넣고 브라우저를 새로고침하면 바로 팔레트의
드롭다운에 나온다. 없으면 목록이 비고, 그것이 정상이다 (모델 없이도 서버는 뜬다).

## NVIDIA 장비에서 실제 SDXL 확인하기

CI 는 tiny 체크포인트로 **배선**만 검증한다. 가중치가 랜덤이라 나오는 그림은
노이즈이고, 실제 가중치가 에러 없이 **이상한 그림**을 내는 실패는 기계 테스트가
잡지 못한다. 이 절은 모델 추가와 diffusion 경로 변경 때 반복하는 실제 GPU
재검증 절차다.

### 검증 원칙

- **에이전트에는 측정만 시키고 판정은 사람이 한다.** 이 검증은 “테스트는 초록인데
  실제로는 틀렸던 것”을 잡기 위한 것이다. 측정값을 다시 에이전트의 판정 문장으로
  받으면 확인되지 않은 계층만 하나 더 생긴다. 에이전트는 원시 결과·해시·이벤트 수·
  메모리 수치만 내고 “통과”라고 쓰지 않는다
- 에이전트는 **git 쓰기 금지 · 코드 수정 금지 · 로드맵 체크박스 변경 금지 · 판정
  문장 금지**다. 임시 디버그가 꼭 필요하면 커밋하지 않고 세션 끝에 되돌린 뒤
  `git status --short`가 비었는지 사람이 확인한다
- 과거 커밋과 비교할 때 `git worktree`를 만들거나 checkout하지 않는다. **`git
  archive` 스냅샷**을 써서 검증 작업이 저장소의 refs·index를 쓰지 않게 한다
- **A~D 각 단계 전에 서버 프로세스를 재시작한다.** 앞 단계의 파이프라인·핸들·
  allocator 상태가 다음 측정을 오염시키면 항목별 원인을 분리할 수 없다

과거 커밋 스냅샷은 예를 들어 이렇게 만든다. 경로는 장비의 임시 공간으로 바꿔도 된다.

```bash
snapshot=/tmp/nodal-verify-9445d56
mkdir -p "$snapshot"
git archive 9445d56 | tar -x -C "$snapshot"
```

### 1. CUDA 로 설치

```bash
uv sync --extra cuda
```

CPU 그룹과 **동시에 켤 수 없다.** 이미 `--group diffusion` 으로 받아 뒀다면 위
명령이 알아서 바꿔 끼운다. 인덱스는 cu130 이다 (루트 `pyproject.toml`) — 드라이버가
더 낮으면 그 URL 을 바꾸고 `uv lock` 을 다시 돌린다.

맥에서 이 명령을 돌리면 **에러로 거부된다.** CUDA 휠에 macOS 빌드가 없기
때문이고, 조용히 CPU 로 떨어지는 것보다 낫다.

### 2. 설치가 CUDA 인지 확인

```bash
uv run python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

`2.x.x+cu130 True` 가 나와야 한다. `+cpu` 가 보이면 그룹이 잘못 켜진 것이다.

### 3. 체크포인트를 놓고 서버를 띄운다

```bash
uv run nodal serve --models ~/models --assets ~/nodal-assets --host 0.0.0.0
```

시작 로그에 `모델 루트: ... (checkpoints N개, ...)` 가 찍힌다. 0개면 경로나
디렉토리 이름이 틀린 것이다. `--host 0.0.0.0` 은 맥에서 브라우저로 붙기 위한 것이다.

### 4. 측정 행렬을 먼저 고정한다

체크포인트마다 프롬프트를 포함한 입력을 고정하고, nodal과 골든 레퍼런스에 같은
값을 쓴다. 커밋·체크포인트 파일·LoRA 파일의 식별자와 해시도 결과에 남긴다.

2026-08-24 M4 마감 측정은 아래 행렬이었다.

| 항목 | 값 |
|---|---|
| 측정 / 비교 커밋 | `f65ff82` (M5.4) / `9445d56` (M4 마무리) |
| 실제 체크포인트 | `sd_xl_base_1.0` · `RealVisXL_V5.0` · `Juggernaut-XL_v9` |
| 공통 생성 조건 | `seed=12345`, `cfg=7.0`, `euler/normal`, 1024×1024 |

### A. 최종 출력을 골든 레퍼런스와 대조한다

1. 서버를 새로 시작해 nodal txt2img 결과를 저장한다
2. 같은 체크포인트·프롬프트·시드·샘플러·스케줄러·크기로 `diffusers` 파이프라인을
   직접 호출한 골든 레퍼런스를 저장한다
3. 두 결과를 나란히 놓고 **사람이** 판정한다

통과 기준은 단순히 “그림이 프롬프트와 관련 있다”가 아니다. 배선·dtype·조건 입력이
잘못되어도 파이프라인은 예외 없이 이상한 그림을 낼 수 있다. 직접 호출 레퍼런스와
나란히 보아 nodal만의 명백한 품질·구도 붕괴가 없는지를 사람이 판단한다. 에이전트는
두 파일과 실행 조건만 전달한다.

### B. WS에서 스텝 프리뷰를 센다

1. 서버를 다시 시작한다
2. 브라우저가 아니라 `/ws` 이벤트 스트림에 직접 연결한 뒤 `steps=60`으로 실행한다
3. 해당 run의 `node.preview` 이벤트 수와 순서를 기록한다

`PREVIEW_COUNT=8`이면 `every = 60 // 8 = 7`이다. KSampler는 7의 배수 8회와
마지막 60스텝에서 1회, 합계 9프레임을 내고 VAEDecode와 Save가 각 1프레임을 더한다.
따라서 이 그래프의 통과 기준은 **11프레임**이다. UI가 렌더링한 횟수는 네트워크·
브라우저 상태가 섞이므로 증거로 쓰지 않는다.

### C. 3사이클 모델 수명과 VRAM 추세를 잰다

1. 서버를 다시 시작한다
2. 체크포인트 3종을 차례로 로드하는 것을 3사이클 반복해 총 9회 관찰한다
3. 각 관찰점에서 live pipelines와 `torch.cuda.memory_allocated()`를 기록한다
4. 실행 결과와 모델 핸들을 놓은 뒤 allocated를 읽기 **직전에 `gc.collect()`를
   호출한다.** 필요하면 이어 `torch.cuda.empty_cache()`를 호출하고 두 호출의
   전후 값을 구분해 기록한다

통과 기준은 `live pipelines <= 1`이 아니다. `manager.py:52`의 설계 상한은
`DEFAULT_CAPACITY = 2`이고 `_evict_if_needed`(`:293`)가 초과분 중 참조되지 않는
항목부터 내린다. 따라서 **live pipelines가 `DEFAULT_CAPACITY`를 넘지 않고,
사이클이 반복돼도 allocated 추세가 계속 올라가지 않아야** 통과다.

`_unload`(`manager.py:313`)는 `del`과 `empty_cache`를 호출하지만, `empty_cache`는
reserved를 반환할 뿐 아직 수거되지 않은 파이썬 객체를 없애지 않는다. 2026-08-24
측정에는 allocated 직전 `gc.collect()`가 빠져 있었다. 수거 지연을 누수로 오인하지
않도록 다음 측정부터 위 4번을 지킨다.

### D. LoRA 적용과 해제가 모두 실제인지 해시로 본다

서버를 다시 시작한 뒤 각 체크포인트에서 같은 입력으로 세 출력을 순서대로 저장한다.

1. LoRA 없음
2. LoRA 적용
3. LoRA 해제 후 재실행

각 출력의 SHA-256을 계산한다. 통과 조건은 둘을 **동시에** 만족하는 것이다.

- `SHA256(1) == SHA256(3)` — 적용 상태가 비-LoRA 분기를 오염시키지 않고 해제됐다
- `SHA256(2) != SHA256(1)` — LoRA가 실제로 적용됐다

두 번째 조건이 결과의 절반이다. LoRA가 아예 적용되지 않아도 (1)==(3)은 성립한다.
M4 1차의 tiny 픽스처는 `lora_B`가 전부 0이라 정확히 그렇게 검증이 조용히
무의미해졌다. “되돌아왔다”와 “중간에 실제로 달라졌다”를 함께 확인해야 한다.

### 2026-08-24 실행 기록

A~D는 위 측정 행렬에서 모두 통과했다. B는 WS에서 11프레임, C는 3사이클 9회
로드 동안 live pipelines 최대 2와 평평한 allocated 추세, D는 세 체크포인트 모두
(1)==(3)이고 (2)만 다른 SHA-256을 기록했다. 사람의 A 판정과 원시 측정 결과를
근거로 `roadmap.md`의 M4 완료 기준을 닫았다.

별개로 1024² `steps=60` 실행이 22분56초(스텝당 23초) 걸려 같은 프로세스의
`steps=15`(스텝당 0.33초)보다 70배 느린 사례가 나왔다. M4 완료를 다시 열지는
않지만 “느려도 감수”할 범위를 넘었으므로 `design.md` §10에서 **M6 선행 조사**로
격상했다. 성능 조사는 이 검증 절차와 섞어 코드 수정하지 않는다.

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

설치되어 있는 1st-party 팩(`nodal_nodes_image`·`nodal_nodes_diffusion`)은
`run`·`validate`·`nodes`·`serve` **모든 명령에서 자동으로** 올라간다. 예전
`--pack MODULE` 경로도 남아 있지만, 매니페스트 확장의 발견 경로는
`~/.nodal/extensions` 하나다.

```bash
uv run nodal nodes                          # 등록된 노드 전체
uv run nodal serve --pack my_custom_pack
```

서드파티 노드 팩의 현재 규약과 설치 예제는 `node-authoring.md`에 있다. 커스텀
프론트 위젯 API와 매니페스트 Python 의존성 자동 설치는 아직 없다.

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
