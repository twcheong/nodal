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

### 2026-08-17 · Claude Code · M4 얇은 수직 절단 — 스키마 노출 (사용자 확인 후 확정)

프론트 담당이 시드 위젯을 만들려면 `/api/nodes` 에 그 스키마가 나와야 하는데,
`Seed` 를 쓰는 노드가 없어 아무것도 나오지 않았다. 최소한만 만들어 흘려보냈다.

#### 옵트인인 것은 **런타임**이지 팩이 아니다

- **결정**: `nodal-nodes-diffusion` 을 루트 `dependencies` 로 옮겨 **언제나 설치**
  한다. 대신 팩의 무거운 의존성(diffusers · transformers · safetensors · numpy)을
  `[runtime]` extra 로 내려 torch · accelerate 와 같은 옵트인 프로파일에 넣었다
- **이유**: 어제 결정("torch 191.8 MB 를 기본에서 뺀다")의 **근거는 무게**였는데,
  팩 자체를 뺀 것은 그 근거를 넘어선 부작용이었다. 스키마 노출에는 torch 도
  diffusers 도 필요 없다 — `nodal` 의 타입뿐이다. 팩을 빼 두면 프론트 담당이
  JSON 스키마를 보려고 191.8 MB 를 받아야 한다
- **결과**: 기본 `uv sync` 증가량은 `nodal-nodes-diffusion` 하나(의존성 `nodal-core`
  뿐). 실측으로 diffusers 계열을 기본에 넣었을 때는 +31 MB 였다
- **강제 규칙**: 이 팩의 **모듈 최상단에서 torch·diffusers 를 import 하지 않는다.**
  하면 기본 환경에서 import 가 깨져 팔레트에서 노드가 통째로 사라진다.
  `run` 안에서 늦게 import 하고, 없으면 `uv sync --group diffusion` 을 하라고
  말하는 에러를 낸다. 테스트가 이 성질을 직접 검사한다
  (`test_pack_registers_without_torch`)
- **영향 범위**: `pyproject.toml`, `packages/nodes-diffusion/pyproject.toml`,
  `packages/nodes-core/src/nodal_nodes_core/cli.py`(`DEFAULT_OPTIONAL_PACKS`), `uv.lock`
- **되돌릴 수 있나**: 예

#### `Conditioning` 을 `types.json` 에 추가 (인터페이스 변경 — 사용자 확인함)

- **결정**: `catalog.opaque` 에 `Conditioning` 추가. `types.py` 에 `CatalogType` 도
- **이유**: `KSampler` 의 `positive` · `negative` 에 줄 타입이 카탈로그에 없었다.
  `CLIP` 으로 대신하면 **인코더와 그 출력이 같은 타입**이 되어 KSampler 의
  `positive` 에 텍스트 인코더가 그대로 꽂힌다. conformance 케이스로 고정했다
- **왜 지금인가**: 나중에 좁히는 것은 파괴적 변경이다. `Any` 로 두고 미루면
  그 자리에서 타입 검사가 꺼진 채로 프론트가 먼저 만들어진다
- **추가적이라 안전하다**: 기존 conformance 케이스를 건드리지 않았고 TS 로더가
  같은 파일을 읽으므로 프론트에 자동 반영된다
- **영향 범위**: `packages/core/src/nodal/{types.json,types.py,__init__.py}`
- **되돌릴 수 있나**: 아니오(사실상) — 프론트가 이 타입으로 소켓을 그리기 시작하면

#### `Seed.MAX` 를 `2**53-1` 로 내렸다 (어제 커밋의 결함 수정)

- **결정**: 어제 `2**64-1` 로 둔 것을 `2**53-1`(JS `Number.MAX_SAFE_INTEGER`)로
- **이유**: `JSON.parse("18446744073709551615")` 는 `18446744073709552000` 을
  돌려준다. 프론트가 이 값을 위젯 상한으로 쓰는 순간 시드가 조용히 다른 수가
  된다. **재현성이 존재 이유인 위젯에서 그것은 치명적이다.** `/api/nodes` 응답을
  실제로 찍어 보고 발견했다 — 어제는 Python 쪽만 보느라 놓쳤다
- **왜 지금 고치는가**: 프론트가 이 값에 기대기 전이다. 하루 늦었으면 파괴적 변경
- **torch·numpy 는 64비트를 받지만** 9천조 가지면 충분하고, 정확한 왕복이 더 중요하다
- **영향 범위**: `packages/core/src/nodal/schema.py`, `packages/core/tests/test_models.py`
- **되돌릴 수 있나**: 예 (아직 아무도 안 쓴다)

#### 스텝 프리뷰는 새 전송 형식을 만들지 않는다

- **결정**: 잠재 → RGB `ndarray` 변환을 **`nodes-diffusion` 안에서** 하고, 그
  다음은 M3 이 등록한 `nodal_nodes_image` 의 프리뷰 인코더를 그대로 탄다.
  `node.preview` 페이로드는 `kind: "inline" | "asset"` 유니온 그대로 — **프론트가
  스텝 프리뷰를 위해 새로 다룰 형식이 없다**
- **이유**: 변환 결과가 §4.4 이미지 계약(`(B,H,W,C)` float32 0..1)을 만족하므로
  기존 인코더가 그대로 받는다. 노드 팩이 인코더를 등록하는 구조(§4.6)가 이
  확장을 위해 있었다. `nodes-image`(다른 에이전트 소유)를 건드리지 않아도 된다
- **미룬 것**: 매 스텝 VAE 디코드 vs 선형 근사는 **품질 선택이고 전송 형식과
  무관**하다. 어느 쪽이든 파이프라인과 프론트 코드는 그대로다
- **⚠️ 기록해 두는 위험**: 선형 근사의 **계수 행렬을 ComfyUI 에서 가져오지 말 것.**
  아이디어는 자유롭게 쓰되 값은 직접 구한다. 절대 규칙 1 이 가장 쉽게 깨지는
  자리다 — 숫자 몇 개라 복사라는 자각 없이 옮기게 된다
- **영향 범위**: `docs/design.md` §9.5 (기존 §9.5~§9.6 은 §9.6~§9.7 로 밀림)
- **되돌릴 수 있나**: 예

#### `KSampler.run` 은 `NotImplementedError` 다

- **결정**: 스키마는 완성, 샘플링 루프는 다음 커밋. `EmptyLatent` 는 실제로 돈다
- **이유**: 사용자가 "run 본문은 최소한이어도 된다" 고 했다. 조용히 0 을 돌려주는
  것보다 명시적으로 실패하는 편이 낫다 — 아니면 프론트가 "돌았는데 결과가
  이상하다" 를 본다
- **`LATENT_CHANNELS = 4` 도 임시다.** 올바른 값은 체크포인트가 정한다 (SD3 ·
  FLUX 는 16). 값이 바뀌어도 **소켓 타입은 그대로**라 프론트가 다시 그릴 일은 없다
- **되돌릴 수 있나**: 예

### 2026-08-16 · Claude Code · M4 diffusion 계약 (사용자 확인 후 확정)

#### numpy 상한 — 걱정은 발생하지 않았다

2026-08-15 항목의 "M4 시작 시 확인할 것" 을 실행했다. **충돌 없다.**

