# nodal — 설계 스펙

이 문서는 **구현 스펙**이다. ComfyUI 소스를 열어보는 대신 이 문서를 보고 구현한다.

- 스택: Python 백엔드(FastAPI + WebSocket) + 웹 프론트엔드(React + TypeScript)
- 참조 대상: ComfyUI (GPL-3.0) — **아키텍처만 참조. 코드 복사 금지.** `../AGENTS.md` 참조.

---

## 0. 난이도 지도

| 영역 | 난이도 | 판단 |
|---|---|---|
| 그래프 실행 엔진 | 중 | **핵심 가치. 직접 만든다.** ~2,000줄 |
| 노드 SDK / 타입 시스템 | 중 | 직접 만든다. ComfyUI를 이길 수 있는 지점 |
| 프론트엔드 노드 캔버스 | 중상 | 라이브러리 사용. 직접 만들면 프로젝트가 여기서 죽는다 |
| 서버 / 큐 / 이벤트 | 하 | 직접 만든다 |
| **Diffusion 모델 구현** | **극상** | **직접 만들지 않는다.** `diffusers`에 위임 |
| VRAM / 오프로딩 | 상 | 1차는 `accelerate`에 위임 |

**전략**: ComfyUI의 진짜 자산은 UI가 아니라 수십 개 모델 아키텍처 구현과 VRAM 곡예다. 수년치 작업이고 재현할 이유가 없다. nodal은 모델 계층을 `diffusers`에 위임하고 **그래프 엔진과 UX에 전부를 건다.**

---

## 1. 설계 근거 — 무엇을 계승하고 무엇을 버리는가

### 1.1 계승할 아이디어 (검증된 설계)

**① 위상 정렬 "용해(dissolve)" 실행 — 전체 정렬 아님**

실행 전에 전체 순서를 확정하지 않는다. 매 스텝마다 "지금 실행 가능한 노드 집합"을 계산하고 하나를 고른다. 노드가 실행 도중 그래프를 확장해도 대응된다.

유지할 상태:
- `pending`: 아직 실행 안 된 노드
- `block_count[node]`: 이 노드를 막고 있는 노드 수
- `blocking[node]`: 이 노드가 막고 있는 노드들

**② 출력 노드 우선 선택 휴리스틱**

총 실행 시간은 동일하지만 프리뷰가 먼저 뜨면 체감 속도가 완전히 다르다. 준비된 노드 중 선택 우선순위:
1. 출력 노드 또는 async 노드
2. 출력 노드를 막고 있는 노드
3. 그 위 단계 (2-hop)
4. 아무거나

**③ 입력 시그니처 기반 캐시**

캐시 키 = `(노드 타입, 해석된 입력값의 재귀 해시)`. 노드 ID가 아니라 **입력의 내용**으로 키를 만들기 때문에 노드를 복사하거나 순서를 바꿔도 캐시가 산다. 사용 경험의 절반이 여기서 나온다.

**④ `ExecutionBlocker` 센티넬**

조건 분기를 별도 제어 흐름 없이 구현하는 트릭. 노드가 실제 값 대신 `ExecutionBlocker`를 반환하면 그 값을 받은 하위 노드는 실행되지 않고 블로커를 그대로 전파한다. 데이터 흐름 그래프에 if를 얹는 가장 저렴한 방법.

**⑤ Lazy 입력**

입력을 `lazy=True`로 선언하면 upstream이 즉시 평가되지 않는다. 노드가 "지금 나는 A만 필요하다"고 말하면 B 브랜치는 아예 실행되지 않는다. Switch/Router 노드의 기반.

**⑥ 이미지 메타데이터에 워크플로 임베딩**

PNG `iTXt` 청크에 워크플로 JSON을 넣어 이미지 파일 자체가 재현 가능한 레시피가 된다. 커뮤니티 문화의 근원. 반드시 넣는다.

**⑦ `IS_CHANGED` 훅**

파일 로더, 랜덤 시드처럼 외부 상태에 의존하는 노드가 "내 입력은 같지만 결과는 바뀐다"고 알리는 탈출구.

### 1.2 버릴 부채

**① 이중 그래프 포맷 — 가장 큰 부채**

ComfyUI에는 두 개의 그래프 표현이 있다. 프론트가 저장하는 워크플로 JSON(좌표·색상·링크 ID 포함)과 백엔드가 실행하는 프롬프트 JSON. 프론트가 매번 변환하고, 둘이 어긋나면 지옥이 열린다.

> **nodal**: 캐논 포맷은 **하나**. UI 상태는 같은 문서의 `ui` 필드에 격리하고 백엔드는 통째로 무시한다. 변환 레이어 없음.

**② 문자열 기반 소켓 타입**

`"IMAGE"`, `"MODEL"` 같은 자유 문자열. 제네릭도 구조적 서브타입도 리스트 타입도 없다. 그래서 커스텀 노드 저자들이 `"*"` 와일드카드를 직접 만들고 `__ne__`를 오버라이드하는 해킹이 생태계 표준이 됐다.

> **nodal**: 구조화된 타입 서술자. §4.3 참조.

**③ 딕셔너리-튜플 노드 스키마**

타입 힌트 없음, IDE 자동완성 없음, 오타는 런타임에야 발견.

> **nodal**: 처음부터 선언형 + Python 타입 힌트. 마이그레이션 부채를 만들지 않는다.

**④ 나머지**

- 노드 ID가 순번 문자열(`"3"`, `"7"`) → UUID
- 전역 `NODE_CLASS_MAPPINGS` 딕셔너리 → 레지스트리 객체
- 커스텀 노드가 `sys.path`에 직접 import되고 monkeypatch 가능 → 매니페스트 기반 로딩
- 프론트 확장이 백엔드 패키지에 섞여 배포 → 명확한 분리

---

## 2. 설계 원칙

1. **하나의 캐논 그래프 포맷.** 백엔드가 실행하는 것과 프론트가 저장하는 것이 같은 문서.
2. **타입은 런타임 이전에 검증한다.** 큐 진입 전 전체 그래프를 타입 체크하고, 실패하면 어느 노드 어느 소켓인지 정확히 지목한다.
3. **엔진은 도메인을 모른다.** `core`는 torch를 import하지 않는다.
4. **캐시는 기본값이지 최적화가 아니다.** 파라미터 하나 바꿨을 때 그 노드 아래만 재실행되는 게 정상 동작.
5. **모든 장기 작업은 취소 가능하고 진행률을 보고한다.**
6. **확장은 매니페스트로 관리한다.**

