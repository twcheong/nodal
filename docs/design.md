# nodal — 설계 스펙

이 문서는 **구현 스펙**이다. ComfyUI 소스를 열어보는 대신 이 문서를 보고 구현한다.

- 스택: Python 백엔드(FastAPI + WebSocket) + 웹 프론트엔드(React + TypeScript)
- 참조 대상: ComfyUI (GPL-3.0) — **아키텍처만 참조. 코드 복사 금지.** `../AGENTS.md` 참조.

**nodal 은 MCP 서버다. MCP 클라이언트가 아니다.** 외부 AI(Claude 등)가 nodal 의
생성 기능을 호출한다. ComfyUI 처럼 바깥에 브리지를 하나 더 붙이는 방식이 아니라
**nodal 자체가 서버**다. 타깃은 영상 제작 산업이 아니라 **제품 광고 수준의 비교적
단순한 제작물**이고, 1차 사용자는 그래프를 손으로 짜는 파워유저가 아니다.

노드 엔진은 사라지지 않는다. **내부 실행 계층**으로 남고 그 위에 MCP 인터페이스가
얹힌다. 상세는 §12. 이 방향은 문서 곳곳에 요구를 건다 — §5.3(캐시 무효화가
최적화가 아니라 정확성), §7(그래프 상태의 단일 소스는 서버), §9.4(시드는 클라이언트가
굴린다), 그리고 서브그래프가 편의 기능이 아니라 **툴의 단위**가 되는 것(§12.2).

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

여기서 UX 는 캔버스만이 아니다. **외부 AI 가 부르는 툴 표면도 UX 다** (§12).
난이도로 치면 하에 가깝지만 프로덕트가 서는 자리이므로 캔버스와 같은 급으로 다룬다.

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

**반환 형태는 두 가지고, 뜻이 다르다** (2026-08-23 확정, `decisions.md`):

| 노드가 돌려준 것 | 뜻 | 그 노드 자신 |
|---|---|---|
| 맨몸 `ExecutionBlocker` | **노드 전체**가 블로킹. 어떤 출력도 나오지 않는다 | `blocked` |
| `NodeResult` 의 값 중 하나가 `ExecutionBlocker` | **그 소켓만** 블로킹. 나머지 출력은 정상 값이다 | `executed` — 실제로 실행됐다 |

**어느 쪽도 조용히 `Success` 로 통과하지 않는다.** 블로커가 값처럼 하류로 흘러가
노드에 인자로 들어가면, 실패는 블로커를 만든 곳이 아니라 **엉뚱한 노드에서**
타입 에러로 나타난다. 원인에서 멀수록 디버깅 비용이 커진다.

**전파 규칙** — 소켓 단위 블로킹이 흥미로운 이유는 여기다:

- 막힌 소켓을 **링크로 소비하는** 하류 노드가 막힌다. 그 하류의 하류도 따라 막힌다
- **같은 노드의 다른 출력**을 쓰는 하류는 **정상 실행된다.** 노드 하나가 "이미지는
  냈지만 마스크는 조건이 안 맞아 없음" 이라고 말할 수 있다
- 블로커와 의존 관계가 없는 형제 가지는 당연히 산다
- 막힌 노드는 **실행되지도 캐시되지도 않는다.** `executed` · `cached` · `blocked`
  는 서로소다
- 요청한 출력이 막혀도 **실행 전체가 실패하지는 않는다.** 막혔다는 사실이
  `blocked` 로 보고된다 — 조건 분기의 정상 결과이지 에러가 아니기 때문이다

**구현됨 (M5.1b, 2026-08-23).** 네 곳이 함께 움직인다 — `_classify` 가
`NodeResult` 안의 블로커를 알아보고 `Success.blocked_sockets` 에 싣고,
`ExecutionList._blocked` 이 `(노드, 소켓)` 으로 키를 넓히고 (소켓 `None` 이면
노드 전체), `_inherited_blocker` 가 링크가 가리키는 **출처 소켓**을 보고,
`propagate_blocker` 가 그 소켓을 읽는 소비자만 막는다.

**전파된 노드는 통째로 막힌다.** 입력 하나가 막히면 그 노드는 실행될 수 없고
따라서 어떤 출력도 낼 수 없다. 소켓 단위 블로킹은 **노드가 스스로 만들어 낼
때만** 생긴다.

막힌 소켓의 값은 `results` 에 넣지 않는다. 하류는 어차피 막혀 읽지 않고, 혹시
전파에 구멍이 있어도 `resolve_inputs` 가 "출력 소켓이 없다" 고 **노드와 소켓을
지목해** 실패한다 — 블로커가 인자로 흘러드는 것보다 낫다.

**⑤ Lazy 입력**

입력을 `lazy=True`로 선언하면 upstream이 즉시 평가되지 않는다. 노드가 "지금 나는 A만 필요하다"고 말하면 B 브랜치는 아예 실행되지 않는다. Switch/Router 노드의 기반.

#### 현재 (2026-08-24 기준, 코드가 이렇다)

**lazy 실행은 아직 열려 있지 않다.** `InputDescriptor.lazy` 와 서버 스키마 전송,
`NeedsLazy` · `ExecutionList.add_deps()` · `unstage()` 기계는 있다. 그러나 노드가
어느 lazy 입력이 필요한지 선언하는 `check_lazy_status` API 가 없고, 최초 실행 계획도
lazy 소켓의 upstream 을 다른 의존성과 똑같이 미리 넣는다. 따라서 오늘
`Socket(..., lazy=True)` 를 적어도 불필요한 브랜치의 실행을 줄이지 못한다.

M5.4 의 `flow.Switch` 는 lazy 입력 둘 중 하나를 고르는 노드가 아니다. 값 하나를 받은
뒤 `NodeResult` 의 두 **출력 소켓** 중 선택되지 않은 하나에 `ExecutionBlocker` 를
놓는다(④). 그래서 닫힌 출력의 하류는 실행되지 않지만 Switch 앞의 값 생산자는 정상
실행된다. 구현된 블로커 규약을 쓰면서 미구현 lazy 를 구현된 것처럼 보이게 하지 않는
경계다.

#### 목표 (lazy 를 열 때 채워야 하는 것)

1. 노드 API 에 `check_lazy_status` 를 선언하고, 노드가 지금 필요한 **입력 소켓
   이름들**을 돌려줄 수 있게 한다. 없는 메서드를 엔진이 추측해서 부르지 않는다
2. 최초 실행 계획은 `lazy=True` 링크를 건너뛰고, `NeedsLazy` 가 요청한 소켓만
   `add_deps()` 로 편입한다. 요청되지 않은 upstream 은 `executed` · `cached` 어디에도
   나타나지 않아야 한다
3. 선택된 lazy 의존성 집합을 캐시 키와 함께 다룬다. 선택되지 않은 브랜치의 값이
   바뀌었다고 결과를 과대 무효화해서도 안 되고, 선택 조건이 바뀌었는데 예전 출력을
   되살려서도 안 된다
4. 봉인된 노드 확장을 연 뒤 lazy + 확장 + 캐시가 한 그래프에서 맞물리는 필수 테스트를
   통과시킨다. 세 기능을 따로 초록으로 만드는 것은 M5 완료 증거가 아니다

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
4. **캐시는 기본값이지 최적화가 아니다.** 파라미터 하나 바꿨을 때 그 노드 아래만 재실행되는 게 정상 동작. 무효화가 부정확하면 **틀린 결과가 나간다** — 최적화가 아니라 정확성 요구사항이다 (§5.3).
5. **모든 장기 작업은 취소 가능하고 진행률을 보고한다.**
6. **확장은 매니페스트로 관리한다.**
7. **그래프 상태의 단일 소스는 서버다.** 클라이언트(웹 캔버스든 MCP 클라이언트든)는 복제본을 들고 있을 뿐 소유하지 않는다. **이것은 목표이고 오늘의 코드는 아직 그렇지 않다** — 권위 사본은 브라우저에 있다 (§7 의 현재/목표 구분). MCP 클라이언트가 붙는 순간 클라이언트가 둘 이상이 되므로, 그때까지 **브라우저만 아는 상태를 늘리지 않는 것**이 지금 이 원칙이 요구하는 전부다 (§7 · §12.4 · §12.5).

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

- **M5 부터 문서는 `definitions` 도 담는다** — 서브그래프 정의다 (§5.5). 위 예제에
  없는 이유는 없어도 완전한 문서이기 때문이다. 정의를 쓰지 않는 그래프에는
  그 필드가 아예 나타나지 않는다.
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

이것은 `Image` 만의 이야기가 아니다. M4 의 `Model`·`VAE`·`CLIP`, M7 의 확장 타입까지
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

> **이 절은 2026-08-23 까지 위 네 문장이 전부였다.** M1 은 적힌 것만 구현했고,
> 그래서 아래 "현재" 가 나왔다. 얇은 스펙은 얇은 구현으로 정확히 번역된다 (§10).

#### 현재 (2026-08-23 기준, 코드가 이렇다)

**노드 확장은 봉인이다. `Expanded` 를 돌려주면 `NotImplementedError` 로 실패한다.**
서브그래프가 로드 시 평탄화로 확정되면서(§12.7) 확장이 크리티컬 패스에서 빠졌다.
구현하지 않되 **무한 루프를 남기지 않는다** — 그것이 봉인의 이유다.

봉인 전 코드는 이랬다:

```python
case Expanded(subgraph):          # executor.py:743
    dyn.splice(node_id, subgraph)
    plan.invalidate_keys()
    plan.unstage()
```

- `unstage()`(`:532`)는 **`staged` 를 `None` 으로 만들기만 한다.** 노드는 `pending`
  에 그대로 남아 다시 선택되고, 또 확장하고, 또 `unstage` 된다 → **무한 루프**
- `splice()`(`:297`)는 ID 접두(`<부모>:<uuid8>:<안쪽>`)를 붙이고 `_parents` 에
  부모를 기록하는 것까지만 한다. 삽입된 노드를 **실행 계획에 넣지 않고**,
  서브그래프의 출력을 부모의 출력에 **연결하지 않는다**

즉 `Expanded` · `splice` · `parent_of` 는 **타입과 이름이 있을 뿐 동작하지 않는다.**
겉보기에 구현된 것처럼 보이는 것이 이 상태의 가장 나쁜 점이다.

#### 목표 (봉인을 열 때 채워야 하는 것)

M5.4 이후 확장이 다시 필요해지면 — 값에 따라 내부 구조가 달라지는 서브그래프가
그 자리다 (§12.7 이 "포기하는 것" 으로 적어 둔 것) — 세 가지를 함께 구현한다.
**하나라도 빠지면 지금과 같은 반쪽이 된다.**