`uv pip compile` 드라이런으로 기존 워크스페이스 의존성 전부 + torch · diffusers ·
transformers · accelerate · safetensors · peft 를 py3.11 / py3.12 × mac / linux
로 해석했고, 네 조합 모두 `numpy<2.5` 를 유지한 채 **전부 최신 버전**으로 풀렸다
(numpy 2.4.6 · torch 2.13.0 · diffusers 0.39.0 · transformers 5.15.0).

이유는 선언된 하한이 낮기 때문이다 — torch 는 numpy 를 의존성으로 **선언조차
하지 않고**, transformers · accelerate 는 `numpy>=1.17`, safetensors 는
`numpy>=1.24.6` (extra), diffusers 는 하한이 없다. 상한과 7 메이저 버전 이상
떨어져 있다.

- **결정**: `requires-python = ">=3.11"` 유지. `numpy>=2.1,<2.5` 유지.
  Python 3.12 상향 **하지 않는다**
- **영향 범위**: `docs/roadmap.md` M4 경고를 해소 표시로 교체
- **되돌릴 수 있나**: 해당 없음 — 아무것도 바꾸지 않았다

#### torch 인덱스 분기 — CPU 기본, CUDA 옵트인

CPU 빌드와 CUDA 빌드는 **같은 패키지 이름·같은 버전**으로 서로 다른 인덱스에
있다. 기본 PyPI 인덱스로 리눅스를 해석하면 `nvidia-*` · `cuda-*` 가 18개 딸려
온다 (수 GB). PyTorch CPU 인덱스를 붙이면 0개가 된다.

- **결정**: 루트 `pyproject.toml` 에 `[[tool.uv.index]]` 둘 + `[tool.uv.sources]`
  의 group/extra 분기. `uv sync` = torch 없음 / `--group diffusion` = CPU /
  `--extra cuda` = CUDA. `conflicts` 로 배타
- **이유 (기본에서 뺀 것)**: 사용자 판단. 리눅스 휠이 191.8 MB 인데 lint ·
  타입 체크 · 프론트만 만지는 사람과 기존 CI 잡이 그 값을 치를 이유가 없다
- **누출을 하나 찾아 막았다**: `nodal-nodes-diffusion` 이 `torch` 를 평범한
  의존성으로 선언하면, 그룹도 엑스트라도 안 켠 해석 분기가 **PyPI 기본 인덱스로
  떨어져 CUDA 휠을 끌고 온다.** 락파일에 `torch <- pypi.org/simple` 항목이 실제로
  생겼다. `accelerate` 는 `torch>=2.0.0` 을 **마커 없이** 하드 의존성으로 걸어
  한 단계 건너 같은 누출을 만든다. 둘 다 패키지에서 빼서 루트 group/extra 로
  옮겼더니 그 항목이 사라졌다. diffusers · transformers · safetensors 는 torch 를
  extra 뒤에만 두므로 패키지에 남는다
- **확인한 사실**: 워크스페이스 **루트의 `[tool.uv.sources]` 는 멤버 패키지의
  요구사항에도 적용된다.** 그래서 `packages/nodes-diffusion` 은 인덱스를 모른다
- **맥에서 `--extra cuda`** 는 에러로 거부된다 (CUDA 휠에 macOS 빌드가 없다).
  조용히 CPU 로 떨어지는 것보다 낫다고 판단해 그대로 뒀다
- **영향 범위**: `pyproject.toml`, `packages/nodes-diffusion/pyproject.toml`,
  `uv.lock`, `.github/workflows/ci.yml`, `README.md`, `docs/dev.md`
- **되돌릴 수 있나**: 예 — 인덱스 선언과 sources 분기를 떼면 PyPI 기본으로 돌아간다

#### `ModelStore` · `DevicePlan` — 최소 표면

- **결정**: `packages/core/src/nodal/models.py` 신설. `ModelStore` Protocol 은
  `plan` 과 `load(ref, *, loader)` **둘뿐**이다. 참조 카운팅 · LRU 언로드 · mmap 은
  노드가 부르지 않으므로 넣지 않았다
- **이유**: 사용자 지시("노드 팩이 실제로 부르는 것만"). Protocol 은 메서드 추가가
  비파괴적이라 작게 시작할 수 있고, 반대로 넓힌 것을 좁히면 노드 팩이 깨진다
- **`ctx.models` 는 `ctx.assets` 와 같은 모양**이다 — core 의 Protocol + 밖의 구현 +
  실패하는 Null 구현. 이미 있는 선례를 따르는 것이 새 패턴을 만드는 것보다 낫다
- **`NullModelStore.plan` 은 터지지 않는다.** `load` 만 터진다 — 디바이스가
  무엇인지 묻는 것은 저장소 없이도 물어볼 수 있어야 하는 질문이다
- **`Device` 는 `torch.device` 가 아니라 값 타입**이고 `dtype` 은 `torch.dtype` 이
  아니라 `types.json` 과 같은 어휘의 문자열이다. core 가 torch 를 모른다는 규칙
- **영향 범위**: `packages/core/src/nodal/{models.py,events.py,executor.py,__init__.py}`
- **되돌릴 수 있나**: 예 — 아직 부르는 노드가 없다

#### 디바이스 경계는 grep 가드로 강제한다

- **결정**: `torch.cuda` · `torch.mps` · `torch.backends.mps` 는
  `nodal_nodes_diffusion/devices.py` 한 파일에만. CI 의 grep 스텝이 검사한다
- **왜 ruff 가 아닌가**: `banned-api` 는 **import 문만** 보고
  `torch.cuda.is_available()` 같은 속성 접근을 지나친다. 게다가 모든 banned-api
  위반이 `TID251` 하나로 보고되므로, per-file-ignores 로 `torch` 는 풀고
  `torch.cuda` 는 막는 것이 **불가능하다**. 시도해 보고 확인했다
- **이유**: 백엔드 분기는 한 번 흩어지면 되돌릴 수 없고, 빠뜨린 자리는 그 하드웨어를
  가진 사람만 발견한다. 저자가 맥에서 개발하고 GPU 가 별도 리눅스 장비인 이
  프로젝트에서는 특히 그렇다
- **영향 범위**: `pyproject.toml` per-file-ignores, `.github/workflows/ci.yml`
- **되돌릴 수 있나**: 예

#### 시드는 cpu 제너레이터에서 만든다

- **결정**: `torch.Generator` 는 언제나 cpu 로 만들고 latent 를 `compute` 로 옮긴다.
  `Seed` 위젯의 `control` (`fixed` · `increment` · `randomize`) 을 읽어 값을 굴리는
  것은 **프론트**이고 서버는 넘어온 정수를 그대로 쓴다
- **이유**: 제너레이터의 device 처리가 백엔드마다 달라서, 그대로 두면 "같은 시드 →
  같은 결과" 가 백엔드를 건널 때 깨진다. 나중에 바꾸면 기존 그래프의 출력이 전부
  달라지므로 처음부터 고정한다. 서버가 시드를 굴리면 캐시 키가 매번 달라지고
  `.nodal.json` 이 재현 가능한 레시피라는 성질이 사라진다
- **`Seed.CONTROLS` 는 에이전트 간 계약**이다 (`AGENTS.md` 규칙 7 의 아래 칸)
- **영향 범위**: `packages/core/src/nodal/schema.py`, `docs/design.md` §9.4
- **되돌릴 수 있나**: 지금은 예. 실제 이미지가 나오기 시작하면 아니오