---

## 3. 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│  apps/web  (Vite + React + TypeScript)                   │
│  ├─ 캔버스 (@xyflow/react)                                │
│  ├─ 노드 팔레트 / 검색                                     │
│  ├─ 그래프 스토어 (Zustand + Yjs CRDT)                     │
│  └─ 실행 클라이언트 (REST + WebSocket)                     │
└───────────────┬─────────────────────────────────────────┘
                │  HTTP / WS
┌───────────────┴─────────────────────────────────────────┐
│  packages/server  (FastAPI + uvicorn)                    │
│  ├─ REST: /nodes, /graph, /runs, /models, /assets        │
│  ├─ WS:   진행률 · 프리뷰 · 로그 · 큐 상태                  │
│  └─ 실행 큐 (단일 워커, 우선순위 지원)                       │
└───────────────┬─────────────────────────────────────────┘
                │
┌───────────────┴─────────────────────────────────────────┐
│  packages/core   (순수 Python — torch 의존 없음)          │
│  ├─ graph.py      캐논 그래프 · 검증 · 순회                │
│  ├─ schema.py     노드 스키마 · 타입 시스템                │
│  ├─ registry.py   노드 등록 · 확장 로딩                    │
│  ├─ executor.py   실행 루프 · 확장 · lazy · 블로커          │
│  ├─ cache.py      입력 시그니처 캐시                       │
│  └─ events.py     진행률 · 취소 토큰                       │
└───────────────┬─────────────────────────────────────────┘
                │
┌───────────────┴─────────────────────────────────────────┐
│  노드 패키지 (플러그인)                                     │
│  ├─ packages/nodes-core        유틸 · 수학 · 문자열 · 파일  │
│  ├─ packages/nodes-image       PIL/numpy 이미지 처리       │
│  └─ packages/nodes-diffusion   diffusers 래핑 (torch 여기만)│
└───────────────┬─────────────────────────────────────────┘
                │
┌───────────────┴─────────────────────────────────────────┐
│  런타임 서비스                                             │
│  ├─ ModelManager   로딩 · 캐시 · 오프로딩 · 참조 카운트      │
│  ├─ AssetStore     content-addressed 중간 산출물           │
│  └─ Paths          모델 · 출력 · 입력 디렉토리 해석          │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 데이터 모델

### 4.1 캐논 그래프 포맷

```jsonc
{
  "nodal_version": "1",
  "id": "018f2c...",              // UUID
  "nodes": {
    "n_a1b2": {
      "type": "image.Resize",      // 네임스페이스 있는 타입 ID
      "inputs": {
        "image":  { "$link": ["n_c3d4", "image"] },  // 링크
        "width":  512,                                // 리터럴
        "method": "lanczos"
      },
      "meta": { "title": "Resize to 512" }
    }
  },
  "outputs": ["n_e5f6"],           // 실행 요청 대상 노드
  "ui": {                          // 백엔드는 전혀 읽지 않음
    "n_a1b2": { "pos": [340, 120], "collapsed": false, "color": "#3a5" },
    "viewport": { "x": 0, "y": 0, "zoom": 1.0 },
    "groups": []
  }
}
```

**포인트**

- 링크가 별도 배열이 아니라 **입력 슬롯에 인라인**. ComfyUI의 위치 기반 튜플 배열(`[id, from_node, from_slot, to_node, to_slot, type]`)은 사람이 읽을 수도 diff할 수도 없다.
- `ui`는 실행에 무관함이 스키마 레벨에서 명시된다. 백엔드는 `ui` 없이도 완전히 동작한다.
- 링크 ID가 없다 → 링크 ID 재할당 버그가 원천적으로 없다.

### 4.2 노드 스키마 (Python SDK)

```python
from nodal import node, Image, Int, Combo, NodeResult
from nodal_nodes_image import ImageArray        # 런타임 타입은 노드 팩이 준다 (§4.4)

@node(
    id="image.Resize",
    title="Resize Image",
    category="image/transform",
    aliases=["scale", "크기 조정"],
)
class Resize:
    image:  Image                                # ← 소켓 **타입**(core 서술자)
    width:  Int   = Int(512, min=1, max=16384, step=8)
    height: Int   = Int(512, min=1, max=16384, step=8)
    method: Combo = Combo("lanczos", options=["nearest", "bilinear", "bicubic", "lanczos"])

    returns = Image

    def run(
        self, image: ImageArray, width: int, height: int, method: str
    ) -> NodeResult:                             # ← run 은 **런타임 타입**을 쓴다
        out = resample(image, (height, width), method)   # (B, H, W, C) 유지
        return NodeResult(out, preview=out)
```

**클래스 어노테이션과 `run` 시그니처는 서로 다른 것을 가리킨다.** 위에서
`image: Image` 는 소켓 타입 서술자이고(팔레트·연결 판정이 이것을 쓴다),
`run` 의 `image: ImageArray` 는 실제로 들어오는 파이썬 값의 타입이다.
같은 이름을 두 번 쓰는 것이 아니라 **다른 층위**를 각각 적는 것이다.

- 클래스 어노테이션이 곧 입력 스키마 → 중복 선언 없음
- `run`은 평범한 함수 시그니처 → 엔진 없이 단위 테스트 가능
- `async def run`도 지원 (엔진이 코루틴 여부 감지)
- `NodeResult`가 값과 UI 사이드채널(프리뷰, 텍스트 배지)을 분리
- **`run` 파라미터에 `Any` 를 쓰지 않는다.** `ImageArray` 를 쓰면 dtype 실수를
  mypy 가 잡는다 — 대표적으로 `uint8 / 255.0` 이 float64 가 되는 정규화 버그 (§4.4)

`Combo.from_provider("checkpoints")`처럼 실행 시점에 옵션을 조회하는 입력은
`register_combo_provider("checkpoints", provider)`로 공급자를 먼저 등록한다.
공급자는 인자 없이 문자열 시퀀스를 반환하며, `Combo.options()`를 호출할 때마다
다시 평가된다.

**출력 이름** — §4.1의 링크는 `["n_c3d4", "image"]`처럼 출력 소켓을 **이름**으로 참조한다. 따라서 이름 없는 출력은 존재할 수 없다.

```python
returns = {"image": Image}                 # 명시 — 이름을 통제하고 싶을 때
returns = {"model": Model, "clip": CLIP}   # 다중 출력
returns = Image                            # 축약 → "image"
returns = (Model, CLIP, VAE)               # 축약 → "model", "clip", "vae"
```

