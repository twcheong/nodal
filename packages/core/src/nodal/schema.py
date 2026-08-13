"""노드 스키마 — `@node` 데코레이터와 리플렉션 (docs/design.md §4.2).

> **계약 파일.** 본문은 M1 에서 채운다. 시그니처는 다른 에이전트가 테스트를
> 작성하는 근거이므로 사용자 확인 없이 바꾸지 않는다 (AGENTS.md 협업 규칙 7).

클래스 어노테이션이 곧 입력 스키마다. 딕셔너리-튜플 스키마를 쓰지 않는다::

    @node(id="image.Resize", category="image/transform")
    class Resize:
        image:  Image
        width:  Int   = Int(512, min=1, max=16384, step=8)
        method: Combo = Combo("lanczos", options=["nearest", "lanczos"])

        returns = {"image": Image}

        def run(self, image, width, method) -> NodeResult:
            return NodeResult(resized, preview=resized)

**어노테이션이 취할 수 있는 형태는 둘뿐이다.**

1. `Type` 인스턴스 (`Image`, `Model`, `Any`) — 위젯 없는 순수 소켓
2. `InputDescriptor` 하위 클래스 (`Int`, `Combo`) — 기본값과 위젯 제약을 붙일 수 있다

기본값이 `InputDescriptor` 인스턴스면 그것이 최종 권위를 갖는다. 기본값이 없으면
필수 입력이다.

**출력 이름**은 `returns` 가 정한다. 캐논 그래프는 링크를 `["n_c3d4", "image"]`
처럼 이름으로 참조하므로 (design.md §4.1) 이름 없는 출력은 존재할 수 없다::

    returns = {"image": Image}                      # 명시
    returns = {"model": Model, "clip": CLIP}        # 다중 출력
    returns = Image                                 # 축약 → "image"
    returns = (Model, CLIP, VAE)                    # 축약 → "model", "clip", "vae"

축약형의 이름은 타입 이름을 소문자로 바꿔 만든다. 같은 타입이 두 번 나오면
`image`, `image_2` 로 붙는다. 이름을 통제하고 싶으면 딕셔너리를 쓴다.

**`ctx` 는 이름으로 옵트인한다.** `run` 시그니처에 `ctx` 파라미터가 있을 때만
엔진이 실행 컨텍스트를 주입한다. 없으면 `run` 은 엔진 없이 그냥 호출할 수 있는
평범한 함수다 — 단위 테스트가 가능해야 한다는 요구사항이 이것이다.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any as TypingAny
from typing import ClassVar, Self, TypeVar

from .types import Type

__all__ = [
    "Bool",
    "Combo",
    "ComboProvider",
    "Float",
    "InputDescriptor",
    "InputSpec",
    "Int",
    "NodeResult",
    "NodeSchema",
    "OutputSpec",
    "SchemaError",
    "Socket",
    "Str",
    "node",
    "output_names_for",
    "reflect_node",
]

NodeClass = TypeVar("NodeClass", bound=type)

#: `Combo.from_provider("checkpoints")` 가 호출할 옵션 공급자.
ComboProvider = Callable[[], Sequence[str]]


class SchemaError(Exception):
    """노드 클래스가 스키마 규칙을 만족하지 않을 때.

    메시지는 항상 어느 노드의 어느 소켓인지 지목한다 (AGENTS.md 코딩 컨벤션).
    """

    def __init__(
        self,
        message: str,
        *,
        node_id: str | None = None,
        socket: str | None = None,
    ) -> None:
        self.node_id = node_id
        self.socket = socket
        where = node_id or "<이름 없는 노드>"
        if socket:
            where = f"{where}.{socket}"
        super().__init__(f"{where}: {message}")


# ------------------------------------------------------------- 입력 서술자


@dataclass(frozen=True)
class InputDescriptor:
    """입력 소켓 하나의 서술 — 타입 + 기본값 + UI 위젯 제약.

    직접 만들기보다 `Int` · `Float` · `Combo` 같은 하위 클래스를 쓴다. 임의
    카탈로그 타입에는 `Socket(Image)` 을 쓴다.

    Attributes:
        type: 소켓 타입. 호환 판정은 `nodal.types.is_compatible` 이 한다.
        default: 기본값. `MISSING` 이면 필수 입력이다.
        lazy: 참이면 upstream 을 즉시 평가하지 않는다 (design.md §1.1 ⑤, M5).
        doc: 툴팁 문구.
        widget: 프론트가 읽는 위젯 힌트 (min/max/step/options ...). 백엔드는
            검증에만 쓴다.
    """

    #: `default` 가 없음을 나타내는 센티넬. `None` 은 유효한 기본값이므로 쓸 수 없다.
    MISSING: ClassVar[object] = object()

    type: Type
    default: TypingAny = MISSING
    lazy: bool = False
    doc: str = ""
    widget: Mapping[str, TypingAny] = field(default_factory=dict)

    @property
    def required(self) -> bool:
        """기본값이 없으면 필수다."""
        raise NotImplementedError


@dataclass(frozen=True)
class Socket(InputDescriptor):
    """임의 카탈로그 타입을 받는 입력. `Socket(Image, lazy=True)`."""

    def __init__(
        self,
        type: Type,
        default: TypingAny = InputDescriptor.MISSING,
        *,
        lazy: bool = False,
        doc: str = "",
    ) -> None:
        raise NotImplementedError


@dataclass(frozen=True)
class Int(InputDescriptor):
    """정수 입력. `Int(512, min=1, max=16384, step=8)`."""

    def __init__(
        self,
        default: int | object = InputDescriptor.MISSING,
        *,
        min: int | None = None,
        max: int | None = None,
        step: int = 1,
        lazy: bool = False,
        doc: str = "",
    ) -> None:
        raise NotImplementedError


@dataclass(frozen=True)
class Float(InputDescriptor):
    """실수 입력. `Float(1.0, min=0.0, max=10.0, step=0.1)`."""

    def __init__(
        self,
        default: float | object = InputDescriptor.MISSING,
        *,
        min: float | None = None,
        max: float | None = None,
        step: float = 0.01,
        lazy: bool = False,
        doc: str = "",
    ) -> None:
        raise NotImplementedError


@dataclass(frozen=True)
class Str(InputDescriptor):
    """문자열 입력. `Str("", multiline=True)`."""

    def __init__(
        self,
        default: str | object = InputDescriptor.MISSING,
        *,
        multiline: bool = False,
        placeholder: str = "",
        lazy: bool = False,
        doc: str = "",
    ) -> None:
        raise NotImplementedError


@dataclass(frozen=True)
class Bool(InputDescriptor):
    """불리언 입력. `Bool(False)`."""

    def __init__(
        self,
        default: bool | object = InputDescriptor.MISSING,
        *,
        lazy: bool = False,
        doc: str = "",
    ) -> None:
        raise NotImplementedError


@dataclass(frozen=True)
class Combo(InputDescriptor):
    """고정 옵션 중 하나를 고르는 입력. 소켓 타입은 `STRING` 이다.

    옵션이 실행 시점에 결정되는 경우(체크포인트 파일 목록 등)에는
    `Combo.from_provider` 를 쓴다.
    """

    def __init__(
        self,
        default: str | object = InputDescriptor.MISSING,
        *,
        options: Sequence[str] = (),
        lazy: bool = False,
        doc: str = "",
    ) -> None:
        raise NotImplementedError

    @classmethod
    def from_provider(
        cls,
        provider: str,
        *,
        default: str | object = InputDescriptor.MISSING,
        lazy: bool = False,
        doc: str = "",
    ) -> Self:
        """등록된 공급자 이름으로 옵션을 채운다. `Combo.from_provider("checkpoints")`.

        공급자 자체는 core 밖에서 등록된다 — core 는 체크포인트가 무엇인지 모른다.
        """
        raise NotImplementedError

    def options(self) -> Sequence[str]:
        """현재 유효한 옵션 목록. 공급자 기반이면 매번 새로 묻는다."""
        raise NotImplementedError


# ------------------------------------------------------------ 리플렉션 결과


@dataclass(frozen=True, slots=True)
class InputSpec:
    """리플렉션이 확정한 입력 소켓 하나."""

    name: str
    type: Type
    default: TypingAny
    required: bool
    lazy: bool
    doc: str
    widget: Mapping[str, TypingAny]


@dataclass(frozen=True, slots=True)
class OutputSpec:
    """리플렉션이 확정한 출력 소켓 하나. 이름은 캐논 그래프의 링크가 참조한다."""

    name: str
    type: Type
    doc: str = ""


@dataclass(frozen=True, slots=True)
class NodeSchema:
    """`@node` 가 붙은 클래스에서 뽑아낸 완전한 스키마.

    레지스트리가 담고, 프론트 팔레트가 소비하고, 실행 엔진이 입력을 맞출 때
    본다. 노드 클래스 자체를 들고 있으므로 엔진은 이것만으로 실행할 수 있다.

    Attributes:
        id: 네임스페이스를 포함한 타입 ID. 캐논 그래프의 `node.type` 과 같다.
        version: 캐시 키에 들어가는 스키마 버전 (design.md §5.3). 입출력을
            바꿨으면 올린다 — 안 올리면 옛 캐시가 새 스키마로 재사용된다.
        output_node: 참이면 실행 선택 휴리스틱이 우선한다 (design.md §1.1 ②).
        cacheable: 거짓이면 결과를 캐시하지 않는다.
        is_async: `run` 이 코루틴 함수인지. 엔진이 자동 감지한다.
        wants_ctx: `run` 시그니처에 `ctx` 파라미터가 있는지.
    """

    id: str
    title: str
    category: str
    aliases: tuple[str, ...]
    version: str
    output_node: bool
    cacheable: bool
    inputs: Mapping[str, InputSpec]
    outputs: Mapping[str, OutputSpec]
    node_class: type
    is_async: bool
    wants_ctx: bool
    doc: str = ""

    def input(self, name: str) -> InputSpec:
        """입력 소켓 하나. 없으면 `SchemaError`."""
        raise NotImplementedError

    def output(self, name: str) -> OutputSpec:
        """출력 소켓 하나. 없으면 `SchemaError`."""
        raise NotImplementedError


# ------------------------------------------------------------ 실행 결과 값


class NodeResult:
    """`run` 이 돌려주는 값 + UI 사이드채널.

    값과 UI 를 분리하는 것이 요점이다. 프리뷰 이미지는 downstream 노드가 받는
    데이터가 아니라 사용자가 보는 것이다::

        return NodeResult(out, preview=out)
        return NodeResult(unet, text_encoder, vae)

    값은 `returns` 에 선언한 순서대로 위치 인자로 넣는다. 개수가 맞지 않으면
    엔진이 어느 노드인지 지목하며 실패한다.
    """

    def __init__(
        self,
        *values: TypingAny,
        preview: TypingAny = None,
        text: str | None = None,
        ui: Mapping[str, TypingAny] | None = None,
    ) -> None:
        raise NotImplementedError

    @property
    def values(self) -> tuple[TypingAny, ...]:
        """선언 순서대로의 출력 값들."""
        raise NotImplementedError

    def as_outputs(self, schema: NodeSchema) -> Mapping[str, TypingAny]:
        """값을 출력 소켓 이름에 맞춰 딕셔너리로 만든다.

        Raises:
            SchemaError: 값 개수가 `returns` 선언과 다를 때.
        """
        raise NotImplementedError


# -------------------------------------------------------------- 데코레이터


def node(
    *,
    id: str,
    title: str | None = None,
    category: str = "",
    aliases: Sequence[str] = (),
    version: str = "1",
    output_node: bool = False,
    cacheable: bool = True,
) -> Callable[[NodeClass], NodeClass]:
    """노드 클래스를 표시하고 스키마를 붙인다.

    데코레이터는 클래스를 **그대로 돌려준다**. 감싸거나 바꾸지 않는다 — 테스트가
    `Resize().run(...)` 를 엔진 없이 그대로 호출할 수 있어야 한다. 뽑아낸
    스키마는 클래스 속성 `__nodal_schema__` 에 붙는다.

    등록은 하지 않는다. 등록은 `NodeRegistry.register` 가 명시적으로 한다 —
    전역 `NODE_CLASS_MAPPINGS` 딕셔너리를 쓰지 않는다 (design.md §1.2 ④).

    Args:
        id: 네임스페이스 필수 (`image.Resize`). 캐논 그래프의 `node.type`.
        title: UI 표시 이름. 없으면 클래스 이름에서 만든다.
        category: 팔레트 분류 (`image/transform`).
        aliases: 검색용 별칭. 한글을 포함할 수 있다.
        version: 스키마 버전. 캐시 키에 들어간다 (design.md §5.3).
        output_node: 실행 선택 휴리스틱에서 우선할 노드인지 (design.md §1.1 ②).
        cacheable: 거짓이면 결과를 캐시하지 않는다.

    Raises:
        SchemaError: 어노테이션·`returns`·`run` 이 규칙을 만족하지 않을 때.
    """
    raise NotImplementedError


def reflect_node(node_class: type) -> NodeSchema:
    """`@node` 없이도 클래스에서 스키마를 뽑는다. 데코레이터가 내부에서 쓴다.

    Raises:
        SchemaError: 어노테이션을 타입으로 해석할 수 없거나, `returns` 가
            없거나, `run` 이 없을 때.
    """
    raise NotImplementedError


def output_names_for(returns: TypingAny) -> Mapping[str, Type]:
    """`returns` 선언을 이름 → 타입 딕셔너리로 정규화한다.

    딕셔너리는 그대로, 축약형(`Image`, `(Model, CLIP, VAE)`)은 타입 이름을
    소문자로 바꿔 이름을 만든다. 같은 타입이 반복되면 `image`, `image_2`.

    Raises:
        SchemaError: `returns` 를 해석할 수 없거나 이름이 중복될 때.
    """
    raise NotImplementedError


def get_schema(node_class: type) -> NodeSchema:
    """`@node` 가 붙인 스키마를 꺼낸다.

    Raises:
        SchemaError: `@node` 가 붙지 않은 클래스일 때.
    """
    raise NotImplementedError