#### 테스트 픽스처는 diffusers 폴더 포맷

- **결정**: CI 는 `hf-internal-testing/tiny-sd-pipe` (8.7 MB) ·
  `tiny-sdxl-pipe` (11.2 MB) 로 `diffusers.pretrained` 경로를 검증한다.
  `diffusers.single_file` 은 GPU 장비의 실제 체크포인트로 수동 확인
- **이유**: tiny 픽스처가 전부 폴더 포맷이고 단일 파일 tiny 체크포인트를 찾지
  못했다. 두 로더는 다른 경로다. `single_file` 의 아키텍처 추론이 실사용에서 가장
  자주 깨지는 지점이라 **에러가 무엇을 추론하려 했는지 말하게** 만들었다
  (`ModelLoadError` 의 `inferred` · `expected` · `evidence`) — 사용자 지시
- **검증되지 않는 것**: 가중치가 랜덤이라 **출력의 의미는 검증하지 못한다.**
  배선 · shape · dtype · 캐시 · 취소 · 프리뷰 경로가 대상이다
- **LoRA 픽스처는 찾지 못했다.** `hf-internal-testing` 은 조직 목록 API 가 막혀
  있어 정확한 이름으로만 조회된다. LoRA 로더 항목에 착수할 때 `diffusers` 테스트
  스위트에서 **이름만** 확인한다 — 픽스처 이름 확인은 소스 복사가 아니므로
  절대 규칙 1 과 무관하다
- **영향 범위**: `docs/design.md` §9.7, `docs/roadmap.md`
- **되돌릴 수 있나**: 예

### 2026-08-14 · Codex · M3 이미지 계약 보정

- **결정**: `Image` 소켓 dtype 을 `float32` 하나로 좁혔다. `uint8` 은 Load/Save 노드
  내부의 파일 경계 표현일 뿐 소켓으로 흐르지 않는다.
- **결정**: 프리뷰 인코더는 `Preview` 대신 `EncodedPreview(data, media_type, width,
  height)` 를 반환한다. core 가 `ctx.progress` 는 inline data URI, `NodeResult.preview`와
  비-JSON 출력은 실행별 `AssetStore`의 asset 으로 만든다.
- **결정**: 명시적 프리뷰와 Tensor 출력에 맞는 인코더가 없으면
  `PreviewEncoderNotFoundError`로 실패한다. Model 같은 불투명 핸들의 빈 전송 참조만
  허용한다. 인코더 등록 누락을 조용한 성공으로 숨기지 않는다.
- **결정**: `execute(..., assets=...)`를 추가하고 server 의 업로드 라우트와 실행 큐가
  같은 저장소 인스턴스를 공유한다. `RunResult.references`가 WS와 REST에 같은
  `OutputRef`를 공급한다.
- **결정**: PNG 워크플로 청크를 `tEXt`에서 UTF-8 `iTXt`로 보정했다. 키워드는
  `nodal_workflow` 그대로다.
- **결정**: API 오류 본문은 OpenAPI 선언대로 `{error: ...}`를 직접 반환한다. FastAPI
  기본 `HTTPException.detail` 래퍼를 쓰지 않는다.
- **이유**: `56baaad`의 형태만으로는 저장소를 `ctx.assets`에 주입할 수 없었고, 인코더가
  실행별 저장소나 inline/asset 정책을 알 수 없었다. `Socket(Image)`도 이름 클래스를
  그대로 저장해 즉시 실패했다. 또한 `tEXt`는 Latin-1이라 한글 프롬프트를 보존하지
  못하고, 실제 오류 응답은 선언한 스키마와 달랐다.
- **영향 범위**: `types.json`, core 실행·프리뷰·스키마 API, server AssetStore·RunQueue,
  OpenAPI 설명과 오류 런타임, `docs/design.md`·`docs/roadmap.md`
- **되돌릴 수 있나**: 아니오 — M3 노드 팩과 프론트가 이 주입·인코딩·전송 계약을
  구현 기준으로 사용한다.

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

### 2026-08-13 · Claude Code · M2 점검 결과 — 남은 두 가지 (2026-08-14 해소)

로드맵 M2 항목 8개는 실서버로 확인해 전부 표시했다. 남은 것 둘을 여기 적어 둔다.

- **✅ 벤치마크 측정**: 브라우저를 포그라운드로 표시하고
  `document.visibilityState === "visible"`, `document.hidden === false`를 확인한 뒤 측정했다.
  200노드·199엣지에서 90프레임 평균 **116fps**, 마운트된 노드 본문은 24개였다.
  결과와 재측정 방법은 `apps/web/PERFORMANCE.md`에 남겼다. 백그라운드 탭에서는 측정을
  시작하지 않고 포그라운드 안내를 표시하도록 계측 도구도 보완했다.

- **✅ 연속 실행 고착 수정**: 원인은 첫 검증·POST 응답을 기다리는 동안 UI가 아직 busy가 아니어서
  실행 요청 여러 건이 동시에 제출될 수 있었던 것이다. 첫 호출이 스토어의 제출 잠금을
  동기적으로 획득하고, 검증 실패·요청 실패·성공 모두 `finally`에서 해제하게 했다. 추가 클릭과
  Ctrl+Enter는 첫 요청이 끝날 때까지 무시하며, 3회 연속 제출 회귀 테스트로 고정했다.

### 2026-08-13 · Claude Code · M2 계약 보완 (프론트 지적 → 사용자 확인 후 확정)

프론트 담당 에이전트가 두 가지를 지적했고, 검증 결과 **둘 다 사실**이었다. 계약 변경이라
사용자에게 물어 확정했다.

- **소켓 타입을 `TypeExpr`로 전송**: `type: str` 은 `describe()` 결과였는데 그것은 사람이
  읽는 **렌더링**이라 복원할 수 없다 (`Tensor[float32, (?, 3)]` 은 `?` 가 라벨이었는지
  `None` 이었는지 지운다). `types.json` 의 `type_expression` 문법을 그대로 보낸다 —
  프론트의 `parseTypeExpr()` 가 이미 그것을 먹는다. `to_type_expr()` 를 `nodal.types` 에
  추가했고 `parse_type_expr` 의 역함수임을 테스트로 고정했다.
  표시용 문자열은 프론트가 `describeType()` 으로 만든다 — 렌더러를 두 번 쓰지 않는다.
- **`run.failed` 이벤트 추가**: 지적은 "`node.error` 이후 `run.done` 이 와도 실패 상태를
  유지한다" 였지만, 실측하니 **`run.done` 조차 오지 않았다** — `execute()` 가 예외로 나가며
  emit 지점을 건너뛰어 run 레벨 종료 이벤트가 아예 없었다. 지적보다 심각한 문제였다.
  종료 이벤트 셋(`run.done`·`run.failed`·`run.cancelled`)이 `RunStatus` 의 종료 상태 셋과
  짝을 이루도록 확정했다. `code`·`message` 를 싣는 이유는 사이클처럼 어느 노드에도
  귀속되지 않는 실패가 있어서다 — 그때는 이 이벤트가 사유를 아는 유일한 통로다.