축약형의 이름은 타입 이름을 소문자로 바꿔 만든다. 같은 타입이 반복되면 `image`, `image_2`. 이름이 중요하면 딕셔너리를 쓴다.

**`ctx`는 이름으로 옵트인한다.** `run` 시그니처에 `ctx` 파라미터가 있을 때만 엔진이 실행 컨텍스트(진행률·취소)를 주입한다. 위 `Resize.run`처럼 `ctx`가 없으면 엔진 없이 그냥 호출할 수 있는 순수 함수다. §9의 `LoadCheckpoint.run(self, ckpt, ctx)`가 옵트인한 예다.

### 4.3 타입 시스템 — ComfyUI를 이길 지점

```
Type = Primitive | Tensor | Opaque | List[Type] | Union[Type, ...] | Any

Primitive : INT | FLOAT | STRING | BOOL
Tensor    : dtype + shape 서술 (예: Image = Tensor[float32, (B,H,W,C)])
Opaque    : 이름 있는 불투명 핸들 (Model, VAE, Scheduler) + 능력 태그 집합
```

**호환 규칙**

호환은 항상 방향이 있다: `source`(출력 소켓) → `target`(입력 소켓).

| 규칙 | 예시 |
|---|---|
| 정확 일치 | `Image → Image` |
| 숫자 승격 | `INT → FLOAT` 자동 허용. 역방향은 불허 (정밀도가 조용히 사라짐) |
| 리스트 승격 | `T → List[T]` 자동 (배치 처리 자연스럽게). 역방향 불허 |
| 리스트 공변 | `A → B`가 호환이면 `List[A] → List[B]`도 호환 |
| Union 넓힘 | `A → Union[A, B]` 허용 (대상 멤버 중 하나에 호환이면 됨) |
| Union 좁힘 | `Union[A, B] → A` 불허. 단 **모든** 멤버가 대상에 호환이면 그건 좁힘이 아니므로 허용 (`Union[INT, FLOAT] → FLOAT`) |
| Opaque 능력 기반 | `Model[sdxl, unet]`은 `Model[unet]` 요구 소켓에 연결 가능. 핸들 이름이 다르면 불허 |
| Tensor | 출처 dtype 집합이 대상의 부분집합이고 랭크가 같으면 호환. 라벨(`B`,`H`)과 `null` 차원은 임의 크기, 양쪽이 정수인 차원만 값이 일치해야 함 |
| `Any`는 명시적 | 와일드카드는 1급 타입이지 해킹이 아님. `Any → T`와 `T → Any` 모두 허용 |

이것만으로 ComfyUI 생태계의 최대 마찰 두 가지 — `"*"` 와일드카드 해킹, "SDXL 모델을 SD1.5 노드에 꽂았는데 런타임 shape 에러" — 를 제거한다.

**검증 시점**: 실행 큐 진입 전 전체 그래프 검증. 프론트는 같은 규칙으로 드래그 중 실시간 피드백(연결 불가 소켓은 흐리게).

> ⚠️ 타입 규칙은 `types.json` **단일 소스**에 정의하고 Python/TS 양쪽에서 로드한다. 규칙을 두 번 쓰지 않는다.

`types.json`은 위 호환 규칙과 **내장 타입 카탈로그**(`INT`·`Image`·`Model`…)를 함께 담는다. 프론트가 드래그 중 실시간 피드백을 하려면 규칙만으로는 부족하고 타입 정의도 필요하기 때문이다.

위치는 `packages/core/src/nodal/types.json` — 패키지 안에 있어야 배포본에서도 로드된다. 로더는 `nodal.types`(Python)와 `apps/web/src/graph/typesystem.ts`(TS) 둘뿐이다.

파일에는 `conformance` 절이 있어 (출처, 대상, 기대 판정) 케이스를 담는다. 양쪽 구현이 **같은 케이스로 같은 답**을 내야 하며, 이것이 두 언어가 규칙 하나를 공유한다는 유일한 증거다. Python은 `tools/check_types.py`, TS는 `typesystem.test.ts`가 돌린다.

---

### 4.4 Image 런타임 표현 (M3 계약)

`types.json` 의 서술자는 `Image = Tensor[float32, (B, H, W, C)]` 다. 그것은
**소켓에 무엇이 흐르는지에 대한 서술**이고, 아래는 그 값의 **실제 파이썬 표현**이다.

| 항목 | 확정 |
|---|---|
| 컨테이너 | `numpy.ndarray` |
| 축 순서 | `(B, H, W, C)` — 배치가 언제나 있다. 이미지 한 장도 `B=1` |
| 정본 dtype | `float32`, 값 범위 **0..1** |
| 파일 경계 dtype | `uint8` (0..255) — Load/Save 내부에서만, 소켓에는 흐르지 않음 |
| 채널 | `C ∈ {1, 3, 4}` (L, RGB, RGBA) |
| PIL | Load/Save 노드 **안에서만**. 소켓으로 흐르지 않는다 |

배치 축을 언제나 두는 이유는 배치가 특별 케이스가 되지 않게 하기 위해서다.
"한 장일 때만 다른 shape" 는 M4 의 샘플러가 배치를 돌려주는 순간 전부 분기가 된다.

`Mask` 는 `(B, H, W)` 로 채널 축이 없고, `Latent` 는 `(B, C, H, W)` 로 채널이 앞이다
(diffusers 관례). 셋의 축 순서가 다른 것은 의도적이며 `types.json` 이 그 사실을 담는다.

#### 런타임 타입은 **소유한 노드 팩**이 준다 (일반 규칙)

이것은 `Image` 만의 이야기가 아니다. M4 의 `Model`·`VAE`·`CLIP`, M6 의 확장 타입까지
같은 규칙을 따른다.

| 층위 | 무엇 | 어디 | 예 |
|---|---|---|---|
| 소켓 타입 | 연결 판정·팔레트용 **서술자** | `core` (`types.json`) | `Image`, `Model` |
| 런타임 타입 | `run` 이 실제로 받는 파이썬 값 | **표현을 소유한 노드 팩** | `ImageArray`, `MaskArray` |

```python
from nodal import Image                          # 소켓 타입 — 클래스 어노테이션에
from nodal_nodes_image import ImageArray         # 런타임 타입 — run 시그니처에
```

