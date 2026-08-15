# nodal

로컬에서 돌아가는 **노드 기반 이미지 생성 워크스테이션**. ComfyUI 와 같은 종류의 도구를,
그 코드를 한 줄도 보지 않고 처음부터 다시 설계한 것이다.

캔버스에 노드를 놓고 소켓을 연결해 그래프를 만들면, 실행 엔진이 필요한 노드만 위상 정렬해서
돌린다. 입력 하나를 바꾸면 **그 아래만** 다시 실행된다.

> **비공개 저장소다.** 개별적으로 공유받아 읽고 있다면, 이 문서 하나로 실행까지 가는 것이
> 목적이다. 막히는 곳이 있으면 그건 문서의 버그다.

---

## 왜 다시 만드는가

ComfyUI 는 훌륭하게 동작하지만 몇 가지가 초기 설계에 박혀 있어 고치기 어렵다.
nodal 은 그 지점들을 처음부터 다르게 잡았다.

| | ComfyUI | nodal |
|---|---|---|
| 소켓 타입 | 자유 문자열 (`"IMAGE"`) | 구조화된 타입 서술자. 와일드카드도 1급 타입 |
| 노드 정의 | 딕셔너리-튜플 스키마 | 선언형 클래스 + 타입 힌트 |
| 노드 ID | 순번 문자열 (`"3"`, `"7"`) | UUID |
| 캐시 키 | 노드 ID 기반 | **입력 시그니처** 기반 |
| 그래프 포맷 | 실행용 / UI용 두 벌 | 한 벌. UI 상태는 같은 문서의 `ui` 필드에 격리 |
| 모델 계층 | 직접 구현 | `diffusers` 에 위임 |

라이선스도 다르다 — ComfyUI 는 GPL-3.0, nodal 은 **Apache-2.0** 이다.
그래서 ComfyUI 코드는 참고조차 하지 않는다 (`NOTICE-provenance.md` 가 기록으로 남아 있다).

---

## 지금 무엇이 되는가

**M3 까지 완료.** 로드맵 M0~M6 중 4개 단계가 끝났다.

### ✅ 되는 것

- **그래프 편집기** — React Flow 캔버스. 노드 생성·연결·삭제·이동, 더블클릭 퍼지 검색
  (한글 별칭 지원), 드래그 중 타입이 호환되는 소켓만 밝게 표시, 저장/불러오기
- **실행 엔진** — 출력 노드에서 역방향으로 필요한 것만 실행, 사이클 탐지, 다이아몬드 의존성,
  입력 시그니처 기반 LRU 캐시, 동기/비동기 노드 자동 감지, 실행 중 취소
- **실시간 상태** — WebSocket 으로 노드별 대기/실행/캐시/에러 색상이 즉시 바뀐다
- **이미지 노드 7종** — Load · Save · Resize · Crop · Blend · Mask · Composite.
  노드 안에 이미지 프리뷰가 그려진다
- **PNG 워크플로 임베딩** — Save 한 PNG 의 `iTXt` 청크에 그래프가 UTF-8 로 들어간다.
  그 PNG 를 캔버스에 **드래그앤드롭하면 워크플로가 그대로 복원된다**
- **CLI** — `nodal run` 하나로 UI 없이 그래프를 실행한다. 어느 노드가 캐시로 스킵됐는지
  기호로 보인다
- **에러 메시지** — 항상 **어느 노드의 어느 소켓**인지 지목한다. 익명 에러가 없다

### ❌ 아직 안 되는 것

솔직하게 적는다. 아래는 전부 **아직 구현되지 않았다.**

- **Diffusion 이 없다 (M4).** 이미지를 *생성* 하지는 못한다. 체크포인트 로딩, KSampler,
  VAE, LoRA, ControlNet 이 전부 다음 단계다. **지금은 GPU 가 필요 없고, 쓰지도 않는다.**
  현재 상태는 "노드 그래프로 돌아가는 이미지 *처리* 도구"에 가깝다
- **조건 분기가 없다 (M5).** lazy 입력, Switch/Router 노드, 서브그래프, 배치 처리
- **확장 시스템이 없다 (M6).** 서드파티 노드 팩을 설치하는 경로가 아직 없다.
  (`--pack` 으로 이름을 대면 로드되긴 하지만 매니페스트·격리 환경이 없다)
- **Undo/redo 가 없다 (M6).** Yjs 가 스택에는 있지만 아직 붙이지 않았다
- **패키징이 없다 (M6).** 원클릭 런처 없이 아래처럼 직접 띄운다
- **한국어 UI 만 있다.** i18n 은 로드맵에 없다

---

## 5분 안에 실행하기