**영향 범위**: `docs/design.md` §6, `packages/core/src/nodal/{types,events,executor}.py`,
`packages/server/src/nodal_server/{schemas,wire}.py`, `schemas/openapi.json`
**되돌릴 수 있나**: 아니오 — 프론트가 이 산출물로 작업 중이다. 변경 시 사용자 확인.

> ⚠️ **프론트 담당에게**: `schemas/openapi.json` 이 바뀌었다.
> `pnpm --filter @nodal/web gen:api` 를 돌려 `generated.ts` 를 재생성해야 한다.
> 그 전까지 CI 의 "생성된 API 타입 drift 검사" 단계가 실패한다.
> `apps/web/` 은 이 커밋에서 건드리지 않았다.

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

### 2026-08-14 · Codex · M2 스펙 모호 — API 소켓 타입의 문자열 문법

- **상태**: **해소됨** — `0a24ba6`에서 소켓 타입이 구조화 `TypeExpr`로 확정되어 아래
  문자열 어댑터 결정은 더 이상 적용하지 않는다.

- **결정**: `/api/nodes`의 `InputSocketModel.type`·`OutputSocketModel.type` 문자열은
  `types.json`의 이름을 기본으로 해석하고, OpenAPI 설명에 예시로 적힌 `List[T]`와
  design.md §4.3의 `Union[A, B]`만 얕은 문자열 문법으로 구조화한다. 실제 호환 판정은
  새로 구현하지 않고 기존 `graph/typesystem.ts`에 위임한다.
- **이유**: OpenAPI 계약은 소켓 타입을 구조화 서술자가 아닌 `string`으로 전송하며
  `List[Image]` 예시는 있지만 중첩 타입을 기계적으로 파싱할 문법이나 구조화 필드가 없다.
  현재 어댑터는 M2 카탈로그 표현을 지원하지만 Tensor의 인라인 shape/dtype 표현처럼 더
  복잡한 문자열이 서버에서 오면 계약 확장이 필요하다.
- **영향 범위**: `apps/web/src/editor/socketTypes.ts`
- **되돌릴 수 있나**: 예 — OpenAPI가 구조화 `TypeExpr`을 보내면 문자열 어댑터를 제거할 수 있다.

### 2026-08-15 · Claude Code · numpy 타입 검사 복구 (선택지 4개 비교 후 결정)

M3 백엔드에서 numpy 스텁을 mypy 검사에서 제외했던 것을 되돌렸다. 선택지를 **실제로
돌려 보고** 골랐다.

- **결정: numpy 를 `>=2.1,<2.5` 로 고정한다.** mypy 예외를 제거했다
- **결정적 근거**: numpy 2.5 는 **자체가 `requires-python >= 3.12`** 다. 우리는
  `requires-python = ">=3.11"` 이므로 `numpy>=2.1` 이라고만 쓴 것은 **처음부터
  일관되지 않은 선언**이었다. 상한을 두는 것이 오히려 선언을 정직하게 만든다.
  2.4 계열은 3.11 을 지원하고 스텁도 3.11 로 파싱된다 (직접 확인)
- **탈락 1 — mypy `python_version` 만 3.12 로**: 3.12 전용 문법(PEP 695 `type` 문)을
  우리 코드에 써도 mypy 가 통과시킨다. 실제로 만들어 확인했다 — mypy 는 통과,
  3.11 인터프리터는 `SyntaxError`. **3.11 을 지킨다는 보증이 사라진다**
- **탈락 2 — `requires-python` 을 3.12 로**: 지금 얻을 것이 numpy 상한 해제뿐인데,
  그 대가로 3.11 지원을 버린다. M4 에서 torch·diffusers 의 지원 범위를 볼 때
  다시 판단하는 편이 낫다. 올리는 것은 언제든 되지만 내리는 것은 어렵다
- **탈락 3 — 런타임 검증으로 대체**: 대체재가 아니다. 아래처럼 **분담**이다

**numpy 타입 검사가 실제로 잡는 것과 못 잡는 것** (직접 실험한 결과)

| 실수 | 잡히나 |
|---|---|
| `uint8 / 255.0` 이 float64 로 승격 | ✅ — Load 경계 정규화의 대표 버그 |
| `float32 / 255.0` | (정상) NEP 50 상 float32 그대로다. 함정이 아니다 |
| `uint8` 배열을 `float32` 자리에 전달 | ✅ |
| 배열이 아닌 값(str 등) 전달 | ✅ |
| `a[..., 0]` 로 랭크가 줄어듦 | ❌ numpy 타입 시스템이 shape 을 모른다 |
| `a.astype(np.float64)` 명시적 승격 | ❌ 스텁이 `dtype[Any]` 를 돌려준다 |
| `np.zeros(..., dtype=np.uint8)` 리터럴의 dtype 추론 | ❌ |

그래서 **dtype 은 타입이, shape 은 런타임이** 담당한다. `ensure_batch` · `to_float32`
가 랭크와 채널 수를 검사하고 있고 그것이 shape 쪽의 보증이다. 선택지 4를 "대신"이
아니라 "함께" 로 둔 이유다.

**`ImageArray` · `MaskArray` 별칭을 `nodal_nodes_image.image` 에 추가**했다.
`np.ndarray[Any, np.dtype[np.float32]]` 라 dtype 이 타입에 박힌다.

**`Image.T` 에 대해** — 계약 때 정한 것은 "**core 에 두되 순수 별칭**" 이고
`design.md` §4.4 가 "core 에서는 언제나 `Any`" 라고 명시한다. 실제 타입으로 하기로
한 적이 없다. 바꾸려면 **core 가 numpy 를 import** 해야 하는데 그것은 "core 는
도메인 중립 그래프 엔진" 규칙 위반이고, `Image.T` 를 고른 근거(mypy 가 인스턴스
속성을 타입으로 못 씀) 와도 무관하다. 대신 노드 팩이 `ImageArray` 를 노출해
**팩 안에서는 진짜 타입 검사**를 받게 했다 — core 의 도메인 중립성과 노드 저자의
타입 안전을 둘 다 가져가는 방법이다.

- **영향 범위**: `packages/nodes-image/{pyproject.toml,src/nodal_nodes_image/image.py}`,
  `pyproject.toml`(mypy 예외 제거), `uv.lock`
- **되돌릴 수 있나**: 예 — 상한 하나다. `requires-python` 을 3.12 로 올리면 뗀다

> ### 📌 M4 시작 시 확인할 것 — numpy 상한과 torch·diffusers
>
> **`numpy<2.5` 상한은 `requires-python = ">=3.11"` 과 한 묶음이다.** M4 에서
> torch·diffusers·transformers 를 넣을 때 그 중 하나라도 **`numpy>=2.5` 를 요구하면
> 상한과 충돌**한다. 그 순간 선택지는 둘뿐이다:
>
> 1. **`requires-python` 을 3.12 로 올린다** — numpy 2.5 자체가 `>=3.12` 를
>    요구하므로 상한을 떼는 것은 곧 3.11 지원을 버리는 것이다. 둘을 따로 정할 수 없다
> 2. 그 의존성을 낮은 버전으로 고정한다 — M4 에서 잘 늙지 않는 선택이다
>
> **M4 를 시작하면 제일 먼저 이것을 확인하라** (해석 순서상 나중에 발견하면
> 패키지 구성을 다시 짜야 한다):
>
> ```bash
> uv add --dry-run torch diffusers transformers   # numpy 하한이 얼마인지 본다
> ```
>
> 확인 결과가 "3.12 강제" 라면 그것은 `AGENTS.md` 기술 스택("Python 3.11+")을
> 바꾸는 일이므로 **사용자 확인이 필요하다.** 에이전트가 임의로 올리지 말 것.