**core 는 런타임 타입을 제공하지 않는다.** 도메인 중립 그래프 엔진이라 numpy 도
torch 도 import 하지 않기 때문이다 (`AGENTS.md` 아키텍처 절). 그래서 core 가 줄 수
있는 것은 `Any` 뿐이고, `Any` 를 타입처럼 생긴 이름으로 감싸는 것은 **해롭다** —
아래 항목이 그 이유다.

> **`Image.T` 는 없앴다 (2026-08-15).** 한때 core 가 `Image.T = Any` 를 노출했다.
> 문제는 `Any` 라는 사실이 사용하는 쪽에서 보이지 않는다는 것이다. `Image.T` 라고
> 적으면 타입을 적은 것처럼 보이는데 실제로는 **이미지가 흐르는 바로 그 자리에서
> 타입 검사를 끈다.** §4.2 의 예제가 그 표기를 쓰고 있었으므로 노드 저자가 그대로
> 따라 하면 전부 검사 밖이 됐다. `Model.T`·`VAE.T` 도 M4 에서 같은 함정이 되므로
> 규칙 자체를 없앴다.
>
> `Any` 가 정말 맞는 자리라면 `typing.Any` 를 그대로 쓴다. 그러면 최소한 **`Any`
> 라는 사실이 읽는 사람에게 보인다.**

**팩이 제공하는 별칭의 이름 규칙**: 소켓 타입 이름 + 표현. 텐서면 `<Type>Array`
(`ImageArray`·`MaskArray`·`LatentArray`), 불투명 핸들이면 `<Type>Handle`
(M4 의 `ModelHandle`·`VAEHandle`). 팩은 이 별칭을 **최상위에서 export** 한다 —
노드 저자가 내부 모듈 경로를 알 필요가 없어야 한다.

**타입이 잡는 것과 못 잡는 것**은 나눠서 이해해야 한다.

`ImageArray` 는 `np.ndarray[Any, np.dtype[np.float32]]` 라 **dtype 승격**을 잡는다.
대표적인 것이 Load 경계의 정규화다:

```python
def load(u8: np.ndarray[Any, np.dtype[np.uint8]]) -> ImageArray:
    return u8 / 255.0        # ❌ uint8 / float → float64. mypy 가 잡는다
```

`float32 / 255.0` 은 **float32 그대로**이므로 (NEP 50 — 파이썬 스칼라는 약한 타입)
정상이고 잡히지 않는다. 함정은 `uint8` 이 섞이는 자리에만 있다.

반면 **shape·랭크는 타입으로 잡히지 않는다.** numpy 의 타입 시스템이 아직 shape 을
모른다. `a[..., 0]` 로 채널 축을 떨어뜨려도 타입은 그대로 통과한다. 그쪽은
`to_float32` · `ensure_batch` 의 **런타임 검증**이 담당한다. 둘은 대체재가 아니라
분담이다 — dtype 은 타입이, shape 은 런타임이 지킨다.

#### 카탈로그 이름이 클래스인 이유

`Image`·`Mask`·`Latent`·`Model`·`CLIP`·`VAE`·`Scheduler` 는 클래스이고, 프리미티브
(`INT`·`FLOAT`·`STRING`·`BOOL`)와 `Any` 는 인스턴스다.

클래스인 이유는 **타입마다 문서가 붙을 자리**가 필요해서다. 각 클래스의 docstring 이
그 소켓의 런타임 계약(축 순서·dtype·범위)을 적어 두는 유일한 곳이다.

> 원래는 `Image.T` 를 mypy 가 받아들이게 하려면 클래스 속성이어야 했기 때문이다.
> `.T` 를 없앤 지금 그 근거는 사라졌지만, 위 문서 자리라는 이유로 클래스를 유지한다.
> 인스턴스로 되돌리는 것은 가능하되 M1 이 동결한 표면을 다시 건드리는 값을 하지 않는다.

M1 이 동결한 `is_compatible(Image, Image)` · `ListType(Image)` 표면은 그대로다.
`nodal.as_type()` 이 입구에서 이름 클래스를 서술자로 바꾼다.

---

### 4.5 AssetStore (M3 계약)

content-addressed 바이트 저장소. 같은 내용이면 같은 해시이므로 같은 이미지를 두 번
저장해도 하나만 남는다. 해시는 캐시 키와 같은 계열(blake2b-128)을 쓴다 — 암호학적
보증이 필요 없고 결정성과 충돌 회피만 필요하다.

**인터페이스는 `packages/core`(`nodal.assets`), 구현은 `packages/server`.** core 에
인터페이스를 두는 이유는 하나다: 이미지를 저장하는 노드가 저장소에 닿아야 하는데
노드 팩은 `core` 만 의존한다. 구현까지 core 에 넣으면 도메인 중립 그래프 엔진에
파일시스템 정책이 들어온다.

노드는 `ctx.assets` 로 접근한다. `ctx` 를 선언하지 않은 노드는 저장소를 모르며
그것이 정상이다 — 순수 함수로 남아 엔진 없이 단위 테스트가 된다. 저장소 없이
실행하면 `NullAssetStore` 가 `put` 에서 **명시적으로 실패한다.** 저장했다고 믿었는데
사라지는 것보다 그 자리에서 터지는 편이 낫다.

```python
class AssetStore(Protocol):
    def put(self, data: bytes, *, media_type: str = ..., filename: str | None = ...,
            width: int | None = ..., height: int | None = ...) -> AssetRef: ...
    def get(self, digest: str) -> bytes | None: ...
    def ref(self, digest: str) -> AssetRef | None: ...
```

`execute(..., assets=store)` 가 저장소를 `NodeContext` 까지 전달한다. server 는 업로드
라우트와 실행 큐에 **같은 인스턴스**를 주입하므로 `AssetRef.hash` 를 곧바로
`GET /api/assets/{hash}` 에 쓸 수 있다.

**픽셀 크기는 넣는 쪽이 알려준다.** 저장소는 바이트와 미디어 타입만 안다 — 저장소가
이미지를 해석하기 시작하면 그것은 더 이상 범용 바이트 저장소가 아니다.

### 4.6 프리뷰 경로 (M3 계약)

**M2 까지 `NodeResult.preview` 는 아무 데도 가지 않았다.** `_classify` 가 값만 꺼내
쓰고 프리뷰를 버렸다. M3 이 그 경로를 만든다.

```
NodeResult(out, preview=out)          ctx.progress(step, total, preview=out)
              └────────────┬───────────────────────┘
                    ctx.preview(value)
                    encoder(value)            ← ndarray → EncodedPreview(PNG bytes)
                    core delivery policy      ← progress=inline, NodeResult=asset
                    node.preview 이벤트
```