1. **서브그래프 출력 → 부모 출력 매핑.** 확장을 소비하던 하류는 `["부모", "소켓"]`
   을 읽고 있다. 그 소켓이 삽입된 어느 노드의 어느 출력인지 말해 주는 것이 필요하다
   — §5.5 의 `SubgraphDef.returns` 와 같은 문제이고, 같은 모양으로 푼다
2. **삽입 노드의 실행 계획 편입.** `splice` 가 돌려주는 ID 들을 `plan.add_node`
   로 넣어야 실행된다. 넣지 않으면 노드가 그래프에는 있고 계획에는 없다
3. **부모 재실행 금지.** 부모는 "펼쳤다" 로 끝난 것이지 아직 할 일이 남은 것이
   아니다. `unstage()`(pending 에 되돌림)가 아니라 **완료 처리**여야 하고,
   부모의 출력은 1번 매핑을 통해 삽입 노드의 출력으로 대체된다

`unstage()` 자체는 lazy 평가(§1.1 ⑤)의 것이다 — 거기서는 "아직 못 하겠다, 다시
불러 달라" 가 정확한 뜻이라 되돌리는 동작이 맞다. **확장이 그것을 빌려 쓴 것이
잘못이었다.**

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

**`IS_CHANGED` 는 최적화가 아니라 정확성 요구사항이다.**