### 2026-08-15 · Claude Code · `Image.T` 제거 — 런타임 타입은 소유한 팩이 준다

- **결정**: `CatalogType.T` 를 **없앴다.** 런타임 타입은 그 표현을 소유한 노드 팩이
  제공한다 (`nodal_nodes_image.ImageArray`). `design.md` §4.2 예제와 §4.4 를 갱신했다
- **이유**: `.T` 는 core 에서 언제나 `Any` 인데 **`Any` 라는 사실이 쓰는 쪽에서
  보이지 않는다.** `Image.T` 라고 적으면 타입을 적은 것처럼 보이지만 실제로는
  이미지가 흐르는 바로 그 자리에서 검사를 끈다. §4.2 예제가 그 표기를 쓰고 있었으니
  노드 저자가 따라 하면 전부 검사 밖이 됐다 — 사용자가 이 점을 지적했다.
  `Any` 가 맞는 자리라면 `typing.Any` 를 그대로 쓰는 편이 낫다. 최소한 보이니까
- **일반 규칙으로 정한 이유**: `Model.T`·`VAE.T` 도 M4 에서 똑같은 함정이 된다.
  개별 사례가 아니라 규칙 자체를 없애는 것이 맞다. 팩이 제공하는 별칭의 이름 규칙도
  같이 정했다 — 텐서는 `<Type>Array`, 불투명 핸들은 `<Type>Handle`, 최상위 export
- **카탈로그 이름은 클래스로 유지한다.** 원래 근거(`.T` 를 mypy 가 받게 하려면
  클래스 속성이어야 함)는 사라졌지만, **타입마다 docstring 이 붙을 자리**라는 다른
  근거가 있다. 인스턴스로 되돌리는 것은 가능하되 M1 동결 표면을 다시 건드리는 값을
  하지 않는다. `design.md` §4.4 에 이 사정을 그대로 적어 뒀다
- **사용자 정정**: 사용자가 "계약 때 실제 타입으로 하기로 했다" 고 했으나 계약은
  "core 에 두되 순수 별칭"(= `Any`)이었다. 확인 후 사용자가 정정했고 core 중립성을
  우선하기로 했다
- **영향 범위**: `packages/core/src/nodal/types.py`, `packages/core/tests/test_schema.py`,
  `packages/nodes-image/src/nodal_nodes_image/__init__.py`, `docs/design.md` §4.2·§4.4
- **되돌릴 수 있나**: 예 — 다만 되돌릴 이유가 없다

### 2026-08-15 · Claude Code · 생성물은 원본과 같은 커밋에서 재생성

- **결정**: `AGENTS.md` 협업 규칙 8 추가. `schemas/openapi.json` 을 바꾼 커밋이
  `apps/web/src/api/generated.ts` 도 함께 재생성한다
- **이유**: "손으로 편집하지 않는다" 와 "재생성하지 않는다" 는 다르다. 나누면 그
  사이 커밋마다 CI 의 drift 검사가 실패한다. M3 계약 커밋에서 실제로 이 혼동으로
  설명 문구를 고치지 못한 채 남겨 뒀었다
- **영향 범위**: `AGENTS.md`, `schemas/openapi.json`, `apps/web/src/api/generated.ts`
- **되돌릴 수 있나**: 예

### 2026-08-14 · Claude Code · M3 백엔드 구현

계약(`56baaad`·`374e6fd`)을 구현했다. 프론트가 병렬로 작업 중이라
`apps/web/`·`schemas.py`·`openapi.json`·`types.json` 은 **건드리지 않았다.**

- **`packages/nodes-image` 신설** (워크스페이스 4번째 파이썬 패키지). `core` 에만
  의존하고 **numpy·Pillow 는 여기서만** 쓴다. import 하는 것만으로
  `register_preview_encoder` 가 ndarray→PNG 인코더를 등록한다
- **노드 7종**: Load · Save · Resize · Crop · Blend · Mask · Composite.
  전부 `float32` 0..1 · `(B,H,W,C)` 계약을 지키고 범위 밖 값은 클립한다
- **`FileAssetStore`**: `<root>/ab/<hash>` + 사이드카 `.json`. 앞 두 글자로 샤딩하는
  이유는 한 디렉토리에 파일이 수만 개 쌓이면 파일시스템이 느려지기 때문이다.
  쓰기는 임시 파일 + `os.replace` 로 원자적 — 중간에 죽어도 반쯤 쓰인 파일이
  해시 이름으로 남지 않는다. 인메모리 `AssetStore` 는 테스트용으로 남겨 뒀다
- **PNG `iTXt`**: 쓰기는 `nodes-image`(Pillow), 읽기는 `nodal_server.png`(**표준
  라이브러리만**). 서버는 Pillow 를 의존하지 않으므로 청크 파서를 직접 썼다 —
  픽셀은 건드리지 않고 텍스트 청크만 읽는다. 같은 키워드가 여러 번 나오면 처음
  것을 쓴다(뒤에 덧붙여 앞의 워크플로를 덮어쓰지 못하게). zip 폭탄 상한 16MB
- **`nodal run --pack MODULE --assets DIR`**: 팩을 **모듈 이름으로 늦게** import 해
  `nodes-core → nodes-image` 정적 의존성을 만들지 않는다. `--assets` 도
  `nodal_server` 를 늦게 import 한다 (`serve` 가 uvicorn 에 쓰는 패턴과 같다).
  팩 자동 발견은 M6 확장 시스템의 몫이다

**사용자 확인 후 바꾼 것 (core 공개 표면)**

- **`NodeContext.graph_json()` · `graph_version()` 추가**. Save 노드가 캐논 그래프를
  `iTXt` 로 심으려면 그래프에 닿아야 하는데 통로가 없었다. **추가만** 했으므로
  프론트가 쓰는 `openapi.json`·`generated.ts` 는 그대로다. 문자열을 돌려주므로
  노드가 그래프를 고칠 수 없다 — 실행 중 그래프 변경은 `Expanded` 의 몫이다

**임의로 판단한 것 (사용자 확인 없이, 공개 표면 아님)**

- **`_output_refs` 가 `AssetRef` 출력을 그대로 쓴다**. 노드가 이미 저장소에 넣고
  참조를 돌려준 경우(Save)에 다시 인코딩하면 **워크플로가 심긴 PNG 대신 맨 PNG 가
  하나 더** 생긴다. private 함수의 동작이고 전송 형태는 그대로다
- **mypy 가 numpy 스텁을 따라가지 않게 했다**. numpy 2.5 의 스텁은 PEP 695 `type`
  문을 쓰는데 mypy 는 `python_version < 3.12` 에서 그 문법을 파싱하지 못해 스텁
  자체에서 syntax error 를 낸다. `requires-python = ">=3.11"` 을 유지하려고
  대상 버전을 올리는 대신 numpy 만 `follow_imports = "skip"` 으로 뒀다.
  **대가: nodes-image 안에서 `np.ndarray` 가 Any 다**