인코딩을 core 가 직접 하지 않는 이유는 core 가 numpy 를 모르기 때문이다. `server` 도
`core` 만 의존하므로 마찬가지다. 그래서 **노드 팩은 바이트와 미디어 메타데이터만
만들고**, core 가 data URI 변환 또는 `AssetStore.put()` 을 결정한다. 인코더가 저장소를
직접 붙잡지 않으므로 앱·테스트마다 다른 실행별 저장소를 안전하게 주입할 수 있다.

```python
@register_preview_encoder
def encode_ndarray(value: Any) -> EncodedPreview | None: ...
```

등록된 인코더가 없거나 아무도 값을 처리하지 못하면 `PreviewEncoderNotFoundError`다.
명시적으로 요청한 프리뷰가 조용히 사라지면 노드 팩 초기화 누락을 성공으로 오해하기
때문이다. Tensor 출력도 인코더가 없으면 실패한다. Model 같은 불투명 핸들은 프리뷰
대상이 아니므로 전송 참조가 비어 있을 수 있다. `ctx.progress(preview=...)` 는 data URI,
`NodeResult(preview=...)` 와 JSON 이 아닌 인코딩 가능한 출력은 asset 이 된다. 모든
인코딩 실패는 해당 노드의 `node.error` 로 보고하고 실행을 실패시킨다.

---

## 5. 실행 엔진

### 5.1 실행 루프

```python
async def execute(graph, requested_outputs, cache, events, cancel_token):
    dyn = DynamicGraph(graph)             # 런타임 확장 노드를 얹을 수 있는 뷰
    plan = ExecutionList(dyn, cache)
    for out_id in requested_outputs:
        plan.add_node(out_id)             # 필요한 조상만 역방향 수집

    while not plan.is_empty():
        cancel_token.raise_if_cancelled()
        node_id = await plan.stage()      # 준비된 노드 중 UX 휴리스틱으로 선택
        result = await run_node(node_id, dyn, cache, events)

        match result:
            case Success():   plan.complete()
            case Expanded(g): dyn.splice(node_id, g); plan.unstage()   # 서브그래프 삽입
            case NeedsLazy(deps): plan.add_deps(node_id, deps); plan.unstage()
            case Blocked():   propagate_blocker(node_id, plan)
            case Failure(e):  raise NodeExecutionError(node_id, e)
```

핵심은 `unstage()`. 노드가 "아직 못 하겠다, 이것들이 먼저 필요하다"고 말하면 실행 목록에 되돌려 놓는다. **이 한 가지 메커니즘이 노드 확장과 lazy 평가를 둘 다 지탱한다.**

### 5.2 노드 확장 (Node Expansion)

노드가 값 대신 서브그래프를 반환할 수 있다. 루프, 배치 반복, 고수준 조합 노드("Upscale 2x"가 내부적으로 tile→sample→merge로 펼쳐지는 것)의 기반.

확장된 노드는 ephemeral 노드로 삽입되고 **부모 ID를 유지**한다. 진행률과 에러가 사용자가 실제로 캔버스에서 보는 노드에 귀속되어야 한다. 이게 없으면 "존재하지 않는 노드에서 에러가 발생"한다.

### 5.3 캐시

```
cache_key(node) = blake2b-128(
    node.type,
    node.schema_version,
    { name: (cache_key(src) if link else literal_value)
      for name, src in node.inputs },
    node.is_changed_token,      # IS_CHANGED 훅 결과
)
```

해시는 표준 라이브러리 `hashlib.blake2b(digest_size=16)`를 사용한다. 캐시 키에
필요한 것은 암호학적 보증이 아니라 결정성과 충분한 충돌 저항이며, core에 별도
네이티브 확장 의존성을 추가하지 않는다. 결정 근거는 `docs/decisions.md`에 기록한다.

**정책** (설정 가능, 기본 = `MEMORY_PRESSURE`)

| 정책 | 동작 |
|---|---|
| `NONE` | 캐시 없음. 디버깅용 |
| `LRU(n)` | 최근 n개 노드 결과 유지 |
| `MEMORY_PRESSURE` | 여유 RAM 임계값 아래로 떨어지면 축출 (기본) |
| `DISK` | 큰 텐서는 memmap으로 디스크 스필 |

ComfyUI가 여러 캐시 구현을 병렬 운영하며 도달한 결론을 압축: **메모리 압력 기반 축출 + 큰 항목 디스크 스필**이 실제로 유일하게 필요한 조합.

### 5.4 취소와 진행률

- 협조적 취소: `CancelToken`을 노드 실행 컨텍스트로 전달. 장기 루프(sampling step)는 매 스텝 확인.
- 진행률: `ctx.progress(step, total, preview=tensor)` — 서버가 WS로 브로드캐스트.
- 노드 실행은 스레드풀로 격리해서 동기 blocking 노드가 이벤트 루프를 막지 않게 한다.

---

## 6. 서버 API

### REST

| 엔드포인트 | 설명 |
|---|---|
| `GET  /api/nodes` | 전체 노드 스키마 (프론트 팔레트 소스) |
| `POST /api/graph/validate` | 실행 없이 타입 검증만 |
| `POST /api/graph/from-png` | PNG `iTXt` 에서 워크플로 복원 (M3) |
| `POST /api/runs` | 실행 큐 등록 → `{run_id}` |
| `GET  /api/runs/{id}` | 상태 · 결과 |
| `DELETE /api/runs/{id}` | 취소 |
| `GET  /api/runs` | 큐 · 히스토리 |
| `GET  /api/models` | 발견된 모델 목록 (타입별) |
| `POST /api/assets` | 입력 파일 업로드 |
| `GET  /api/assets/{hash}` | content-addressed 조회 |
| `GET  /api/extensions` | 로드된 확장 · 실패한 확장 |

### WebSocket 이벤트 (`/ws`)

```typescript
type Event =
  | { t: "run.started";  run_id: string; node_count: number }
  | { t: "node.started"; run_id: string; node_id: string }
  | { t: "node.progress"; node_id: string; step: number; total: number }
  | { t: "node.preview"; node_id: string; preview: Preview }
  | { t: "node.cached";  node_id: string }                   // 캐시 히트 시각화
  | { t: "node.done";    node_id: string; outputs: OutputRef[] }
  | { t: "node.error";   node_id: string; message: string; traceback: string[] }
  | { t: "run.done" | "run.cancelled"; run_id: string; elapsed_ms: number }
  | { t: "queue";        pending: number; running: string | null };
```