사람이 캔버스를 쓸 때 캐시 오판의 비용은 낮다 — 결과가 이상하면 캐시 무시 재실행
(`Ctrl+Shift+Enter`)을 누른다. **MCP 클라이언트에는 그 버튼이 없다.** 외부 AI 는
같은 워크플로를 파라미터만 바꿔 반복 호출하는 것이 기본 사용 패턴이고("좀 더
따뜻하게", "배경만 바꿔서"), 두 방향의 오판이 각각 다르게 나쁘다:

| 오판 | 사람 | AI 클라이언트 |
|---|---|---|
| **과소 무효화** (바뀌었는데 캐시 히트) | 이상하면 재실행 | 낡은 이미지를 새 결과로 믿는다. 조용히 틀린다 |
| **과대 무효화** (안 바뀌었는데 재실행) | 좀 느리다 | 반복 호출마다 전체 재계산 — 툴이 쓸모없어진다 |

캐시 키(위 식)가 감당하는 것은 그래프 안의 값뿐이다. 파일 · 스캔된 모델 목록 ·
시각처럼 **그래프 밖에 있는 상태**는 `IS_CHANGED` 훅이 토큰으로 끌어들이지
않으면 캐시가 볼 수 없다. M5 에서 격상해 다루는 이유다 (`roadmap.md` M5).

**캐시는 블로커를 값으로 되살리지 않는다** (M5.1b). 부분 블로킹된 노드는
`executed` 라서 그 출력이 캐시에 들어가고, 그 안에는 `ExecutionBlocker` 가
그대로 실린다. 히트 경로가 그것을 알아보지 않으면 **첫 실행만 맞고 두 번째
실행부터 블로커가 값처럼 하류로 흘러간다** — 캐시가 조건 분기를 지우는 셈이다.
그래서 히트한 출력도 갓 실행한 출력과 **같은 판정**을 받는다 (`_blocked_sockets`
하나를 양쪽이 쓴다). 이것은 성능이 아니라 **정확성**의 문제다 (§2 원칙 4).

> 블로커를 빼고 캐시하는 선택지도 있었지만 더 나쁘다 — 히트가 "출력이 없는 정상
> 결과" 로 보여 하류가 그냥 실행된다. 근거는 `decisions.md` G1.

#### `IS_CHANGED` 의 노드 API (M5 계약)

```python
@node(id="image.Load", ...)
class Load:
    path: String = String("")

    @staticmethod
    def is_changed(path: str) -> str:
        return f"{os.path.getmtime(path)}"      # 문자열 토큰

    def run(self, path: str) -> NodeResult: ...
```

- **`@staticmethod` 다.** 인스턴스도 실행 컨텍스트도 없이 부를 수 있어야 한다 —
  캐시 조회는 노드를 만들기 **전에** 일어난다
- **반환은 문자열 토큰**이다. bool 이 아니다. "바뀌었나"는 무엇과 비교해서
  바뀌었는지를 노드가 기억해야 답할 수 있는 질문이고, 그러면 노드가 상태를 갖는다.
  토큰은 비교를 **캐시 키에게** 맡긴다 — 토큰이 달라지면 키가 달라진다
  (`cache_key(..., is_changed_token=...)`, `cache.py`)

**받는 것은 리터럴·위젯 입력뿐이다. 링크로 들어오는 값은 주지 않는다.**

이건 편의상의 제한이 아니라 순서의 문제다. 훅은 캐시를 조회하기 전에 평가돼야
하는데(`executor.py` 의 `cache_key_for` 가 `cache.get` 보다 앞이다), 링크 값은
상류 노드를 **실행한 뒤에야** 존재한다. 링크 값을 받겠다고 하면 "캐시를 쓸지
결정하려고 상류를 전부 실행한다"가 되어 캐시가 캐시가 아니게 된다.

시그니처에 링크로 연결된 소켓 이름을 적으면 엔진이 **거부한다** — 조용히 `None`
을 넣지 않는다. 파일 경로가 상류에서 오는 노드는 훅을 가질 수 없고, 그것이 맞다.

**거부는 검증 단계에서 일어난다** (`is_changed_linked_input`, M5.3). 실행을
시작한 뒤 죽는 것은 답이 아니다 — §2 원칙 2 는 큐 진입 전 검사를 요구하고,
§12.3 은 MCP 가 실행 전에 답을 듣기를 요구한다. **평탄화 뒤에 판정한다**:
정의 안에서 `{"$param": "path"}` 였던 입력이 인스턴스에서 링크로 채워질 수 있고,
그때 비로소 훅이 링크 입력을 받게 된다 — 평탄화 전에는 알 수 없다 (§5.5).

실행 시점 방어(`ExecutionList.cache_key_for`)는 남아 있다. 검증을 건너뛰고 실행
계획을 직접 모는 호출자가 있기 때문이다.

**하류 전파는 공짜다.** 훅이 있는 노드 하나가 새 토큰을 내면 그 노드의 키가
바뀌고, `cache_key_for` 는 상류의 **키를** 자기 입력값으로 쓰므로(`executor.py`)
하류 키가 연쇄적으로 바뀐다. 무효화를 따로 전파하는 코드가 없다 — 키 계산이
이미 그 모양이기 때문이다.

### 5.4 취소와 진행률

- 협조적 취소: `CancelToken`을 노드 실행 컨텍스트로 전달. 장기 루프(sampling step)는 매 스텝 확인.
- 진행률: `ctx.progress(step, total, preview=tensor)` — 서버가 WS로 브로드캐스트.
- 노드 실행은 스레드풀로 격리해서 동기 blocking 노드가 이벤트 루프를 막지 않게 한다.

### 5.5 서브그래프 — 표현과 평탄화

서브그래프는 저작 편의가 아니라 **MCP 툴의 단위**다 (§12.2). 템플릿 하나가
MCP 툴 하나이고, 그 툴의 `inputSchema` 는 여기 선언된 `params` 에서 그대로
생성된다 (§12.3).

#### 정의는 문서 안에 산다

```jsonc
{
  "nodal_version": "1",
  "definitions": {
    "thumbnail": {
      "params": {
        "source": { "type": "Image" },
        "size":   { "type": "INT", "default": 256, "widget": { "min": 16, "max": 2048 } }
      },
      "nodes": {
        "fit": {
          "type": "image.Resize",
          "inputs": {
            "image":  { "$param": "source" },   // ← 밖에서 들어오는 값
            "width":  { "$param": "size" },
            "height": { "$param": "size" }
          }
        }
      },
      "returns": { "image": { "$link": ["fit", "image"] } }   // ← 밖으로 나가는 값
    }
  },
  "nodes": {
    "load":  { "type": "image.Load", "inputs": { "path": "cat.png" } },
    "thumb": {
      "type": "subgraph.thumbnail",                            // ← 인스턴스
      "inputs": { "source": { "$link": ["load", "image"] }, "size": 128 }
    },
    "save":  { "type": "image.Save", "inputs": { "image": { "$link": ["thumb", "image"] } } }
  },
  "outputs": ["save"]
}
```

**외부 파일 참조가 아니다.** 정의는 그것을 쓰는 문서 안에 통째로 실린다. 이유는
하나뿐인데 결정적이다 — 문서가 자기완결적이지 않으면 PNG `iTXt` 워크플로 복원(§6)
이 반쪽이 되고, "문서 하나가 곧 재현 가능한 레시피"(§1.2 ①)가 거짓이 된다.
템플릿 카탈로그의 `.nodal.json` 파일들(§12.8)은 각자 자기 정의를 들고 다닌다.

대가는 **중복**이다. 같은 정의를 쓰는 문서 열 개는 그것을 열 번 담는다. 이것은
받아들인다 — 캐시 키가 입력 시그니처 기반이라(§5.3) 같은 내용은 같은 키를 갖고,
중복이 재계산으로 이어지지 않는다.

#### 예약 키는 이제 둘이다

| 키 | 뜻 | 어디서 유효한가 |
|---|---|---|
| `$link` | 다른 노드의 출력 | 어디서나 (단 정의 안의 링크는 그 정의 안만) |
| `$param` | 이 정의의 파라미터 | **정의 안에서만** |

`graph.py` 의 입력 판별(`_input_kind`)이 두 갈래에서 **세 갈래**(link / param /
literal)로 넓어진다. 최상위 그래프에 `$param` 이 나타나면 검증이 거부한다
(`param_outside_definition`) — 채울 사람이 없는 구멍이기 때문이다.

#### 파라미터 선언

`params` 는 이름 → `{type, default, doc, widget}` 이다.

- `type` 은 `types.json` 의 타입 표현식이다 (§4.3). 인스턴스의 입력 소켓 타입이 된다
- **`default` 가 없거나 `null` 이면 필수 파라미터다.** 둘을 구분하지 않는다 —
  구분하면 캐논 문서에 빈 값이 두 가지 생기고, 카탈로그 타입 중 `null` 을 정상
  값으로 갖는 것이 없어 잃는 것도 없다
- `doc` 은 이 파라미터가 무엇인지다 (M6.0b). **선택이다** — 이름과 타입만으로
  충분한 파라미터가 있다. MCP 툴 `inputSchema` 의 `description`(§12.3)과 프론트
  위젯 툴팁이 이것을 읽는다
- `widget` 은 열린 힌트다 (§4.2 의 위젯 힌트와 같은 어휘). 실행은 읽지 않는다

**정의 자체도 `doc` 을 갖는다** (M6.0b). 정의가 무엇을 하는지를 스스로 적는
자리이고, 쓰는 곳이 셋이다 — MCP 툴 설명(§12.2) · 프론트 위젯 툴팁 · 캔버스의
서브그래프 노드 표시. 서브그래프 일반에서는 선택이지만 **카탈로그에 노출되는
순간 필수다** (§12.8).

> **왜 `meta.notes` 를 재쓰지 않았나.** `NodeMeta` 는 "실행에 영향을 주지 않는
> 노드 부가 정보" 이고 `title` · `notes` 는 사람이 캔버스에 적는 메모 자리다.
> 그것을 툴 설명으로 승격시키면 사용자가 적어 둔 "TODO: 나중에 고칠 것" 이 AI 의
> 툴 선택 근거가 된다. 같은 문자열이지만 용도가 다르다.

`returns` 는 인스턴스가 내보내는 소켓 이름 → 정의 안의 `(노드, 소켓)` 이다.
이것이 있어야 밖에서 `{"$link": ["thumb", "image"]}` 라고 쓸 수 있다 — 그 `image`
는 정의가 **선언한 이름**이지 안쪽 노드의 소켓 이름이 아니다.

> **왜 `outputs` 가 아니라 `returns` 인가** (2026-08-23 rename). 두 가지가 겹친다.
> ① 같은 문서 안에 `Graph.outputs`(**실행을 요청할 노드 목록**, `list[NodeId]`)가
> 이미 있다. 한 단계 차이로 나란히 놓인 두 필드가 같은 단어면서 다른 것을
> 뜻하면 반드시 헷갈린다. ② 노드 SDK 는 같은 역할을 이미 `returns` 로 부른다
> (§4.2 의 `returns: ClassVar[dict[str, Type]]`). **인스턴스는 밖에서 보면
> 노드다** — `subgraph.<이름>` 이 노드 타입 자리에 온다. 정의가 곧 노드 스키마
> 역할을 하므로 같은 단어가 어휘상 맞다.
>
> 값의 모양은 다르다 — SDK 의 `returns` 는 소켓 이름 → **타입**이고, 여기는
> 소켓 이름 → **`$link`** 다. 같은 질문("이 노드는 무엇을 내보내는가")에 답하는
> 같은 이름이고, 답하는 방식이 다르다. 정의는 타입을 **선언**하지 않고 안쪽
> 노드에서 **물려받기** 때문이다.

#### 평탄화 — 검증의 첫 걸음이다 (M5.3)

**실행 시 노드 확장(§5.2)이 아니다.** 근거는 캐시 입도다 (§12.7): 불투명한 실행
단위가 되면 캐시가 통째로 걸려 파라미터 하나 바꾼 재호출이 전체 재계산이 된다.

**어디서 일어나는가 — 파싱 직후가 아니라 `validate_for_execution` 안이다**
(2026-08-23 확정, 열린 질문 10·11·14 해소):

```
parse_graph        문서를 읽는다. 정의는 정의인 채로 남는다
validate_graph     문서의 자기모순 (레지스트리 없이 판정 — 아래 표)
validate_for_execution
  ├─ ① 평탄화        ← 여기다
  └─ ② 기존 검증      노드 타입 · 소켓 타입 · 필수 입력 (평탄화된 그래프 위에서)
execute            평탄화된 평범한 그래프를 실행한다
```

> **§12.7 의 "로드 시 평탄화" 는 "실행 시 확장이 아니다" 라는 뜻이었지 "파싱
> 직후" 라는 뜻이 아니었다.** 그 오해가 열린 질문 10 을 열어 두고 있었다 —
> "평탄화가 로드에서 실패하면 에러 경로가 검증과 달라진다" 는 전제였는데,
> 평탄화가 검증 **안에** 있으면 그 전제 자체가 사라진다.

**따라서 평탄화 실패는 예외가 아니라 `GraphIssue` 다.** 이것이 이 배치의 전부다:

| 평탄화가 만나는 문제 | 어떻게 나오나 |
|---|---|
| 필수 파라미터 누락 (기본값도 없고 인스턴스도 안 줬다) | `GraphIssue` — **어느 인스턴스의 어느 파라미터**인지 지목 |
| `params[].type` 이 타입 표현식 문법을 벗어남 | `GraphIssue` — 타입 카탈로그를 아는 층이 여기다 |
| 정의 간 순환 · 깊이/크기 한계 초과 | `GraphIssue` — 예외로 터지지 않는다 |

`POST /api/graph/validate` 가 서브그래프 문서에 **정상으로 답한다.** 응답 형상은
바뀌지 않는다 — `{valid, issues[]}` 그대로다. MCP 가 `run_template` 전에 "이
파라미터가 빠졌다" 를 답할 수 있어야 한다는 §12.3 의 요구가 이것이다. 실행을
시작한 뒤 예외로 죽는 것은 답이 아니다.

평탄화가 수행하는 것:

1. **인스턴스마다 정의를 복제한다.** 인스턴스 둘이 같은 정의를 써도 서로 다른
   노드가 된다 — 공유하면 한쪽의 파라미터가 다른 쪽에 새어 들어간다
2. **ID 에 접두를 붙인다**: `<인스턴스 ID>:<안쪽 ID>`. 위 예제는 `thumb:fit`.
   구분자 `:` 는 노드 ID 문법(`_NODE_ID_RE`)이 이미 허용하고 **사용자가 손으로
   쓰지 않는** 문자다. 중첩되면 접두가 겹쳐 쌓인다 (`outer:inner:fit`)
3. **`$param` 을 인스턴스가 준 값으로 치환한다.** 인스턴스가 리터럴을 줬으면
   리터럴이, 링크를 줬으면 **그 링크가 그대로** 들어간다. 값이 없으면 선언된
   기본값이고, 기본값도 없으면 오류다
4. **경계 링크를 재배선한다.** 밖에서 `["thumb", "image"]` 를 읽던 링크는
   정의의 `returns["image"]` 가 가리키는 안쪽 노드로 바뀐다 → `["thumb:fit", "image"]`
5. **인스턴스 노드를 지운다.** 평탄화가 끝난 그래프에 `subgraph.*` 타입은 남지 않는다
6. **중첩은 재귀한다.** 안쪽 정의가 또 인스턴스를 담으면 같은 규칙을 반복한다.
   한계는 **두 가지를 함께** 둔다 — 깊이만으로는 부족하다. 중첩 2단이어도 각
   정의가 50노드면 결과가 폭발한다

| 한계 | 값 | 근거 |
|---|---|---|
| 중첩 깊이 | **8** (`MAX_DEPTH`) | 사람이 손으로 만드는 중첩은 2~3단이고 MCP 템플릿은 중첩을 거의 만들지 않는다. 실수만 잡고 정상 사용을 막지 않는 자리 |
| 결과 노드 수 | **10,000** (`MAX_NODES`) | M2 벤치마크(200노드)의 50배. 실사용 상한을 크게 넘는다 |

**초과하면 어느 한계에 걸렸는지 지목한다** (`subgraph_too_deep` ·
`subgraph_too_large`). "너무 큽니다" 는 익명 에러다 — 깊이에 걸린 사람은 정의가
서로를 참조하는지 보고, 크기에 걸린 사람은 정의당 노드 수를 줄인다. 할 일이 다르다.

깊이 한계는 **사이클의 마지막 방어선**이기도 하다. 정의 간 순환은 `validate_graph`
가 잡지만, 그것을 건너뛰고 `flatten` 을 직접 부르는 호출자에게도 무한 루프를
주지 않는다.

평탄화 결과는 **평범한 그래프**다. 실행 엔진 · 캐시 · 이벤트는 서브그래프가
있었다는 사실을 모른다. 그래서 M5.2 가 M5.3 을 기다리지 않아도 된다.

이 문장은 테스트가 고정한다 — 평탄화 결과와 **손으로 쓴 동등 그래프가 같은 캐시
키를 낸다** (`test_flatten_matches_handwritten_graph`). 캐시 키는 노드 ID 가 아니라
타입 + 해석된 입력의 재귀 해시라(§5.3), 키가 같다는 것은 두 그래프가 엔진에게
구별되지 않는다는 뜻이다.

> **PNG 에 심기는 것은 평탄화 *전* 문서다.** `ctx.graph_json()`(§6)이 원본을
> 돌려주므로, 이미지를 다시 떨어뜨리면 정의가 살아 돌아온다. 평탄화 결과를
> 심으면 템플릿 구조가 사라진 사본이 남는다 — "문서 하나가 곧 재현 가능한
> 레시피"(§1.2 ①)가 반쪽이 된다.

> **UI 가 잃는 것**: 평탄화 후 노드는 `thumb:fit` 이라 사용자가 캔버스에서 접은
> 그룹으로 다시 보려면 접두를 되읽어야 한다. 그래서 접두 문법을 여기에 **계약으로**
> 못박는다 — 프론트가 추측하지 않게.

#### 검증 — 레지스트리를 몰라도 판정되는 것들

아래는 `validate_graph`(문서 검증)가 **평탄화 전에** 잡는다. 노드 팩이 하나도
설치되지 않은 서버에서도 답할 수 있어야 하므로 위의 평탄화 층과 나눈다 —
문서가 자기모순이면 평탄화를 시도할 이유가 없다.

| 코드 | 무엇 |
|---|---|
| `unknown_subgraph` | `subgraph.<이름>` 인데 `definitions` 에 그 이름이 없다 |
| `unknown_param` | `$param` 이 그 정의에 선언되지 않은 이름을 가리킨다 |
| `param_outside_definition` | `$param` 을 최상위 그래프에서 썼다 |
| `subgraph_external_link` | 정의 안의 링크가 정의 밖 노드를 가리킨다 |
| `unknown_link_target` | 정의 안의 링크가 아무 데도 없는 노드를 가리킨다 |
| `unknown_output_socket` | 정의가 선언하지 않은 출력을 밖에서 읽는다 |
| `subgraph_cycle` | 정의들이 서로를(또는 자기를) 참조한다 |

**순환이 여기 있는 이유**: 일반 사이클은 실행 엔진의 역방향 용해가 잡는다(§5.1).
정의 간 순환은 **실행에 도달하지 못한다** — 평탄화가 먼저 무한히 펼쳐진다.

**에러는 정의 이름을 함께 지목한다.** `GraphIssue` 에 `definition` 필드가 있고
위치는 `definitions.<이름>.nodes.<노드>.inputs.<소켓>` 이 된다. 정의마다 별개의
이름공간이라 노드 ID 만으로는 어느 정의인지 알 수 없다.

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
| `POST /api/assets` | 입력 파일 업로드 |
| `GET  /api/assets/{hash}` | content-addressed 조회 |
| `GET  /api/extensions` | 로드된 확장 · 실패한 확장 |

> **`GET /api/models` 는 뺐다 (M4).** 모델 목록은 `/api/nodes` 의 각 소켓
> `widget.options` 로 나간다 — 서버가 `Combo.from_provider` 의 공급자를 요청마다
> 스캔해 채운다. 목록을 엔드포인트로도 내보내면 같은 사실이 두 경로로 흐르고,
> 실제로 어긋났다: 프론트가 언제나 비어 있던 `/api/models` 를 읽어 체크포인트
> 콤보에 늘 "모델 없음" 이 떴다. 근거는 `decisions.md` 2026-08-18.

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
- 자동 저장: 변경 시 디바운스 후 리비전 저장

> ⚠️ **웹 클라이언트의 그래프 상태 소유 — 현재와 목표가 다르다.** 아래 두 문단은
> 서로 다른 시제다. 섞어 읽지 말 것.
>
> **현재 (2026-08-23 기준, 코드가 이렇다):** 권위 있는 사본은 **브라우저에 있다.**
> `apps/web/src/App.tsx:56` 이 마지막 그래프를 `localStorage("nodal.lastGraph")` 에
> 쓰고, 내보내기는 blob 다운로드다. 서버에는 그래프 저장소가 **없다** —
> `/api/graph/*` 는 `validate` 와 `from-png` 뿐이다. 위의 Zustand 스토어는 복제본이
> 아니라 사실상 원본이다.
>
> **목표 (§2 원칙 7 · §12.4):** 그래프 상태의 단일 소스는 서버다. 클라이언트가
> 하나였던 M2~M4 에서는 둘의 구분이 무의미했지만, MCP 클라이언트가 같은 그래프를
> 건드리는 순간 "누가 진짜인가"가 답해져야 한다.
>
> **지금 요구하는 것은 이 간극을 메우라는 것이 아니라 넓히지 말라는 것이다.**
> 서버 측 그래프 저장소를 지금 만들 필요는 없다 (실시간 가시화도 MVP 밖이다 —
> §12.5). 다만 **브라우저만 아는 상태를 새로 늘리지 않는다** — 늘려 두면 그때
> 아키텍처를 뒤집어야 한다. 이 영역을 건드리는 에이전트는 위 "현재" 를 사실로,
> "목표" 를 방향으로 읽는다.

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
(`fixed` · `increment` · `randomize`) 을 읽어 값을 바꾸는 것은 **클라이언트**이고,
백엔드는 넘어온 정수를 그대로 쓴다. 서버가 몰래 굴리면 캐시 키가 매번 달라지고
`.nodal.json` 이 재현 가능한 레시피라는 성질이 사라진다 (§1.2).

> **"프론트가 굴린다" 가 아니라 "클라이언트가 굴린다" 이다.** 이 규칙이 정해질
> 때 클라이언트는 브라우저 하나였고 그래서 "프론트" 라고 적혀 있었다. MCP 경로에서
> 클라이언트는 브라우저가 아니라 외부 AI 다 — 규칙은 그대로 적용되고, 그래서
> **MCP 툴 스키마에서 시드는 명시적 파라미터로 노출한다** (§12.3). 기존 결정의
> 확장이지 변경이 아니다.

**`control` 어휘의 단일 소스는 `types.json` 의 `widget_vocabulary.seed.control`
이다.** 세 곳이 그것 하나를 본다:

| 어디 | 무엇을 | 무엇을 막나 |
|---|---|---|
| `nodal.Seed.CONTROLS` | 읽어 쓴다 | 백엔드가 낡을 수 없다 (파생) |
| `apps/web/.../widgets.ts` 의 `SeedControl` | 리터럴 유니온으로 다시 적는다 | **tsc 가 `"randomise"` 를 거부한다** |
| `widgets.test.ts` · `tools/check_types.py` | 셋이 같은지 검사 | 리터럴이 낡거나 누가 하드코딩하는 것 |

TS 가 리터럴을 다시 적는 이유는 **TypeScript 가 JSON 모듈의 배열을 `string[]`
으로 넓혀 리터럴 유니온을 뽑을 수 없기 때문**이다. 그 중복은 피할 수 없고,
대신 테스트가 고정한다.

왜 이렇게까지 하는가: `widget` 은 OpenAPI 에서 자유 딕셔너리라
`generated.ts` 가 `Record<string, unknown>` 을 준다. 방어가 없으면 프론트의
오타가 **양쪽 저장소를 다 초록으로 통과해 런타임에야 드러난다** — `AGENTS.md`
규칙 7 이 말하는 아래 칸이다.

서버가 우리가 모르는 `control` 을 보내는 반대 방향은 `parseSeedControl` 이
경계에서 좁힌다. 모르는 값이면 `null` 이고 **조용히 `"fixed"` 로 떨어지지
않는다** — 시드는 재현성이 존재 이유라 조용한 대체가 특히 나쁘다.

### 9.5 스텝 프리뷰 — 새 전송 형식을 만들지 않는다

**`node.preview` 의 페이로드 형태는 M3 에서 바뀌지 않는다.** 프론트가 스텝
프리뷰를 위해 새로 다뤄야 할 전송 형식은 **없다** — `kind: "inline" | "asset"`
유니온 그대로다 (§6). 프론트가 이번에 만들 것은 시드 위젯뿐이다.

그렇게 되는 이유는 변환이 어디서 일어나는지에 있다:

```
KSampler 의 스텝 콜백
  → 잠재 (B, C, H, W) torch.Tensor          [nodes-diffusion]
  → RGB (B, H, W, C) float32 0..1 ndarray   [nodes-diffusion]  ← 여기서 변환
  → PNG data URI                            [nodes-image 의 인코더]  ← M3 그대로
  → node.preview {kind: "inline"}           [core]
```

**잠재 → RGB 변환은 `nodes-diffusion` 안에서** 한다. 그 결과는 §4.4 의 이미지
계약(`(B, H, W, C)` float32 0..1)을 그대로 만족하는 ndarray 이므로, M3 에서
`nodal_nodes_image` 가 등록한 `register_preview_encoder` 인코더가 **아무 변경
없이** 받아 PNG 로 만든다. 노드 팩이 인코더를 등록하는 구조가 이 확장을 위해
있었다 (§4.6).

세 가지가 이 배치에서 따라 나온다:

- **core 는 여전히 잠재가 무엇인지 모른다.** 인코더에 넘어가는 시점에는 이미
  평범한 ndarray 다
- **`nodes-image` 를 고치지 않는다.** 다른 에이전트 소유 영역을 건드리지 않고
  기능이 늘어난다
- **프리뷰가 없어도 실행은 된다.** 인코더가 없으면 `encode_preview` 가 `None` 을
  돌려주고 이벤트를 보내지 않는다 (§4.6) — `nodes-image` 없이 diffusion 만 설치한
  경우다

`ctx.progress(step, total, preview=...)` 하나로 진행률과 프리뷰가 같이 나간다.
프리뷰 경로가 여러 개가 되지 않게 M3 이 이미 한 지점으로 모아 뒀다.

> **어떤 근사로 RGB 를 만들 것인가는 아직 정하지 않았다.** 매 스텝 VAE 디코드는
> 정확하지만 비싸고, 잠재→RGB 선형 근사는 싸지만 색이 거칠다. 이것은 **품질
> 선택이고 전송 형식과 무관하다** — 어느 쪽을 골라도 위 파이프라인과 프론트
> 코드는 그대로다. M4 구현에서 정한다.
>
> ⚠️ 선형 근사를 쓸 때 **계수 행렬을 ComfyUI 에서 가져오지 말 것.** "잠재를
> 선형 사상으로 미리보기한다" 는 아이디어는 자유롭게 쓰되 계수는 직접 구하거나
> 허용적 라이선스 출처를 쓴다. `AGENTS.md` 절대 규칙 1 이 가장 쉽게 깨지는
> 자리다 — 값 몇 개라 복사라는 자각 없이 옮기게 된다.

### 9.6 `ModelManager` 책임

- 참조 카운팅 — 여러 노드가 같은 체크포인트를 공유하면 한 번만 로드
- `accelerate`의 `cpu_offload` / `sequential_offload`로 VRAM 압박 처리 (1차)
- 사용 안 하는 모델 LRU 언로드
- `safetensors` mmap 로딩

**이 중 어느 것도 `ModelStore` Protocol 에 없다.** 노드가 부르지 않기 때문이다.
Protocol 은 메서드 추가가 비파괴적이므로 작게 시작해서 필요할 때 넓힌다 — 반대로
넓힌 것을 좁히면 노드 팩이 깨진다.

지원 범위 1차: SD1.5, SDXL, SD3, FLUX (전부 `diffusers` 커버).

> 오프로딩 오버헤드가 참을 수 없어지면 레이어 단위 부분 오프로드를 직접 구현한다. **단 ComfyUI 코드 복사 금지 — `../AGENTS.md` 참조.**

### 9.7 테스트는 tiny 체크포인트로 돈다

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
| VRAM 관리를 `accelerate`에 맡긴 경로가 프로덕트 한계를 넘게 느림 | **M6 선행 조사.** 같은 장비·같은 서버 프로세스의 1024² SDXL에서 `steps=60`은 22분56초(**스텝당 23초**), `steps=15`는 **스텝당 0.33초**로 70배 차이였다. 느린 실행은 allocated 16.59 GiB · GPU util 100% · power 87.65W였고, `manager.py:283`의 `enable_model_cpu_offload`가 개입한 형태다. “감수”하기로 한 크기가 프로덕트 요구를 넘었다. §12.1의 “이 제품 사진으로 인스타그램용 광고 이미지” 사용자에게 한 장 23분은 `run_id` 폴링(§12.6)이 있어도 프로덕트가 아니다 |
| 확장 생태계가 안 생김 | 초기에는 안 생기는 게 정상. ComfyUI 워크플로 임포터를 M4 이후 검토 |
| 프론트/백 타입 규칙이 어긋남 | `types.json` 단일 소스 + 계약 테스트 |
| 캐시 무효화 오판이 AI 클라이언트에 **틀린 결과**로 나감 | `IS_CHANGED` 를 M5 에서 격상. 두 방향(과소·과대) 모두 테스트로 고정 (§5.3) |
| 템플릿 표면이 굳어 노드 엔진이 죽은 코드가 됨 | 템플릿은 **서브그래프로 만든다**. 전용 코드 경로를 만들지 않는다 — 템플릿이 늘어도 엔진 위에서 늘어난다 (§12.2) |
| 웹 클라이언트가 그래프 상태를 사실상 소유해 버림 | 지금은 클라이언트가 하나뿐이라 증상이 없다. **증상이 없는 동안** 서버 권위를 전제로 유지한다 (§2 원칙 7 · §7) |
| 긴 실행의 하트비트가 **클라이언트 구현에 좌우됨** | progress notification 에 정확성을 걸지 않는다. `run_id` 폴링이 정본이고 알림은 부가 (§12.6) |
| **로컬 바인딩(`127.0.0.1`)을 보안 경계로 착각함** | 막아 주는 것은 "다른 기계에서 못 온다" 뿐이고, **사용자 자신의 브라우저**는 로컬이다. MCP streamable HTTP 는 DNS rebinding 대상이라 악성 페이지가 도메인을 `127.0.0.1` 로 해석시켜 `/mcp` 를 부를 수 있다. 완화는 **`Origin` 헤더 검증** — MCP 스펙이 요구하고 `roadmap.md` M6.1 의 필수 항목이다. G2 로 MCP 가 캔버스와 같은 프로세스에 있어 위험이 평균보다 높다 (§12.9) |
| 문서가 목표를 현재형으로 적어 **코드에 대해 거짓말함** | 미구현 전제는 **현재/목표를 명시적으로 분리**해 적는다. §7 이 실제 사례였다 (2026-08-23 교정) |
| **스펙이 얇으면 구현도 딱 그만큼 얇게 나오고, 타입과 이름만 있는 코드가 구현된 것처럼 보인다** | §5.2 가 네 문장이라 `Expanded`·`splice` 가 이름만 있는 채로 M1 을 통과했다. 완료 판정을 **동작 테스트**로 한다 — 코드가 있는지가 아니라 (`codex/m5-engine-tests`가 이것을 드러냈다). 계약 문서는 "무엇을 반환하면 무엇이 일어나는가" 까지 적고, 못 적으면 그 기능은 아직 스펙이 없는 것이다 |

## 11. 열린 질문

1. 그래프 저장소: 파일(`.nodal.json`) vs SQLite 라이브러리 → **파일 권장**, git 친화적
2. ComfyUI 워크플로 임포트 지원 여부 → 사용자 유입에는 강력하지만 §1.2의 부채를 일부 다시 들여옴
3. 다중 실행 워커 (GPU 여러 장) → M7 이후
4. ~~라이선스~~ → **해소됨.** Apache-2.0 확정 (2026-08-14, `license.md`)
5. ~~저수준 `execute_graph` 툴을 함께 노출할 것인가~~ → **해소됨 (2026-08-23).** MVP 에서 **노출하지 않는다** (§12.2)
6. ~~서브그래프를 무엇으로 펼치나~~ → **해소됨 (2026-08-23).** **로드 시 평탄화** (§12.7 · `roadmap.md` M5)
7. ~~템플릿 카탈로그는 어디에 사나~~ → **해소됨 (2026-08-23).** 디렉토리 하나(`~/.nodal/templates/*.nodal.json`)가 유일한 발견 메커니즘이고, §8 확장은 거기 **등록하는 공급자**다 (§12.8)
8. ~~긴 실행을 MCP 에서 어떻게 다루나~~ → **해소됨 (2026-08-23).** `run_id` 반환 후 폴링. progress notification 은 **추가로** 보내되 의존하지 않는다 (§12.6)
9. ~~MCP 서버가 어느 마일스톤인가~~ → **해소됨 (2026-08-23, 사용자 결정).** **M6** 이다. 기존 M6(확장·배포)은 M7 로 밀렸다 (`roadmap.md`)

**M5.0 계약(§5.5)이 새로 연 것들** — 전부 M5.2~M5.3 착수 시점에 답한다:

10. ~~인스턴스가 필수 파라미터를 채웠는지 누가 보나~~ → **해소됨 (2026-08-23, 사용자 결정).** 평탄화가 `validate_for_execution` 의 첫 걸음이므로 **거기서 본다.** 기본값도 없고 인스턴스도 안 준 파라미터는 예외가 아니라 `GraphIssue` 이고, 어느 인스턴스의 어느 파라미터인지 지목한다 (§5.5). "로드가 실패한다" 는 전제가 틀렸다 — 평탄화는 로드가 아니라 검증 안에 있다
11. ~~`params[].type` 의 타입 표현식이 유효한지 누가 보나~~ → **해소됨 (2026-08-23).** 같은 층이다. 타입 카탈로그를 아는 곳이 `validate_for_execution` 이고, 평탄화가 그 안으로 들어오면서 `subgraph.*` 를 모른다는 문제도 함께 사라졌다 (§5.5)
12. ~~평탄화 한계를 얼마로~~ → **해소됨 (2026-08-24, M5.3).** 중첩 깊이 **8**, 결과 노드 수 **10,000**. 둘을 함께 두고 초과 시 어느 쪽인지 지목한다 (§5.5 의 표)
13. **평탄화된 그래프를 UI 에서 다시 접을 것인가** → `<인스턴스>:<안쪽>` 접두를 되읽으면 가능하다. M5.5 프론트가 필요하다고 판단하면 그때. 계약(접두 문법)은 이미 §5.5 에 있다
14. ~~`POST /api/graph/validate` 가 평탄화 전 문서에 무엇을 답해야 하나~~ → **해소됨 (2026-08-23).** 엔드포인트가 평탄화한 뒤 검증한다 (`validate_for_execution` 안에서 일어나므로 엔드포인트 코드는 그대로다). **응답 형상은 바뀌지 않는다** — `{valid, issues[]}` 그대로다 (§5.5)

**M6.0 계약(§12)이 새로 연 것들** — 셋 다 M6.0b 에서 닫혔다:

15. ~~툴과 파라미터의 설명을 어디서 얻나~~ → **해소됨 (2026-08-24, 사용자 결정).**
    캐논 포맷에 `doc` 을 넣었다 — `SubgraphDef.doc` 과 `ParamDef.doc` (§5.5).
    MCP 전용이 아니라 **정의의 자기 서술**이고 쓰는 곳이 셋이다 (툴 설명 · 위젯
    툴팁 · 캔버스 표시). **카탈로그에 노출되려면 정의의 `doc` 이 필수**이고
    파라미터의 것은 선택이다 (§12.8 · §12.3)
16. ~~MCP 클라이언트가 이미지를 어떻게 건네나~~ → **해소됨 (2026-08-24, 사용자
    결정) — 형식만.** `Image` 파라미터의 값은 파일 경로이거나 `asset:<hash>` 이고
    판별은 예약 접두다 (§12.3). **`asset:` 는 아직 동작하지 않는다** — 현재/목표를
    §12.3 에 나눠 적었고, 지금 넘기면 미구현 에러다. 형식을 먼저 고정한 이유는
    업로드 경로가 생겼을 때 템플릿을 다시 고치지 않기 위해서다
17. ~~`/mcp` 를 로컬 밖으로 열 때의 인증~~ → **해소됨 (2026-08-24): 인증은 MVP
    밖이다.** 다만 질문에 두 가지가 섞여 있었다 — **`Origin` 헤더 검증은 인증이
    아니고 MVP 안이다.** `127.0.0.1` 바인딩이 DNS rebinding 을 막지 못하기
    때문이고, 열린 질문이 아니라 **`roadmap.md` M6.1 의 구현 항목**으로 옮겼다
    (§12.9 · §10)

---

## 12. MCP 인터페이스 — nodal 의 1차 표면

**이 절은 계약이다** (2026-08-24, M6.0 · M6.0b). 착수 시점에 확정하기로 했던 툴
이름과 파라미터 형태가 여기서 확정됐다. 바꾸려면 `AGENTS.md` 협업 규칙 7 의
절차를 따른다 — MCP 표면은 그 표의 **아래 칸**(에이전트 간 계약)에 속한다.
클라이언트와 서버가 각자 돌아가므로 어긋나도 양쪽 다 초록이고, 런타임에야 드러난다.

계약이 된 것과 아직 없는 것을 나눠 둔다:

| 있다 (M6.0 · M6.0b) | 아직 없다 |
|---|---|
| 툴 입도와 이름 (§12.2 · §12.6) | MCP 서버 구현 그 자체 |
| 템플릿 카탈로그 규약 (§12.8) — 코드로 있다 | 툴 호출을 실행 큐에 잇는 배선 |
| `params` → `inputSchema` 변환 (§12.3) — 코드로 있다 | 템플릿 3 종 (`roadmap.md` M6) |
| run 생명주기와 상태 전이 (§12.6) | `Origin` 헤더 검증 (`roadmap.md` M6.1 **필수**) |
| 전송과 배치 (§12.9) | `Image` 값의 `asset:` 경로 — **형식만 있고 동작하지 않는다** (§12.3) |
| 설명 필드 `doc` (§5.5 · §12.3 · §12.8) | |

고정하는 것 중 가장 중요한 것은 여전히 **무엇을 노출하고 무엇을 노출하지
않는가**이다.

### 12.1 무엇인가

nodal 은 **MCP 서버**다. 외부 AI 클라이언트가 nodal 에 붙어 생성 기능을 호출한다.
반대 방향(nodal 이 다른 MCP 서버를 부르는 클라이언트가 되는 것)은 이 문서의 범위가
아니다.

ComfyUI 생태계에는 바깥에서 HTTP API 를 감싸는 MCP 브리지가 여럿 있다. nodal 은
그 구조를 따르지 않는다 — **브리지는 서버가 모르는 것을 대신 말해야 하고**, 그래서
노드 목록·타입 규칙·에러 귀속이 두 번 표현된다. 두 번 표현된 것은 어긋난다
(`AGENTS.md` 규칙 7 이 반복해서 말하는 실패 양상이고, `GET /api/models` 가 실제로
그렇게 죽었다 — `decisions.md` 2026-08-18). nodal 은 스키마·타입·에러를 이미
소유하고 있으므로 그것을 직접 MCP 로 말한다.

**타깃**은 영상 제작 산업이 아니라 **제품 광고 수준의 비교적 단순한 제작물**이다.
1차 사용자는 노드 그래프를 손으로 짜는 파워유저가 아니라, "이 제품 사진으로
인스타그램용 광고 이미지" 라고 말하는 사람이고, 그 말을 받는 것은 외부 AI 다.

**노드 엔진은 사라지지 않는다.** 내부 실행 계층으로 남는다. 캔버스는 템플릿을
만들고 고치는 저작 도구가 되지, 없어지지 않는다.

### 12.2 툴 입도 — 서브그래프가 툴의 단위다

세 가지를 검토했다.

| 안 | 모양 | 판단 |
|---|---|---|
| 저수준 | `execute_graph(graph_json)` 단독 | ❌ 클라이언트가 노드 타입을 **환각한다.** 그래프 전체가 매번 토큰을 먹고, 커질수록 불안정해진다 |
| 고수준 | `create_product_ad(product_image, style, ...)` 전용 툴 | ❌ 안정적이지만 nodal 이 **특수 목적 API** 가 된다. 그럴 거면 노드 엔진을 만든 이유가 없다 |
| **중간** | `list_templates()` → `run_template(id, params)` | ✅ **채택.** 클라이언트는 그래프를 쓰지 않고 **검증된 워크플로에 파라미터만 넣는다** |

> 표는 **판단의 기록이라 그대로 둔다.** 채택안의 툴 모양은 2026-08-24 에 한 번
> 더 좁혀졌다 (아래 "툴은 템플릿당 하나다"). 결론 — 클라이언트는 그래프를 쓰지
> 않는다 — 은 그대로다.

채택안의 성질:

- 클라이언트가 아는 것은 **템플릿 목록과 그 파라미터**뿐이다. 노드 타입을 몰라도
  되고, 그래서 환각할 것이 없다
- 토큰 비용이 그래프 크기가 아니라 **파라미터 개수**에 비례한다
- 워크플로가 늘어나는 방식이 코드가 아니라 **데이터**다 — 새 템플릿은 새 서브그래프이고,
  전용 코드 경로가 아니다. 노드 엔진이 죽은 코드가 되지 않는 이유가 이것이다

**따라서 M5 의 서브그래프는 편의 기능이 아니라 프로덕트의 핵심 단위다.** "그룹 접기"
라는 저작 편의로 계획되어 있던 것이 이제 **툴 표면 그 자체**다. `roadmap.md` 의 M5
순서가 이 때문에 바뀌었다.

**저수준 `execute_graph` 는 MVP 에서 노출하지 않는다** (2026-08-23, 열린 질문 5
해소). 탈출구로는 유용하지만 **있으면 클라이언트가 그쪽으로 흐른다** — 범용 툴과
템플릿 툴이 나란히 있으면 AI 는 매번 되는 쪽이 아니라 **일반적인 쪽**을 고르고,
그러면 위 표의 ❌ 가 그대로 돌아온다. 템플릿을 만들어 놓고 아무도 안 쓰는 것이
최악이다. 필요해지면 **플래그 뒤에** 나중에 추가한다 — 빼는 것보다 넣는 것이 쉽다.

#### 툴은 템플릿당 하나다 (2026-08-24 사용자 결정)

**바뀌기 전**: 툴이 둘이었다. `list_templates()` 로 목록을 받고,
`run_template(id, params)` **하나**로 전부 실행한다.

**바뀐 뒤**: 템플릿 하나가 툴 하나다. 카탈로그(§12.8)가 `run_template_<id>` 를
**동적으로 생성**하고, 그 템플릿의 `params` 선언이 그대로 툴의 `inputSchema` 가
된다 (§12.3).

**이유는 검증할 스키마가 없어서다.** `run_template(id, params)` 에서 `params` 는
자유 딕셔너리다 — 템플릿마다 모양이 다르니 그럴 수밖에 없다. 그래서 MCP
클라이언트에게는 인자를 확인할 근거가 없고, 잘못된 인자는 **서버까지 와서야**
걸린다. 툴을 템플릿마다 만들면 타입도 필수 여부도 값의 범위도 스키마에 있고,
틀린 인자가 **서버에 닿기 전에** 걸린다.

**표의 ❌ 고수준 안으로 돌아간 것이 아니다.** 그쪽이 거부된 이유는 툴이 많아서가
아니라 툴 하나하나가 **코드**여서였다 — `create_product_ad` 를 쓰려면 누군가
그 함수를 짜야 한다. 여기서 툴은 **데이터에서 생성된다.** 새 워크플로는 여전히
새 파일 하나이고 전용 코드 경로가 아니다. "워크플로가 코드가 아니라 데이터로
늘어난다" 는 채택 이유가 그대로 지켜지고, 오히려 그것이 툴 목록에까지 미친다.

**`list_templates()` 는 남긴다.** 툴 목록 자체는 MCP 의 `tools/list` 가 이미
주므로 호출 경로로는 필요 없다. 남기는 이유는 **거부된 템플릿**이다 — 파일을
넣었는데 툴이 안 보이는 사람이 이유를 물어볼 자리가 있어야 한다 (§12.8).

### 12.3 파라미터 규약

- **시드는 명시적 파라미터다.** 서버가 암묵적으로 생성하지 않는다. 굴리는 것은
  클라이언트 — MCP 경로에서는 외부 AI 다 (§9.4). 서버가 굴리면 캐시 키가 매번
  달라져 §5.3 의 과대 무효화가 항상 일어나고, 같은 요청을 다시 해도 같은 그림이
  나오지 않는다
- **템플릿이 선언한 파라미터만 받는다.** 임의 노드 주입 경로가 아니다. 타입 검증은
  이미 있는 것을 쓴다 (§2 원칙 2) — 실패하면 어느 파라미터인지 지목한다
- **결과는 에셋 참조로 돌려준다.** content-addressed (§4.5). 이미지 바이트를 툴
  응답에 그대로 싣는 것은 클라이언트 컨텍스트를 태운다

#### `params` → `inputSchema` 변환 (2026-08-24 계약)

툴의 `inputSchema` 는 손으로 쓰지 않는다. 템플릿의 `params` 선언(§5.5)에서
**기계적으로** 생성한다 — 구현은 `nodal_server.toolschema.build_input_schema` 다.

**타입 매핑** (§4.3 의 타입 표현식 → JSON Schema)

| nodal 타입 | JSON Schema | |
|---|---|---|
| `INT` | `{"type": "integer"}` | |
| `FLOAT` | `{"type": "number"}` | |
| `STRING` | `{"type": "string"}` | |
| `BOOL` | `{"type": "boolean"}` | |
| `List[T]` | `{"type": "array", "items": <T>}` | `T` 가 변환될 때만 |
| `Union[A, B]` | `{"anyOf": [<A>, <B>]}` | 멤버가 **전부** 변환될 때만 |
| `Image` | `{"type": "string"}` | **값 형식이 계약이다** — 아래 |
| `Any` | ❌ 변환 불가 | 검증할 것이 없다 — 툴을 템플릿당 하나 만든 이유가 지워진다 |
| 그 밖의 텐서 (`Mask` · `Latent`) | ❌ | MCP 인자는 JSON 이다. 클라이언트가 텐서를 만들 수 없다 |
| 이름 없는 텐서 서술자 (`{"tensor": ...}`) | ❌ | 계약이 붙은 것은 **카탈로그의 이름**이지 shape 가 아니다 |
| 불투명 핸들 (`Model` · `CLIP` · `VAE` ...) | ❌ | 핸들은 엔진 안에서만 산다 |

**❌ 가 하나라도 있으면 그 템플릿을 노출하지 않고 이유를 로그에 남긴다.** 구멍
난 스키마를 내보내느니 툴이 없는 편이 낫다 — AI 는 스키마가 허용하는 것을 그대로
시도하고, 텐서 자리에 무엇을 넣어야 하는지 물어볼 곳이 없으면 지어낸다.

**❌ 는 노출된 정의의 `params` 에만 걸린다.** 그 정의가 안에서 쓰는 중첩
서브그래프는 `Image` 를 받아도 된다 — 그 값은 밖에서 오지 않고 위쪽 노드에서
온다. 예제(`examples/templates/thumbnail.nodal.json`)가 그 모양이다.

**`Image` 만 예외인 이유**: 텐서는 JSON 이 될 수 없지만 **이미지는 클라이언트가
이미 가지고 있는 값**이고, 그것을 가리키는 문자열은 만들 수 있다. `Mask` 와
`Latent` 에는 클라이언트가 손에 쥔 대응물이 없다.

#### `Image` 파라미터의 값 형식 (2026-08-24 계약, M6.0b)

값은 문자열이고 **형식이 둘**이다:

| 형식 | 예 | |
|---|---|---|
| 파일 경로 | `examples/sample.png` | 서버가 읽을 수 있는 경로 |
| 에셋 참조 | `asset:9f2a...` | content-addressed (§4.5) |

**판별은 `asset:` 접두다.** 캐논 문서가 `$link` · `$param` 을 예약 키로 쓰는 것과
같은 방식이고 (§5.5), 한 문자열 안에 두 형식을 섞을 때 생기는 판별 모호성을
접두 하나로 없앤다. **`asset:` 는 예약 접두라 다른 뜻으로 쓸 수 없다** — 그래서
`Image` 로 선언되지 않은 파라미터에 들어온 에셋 참조도 같은 규칙으로 걸린다.

##### 현재 (2026-08-24 기준, 코드가 이렇다)

**경로만 동작한다.** `asset:` 는 형식만 계약에 있고 실행되지 않는다 — 서버에
**에셋에서 이미지를 읽는 노드가 없고**(`image.Load` 는 경로만 안다), 클라이언트가
이미지를 올리는 수단도 MCP 클라이언트마다 달라 아직 정할 수 없다.

**지금 `asset:` 값을 넘기면 명확한 미구현 에러다** (`AssetReferenceNotSupportedError`).
조용히 경로로 취급하지 않는다 — 그러면 `asset:9f2a...` 라는 이름의 파일을 찾다가
"그런 파일이 없다" 로 죽고, **클라이언트는 자기가 해시를 잘못 줬다고 생각한다.**
서버가 못 하는 일과 클라이언트가 틀린 것은 다른 문제이고 답도 다르다.

##### 목표 (에셋 경로를 열 때 채워야 하는 것)

1. 클라이언트가 이미지를 올리는 수단. `POST /api/assets` 는 이미 있지만 (§4.5)
   MCP 클라이언트가 그것을 부르는 경로가 정해지지 않았다
2. 에셋 해시로 이미지를 읽는 노드. 결과가 에셋 참조로 **나가는데**(§12.3) 들어올
   때는 경로뿐인 비대칭이 여기서 닫힌다

**형식을 지금 고정하는 이유가 이것이다.** 업로드 경로가 생겼을 때 **템플릿을
다시 고치지 않는다** — 이미 `Image` 로 선언한 파라미터가 그대로 에셋 참조를 받는다.

**필수와 선택**

`default` 가 없거나 `null` 이면 `required`, 있으면 optional 이고 그 값이 JSON
Schema 의 `default` 로 실린다. §5.5 의 규약을 그대로 옮긴 것이다 — 빈 값을 두
가지로 나누지 않는다는 결정도 함께 온다.

`additionalProperties: false` 를 언제나 붙인다. **템플릿이 선언한 파라미터만
받는다** 가 스키마에서 강제되는 자리다.

**설명 (`doc` → `description`)**

파라미터의 `doc`(§5.5)이 JSON Schema 의 `description` 이 된다. `Image` 처럼 값
형식이 따로 있는 타입은 사람이 쓴 설명 **뒤에** 형식 설명이 붙는다 — 앞이
"무엇인지", 뒤가 "어떻게 쓰는지" 라야 읽힌다.

**`doc` 이 없으면 `description` 도 없다.** 서버가 지어내지 않는다. 그때 AI 에게
보이는 것은 **이름과 타입뿐**이다:

```jsonc
"method": { "type": "string", "enum": ["nearest", "bilinear", "bicubic", "lanczos"] }
```

`method` 처럼 enum 이 스스로 말하는 파라미터는 그것으로 충분하다. 그러나
`strength` 나 `mode` 같은 이름은 값의 의미를 말하지 않으므로, AI 는 **범위 안의
아무 값이나 고른다.** 그것이 파라미터 `doc` 을 필수로 하지 않되 권하는 이유다 —
필수로 만들면 이름이 이미 충분한 자리에 잡음이 들어간다.

**위젯 힌트 → 제약**

| 힌트 | JSON Schema | 조건 |
|---|---|---|
| `min` · `max` | `minimum` · `maximum` | 숫자 타입일 때만 |
| `options` | `enum` | |
| `step` | `multipleOf` | **정수이고** `min` 이 `step` 의 배수일 때만 (아래) |
| `provider` | (없음) | 옵션이 실행 시점 레지스트리에서 나온다 (§4.2) |
| `multiline` · `placeholder` · `control` | (없음) | 표현만 바꾼다 |

**옮기지 못한 제약은 지어내지 않고 이유를 남긴다.** 원칙은 하나다 — **스키마가
엔진보다 엄격해지면 안 된다.** 그런 스키마는 엔진이 받아들이는 값을
클라이언트에서 거부하고, 그 실패는 서버 로그에 **아무 흔적도 남기지 않는다.**
있는 제약이 빠지는 것은 서버가 잡지만, 없는 제약이 생기는 것은 아무도 못 잡는다.

`step` 이 두 자리에서 멈추는 것이 그 예다:

- `multipleOf` 는 `값 % step == 0` 이지 스테퍼가 뜻하는 `(값 - min) % step == 0`
  이 아니다. `min: 1, step: 8` 에 `multipleOf: 8` 을 붙이면 엔진이 받는 100 을
  클라이언트가 거부한다 (`image.Resize` 의 `width` 가 정확히 그 모양이다)
- FLOAT 에서 `multipleOf: 0.1` 은 IEEE-754 때문에 0.3 을 거부하는 검증기가 있다.
  표현 오차로 정상 값이 막히는 쪽이 제약이 없는 쪽보다 나쁘다

**시드가 툴에 드러난다**

시드가 명시적 파라미터라는 것(위)에 하나를 더한다 — **템플릿이 시드를 선언했는지
자체가 툴에 드러나야 한다.** 툴 설명이 둘 중 하나를 말한다:

- 선언했다: 어느 파라미터가 시드인지, 같은 인자면 같은 결과가 나온다는 것
- 선언하지 않았다: **같은 인자로 다시 불러도 같은 결과가 보장되지 않는다는 것**

말하지 않으면 클라이언트는 재현될 것이라고 가정한다. 서버는 시드를 만들어 넣지
않으므로 그 가정은 틀릴 수 있고, 틀렸다는 사실은 그림이 달라진 뒤에야 드러난다.

시드로 인정되는 신호는 둘이고 **둘 중 하나면 시드다**: `widget.seed` 가 참이거나
(노드 SDK 의 `Seed` 가 붙이는 힌트와 같은 어휘 — `types.json`), 파라미터 이름이
`seed` 이거나. 이름만으로도 인정하는 이유는 힌트를 빠뜨린 템플릿이 조용히 "시드
없음" 으로 발표되는 쪽이 더 나쁘기 때문이다. "시드가 없다" 는 **재현되지 않는다는
약속**이라 틀리면 안 된다.

> **툴 설명은 선언에서 만들어 낸다.** 캐논 포맷에 설명 필드가 없기 때문이다
> (§5.5 의 `params` 는 `{type, default, widget}` 이 전부다). 이 커밋에서 필드를
> 추가하지 않았다 — 열린 질문 15.

#### 툴 응답과 에러 귀속

**툴 호출 하나는 그래프 하나로 감싸인다.** 모양은 언제나 같다:

```jsonc
{
  "definitions": { /* 템플릿 파일의 정의 전부 */ },
  "nodes": { "call": { "type": "subgraph.<템플릿 ID>", "inputs": { /* 툴 인자 */ } } },
  "outputs": ["call"]
}
```

정의를 통째로 싣는 이유는 노출된 정의가 다른 정의를 중첩해 쓸 수 있고, 문서가
자기완결적이어야 하기 때문이다 (§5.5).

**인스턴스 ID 가 `call` 로 고정된 것이 계약이다.** 평탄화 전에 나온 `GraphIssue`
의 `node_id` 가 `call` 이면 그 이슈는 **툴 인자**에 귀속되고 `socket` 이 곧
파라미터 이름이다. 그래서 에러를 번역하지 않고 그대로 옮기면 어느 인자인지
지목된다 — §12.3 이 요구하는 것이 이것이다.

```
missing_param | nodes.call.inputs.source_path | 필수 파라미터가 비어 있다 — ...
```

평탄화 후 내부 노드는 `call:<안쪽 ID>` 가 되고 (§5.5 ②), 요청된 출력 `call` 은
정의의 `returns` 가 가리키는 안쪽 노드로 옮겨진다.

**결과의 이름은 `returns` 가 정한다.** `get_run` 의 `results` 키가 정의의 `returns`
소켓 이름이고, 값은 **에셋 참조**다 (§4.5). `returns` 가 비어 있는 정의는 노출하지
않는다 — 내보내는 것이 없으면 툴이 돌려줄 것도 없다.

전송 형태는 **서버가 이미 소유한 것을 그대로 쓴다** — `AssetRefModel` ·
`OutputRefModel` · `IssueModel` (§6). MCP 를 위해 두 번째 표현을 만들지 않는다.
브리지를 거부한 §12.1 이 응답 형태에도 적용되는 자리다.

### 12.4 그래프 상태의 소유

**서버가 그래프 상태의 단일 소스다** (§2 원칙 7). 클라이언트가 둘 이상인 순간부터
이것은 선택이 아니다 — 웹 캔버스와 MCP 클라이언트가 각자 진짜라고 믿는 사본을 들면
합칠 방법이 없다.

지금 요구하는 것은 **웹 클라이언트가 그래프 상태를 독점 소유하는 설계를 하지 않는
것**뿐이다 (§7). 서버 측 그래프 저장소를 지금 만들라는 뜻은 아니다.

### 12.5 MVP 밖 — 실시간 가시화

**외부 AI 가 그래프를 만들거나 바꾸는 모습을 사용자가 캔버스에서 실시간으로 보는
기능은 MVP 에서 제외한다.** MCP 호출은 UI 가시화 없이 동작해도 된다.

가시화 자체는 나중에 얹을 수 있다 — 이미 WS 이벤트 채널이 있고(§6) 캐논 포맷이
하나다(§1.2 ①). 되돌릴 수 없는 것은 **상태 소유**뿐이라 그것만 지금 막아 둔다.

> **기능은 미루되 방향은 막아둔다.** 이 절이 하는 일의 전부다.

### 12.6 긴 실행 — `run_id` 반환 후 폴링

**툴 호출은 동기로 블로킹하지 않는다.** SDXL 생성 하나가 수십 초~수 분이고, MCP
클라이언트의 기본 요청 타임아웃은 그보다 훨씬 짧다 (대략 60 초대).

**툴 이름은 확정이다** (2026-08-24):

```
run_template_<id>(...)   → 즉시 { run_id, status } 반환. 템플릿마다 하나 (§12.2)
get_run(run_id)          → 상태 · 진행률 · 결과(에셋 참조)
cancel_run(run_id)       → 협조적 취소를 요청한다
list_templates()         → 카탈로그 상태. 거부된 파일과 이유를 포함한다 (§12.8)
```

**상태 전이도 확정이다.** 값과 이름은 REST 의 `RunStatus` 와 **같은 것**이다
(§6) — MCP 를 위해 상태를 새로 만들지 않는다.

| 상태 | 갈 수 있는 곳 | 언제 |
|---|---|---|
| `queued` | `running` | 워커가 집었다 |
| `queued` | `cancelled` | 시작 전에 `cancel_run` 이 왔다 |
| `running` | `succeeded` | 요청된 출력이 전부 끝났다 |
| `running` | `failed` | 노드가 실패했거나 검증이 실패했다 |
| `running` | `cancelled` | `cancel_run` 이후 노드가 `raise_if_cancelled()` 에 닿았다 |
| `succeeded` · `failed` · `cancelled` | (없음) | 종단이다 |

- **종단 상태에서 `cancel_run` 은 오류가 아니다.** 그때의 상태를 그대로 돌려준다.
  AI 가 이미 끝난 실행을 취소하려는 것은 정상적인 경합이고, 오류로 답하면
  클라이언트가 그것을 실패로 오해한다
- **취소는 요청이다.** 실제로 멈추는 것은 노드가 `raise_if_cancelled()` 를 부를
  때다 (§5.4). 즉시 멈춘다고 약속하지 않는다

- **`cancel_run` 은 선택 기능이 아니다.** AI 클라이언트가 스스로 판단을 바꿨을 때
  (잘못된 파라미터를 넣었다는 것을 뒤늦게 알았을 때) 중단할 방법이 없으면 GPU 를
  붙든 채 끝날 때까지 기다린다. 엔진의 협조적 취소(§5.4)를 그대로 노출한다
- **progress notification 은 *추가로* 보내되 의존하지 않는다.** 스펙상 진행률
  알림으로 타임아웃을 갱신할 수 있지만, 그것은 **클라이언트가 요청에
  progress token 을 붙였을 때만** 성립한다. 붙이지 않는 클라이언트에서는 서버가
  아무리 옳게 구현해도 하트비트가 무의미하다 — **서버 구현이 클라이언트 구현에
  좌우되는 구조에 정확성을 걸지 않는다.** 스펙 차원의 비동기·재개 메커니즘은
  아직 제안 단계다
- **부수 효과 하나가 공짜로 따라온다**: `run_id` 는 나중에 실시간 가시화(§12.5)를
  붙일 때 **관찰 지점**이 된다. MVP 에서 뺀 기능이 길을 막지 않는다

**run 기록은 메모리에 둔다** (2026-08-24 확정). 서버를 재시작하면 사라진다.
REST 의 실행 큐가 이미 그렇고 (§6 의 히스토리 상한), MCP 를 위해 두 번째 저장소를
만들지 않는다.

**에셋은 남는다.** content-addressed 라 디스크에 있다 (§4.5). 이 비대칭이 계약의
일부다:

| | 재시작 후 |
|---|---|
| `run_id` | 사라진다. 없는 run 을 물으면 **없다고 답한다** — 지어내지 않는다 |
| 에셋 해시 | 남는다. `GET /api/assets/{hash}` 가 그대로 답한다 |

**따라서 클라이언트가 오래 들고 있어야 하는 것은 `run_id` 가 아니라 해시다.**
`run_id` 는 그 실행이 끝날 때까지만 의미가 있다.

> ⚠️ `--assets DIR` 없이 띄우면 **에셋도 메모리다** (`nodal serve` 가 시작할 때
> 그렇게 말한다). 그러면 위 표의 오른쪽 칸도 사라진다. MCP 표면에서는 사실상
> 필수 옵션이다.

### 12.7 서브그래프는 로드 시 평탄화한다

**결정 (2026-08-23, 열린 질문 6 해소): 로드 시 평탄화.** 실행 시 노드 확장(§5.2)이
아니다.

- **이유는 캐시 입도다.** 실행 시 확장이면 서브그래프가 불투명한 실행 단위가 되고
  캐시가 통째로 걸리기 쉽다. 그러면 파라미터 하나 바꾼 재호출마다 전체 재계산 —
  §5.3 의 **과대 무효화가 항상** 일어나고, `IS_CHANGED` 를 격상한 이유와 정면으로
  어긋난다. 평탄화하면 캐시가 **내부 노드 단위**로 걸려 바뀐 노드 하류만 무효화된다
- **포기하는 것**: 입력 **값**에 따라 내부 구조가 달라지는 서브그래프 (예: N 개
  변형을 N 에 따라 노드로 펼치기). MVP 템플릿은 실행 전에 파라미터가 전부
  바인딩되므로 불필요하고, 필요해지면 **배치 차원**으로 푸는 것이 먼저다 (M5 ②)
- **따라서 §5.2 "노드 확장" 은 강등된 채로 둔다** (`roadmap.md` M5 ③).
  2026-08-23 에 **봉인**됐다 — `Expanded` 는 `NotImplementedError` 로 실패한다

> **"로드 시" 는 "실행 시 확장이 아니다" 라는 뜻이지 "파싱 직후" 가 아니다.**
> 실제로 평탄화가 도는 자리는 `validate_for_execution` 의 첫 걸음이다 (§5.5).
> 그래야 필수 파라미터 누락 같은 실패가 **예외가 아니라 `GraphIssue`** 로 나오고,
> `POST /api/graph/validate` 가 MCP 클라이언트에게 실행 전에 답할 수 있다
> (§12.3). 이 문장이 없어서 열린 질문 10 이 한동안 열려 있었다.

### 12.8 템플릿 카탈로그 — 발견 메커니즘은 하나다

**결정 (2026-08-23, 열린 질문 7 해소):** 카탈로그는 **디렉토리 하나**다 —
`~/.nodal/templates/*.nodal.json`. `list_templates()` 가 보는 것은 이 레지스트리
하나뿐이다.

§8 확장이 템플릿을 배포하는 것은 **두 번째 발견 경로가 아니라 같은 레지스트리에
등록하는 공급자**로 푼다. 노드 팩이 `register_combo_provider` 로 위젯 옵션에
합류하는 것과 같은 모양이다.

- **왜 §8 매니페스트에 얹지 않았나**: §8 로더는 M7(구 M6)에 있다. 거기 얹으면
  MVP 템플릿이 확장 시스템 완성을 기다린다 — MCP 표면(M6)이 자기보다 뒤 마일스톤에
  의존하게 된다
- **왜 두 경로를 만들지 않나**: 두 번 표현된 것은 어긋난다. `GET /api/models` 가
  정확히 그렇게 죽었다 (`decisions.md` 2026-08-18)

#### 규약 (2026-08-24 계약)

구현은 `nodal_server.templates` 다.

| | |
|---|---|
| 디렉토리 | `~/.nodal/templates` — 없으면 템플릿 0 개로 시작한다 (오류가 아니다) |
| 파일 | `<id>.nodal.json`. **캐논 문서와 같은 확장자다** — 템플릿은 별도 포맷이 아니다 |
| 템플릿 ID | 파일명에서 `.nodal.json` 을 뗀 것. `^[a-z][a-z0-9_]{0,47}$` |
| 노출되는 정의 | 그 파일의 `definitions` 중 **ID 와 같은 이름**의 정의 하나 |
| 툴 이름 | `run_template_<id>` |
| 노출 조건 | 그 정의에 **`doc` 이 있어야 한다** (M6.0b) |

**어느 정의가 툴인지는 파일 이름이 말한다.** 캐논 포맷에 필드를 만들지 않는다.
`ui` 에 넣는 것도 아니다 — 백엔드가 읽지 않기로 한 필드에 백엔드가 읽어야 하는
것을 넣으면 그 결정이 무의미해진다 (§4.1).

**ID 가 정의 이름(`_DEF_NAME_RE`)보다 좁은 이유는 둘이다.** ID 가 곧 파일명인데
macOS · Windows 는 대소문자를 구분하지 않으므로 `Foo` 와 `foo` 를 허용하면
**리눅스에서만 되는 카탈로그**가 된다. 길이를 48 자로 자르는 것은
`run_template_` 를 붙인 툴 이름이 64 자를 넘지 않게 하기 위해서다.

**정의는 여럿이어도 된다.** 나머지는 노출된 정의가 안에서 쓰는 중첩
서브그래프다. 노출은 언제나 하나다.

**최상위 `nodes` · `outputs` 는 MCP 표면이 읽지 않는다.** 같은 파일을
`nodal run` 으로 돌려볼 수 있게 남겨 두는 **저작용 하네스**다. 템플릿을 고치는
사람이 MCP 클라이언트를 띄우지 않고도 확인할 수 있어야 한다.

**로드를 거부하는 경우 — 조용히 건너뛰지 않는다:**

| 거부 사유 | |
|---|---|
| ID 가 규칙에 맞지 않는다 | 파일명 문제다 |
| 캐논 문서가 아니다 · 문서 검증(§5.5)에 실패한다 | `GraphIssue` 위치를 함께 남긴다 |
| 파일 이름과 같은 정의가 없다 | 있는 정의 목록을 함께 말한다 |
| **그 정의에 `doc` 이 없다** | 아래 |
| 그 정의에 `returns` 가 없다 | 내보내는 것이 없으면 툴이 돌려줄 것도 없다 |
| `params` 에서 `inputSchema` 를 만들 수 없다 | 어느 파라미터인지 지목한다 (§12.3) |

**`doc` 은 노출 지점에서만 필수다** (M6.0b, 사용자 결정). 서브그래프 일반에서는
선택이고 (§5.5), `~/.nodal/templates/` 에 놓여 MCP 툴이 되는 순간 요구한다.

> **툴 설명은 AI 가 그 툴을 고를지 판단하는 유일한 근거이므로, 설명 품질이 곧
> 제품 품질이다.** 그래서 노출 지점에서 강제한다.

서버가 대신 지어낼 수 없는 종류의 정보이기도 하다. 이름과 노드 목록에서 만들어
낸 문장("`image.Resize` 와 `image.Save` 를 쓰는 템플릿")은 **무엇을 하는지가
아니라 무엇으로 만들어졌는지**를 말한다. AI 는 그것으로 이 툴이 지금 필요한지
판단하지 못한다.

**이유는 로그에 남고 카탈로그에도 남는다.** 로그는 흘러가므로 `list_templates()`
가 같은 것을 답한다 (§12.2). 파일을 넣었는데 툴이 안 보이는 사람이 물어볼 자리가
그것이다.

**파일 하나가 잘못됐다고 카탈로그가 사라지지 않는다.** 그 파일만 거부한다 —
아니면 관계없는 템플릿을 쓰던 사람이 이유 없이 툴을 잃는다.

### 12.9 전송과 배치 — `nodal serve` 와 같은 프로세스다

**결정 (2026-08-24, 사용자 결정): MCP 서버는 `nodal serve` 와 같은 프로세스에서
streamable HTTP 로 노출한다.** 클라이언트가 띄우는 별도 stdio 프로세스가 아니다.

이유는 둘이고, 둘 다 나중에 고치기 어렵다:

- **nodal 서버는 GPU 와 모델 캐시를 붙든 장기 프로세스다** (§9.6). stdio 서버는
  클라이언트가 필요할 때 띄우고 끝나면 죽이는 수명인데, 거기에 체크포인트 로딩을
  얹으면 호출마다 수 GB 를 다시 읽는다. 웹 캔버스와 동시에 뜨면 VRAM 을 두 번 잡는다
- **별도 프로세스면 그것이 곧 브리지다.** 노드 스키마 · 타입 규칙 · 에러 귀속을
  두 번 표현하게 되고, 그것이 §12.1 이 ComfyUI MCP 브리지를 거부한 이유 그대로다.
  같은 프로세스면 카탈로그 · `AssetStore` · 실행 큐가 **하나의 인스턴스**다

```
nodal serve
├── /api/*     REST (§6)
├── /ws        WebSocket 이벤트 (§6)
└── /mcp       MCP streamable HTTP      ← 여기
```

따라오는 성질:

- **실행 큐가 하나다.** 웹 캔버스에서 돌린 것과 MCP 로 돌린 것이 같은 줄에 선다.
  GPU 가 하나라 그것이 맞다. 웹 UI 는 MCP 실행도 `/ws` 로 본다 — §12.5 가 미룬
  가시화가 나중에 붙을 자리가 이렇게 열려 있다
- **그래프 상태의 단일 소스가 서버라는 §12.4 가 배치에서도 성립한다**
- **인증은 MVP 밖이다** (2026-08-24 확정, 열린 질문 17). `nodal serve` 는 기본이
  `127.0.0.1` 이고 로컬 단일 사용자를 전제한다. MCP 를 붙였다고 그 전제가 바뀌지
  않는다. OAuth 같은 것은 `/mcp` 를 로컬 밖으로 열 때의 문제다
- **그러나 `Origin` 헤더 검증은 다르다 — M6.1 필수 항목이다** (`roadmap.md`).
  MCP streamable HTTP 는 DNS rebinding 대상이고 스펙이 `Origin` 검증을 요구한다.
  **`127.0.0.1` 바인딩은 이것을 막지 못한다** — 사용자가 브라우저로 연 악성
  페이지가 자기 도메인을 `127.0.0.1` 로 해석시키면 그 페이지의 스크립트가 로컬
  엔드포인트를 부를 수 있다. 인증이 없다는 것과 아무나 부를 수 있다는 것은
  다른 문제이고, 뒤엣것은 MVP 안에서 닫는다

> **G2 가 이 위험을 평균보다 높인다.** MCP 가 `nodal serve` 와 같은 프로세스에
> 있고 (위), 사용자는 그 서버를 **브라우저로 열어 둔 채** 작업한다. 캔버스를 띄워
> 둔 브라우저가 곧 공격 표면이다. 배치 결정이 만든 위험이므로 배치를 적은 자리에
> 함께 적는다 (§10 의 리스크 표에도 있다).

**의존성**: MCP 파이썬 SDK (`mcp`, MIT) 를 `packages/server` 에 넣었다. 라이선스는
`AGENTS.md` 기술 스택이 요구하는 허용적 계열이고, 전이 의존성도 MIT · BSD-3-Clause ·
Apache-2.0 · MIT-0 뿐이다 (`decisions.md` 2026-08-24).