**검증 (브라우저 없이)** — 요청받은 네 가지를 전부 실제로 돌려 확인했다.

1. CLI 로 Load→Resize→Save (64x48 → 16x12) 실행, 디스크에 PNG 저장 확인
2. 저장된 PNG 를 `POST /api/graph/from-png` 에 넣어 그래프 복원 → 노드 3개·링크·
   그래프 id·한글 `meta.title` 까지 보존. **복원한 그래프를 그대로 재실행(202)** 까지 확인
3. `--twice` 재실행에서 `load`·`resize` 캐시 히트, `save` 만 재실행
   (Save 는 `cacheable=False` — 저장은 부수효과라 건너뛰면 안 된다)
4. `node.preview` 가 세 노드 모두에서 나가고 픽셀 크기가 실린다

- **영향 범위**: `packages/nodes-image/**`(신규), `packages/server/src/nodal_server/{assets,png,app}.py`,
  `packages/core/src/nodal/{events,executor}.py`, `packages/nodes-core/src/nodal_nodes_core/cli.py`,
  `pyproject.toml`, `docs/roadmap.md`
- **되돌릴 수 있나**: 예 — 계약을 바꾸지 않았으므로 구현만 되돌리면 된다

> ⚠️ **프론트 담당에게**: 계약은 그대로다. `generated.ts` 재생성이 필요 없다.
> 다만 `POST /api/graph/from-png` 가 **이제 실제로 동작한다** (501 아님).
> OpenAPI 의 설명 문구는 아직 "501 을 돌려준다" 라고 되어 있다 — 그것을 고치면
> `openapi.json` 이 바뀌어 `generated.ts` 가 stale 이 되므로 건드리지 않았다.

### 2026-08-14 · Claude Code · `tools/ci-local.sh` — CI 를 파싱해서 실행한다

- **결정**: 커밋 전 검사 스크립트를 추가하되, 명령 목록을 스크립트에 적지 않는다.
  `.github/workflows/ci.yml` 을 파싱해 각 잡의 `run:` 블록을 그대로 꺼내 실행한다.
  로컬 대응물이 없는 단계(액션 단계, PR 전용 `dco` 잡)는 건너뛰고 **무엇을 왜 건너뛰었는지
  끝에 나열한다** — 조용히 빠지면 스크립트가 거짓 안심을 준다
- **이유**: 사용자 지시는 "ci.yml 의 복사본으로 만들지 마"였다. 복사본은 반드시 어긋난다 —
  `AGENTS.md` 가 CLAUDE.md/AGENTS.md 에 대해, 코딩 컨벤션이 `types.json` 에 대해
  말하는 것과 같은 원칙이다. 검사를 CI 에만 추가하고 로컬 스크립트에 옮기는 걸 잊으면
  "로컬은 초록, CI 는 빨강"이 다시 생긴다. 파싱하면 그 실패 모드 자체가 없어진다
- **의존성 추가**: `pyyaml>=6.0` 을 dev 그룹에 넣었다. uv.lock 에 이미 전이 의존성으로
  들어와 있었지만 **선언되지 않은 것에 기대면 락 갱신 때 조용히 사라진다.**
  MIT 라이선스라 라이선스 가드에 걸리지 않는다
- **검증**: 초록을 믿지 않고 빨강을 확인했다. (1) `LICENSE` 를 치우고 실패 확인,
  (2) `LicenseRef-UNDECIDED` 를 되살려 실패 확인, (3) **`ci.yml` 에만 실패 단계를
  추가하고 스크립트를 고치지 않은 채 잡히는지 확인** — 셋 다 의도대로 빨강이 됐고
  종료 코드도 1 이었다
- **개발 중 잡은 버그 (기록해 둘 가치가 있음)**: 처음 구현은 `read` 로 필드를 나눴는데
  `read` 는 첫 개행에서 자른다. 그래서 여러 줄짜리 `run:` 블록이 **첫 줄만 실행되고
  통과로 보고됐다** — 이 스크립트가 막으려던 바로 그 거짓 통과를 스크립트 자신이
  저지르고 있었다. 파라미터 확장으로 바꿔 고쳤다
- **영향 범위**: `tools/ci-local.sh`(신규), `pyproject.toml`(dev 의존성),
  `docs/dev.md`, `AGENTS.md` 코딩 컨벤션
- **되돌릴 수 있나**: 예 — 파일 하나와 dev 의존성 하나다

### 2026-08-14 · Claude Code · M3 이미지 계약 (사용자 확인 후 확정)

`docs/design.md` §4.3 과 roadmap M3 만으로는 답이 안 나오는 지점 7개를 **사용자에게
물어 확정**했다. 임의 해석하지 않았다. 산출물은 `design.md` §4.4~4.6 · §6 과
`schemas/openapi.json` 이다. **계약만 확정했고 구현은 다음 단계다.**

- **Image 런타임 표현 = numpy `(B,H,W,C)` float32 0..1.** `types.json` 은 이미
  `Tensor[uint8|float32, (B,H,W,C)]` 였는데 §4.2 예제는 `image.resize(...)` 를
  불렀다 — 그건 PIL API 라 배치가 없다. **둘이 모순이었다.** types.json 이 이미
  프론트가 쓰는 계약이라 그쪽을 살리고 예제를 고쳤다. PIL 은 Load/Save 안에서만 쓴다
- **`Image.T` 때문에 카탈로그 이름이 클래스가 됐다.** design.md 가 `Image.T` 를 쓰는데
  코드에 없었다. 그런데 **mypy 는 인스턴스 속성을 타입 어노테이션으로 받지 않는다**
  (`Name "Image.T" is not defined`). 클래스 속성이어야만 하고, 노드 팩도 mypy 범위라
  (2026-08-13 결정) 우회할 수 없다. 실제로 4가지 형태를 만들어 검증하고 확인했다.
  프리미티브와 `Any` 는 인스턴스로 남는다 — 런타임 타입이 `int` 등이라 `.T` 가 무의미
- **M1 동결 표면은 `as_type()` 강제변환으로 지켰다.** Codex 의 M1 테스트가
  `is_compatible(Image, Image)` · `ListType(Image)` 로 **이름을 값으로** 쓴다.
  이름을 클래스로 바꾸면 깨지는데 그 테스트는 동결 계약이라 손댈 수 없다.
  `is_compatible` · `ListType` · `UnionType` · `to_type_expr` 네 입구에서 정규화해
  **M1 테스트를 한 줄도 고치지 않고** 통과시켰다
- **AssetStore = core 인터페이스 + server 구현.** 이미지 저장 노드가 저장소에 닿아야
  하는데 노드 팩은 `core` 만 의존한다. 구현까지 core 에 넣으면 도메인 중립 엔진에
  파일시스템 정책이 들어온다. 노드는 `ctx.assets` 로 접근한다.
  **픽셀 크기는 넣는 쪽이 알려준다** — 저장소가 이미지를 해석하면 범용 바이트
  저장소가 아니게 된다
- **`OutputRef.asset` 을 해시 문자열 → `AssetRef` 구조체로.** 프론트가 노드 안에
  프리뷰를 그리려면 이미지를 **받기 전에** 크기를 알아야 레이아웃이 안 튄다