**M2 계약에서 확정한 것** — 위 정의에 빠져 있던 부분이다. 생성된 산출물은 `schemas/openapi.json`이고 프론트는 거기서 타입을 만든다.

`OutputRef`는 값이 아니라 **참조**다. 이미지나 텐서를 WS로 그대로 흘리면 메가바이트가 소켓을 타고 나간다.

```typescript
type OutputRef = {
  socket: string        // 출력 소켓 이름 — 캐논 그래프의 링크가 참조하는 그 이름
  type: TypeExpr        // types.json 의 타입 표현식
  inline?: JsonValue    // JSON으로 표현되는 작은 값
  asset?: AssetRef      // 저장소에 있는 값 (M3)
}

type AssetRef = {
  hash: string          // GET /api/assets/{hash}
  media_type: string
  size_bytes: number
  width?: number | null   // 이미지가 아니면 null
  height?: number | null
}
```

**`asset` 은 M2 까지 해시 문자열이었다. M3 계약에서 `AssetRef` 로 바꿨다.** 프론트가
노드 안에 프리뷰를 그리려면 이미지를 **받기 전에** 크기를 알아야 레이아웃이 튀지
않는데, 해시만으로는 알 수 없었다.

**모든 이벤트가 `run_id`를 싣는다** (`queue` 제외 — 특정 실행에 속하지 않는다). `/ws`는 전역 스트림이고 프론트는 히스토리와 여러 탭을 동시에 본다.

**종료 이벤트는 셋이고 `RunStatus`의 종료 상태와 짝을 이룬다.** 위 정의에는 `run.failed`가 없었는데, 그러면 실패한 실행에 run 레벨 종료 신호가 **아예 없어서** 프론트 상태 머신이 걸린다. `node.error`는 노드 단위라 그 역할을 못 한다 — 실행 도중 발견된 사이클처럼 어느 노드에도 귀속되지 않는 실패도 있다.

```typescript
| { t: "run.failed"; run_id: string; elapsed_ms: number; code: string; message: string }
```

| 종료 이벤트 | `RunStatus` |
|---|---|
| `run.done` | `succeeded` |
| `run.failed` | `failed` |
| `run.cancelled` | `cancelled` |

**프리뷰는 판별 가능한 유니온이다 (M3).** 위 정의는 `image: string` 에 "base64 or
asset ref" 라는 주석만 달려 있었다 — 받는 쪽이 둘 중 무엇인지 **구분할 방법이 없었다.**

```typescript
type Preview =
  | { kind: "inline"; data_uri: string; width?: number | null; height?: number | null }
  | { kind: "asset";  asset: AssetRef }
```

`inline` 은 버려질 프리뷰(샘플링 중간 이미지)를 위한 것이다. 그것까지 저장소에 넣으면
스텝마다 쌓여 content-addressed 저장소가 오염된다. `asset` 은 어차피 저장소에 있는
최종 출력이라 WS 로 바이트를 다시 흘릴 이유가 없다.

**소켓 타입은 `types.json`의 타입 표현식으로 전송한다.** 사람이 읽는 렌더링(`describe()`)이 아니다 — 그것은 복원할 수 없다. `Tensor[float32, (?, 3)]`는 `?`가 라벨(`B`)이었는지 `null`이었는지 지운다.

```jsonc
{ "name": "img",    "type": "Image" }                    // 카탈로그 이름은 문자열
{ "name": "images", "type": { "list": "Image" } }
{ "name": "scale",  "type": { "union": ["INT", "FLOAT"] } }
```

프론트는 이미 `parseTypeExpr()`·`isCompatible()`·`describeType()`을 갖고 있으므로(§4.3의 `types.json` 로더), 표시용 문자열은 자기가 만든다. 렌더러가 양쪽에 생기지 않는다.

**에러 응답은 하나의 모양이다.** HTTP 상태로 분기하고 본문은 언제나 아래와 같다. `issues[]`는 M1의 `GraphIssue`를 그대로 직렬화한 것이라 에러 어휘가 하나로 유지된다.

```jsonc
// 422 — 그래프 검증 실패
{
  "error": {
    "code": "graph_invalid",
    "message": "그래프 검증 실패 (1건)",
    "issues": [{
      "code": "type_mismatch",
      "message": "c.value (INT) 를 이 소켓(STRING)에 연결할 수 없다",
      "node_id": "f", "socket": "template",
      "location": "nodes.f.inputs.template"   // 프론트가 이걸로 소켓을 지목한다
    }]
  }
}
```

단 `POST /api/graph/validate`는 **무효한 그래프도 200**이다. 검증은 질의이지 명령이므로 "이 그래프는 무효다"가 성공적인 답이다.

**실행 상태는 5개**: `queued` · `running` · `succeeded` · `failed` · `cancelled`.

| 엔드포인트 | 응답 |
|---|---|
| `GET /api/runs/{id}` | 상태 + `outputs`(노드별 `OutputRef[]`) + `executed`·`cached`·`blocked` + 타임스탬프 |
| `GET /api/runs` | `{running, queued[], history[], limit}` |

`executed`와 `cached`를 REST에도 두는 이유는 WS를 놓친 클라이언트(새로고침·늦은 접속)도 무엇이 재실행됐는지 알아야 하기 때문이다.

### PNG `iTXt` 워크플로 (M3 계약)

이미지 파일 자체가 재현 가능한 레시피가 된다 (§1.2). 확정한 것:

| 항목 | 확정 |
|---|---|
| 청크 종류 | PNG `iTXt` (UTF-8) |
| 키워드 | **`nodal_workflow`** — 캐논 그래프 JSON |
| 부가 키워드 | `nodal_version` — 나중에 포맷이 바뀔 때 마이그레이션 근거 |
| 임베딩 | Save 노드 |
| 복원 | **서버** — `POST /api/graph/from-png` |

키워드를 `workflow` 가 아니라 `nodal_workflow` 로 둔 이유는 다른 노드 도구가 흔히
`workflow` 를 쓰기 때문이다. 남의 PNG 를 삼켜 이상한 그래프를 만들거나 반대로 nodal
PNG 를 남이 오해하는 일이 없어야 한다.

`tEXt` 는 Latin-1 이라 한글 노드 제목·프롬프트를 담는 캐논 JSON과 맞지 않는다.
`iTXt` 를 쓰면 `Graph.to_json()` 의 UTF-8 문자열을 ASCII 이스케이프 없이 보존한다.