### 준비물

| 도구 | 버전 | 비고 |
|---|---|---|
| [`uv`](https://docs.astral.sh/uv/) | 최신 | Python 은 `uv` 가 알아서 받아온다. 직접 설치할 필요 없다 |
| Node.js | 20+ | |
| `pnpm` | 11+ | `corepack enable` 하면 버전이 자동으로 맞는다 |

GPU 는 **필요 없다.** M4 전까지는 torch 조차 설치되지 않는다.

### 1. 설치

```bash
uv sync
```

```bash
pnpm install
```

두 락파일(`uv.lock`, `pnpm-lock.yaml`)이 커밋되어 있으므로 버전은 그대로 재현된다.

### 2. 백엔드 서버

```bash
uv run nodal serve
```

`노드 18개 등록. http://127.0.0.1:8188/docs` 가 찍히면 성공이다.
`/docs` 에서 REST API 를 바로 눌러볼 수 있다.

> Save 한 이미지를 디스크에 남기려면 `uv run nodal serve --assets ./assets` 로 띄운다.
> 안 주면 메모리에만 있다가 서버를 끄면 사라진다 (시작할 때 알려준다).

### 3. 프론트엔드 — **새 터미널에서**

```bash
pnpm --filter @nodal/web dev
```

http://localhost:5173 을 연다. 우상단에 **`LIVE API`** 배지가 보이면 실서버에 붙은 것이다.
(백엔드 없이 화면만 보고 싶으면 `VITE_NODAL_API_MODE=mock` 을 앞에 붙인다.)

<!-- 📸 스크린샷 자리 — 그래프 편집기 전체 화면 -->
> **[스크린샷: 노드 팔레트 + 캔버스 + 인스펙터가 보이는 전체 화면]**

---

## 이렇게 써보세요

### A. CLI 로 실행 엔진의 요점 보기 — 1분

이 저장소에서 가장 중요한 것은 캐시다. `examples/arithmetic.nodal.json` 은 그것을
눈으로 보여주려고 만든 그래프다 (다이아몬드 의존성 + 실행되지 않는 노드 포함).

```bash
uv run nodal run examples/arithmetic.nodal.json --twice --set offset.value=10
```

`--twice` 는 **같은 캐시로 두 번** 돌리고, `--set` 은 2회차에만 적용된다.
그래서 출력이 이렇게 나온다:

```
▶ 실행 시작 (11개 노드)
  ● offset 실행
  ● seed 실행
  ...

▶ 같은 캐시로 재실행 (offset.value=10 적용)
  ● offset 실행
  ◌ seed 캐시 히트 — 건너뜀
  ◌ doubled 캐시 히트 — 건너뜀
  ● shifted 실행
  ◌ squared 캐시 히트 — 건너뜀
  ● gap 실행
  ...

결과
  report.text = '최종 결과: 36'

실행 8 · 캐시 3 · 0ms
```

**`◌` 가 캐시 히트, `●` 가 실행이다.** `offset` 을 바꿨더니 그 아래(`shifted` → `gap` → …)만
다시 돌고, 무관한 `seed` · `doubled` · `squared` 는 건너뛴다. 캐시 키가 노드 ID 가 아니라
**입력 시그니처**라서 가능한 동작이다.

그래프에 있는 `unused` 노드는 어느 실행에도 나타나지 않는다 — `outputs` 에 기여하지 않으니
엔진이 아예 건드리지 않는다.

같이 볼 만한 것:

```bash
uv run nodal validate examples/arithmetic.nodal.json   # 실행 없이 검증만
uv run nodal nodes 곱하기                               # 한글 별칭으로 노드 검색
uv run nodal nodes                                      # 등록된 노드 18개 전부
```

### B. 브라우저에서 이미지 워크플로 — 3분

1. 왼쪽 팔레트의 **IMAGE/IO → Load Image** 를 캔버스로 끌어다 놓고, `path` 에 아무 PNG/JPEG
   경로를 적는다
2. **IMAGE/TRANSFORM → Resize Image** 를 놓고 `Load` 의 `image` 출력을 `Resize` 의 `image`
   입력에 연결한다 — 드래그하는 동안 **호환되는 소켓만 밝게** 표시된다
3. **IMAGE/IO → Save Image** 를 붙이고 우상단 **실행** 을 누른다
4. 각 노드 안에 이미지 프리뷰가 그려지고, 상태 색이 실행 → 성공으로 바뀐다
5. 다시 **실행** 을 누르면 전부 `캐시` 상태가 된다

<!-- 📸 스크린샷 자리 — 이미지 노드 3개가 연결되고 프리뷰가 보이는 상태 -->
> **[스크린샷: Load → Resize → Save 가 연결되고 노드 안에 프리뷰가 뜬 모습]**

**그리고 여기가 재미있는 부분** — 저장된 PNG 를 캔버스에 **드래그앤드롭** 하면
그래프가 통째로 복원된다. 워크플로가 PNG 의 `iTXt` 메타데이터 안에 UTF-8 로 들어 있다.

CLI 로도 같은 것을 할 수 있다:

```bash
uv run nodal run my-image-graph.json --assets ./assets
```

<!-- 📸 스크린샷 자리 — PNG 드롭 → 워크플로 복원 -->
> **[스크린샷: PNG 를 캔버스에 떨어뜨려 워크플로가 복원되는 순간]**

---

## 검사 돌려보기

전부 통과하는 상태로 공유했다. 확인하고 싶으면:

```bash
tools/ci-local.sh
```

`.github/workflows/ci.yml` 을 **파싱해서** 거기 있는 명령을 그대로 실행한다 —
CI 의 복사본이 아니라서 어긋나지 않는다. 로컬 대응물이 없는 단계는 무엇을 왜 건너뛰었는지
끝에 나열한다.

---

## 저장소 구조

```
packages/core          # 그래프 엔진. torch 도 이미지도 모른다. 도메인 중립
packages/server        # FastAPI — REST + WebSocket
packages/nodes-core    # 기본 노드 팩 (수학·문자열) + `nodal` CLI
packages/nodes-image   # 이미지 노드 팩 (numpy · Pillow 는 여기에만 있다)
apps/web               # Vite + React 프론트엔드
schemas/               # 생성된 JSON Schema · OpenAPI (손으로 고치지 않는다)
examples/              # 예제 그래프
```

의존성은 **한 방향으로만** 흐른다:

```
apps/web  →  packages/server  →  packages/core
packages/nodes-*  →  packages/core
```

`packages/core` 는 torch 도, server 도, 노드 팩도 import 하지 않는다. 사람이 지키는 게
아니라 `ruff` 의 `banned-api` 규칙이 거부한다.

---

## 문서 안내

**읽는 순서대로** 적었다.

| 파일 | 무엇 | 읽어야 하나 |
|---|---|---|
| [`docs/design.md`](docs/design.md) | 아키텍처 · 데이터 모델 · 실행 엔진 · API 스펙 | **설계가 궁금하면 여기.** 이 저장소에서 가장 내용이 많은 문서다 |
| [`docs/roadmap.md`](docs/roadmap.md) | M0~M6 마일스톤과 완료 기준 | **진행 상황이 궁금하면 여기.** 체크박스가 현재 상태다 |
| [`docs/dev.md`](docs/dev.md) | 로컬에서 무엇을 실행하는지 | 직접 만져볼 거면 |
| [`docs/decisions.md`](docs/decisions.md) | 설계 판단 변경 로그 | "왜 이렇게 했지?" 싶을 때 |
| [`docs/license.md`](docs/license.md) | Apache-2.0 선택 근거 | 라이선스가 궁금하면 |

### 사람은 안 읽어도 되는 파일

- **[`AGENTS.md`](AGENTS.md) · [`CLAUDE.md`](CLAUDE.md) — 코딩 에이전트용 지침이다.**
  이 저장소는 Claude Code 와 Codex 가 함께 작업했고, 두 에이전트가 서로 밟지 않게 하려고
  둔 규칙이다. 사람이 코드를 이해하는 데는 필요 없다. (다만 "ComfyUI 코드를 절대
  복사하지 않는다"가 왜 절대 규칙인지는 궁금하면 볼 만하다.)
- **`NOTICE-provenance.md`** — 외부 프로젝트를 아키텍처 수준에서만 참조했다는 내부 기록.
  법적 방어용이지 읽을거리가 아니다.

---

## 라이선스

**[Apache-2.0](LICENSE)** — 저작권자 정태우 (twcheong99@gmail.com).
귀속 고지는 [`NOTICE`](NOTICE) 에 있다.

MIT 가 아니라 Apache-2.0 인 이유는 **명시적 특허 허여(§3)** 다. 이미지 생성은 특허 활동이
활발한 영역이라 기여자로부터 특허 라이선스를 함께 받아두는 쪽이 채택자에게 안전하다.
전체 근거와 검토했다 탈락한 선택지들은 [`docs/license.md`](docs/license.md) 에 있다.

의존성은 전부 허용적 라이선스(MIT · Apache-2.0 · BSD · HPND)로 유지한다.
**GPL/AGPL 의존성은 추가하지 않는다** — CI 의 `licence-guard` 잡이 강제한다.