- **`node.preview` 를 판별 가능한 유니온으로.** `image: string` 에 "base64 or asset
  ref" 주석만 있었다 — 받는 쪽이 구분할 방법이 **없었다.** `kind` 로 나눈다.
  중간 프리뷰는 `inline`, 최종 출력은 `asset` — 스텝마다 나오는 프리뷰를 저장소에
  넣으면 content-addressed 저장소가 오염된다
- **프리뷰 인코딩은 노드 팩이 등록한다.** core 는 numpy 를 모르고 server 도 `core` 만
  의존한다. `register_preview_encoder()` 로 노드 팩이 넣고 core 는 부르기만 한다 —
  `register_combo_provider()` 와 같은 패턴이다
- **PNG tEXt: 키워드 `nodal_workflow`, 복원은 서버.** `workflow` 는 다른 노드 도구가
  흔히 쓴다. 파서를 Python·TS 양쪽에 두면 "규칙을 두 번 쓰지 않는다" 위반이라
  `POST /api/graph/from-png` 한 곳에 둔다 (지금은 501)

**발견한 것 — `NodeResult.preview` 는 M2 까지 아무 데도 가지 않았다.** `_classify` 가
값만 꺼내고 프리뷰를 버렸다. 경로가 "약하다"가 아니라 **아예 없었다.**
`run_node` 가 `ctx.preview()` 를 부르도록 이었다.

**다른 에이전트 파일을 건드린 것 (AGENTS.md 협업 규칙 6)**:
- `apps/web/src/state/editorStore.ts` 1줄 (`event.image` → `previewSrc(event.preview)`)
  과 `api/types.ts` 에 `previewSrc`·`previewSize` 추가. 계약이 바뀌면 프론트가
  컴파일되지 않아 CI 가 빨개진다. **최소 수정만** 했고 렌더링 로직은 그대로다
- `packages/server/tests/test_openapi_export.py` 의 왕복 테스트를 `as_type(Image)` 로
  정규화. 이 파일은 내가 M2 계약에서 쓴 것이다
- `packages/core/tests` 는 **한 줄도 건드리지 않았다**

**`__all__` 에 `# noqa: RUF022`**: 그룹이 하나 늘자 RUF022 가 전역 알파벳 정렬을
요구했다. 그러면 `# --- 캐시` 아래 `MISS` 만 남고 `Cache` 는 다른 그룹으로 흩어진다.
그 목록은 M1 계약의 목차라고 파일이 스스로 적어 두었으므로 목차를 지켰다. 그룹 **안**은
정렬을 유지한다.

**의존성 추가 없음.** numpy·Pillow 는 M3 **구현** 단계에서 `nodes-image` 에 들어간다.
core 는 여전히 `pydantic` 하나뿐이다.

- **영향 범위**: `packages/core/src/nodal/{types,schema,events,executor,assets,preview,__init__}.py`,
  `packages/server/src/nodal_server/{schemas,app,wire}.py`, `schemas/openapi.json`,
  `apps/web/src/api/{types.ts,generated.ts}`, `apps/web/src/state/editorStore.ts`,
  `docs/design.md` §4.2·§4.4~4.6·§6
- **되돌릴 수 있나**: **아니오** — M3 프론트를 다른 에이전트가 이 산출물로 작성한다.
  바꾸려면 사용자 확인이 필요하다 (AGENTS.md 협업 규칙 7)

> ⚠️ **프론트 담당에게**: `schemas/openapi.json` 이 바뀌었다. `generated.ts` 는 이
> 커밋에서 재생성해 두었다. `OutputRef.asset` 이 **문자열이 아니라 객체**이고
> `node.preview` 가 `image: string` 이 아니라 `preview: {kind, ...}` 다.
> `previewSrc()` · `previewSize()` 를 `api/types.ts` 에 넣어 뒀으니 프리뷰 위젯은
> 그것을 쓰면 된다.

### 2026-08-14 · Claude Code · 라이선스 Apache-2.0 확정 (사용자 결정)

- **결정**: 라이선스를 **Apache-2.0** 으로 확정했다. 저작권자는 정태우 (twcheong99@gmail.com).
  `LICENSE`(전문) · `NOTICE`(§4(d) 귀속 고지)를 만들고, `LicenseRef-UNDECIDED` 와
  "license 필드는 의도적으로 비어 있다" 주석을 전부 걷어냈다.
  **이것은 에이전트의 판단이 아니라 사용자의 결정이다** — 라이선스는 `decisions.md` 상단의
  "기록 대신 사용자에게 물어보는" 항목이고, 실제로 사용자가 지시했다
- **이유** (상세는 `docs/license.md`):
  1. **플러그인 생태계** — nodal 은 플러그인 기반 도구다. GPL/AGPL 이면 같은 프로세스에
     로드되는 플러그인이 파생 저작물로 해석되어 `design.md` §8 의 확장 구조(M6)가
     법적 회색지대에 놓인다. Apache-2.0 이면 플러그인 저자가 자유롭게 라이선스를 붙인다
  2. **특허 허여(§3)** — MIT 와 실질 동일하지만 명시적 특허 조항이 있다.
     이미지 생성은 특허 활동이 활발한 영역이라 기업 채택의 실제 장벽을 낮춘다.
     MIT 를 탈락시킨 유일한 차이가 이것이다
  3. **스택 일관성** — `diffusers`·`transformers`·`accelerate`·`safetensors` 가 전부
     Apache-2.0 이다. 모델 계층을 `diffusers` 에 위임하는 핵심 설계 결정 6번과 맞물린다
  4. **포기한 것**: ComfyUI(GPL-3.0) 코드 참조. 손실이 작다 — 절대 규칙 1로 처음부터
     복사를 금지해 왔고 모델 계층은 위임했다. AGPL 은 "SaaS 로 팔리는 것을 막는" 동기보다
     생태계 성장을 택해 탈락
- **언제부터 되돌릴 수 없나** — 잠기는 시점이 셋이고 **가장 먼저 오는 것은 외부 기여 수락이다**:
  - **첫 외부 기여 수락 → 여기서 잠긴다.** 기여자 전원 동의 없이는 재라이선스 불가.
    DCO 는 기여할 권리를 확인할 뿐 재라이선스 권한을 넘기지 않는다 (그것은 CLA 다).
    **즉 외부 기여를 받기 시작하는 순간 Apache-2.0 은 사실상 최종이다**
  - 첫 공개 배포(≈ M3) → 그 버전은 영구히 Apache-2.0. 회수 불가
  - 첫 GPL 코드 복사 → 배포물이 즉시 자기 `LICENSE` 와 모순된다
  - **현재는 셋 다 발생 전이므로 아직 되돌릴 수 있다** (단독 저작권자, 미배포)
- **절대 규칙 변경**: `AGENTS.md` 절대 규칙 2("라이선스 파일을 만들지 않는다")를 **삭제**하고
  3번(비공개 전제)을 2번으로 당겼다. 규칙 1(ComfyUI 복사 금지)은 **유지하되 이유를 갱신**했다 —
  예전에는 "선택지를 살려두기 위해"였지만 이제는 "이미 한 약속을 지키기 위해"다.
  Apache-2.0 과 GPL-3.0 은 한 방향으로만 호환되므로 위반의 결과가 더 나빠졌다