**복원을 서버가 하는 이유**: iTXt 파서가 Python·TS 양쪽에 생기면 그것이 곧 "규칙을 두
번 쓰지 않는다" 위반이다. 프론트의 드래그앤드롭은 파일을 이 엔드포인트로 던지고
캐논 그래프를 받는다. 스키마 검증도 서버가 한 번에 한다.

---

`node.cached`를 명시적 이벤트로 두는 게 포인트. 어느 노드가 재실행됐고 어느 노드가 스킵됐는지 색으로 보이면 캐시가 마법이 아니라 이해 가능한 도구가 된다. ComfyUI에는 이게 없어서 사용자가 캐시 동작을 추측한다.

---

## 7. 프론트엔드

### 캔버스: `@xyflow/react` (React Flow, MIT)

| 후보 | 판단 |
|---|---|
| **React Flow** | ✅ 채택. 노드가 DOM이라 위젯(슬라이더/텍스트에어리어/이미지 프리뷰)을 그냥 React로 넣을 수 있다. 가상화 내장 |
| LiteGraph.js | ❌ canvas 기반이라 위젯 하나마다 직접 그려야 한다. ComfyUI 프론트팀이 몇 년째 포크를 고통스럽게 유지 중 |
| 직접 구현 | ❌ 노드 수천 개가 필요할 때만. 그 시점은 오지 않는다 |

**주의**: React Flow는 DOM 기반이라 수백 노드를 넘으면 느려진다. 실사용은 20~80 노드대이므로 문제없지만, `React.memo` + 뷰포트 밖 위젯 언마운트로 방어한다.

### 상태 관리

- **Zustand** — 그래프 스토어
- **Yjs** — undo/redo를 CRDT 히스토리로. 처음부터 넣으면 나중에 협업 편집이 거의 공짜
- 자동 저장: 변경 시 디바운스 후 로컬에 리비전 저장

### 반드시 넣을 UX (ComfyUI가 늦게 배운 것들)

1. **연결 가능 소켓 하이라이트** — 링크 드래그 시작 시 타입 호환 소켓만 밝게
2. **노드 검색이 첫 진입점** — 더블클릭 → 퍼지 검색 (별칭·한글 포함)
3. **캐시 상태 시각화** — 재실행/캐시 히트/대기/에러를 노드 테두리 색으로
4. **인라인 에러** — 스택트레이스는 실패한 노드 안에 접힌 상태로. 별도 팝업 금지
5. **PNG 드래그 앤 드롭 → 워크플로 복원**
6. **Ctrl+Enter 실행, Ctrl+Shift+Enter 캐시 무시 재실행**

---

## 8. 확장 시스템

```
~/.nodal/extensions/my-pack/
├── nodal.toml           # 매니페스트
├── nodes/*.py           # @node 데코레이터
└── web/index.js         # 선택: 커스텀 위젯 (ESM)
```

```toml
[extension]
id = "com.example.my-pack"
name = "My Pack"
version = "0.2.0"
nodal_api = "^1.0"        # 이거 없으면 로드 거부

[dependencies]
python = ["opencv-python>=4.9"]
```

**규칙**

- `nodal_api` 버전 범위 필수 선언 → 업데이트 시 어떤 확장이 깨지는지 사전에 안다
- 확장 하나가 예외를 던져도 나머지는 로드된다. 실패는 `/api/extensions`에 기록되고 UI에 배너
- 확장은 자체 격리 환경(`uv`)에 의존성 설치 → "커스텀 노드 설치했더니 torch 버전이 깨짐" 회피
- 프론트 확장은 ESM 동적 import. 백엔드 패키지에 섞지 않는다

---

## 9. 모델 계층 (diffusion)

**`diffusers`를 쓴다. 직접 구현하지 않는다.**

이 절은 M4 계약이다. `ModelStore` · `DevicePlan` · `Seed` 는 `packages/core` 에
있고 구현은 `packages/nodes-diffusion` 에 있다.

### 9.1 노드가 보는 것

```python
@node(id="diffusion.LoadCheckpoint", category="diffusion/loaders")
class LoadCheckpoint:
    ckpt: Combo = Combo.from_provider("checkpoints")   # 파일 스캔에서 옵션 생성
    returns = (Model, CLIP, VAE)

    def run(self, ckpt, ctx):
        handle = ctx.models.load(ckpt, loader="diffusers.single_file")
        return NodeResult(handle.unet, handle.text_encoder, handle.vae)
```

`ctx.models` 는 `ctx.assets` 와 같은 모양이고 같은 이유로 존재한다 — 체크포인트를
로드하는 노드는 `core` 만 의존하므로 다른 통로가 없다 (§4.5).

`load()` 가 돌려주는 핸들은 **core 에게 불투명**하다. 실제 타입은 그 표현을
소유한 노드 팩이 `ModelHandle` 로 노출한다 (§4.4 의 `<Type>Handle` 규칙).

### 9.2 두 로더는 다른 경로다

| `loader` | 읽는 것 | 아키텍처를 |
|---|---|---|
| `diffusers.single_file` | `.safetensors` 한 덩어리 | **텐서 키에서 추론한다** |
| `diffusers.pretrained` | `model_index.json` 이 있는 폴더 | 파일이 명시한다 |

**`single_file` 의 추론이 실사용에서 가장 자주 깨진다.** 그래서 실패는 반드시
`ModelLoadError` 로 나가고 **네 가지를 싣는다**:

- `ref` — 무엇을 읽었는지
- `loader` — 어느 로더로
- `inferred` — 무엇으로 추론했는지. **추론 자체가 실패했으면 `None`**
- `expected` — 이 로더가 인식할 수 있는 아키텍처들

`evidence` 는 있으면 싣는다 — 파일에서 실제로 관찰한 텐서 키 접두사 같은 것으로,
사용자가 "아 이건 그 모델이 아니구나" 를 스스로 판단할 유일한 재료다.

"체크포인트 로드 실패" 라고만 하면 파일이 깨진 것인지, 지원하지 않는
아키텍처인지, 컴포넌트가 빠진 것인지 구분할 수 없다. 익명 에러 금지 규칙
(`AGENTS.md` 코딩 컨벤션)이 여기서 구체적으로 뜻하는 바다.

노드 ID 는 `ModelLoadError` 가 붙이지 않는다 — 실행 루프가 `NodeExecutionError`
로 감싸며 붙인다. 저장소는 자기를 누가 불렀는지 모른다.

### 9.3 디바이스 — 노드는 백엔드 이름을 모른다

