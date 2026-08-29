# 백엔드 노드 팩 저작 가이드

이 문서는 현재 코드가 지원하는 **Python 백엔드 노드 팩**만 다룬다. 아래 최소 예제는
[`examples/extensions/guide-pack`](../examples/extensions/guide-pack)에 그대로 있으며,
테스트가 그 디렉토리를 설치 경로에 복사해 `/api/nodes` 노출까지 확인한다.

## 먼저 알아둘 경계

- 확장 위치는 `~/.nodal/extensions/<pack>/` 하나다. `nodal run`·`validate`·`nodes`·
  `serve`·`launch`가 모두 같은 경로를 본다.
- `web/index.js` 전송로는 있다. 서버가 완성된 URL을 주고, 프론트가 그 URL을 한 번
  ESM으로 평가하며, 실패하면 다른 확장 실패와 같은 UI 배너에 사유를 표시한다.
- 그러나 평가된 모듈이 호출할 등록 함수나 위젯 마운트·해제 API는 **아직 없다.**
  따라서 커스텀 위젯은 아직 저작할 수 없다. `globalThis`를 뒤지거나 DOM을 직접
  바꾸는 코드는 지원되는 방법도 호환성 계약도 아니다 (`design.md` §8·§11 질문 20).
- 확장은 `nodal serve`와 같은 Python 프로세스에서 import된다. 신뢰하지 않는 확장
  코드를 설치하면 안 된다.

## 1. 디렉토리 만들기

최소 구조는 두 파일이다.

```text
my-pack/
├── nodal.toml
└── nodes/
    └── boolean.py
```

필요하면 `templates/*.nodal.json`을 추가할 수 있다. `web/`은 위에서 설명한 API가
정해질 때까지 사용하지 않는다.

## 2. 매니페스트 쓰기

```toml
[extension]
id = "com.example.my-pack"
name = "My Pack"
version = "0.1.0"
nodal_api = "^0.1"
```

- `id`는 소문자로 시작하고 소문자·숫자·`_`·`.`·`-`만 쓴다.
- `nodal_api`는 필수다. 현재 확장 API는 `0.1.0`이고 범위 문법은 캐럿만 지원한다.
  `^0.1`은 `>=0.1.0, <0.2.0`이다. `>=`·`~`·콤마 범위는 로드를 거부한다.
- `[dependencies].python`은 설계 문서에 예약돼 있지만 **현재 로더나 런처가 설치하지
  않는다.** 아래 완료 예제처럼 nodal 자체만 쓰는 팩은 바로 설치할 수 있다. 추가
  Python 패키지를 자동으로 해석·설치하는 경로는 아직 없으므로 그 기능이 있는 것처럼
  매니페스트에만 적어서는 안 된다.

## 3. 노드 정의하기

```python
from nodal import Bool, NodeResult, node


@node(
    id="example.InvertBoolean",
    title="Invert Boolean",
    category="example",
    aliases=["not", "반전"],
)
class InvertBoolean:
    value: Bool = Bool(False, doc="뒤집을 값")

    returns = {"value": Bool}

    def run(self, value: bool) -> NodeResult:
        return NodeResult(not value)
```

계약은 다음과 같다.

- `@node(id=...)`의 ID는 반드시 `namespace.Name` 모양이고 전체 레지스트리에서
  유일해야 한다. 충돌은 덮어쓰지 않고 그 확장 전체를 거부한다.
- 클래스 어노테이션은 **소켓 서술자**다. `Int`·`Float`·`Str`·`Bool`·`Combo`·
  `Seed`와 `Socket(Image)` 같은 현재 `nodal` export만 쓴다.
- `run`의 어노테이션은 실제 Python 런타임 값이다. 위 예제에서 클래스의 `Bool`과
  `run`의 `bool`은 서로 다른 층이다.
- 기본값이 없으면 필수 입력이다. `Int(512, min=1, max=4096, step=8)`처럼 현재
  서술자가 제공하는 제약만 쓴다. 자유로운 위젯 힌트 문자열을 만들지 않는다.
- `returns`는 출력 소켓 이름과 타입을 선언한다. `NodeResult`의 위치 인자 개수와
  선언된 출력 개수가 같아야 한다.
- `run`은 평범한 동기 함수나 `async def`다. 실행 컨텍스트가 필요할 때만 이름이
  정확히 `ctx`인 파라미터를 추가한다. 그렇지 않으면 엔진 없이 `run`을 직접 단위
  테스트할 수 있어야 한다.
- 부수효과가 있는 출력 노드는 `@node(..., output_node=True, cacheable=False)`로
  선언한다. 입력이 같아도 다시 실행돼야 하는 동작을 캐시하면 안 된다.

`types.json`의 타입 카탈로그나 위젯 닫힌 어휘는 백엔드와 프론트 사이의 인터페이스다.
노드 팩이 임의 이름을 추가하는 확장 지점이 아니다.

## 4. 설치하기

macOS·Linux:

```bash
mkdir -p ~/.nodal/extensions
cp -R examples/extensions/guide-pack ~/.nodal/extensions/guide-pack
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.nodal\extensions" | Out-Null
Copy-Item -Recurse -Force "examples\extensions\guide-pack" "$HOME\.nodal\extensions\guide-pack"
```

서버가 실행 중이었다면 재시작한다. 로더는 시작할 때 한 번 import한다. 원클릭
런처도 이 사용자 홈 경로를 명시적으로 사용하므로, 저장소 안에 팩을 섞을 필요가 없다.

## 5. 노출 확인하기

CLI:

```bash
uv run nodal nodes guide
```

서버:

```bash
uv run nodal serve
```

다른 터미널에서:

```bash
curl http://127.0.0.1:8188/api/nodes
curl http://127.0.0.1:8188/api/extensions
```

`guide.InvertBoolean`이 `/api/nodes`에 있고 `com.example.guide-pack`이
`/api/extensions.loaded[]`에 있으면 설치된 것이다. 실패한 확장은 서버 시작 로그와
`/api/extensions.failed[]`에 원인이 나온다. 한 확장의 실패는 다른 확장을 막지 않는다.

깨끗한 임시 Python 환경에서 같은 과정을 끝까지 재현하려면 다음을 실행한다.

```bash
uv run python tools/smoke_node_pack.py
```

이 검사는 임시 venv를 만들고 nodal 패키지들을 설치한 뒤, 예제 팩을 임시 사용자 홈의
`.nodal/extensions`에 복사하고 실제 서버의 `/api/nodes` 응답을 확인한다.