- **CI 반전**: `licence-guard` 의 "LICENSE 파일이 없는지 확인"을 "`LICENSE`·`NOTICE` 가
  있는지 확인"으로 뒤집고, `LicenseRef-UNDECIDED` 잔존 검사를 추가했다.
  GPL/AGPL 의존성 검사는 그대로 유지 — 확정 이후 더 중요해졌다
- **소스 헤더는 붙이지 않는다**: Apache-2.0 §4 는 파일 헤더를 요구하지 않는다
  (APPENDIX 는 권고다). 한국어 docstring 이 많은 이 저장소에서 헤더는 노이즈만 키운다
- **영향 범위**: `LICENSE`(신규), `NOTICE`(신규), `AGENTS.md`, `docs/license.md`(재작성),
  `docs/{roadmap,design}.md`, `NOTICE-provenance.md`, `package.json`,
  `apps/web/package.json`, `pyproject.toml` ×4, `.github/workflows/ci.yml`
- **되돌릴 수 있나**: **지금은 예 — 위 세 시점 전까지만.** 그 다음부터는 아니오

### 2026-08-14 · Codex · M2 스펙 모호 — 실행 실패의 터미널 WS 이벤트

- **상태**: **해소됨** — `0a24ba6`에서 `run.failed`가 추가되어 아래 임시 해석을 대체한다.

- **결정**: `node.error`를 받은 실행은 뒤이어 `run.done`이 와도 프론트 상태를 `failed`로
  유지한다. `run.done`은 전송 완료 신호로만 취급한다.
- **이유**: `RunStatus`에는 `failed`가 있지만 `WsEvent` 유니온에는 `run.failed`가 없고,
  `node.error` 이후 어떤 터미널 이벤트가 오는지 design.md §6에 명시되지 않았다. 오류를
  성공으로 덮는 것보다 노드 오류를 보존하는 해석이 사용자에게 안전하다.
- **영향 범위**: `apps/web/src/state/editorStore.ts`, 목 실행 클라이언트
- **되돌릴 수 있나**: 예 — `run.failed` 이벤트가 계약에 추가되면 그 이벤트로 전환한다.

### 2026-08-16 · Claude Code · 1st-party 노드 팩을 모든 CLI 명령에서 기본 로드

- **결정**: `DEFAULT_OPTIONAL_PACKS = ("nodal_nodes_image",)` 를 두고 `run`·`validate`·
  `nodes`·`serve` 가 **설치되어 있으면** 이 팩을 자동으로 올린다. `serve` 에 `--pack` 과
  `--assets` 를 추가했다 (`run` 에만 있었다). 서드파티 팩은 여전히 `--pack` 으로만 들어온다.
- **이유**: `nodal serve` 가 `_build_registry()` 를 인자 없이 불러서 **브라우저 팔레트에
  이미지 노드가 하나도 뜨지 않았다.** `/api/nodes` 가 팔레트의 유일한 출처이므로 M3 기능
  전체(이미지 노드 · 프리뷰 · PNG 워크플로 복원)가 UI 에서 도달 불가였다. 깨끗한 체크아웃에서
  확인한 실제 증상이고, 테스트는 레지스트리를 직접 만들어 넘기므로 잡히지 않았다.
  - **왜 `serve` 만 고치지 않았나**: `nodes` 에는 보이는데 `run` 은 "등록되지 않은 노드
    타입"으로 실패하거나, CLI 로는 되는데 브라우저에는 없는 상태가 가장 나쁘다.
    명령마다 다른 레지스트리를 갖는 것 자체가 버그의 원인이다
  - **M6 팩 자동 발견과 다르다**: 이름이 소스에 박혀 있고 같은 워크스페이스에서 함께
    배포되는 팩뿐이다. 발견 *규칙* 이 아니라 이 애플리케이션의 구성 *선언* 이다
  - **아키텍처 규칙은 유지된다**: 문자열로 늦게 import 하고 없으면 조용히 넘어간다.
    `nodal-nodes-core` 는 `nodal-nodes-image` 를 정적으로 의존하지 않는다.
    같은 파일의 `_build_asset_store()` 가 `nodal_server` 를 다루는 방식과 같다
- **함께 고친 것**: `serve` 가 `create_app(assets_root=...)` 를 넘기지 않아 Save 결과가
  메모리에만 남았다. `--assets` 를 주지 않으면 시작할 때 그렇다고 알린다
- **영향 범위**: `packages/nodes-core/src/nodal_nodes_core/cli.py`
- **되돌릴 수 있나**: 예 — 상수를 비우면 이전 동작이다

### 2026-08-16 · Claude Code · 프론트 개발 서버 기본값을 live 로

- **결정**: `apps/web/.env` 를 추가해 `VITE_NODAL_API_MODE` 의 기본값을 `live` 로 바꿨다.
  목은 `VITE_NODAL_API_MODE=mock pnpm ... dev` 로 옵트인한다.
- **이유**: 기본이 목이면 `pnpm dev` 로 띄운 화면이 실서버에 붙은 것처럼 보이지만 실제로는
  아무것도 실행하지 않는다 — **조용히 틀린다.** `vite.config.ts` 가 이미 `/api` 와 `/ws` 를
  `127.0.0.1:8188` 로 프록시하고 있고, 그 프록시는 live 모드에서만 의미가 있다.
  즉 설정 파일이 이미 live 를 전제하고 있었고 기본값만 어긋나 있었다.
  `roadmap.md` M2 완료 기준도 사람이 매번 손으로 env 를 붙여 확인한 기록이다.
- **영향 범위**: `apps/web/.env` (신규). `createGraphApiClient()` 의 호출자는 `App.tsx`
  하나뿐이고 테스트는 목/HTTP 클라이언트를 직접 만들므로 영향받지 않는다.
- **되돌릴 수 있나**: 예 — 파일을 지우면 이전 동작(목 기본)이다

### 2026-08-16 · Claude Code · 휠에 LICENSE·NOTICE 포함

- **결정**: `LICENSE` 와 `NOTICE` 를 `packages/*` 각각에 복사하고 네 `pyproject.toml` 에
  `license-files = ["LICENSE", "NOTICE"]` 를 추가했다. 사본이 루트와 같은지는 CI 의
  `licence-guard` 가 `cmp` 로 검사한다.
- **이유**: `docs/license.md` 가 "M3 배포 전에 할 일"로 남겨둔 항목이다. hatchling 은 각
  패키지 디렉토리 안에서만 라이선스 파일을 찾으므로 휠의 `.dist-info/licenses/` 가 비어
  있었고 (확인함), 그 상태로 배포하면 Apache-2.0 §4(a) 를 만족하지 못한다.
  저장소를 남에게 넘기는 시점이므로 지금 닫는다.
  - **사본을 두는 것이 "규칙을 두 번 쓰지 않는다"와 충돌하지 않나**: 충돌한다. 그래서
    사람의 기억 대신 CI 검사를 붙였다. 심볼릭 링크는 Windows 에서 깨질 수 있어 피했다
- **영향 범위**: `packages/*/LICENSE`, `packages/*/NOTICE` (신규 8개),
  `packages/*/pyproject.toml`, `.github/workflows/ci.yml`, `docs/license.md`
- **되돌릴 수 있나**: 예 — 다만 되돌리면 배포물이 §4(a) 를 위반한다