`if device == "cuda"` 를 노드가 쓸 수 있게 두면 백엔드 분기가 노드마다 흩어진다.
한 번 흩어지면 되돌릴 수 없고, 빠뜨린 자리는 그 하드웨어를 가진 사람만 발견한다.

그래서 노드가 보는 것은 **이미 해석이 끝난** `DevicePlan` 하나뿐이다:

| 필드 | 뜻 |
|---|---|
| `compute` | forward 가 도는 곳 |
| `offload` | 안 쓰는 가중치가 앉아 있는 곳. `compute` 와 같으면 오프로드가 꺼진 것 |
| `dtype` | `types.json` 과 같은 어휘의 문자열 (`float16` · `bfloat16` · `float32`) |

오프로드 여부를 별도 불리언으로 두지 않는다 — 두 상태가 어긋날 수 있다.

**강제 수단**: `torch.cuda` · `torch.mps` · `torch.backends.mps` 는
`nodal_nodes_diffusion/devices.py` **한 파일에만** 등장한다. ruff 의 `banned-api`
는 import 문만 보므로 속성 접근을 놓친다 — 그래서 CI 의 grep 가드가 검사한다
(`ci.yml` 의 "디바이스 경계").

정책은 주입된다. `NODAL_DEVICE` (`auto` · `cuda` · `mps` · `cpu`) 로 덮어쓰고,
`auto` 는 cuda → mps → cpu 순으로 찾는다. **명시한 백엔드가 없으면 조용히 cpu 로
떨어지지 않고 실패한다** — cuda 를 지정했는데 cpu 로 도는 것은 거의 언제나 사고다.

정책이 값으로 주입되는 덕분에 "mps 에서 어떻게 되는가" 를 맥이 아닌 곳에서도
단위 테스트할 수 있다. 저자가 맥에서 개발하고 GPU 가 별도 장비인 이 프로젝트에서
이것은 편의가 아니라 필수다.

### 9.4 시드는 백엔드와 무관하게 재현된다

`torch.Generator` 의 device 처리는 백엔드마다 다르다. 그것을 그대로 두면 "같은
시드 → 같은 결과" 라는 약속이 백엔드를 건널 때 깨진다.

**규칙: 시드는 언제나 cpu 제너레이터에서 만들고 latent 를 `compute` 로 옮긴다.**
나중에 바꾸면 기존 그래프의 출력이 전부 달라지므로 처음부터 고정한다.

**서버는 시드를 굴리지 않는다.** `Seed` 위젯의 `control`
(`fixed` · `increment` · `randomize`) 을 읽어 값을 바꾸는 것은 **프론트**이고,
백엔드는 넘어온 정수를 그대로 쓴다. 서버가 몰래 굴리면 캐시 키가 매번 달라지고
`.nodal.json` 이 재현 가능한 레시피라는 성질이 사라진다 (§1.2).

`control` 값 셋은 프론트 코드에 박히므로 **에이전트 사이의 계약**이다.

### 9.5 `ModelManager` 책임

- 참조 카운팅 — 여러 노드가 같은 체크포인트를 공유하면 한 번만 로드
- `accelerate`의 `cpu_offload` / `sequential_offload`로 VRAM 압박 처리 (1차)
- 사용 안 하는 모델 LRU 언로드
- `safetensors` mmap 로딩

**이 중 어느 것도 `ModelStore` Protocol 에 없다.** 노드가 부르지 않기 때문이다.
Protocol 은 메서드 추가가 비파괴적이므로 작게 시작해서 필요할 때 넓힌다 — 반대로
넓힌 것을 좁히면 노드 팩이 깨진다.

지원 범위 1차: SD1.5, SDXL, SD3, FLUX (전부 `diffusers` 커버).

> 오프로딩 오버헤드가 참을 수 없어지면 레이어 단위 부분 오프로드를 직접 구현한다. **단 ComfyUI 코드 복사 금지 — `../AGENTS.md` 참조.**

### 9.6 테스트는 tiny 체크포인트로 돈다

`hf-internal-testing/tiny-sd-pipe` (8.7 MB) · `tiny-sdxl-pipe` (11.2 MB) 는 채널
수만 32/64 로 줄인 **진짜 `UNet2DConditionModel` + `AutoencoderKL`** 이다. 목이
아니라서 스케줄러 루프 · cross-attention · `scaling_factor` 가 실제로 돈다. CPU
에서 초 단위로 끝난다.

**검증되지 않는 것**: 가중치가 랜덤이라 **출력의 의미는 검증하지 못한다.** 잡히는
것은 배선 · shape · dtype · 캐시 · 취소 · 프리뷰 경로다. 이미지 품질은 GPU 장비의
수동 확인 몫이지 CI 의 몫이 아니다.

이 픽스처들은 전부 **diffusers 폴더 포맷**이라 `diffusers.pretrained` 경로만
검증한다. `single_file` 은 GPU 장비의 실제 체크포인트로 수동 확인한다 — 그것이
§9.2 의 에러가 특히 자세해야 하는 이유이기도 하다.

---

## 10. 기술 리스크

| 리스크 | 완화 |
|---|---|
| 노드 확장 + lazy + 캐시가 상호작용하며 미묘한 버그 | M1에서 실행 엔진만 격리해 테스트. 세 기능이 겹치는 케이스를 명시적 테스트로 고정 |
| React Flow가 대형 그래프에서 버벅임 | 뷰포트 밖 위젯 언마운트, 노드 본문 memo화. 200노드 벤치마크를 M2 완료 기준에 포함 |
| VRAM 관리를 `accelerate`에 맡기면 ComfyUI보다 느림 | 1차는 감수. "느리지만 동작"이 "빠르지만 미완성"보다 낫다 |
| 확장 생태계가 안 생김 | 초기에는 안 생기는 게 정상. ComfyUI 워크플로 임포터를 M4 이후 검토 |
| 프론트/백 타입 규칙이 어긋남 | `types.json` 단일 소스 + 계약 테스트 |

## 11. 열린 질문

1. 그래프 저장소: 파일(`.nodal.json`) vs SQLite 라이브러리 → **파일 권장**, git 친화적
2. ComfyUI 워크플로 임포트 지원 여부 → 사용자 유입에는 강력하지만 §1.2의 부채를 일부 다시 들여옴
3. 다중 실행 워커 (GPU 여러 장) → M6 이후
4. ~~라이선스~~ → **해소됨.** Apache-2.0 확정 (2026-08-14, `license.md`)
