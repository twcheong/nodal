"""노드 스키마 — `@node` 데코레이터와 리플렉션 (docs/design.md §4.2).

> 시그니처는 다른 에이전트가 테스트를 작성하는 근거다. 사용자 확인 없이
> 바꾸지 않는다 (AGENTS.md 협업 규칙 7).

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

import inspect
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any as TypingAny
from typing import ClassVar, Self, TypeVar

from .types import BOOL, FLOAT, INT, STRING, Type

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
    "get_schema",
    "node",
    "output_names_for",
    "reflect_node",
    "register_combo_provider",
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
        return self.default is InputDescriptor.MISSING


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
        super().__init__(type=type, default=default, lazy=lazy, doc=doc, widget={})


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
        super().__init__(
            type=INT,
            default=default,
            lazy=lazy,
            doc=doc,
            widget=_widget(min=min, max=max, step=step),
        )


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
        super().__init__(
            type=FLOAT,
            default=default,
            lazy=lazy,
            doc=doc,
            widget=_widget(min=min, max=max, step=step),
        )


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
        super().__init__(
            type=STRING,
            default=default,
            lazy=lazy,
            doc=doc,
            widget=_widget(multiline=multiline or None, placeholder=placeholder or None),
        )


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
        super().__init__(type=BOOL, default=default, lazy=lazy, doc=doc, widget={})


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
        super().__init__(
            type=STRING,
            default=default,
            lazy=lazy,
            doc=doc,
            widget=_widget(options=tuple(options) or None),
        )

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
        combo = cls(default, lazy=lazy, doc=doc)
        object.__setattr__(combo, "widget", _widget(provider=provider))
        return combo

    def options(self) -> Sequence[str]:
        """현재 유효한 옵션 목록. 공급자 기반이면 매번 새로 묻는다."""
        provider = self.widget.get("provider")
        if provider is None:
            return tuple(self.widget.get("options", ()))
        try:
            return tuple(_COMBO_PROVIDERS[provider]())
        except KeyError:
            known = ", ".join(sorted(_COMBO_PROVIDERS)) or "(등록된 공급자 없음)"
            raise SchemaError(
                f"등록되지 않은 Combo 공급자: {provider!r}. 등록된 것: {known}"
            ) from None


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
        try:
            return self.inputs[name]
        except KeyError:
            known = ", ".join(self.inputs) or "(입력 없음)"
            raise SchemaError(
                f"그런 입력 소켓이 없다. 있는 것: {known}", node_id=self.id, socket=name
            ) from None

    def output(self, name: str) -> OutputSpec:
        """출력 소켓 하나. 없으면 `SchemaError`."""
        try:
            return self.outputs[name]
        except KeyError:
            known = ", ".join(self.outputs) or "(출력 없음)"
            raise SchemaError(
                f"그런 출력 소켓이 없다. 있는 것: {known}", node_id=self.id, socket=name
            ) from None


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
        self._values = values
        self.preview = preview
        self.text = text
        self.ui: Mapping[str, TypingAny] = dict(ui) if ui else {}

    @property
    def values(self) -> tuple[TypingAny, ...]:
        """선언 순서대로의 출력 값들."""
        return self._values

    def as_outputs(self, schema: NodeSchema) -> Mapping[str, TypingAny]:
        """값을 출력 소켓 이름에 맞춰 딕셔너리로 만든다.

        Raises:
            SchemaError: 값 개수가 `returns` 선언과 다를 때.
        """
        names = tuple(schema.outputs)
        if len(self._values) != len(names):
            raise SchemaError(
                f"run 이 값 {len(self._values)}개를 돌려줬는데 returns 는 "
                f"{len(names)}개를 선언했다 ({', '.join(names) or '없음'})",
                node_id=schema.id,
            )
        return dict(zip(names, self._values, strict=True))

    def __repr__(self) -> str:
        extra = ""
        if self.preview is not None:
            extra += ", preview=..."
        if self.text is not None:
            extra += f", text={self.text!r}"
        return f"NodeResult({', '.join(repr(v) for v in self._values)}{extra})"


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
    options = _NodeOptions(
        id=id,
        title=title,
        category=category,
        aliases=tuple(aliases),
        version=version,
        output_node=output_node,
        cacheable=cacheable,
    )

    def decorate(node_class: NodeClass) -> NodeClass:
        if not _NODE_TYPE_ID_RE.match(id):
            raise SchemaError(
                f"노드 타입 ID 는 네임스페이스를 포함해야 한다 (예: image.Resize): {id!r}",
                node_id=id,
            )
        node_class.__nodal_options__ = options  # type: ignore[attr-defined]
        node_class.__nodal_schema__ = reflect_node(node_class)  # type: ignore[attr-defined]
        return node_class

    return decorate


def reflect_node(node_class: type) -> NodeSchema:
    """`@node` 없이도 클래스에서 스키마를 뽑는다. 데코레이터가 내부에서 쓴다.

    Raises:
        SchemaError: 어노테이션을 타입으로 해석할 수 없거나, `returns` 가
            없거나, `run` 이 없을 때.
    """
    options = node_class.__dict__.get("__nodal_options__") or _NodeOptions(
        # `@node` 없이 부를 때의 기본값. 모듈 이름을 네임스페이스로 쓴다.
        id=f"{node_class.__module__.rsplit('.', 1)[-1]}.{node_class.__name__}"
    )
    node_id = options.id

    inputs = _reflect_inputs(node_class, node_id)

    returns = getattr(node_class, "returns", None)
    if returns is None:
        raise SchemaError(
            "`returns` 선언이 없다. 출력이 없는 노드도 `returns = {}` 를 명시해야 한다",
            node_id=node_id,
        )
    outputs = {
        name: OutputSpec(name=name, type=socket_type)
        for name, socket_type in output_names_for(returns).items()
    }

    run = getattr(node_class, "run", None)
    if run is None or not callable(run):
        raise SchemaError("`run` 메서드가 없다", node_id=node_id)

    params = _run_parameters(run)
    _check_run_signature(node_id, run, params, inputs)

    return NodeSchema(
        id=node_id,
        title=options.title or _title_from_class_name(node_class.__name__),
        category=options.category,
        aliases=options.aliases,
        version=options.version,
        output_node=options.output_node,
        cacheable=options.cacheable,
        inputs=inputs,
        outputs=outputs,
        node_class=node_class,
        is_async=inspect.iscoroutinefunction(run),
        wants_ctx=_CTX_PARAM in params,
        doc=inspect.cleandoc(node_class.__doc__ or ""),
    )


def output_names_for(returns: TypingAny) -> Mapping[str, Type]:
    """`returns` 선언을 이름 → 타입 딕셔너리로 정규화한다.

    딕셔너리는 그대로, 축약형(`Image`, `(Model, CLIP, VAE)`)은 타입 이름을
    소문자로 바꿔 이름을 만든다. 같은 타입이 반복되면 `image`, `image_2`.

    Raises:
        SchemaError: `returns` 를 해석할 수 없거나 이름이 중복될 때.
    """
    if isinstance(returns, Mapping):
        out: dict[str, Type] = {}
        for name, socket_type in returns.items():
            resolved = _as_socket_type(socket_type)
            if resolved is None:
                raise SchemaError(
                    f"출력 타입으로 해석할 수 없다: {socket_type!r}", socket=str(name)
                )
            out[str(name)] = resolved
        return out

    declared = returns if isinstance(returns, tuple) else (returns,)

    named: dict[str, Type] = {}
    for entry in declared:
        resolved = _as_socket_type(entry)
        if resolved is None:
            raise SchemaError(f"출력 타입으로 해석할 수 없다: {entry!r}")
        base = _output_name_for_type(resolved)
        name, index = base, 1
        while name in named:
            index += 1
            name = f"{base}_{index}"
        named[name] = resolved
    return named


def get_schema(node_class: type) -> NodeSchema:
    """`@node` 가 붙인 스키마를 꺼낸다.

    Raises:
        SchemaError: `@node` 가 붙지 않은 클래스일 때.
    """
    schema = getattr(node_class, "__nodal_schema__", None)
    if not isinstance(schema, NodeSchema):
        raise SchemaError(f"`@node` 가 붙지 않은 클래스다: {node_class.__name__}")
    return schema


def register_combo_provider(name: str, provider: ComboProvider) -> None:
    """`Combo.from_provider(name)` 이 호출할 옵션 공급자를 등록한다.

    core 는 공급자가 무엇을 세는지 모른다 — 체크포인트 디렉토리를 스캔하는 것은
    노드 패키지의 일이다.
    """
    _COMBO_PROVIDERS[name] = provider


# ------------------------------------------------------------------ 내부


#: `@node(id=...)` 가 요구하는 네임스페이스 형태. 캐논 그래프의 `node.type` 과 같다.
_NODE_TYPE_ID_RE = re.compile(r"^[a-z][a-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$")

#: 이 이름의 파라미터가 `run` 에 있으면 엔진이 실행 컨텍스트를 주입한다.
_CTX_PARAM = "ctx"

_COMBO_PROVIDERS: dict[str, ComboProvider] = {}


@dataclass(frozen=True, slots=True)
class _NodeOptions:
    """`@node` 인자를 담아 클래스에 붙여 두는 상자."""

    id: str
    title: str | None = None
    category: str = ""
    aliases: tuple[str, ...] = ()
    version: str = "1"
    output_node: bool = False
    cacheable: bool = True


def _widget(**hints: TypingAny) -> Mapping[str, TypingAny]:
    """`None` 인 힌트를 걸러낸 위젯 딕셔너리. 안 쓴 제약은 스키마에 남기지 않는다."""
    return {key: value for key, value in hints.items() if value is not None}


def _title_from_class_name(name: str) -> str:
    """`LoadCheckpoint` → `Load Checkpoint`."""
    out: list[str] = []
    for index, char in enumerate(name):
        if char.isupper() and index and not name[index - 1].isupper():
            out.append(" ")
        out.append(char)
    return "".join(out)


def _output_name_for_type(socket_type: Type) -> str:
    """축약형 `returns` 의 이름을 타입에서 만든다. `Image` → `image`."""
    return socket_type.describe().split("[", 1)[0].lower()


def _as_socket_type(value: TypingAny) -> Type | None:
    """어노테이션이나 `returns` 항목을 소켓 타입으로 푼다. 해석 못 하면 `None`."""
    if isinstance(value, Type):
        return value
    if isinstance(value, InputDescriptor):
        return value.type
    if isinstance(value, type) and issubclass(value, InputDescriptor):
        if value is InputDescriptor:
            # 기반 클래스는 타입을 모른다. `Socket(Image)` 나 하위 서술자를 써야 한다.
            return None
        # `Int` 처럼 클래스로 쓴 경우. 하위 서술자는 인자 없이 만들 수 있고 자기
        # 타입을 안다. (기반 클래스는 `type` 이 필수라 mypy 가 여기서 항의한다.)
        return value().type  # type: ignore[call-arg]
    return None


def _reflect_inputs(node_class: type, node_id: str) -> Mapping[str, InputSpec]:
    """클래스 어노테이션을 입력 스키마로 바꾼다. 선언 순서를 유지한다."""
    specs: dict[str, InputSpec] = {}

    # 상위 클래스부터 훑어 하위 클래스가 덮어쓸 수 있게 한다.
    for klass in reversed(node_class.__mro__):
        if klass is object:
            continue
        try:
            annotations = inspect.get_annotations(klass, eval_str=True)
        except (NameError, AttributeError) as exc:
            raise SchemaError(f"어노테이션을 평가할 수 없다: {exc}", node_id=node_id) from exc

        for name, annotation in annotations.items():
            if name.startswith("_") or name in _RESERVED_ATTRS:
                continue
            specs[name] = _input_spec(node_id, name, annotation, getattr(klass, name, None))

    return specs


#: 입력 소켓이 아닌 클래스 속성 이름.
_RESERVED_ATTRS = frozenset({"returns", "run"})


def _input_spec(
    node_id: str,
    name: str,
    annotation: TypingAny,
    declared_default: TypingAny,
) -> InputSpec:
    """어노테이션 + 기본값 한 쌍을 `InputSpec` 으로 확정한다."""
    if isinstance(declared_default, InputDescriptor):
        # 기본값이 서술자면 그것이 최종 권위를 갖는다.
        descriptor = declared_default
    else:
        socket_type = _as_socket_type(annotation)
        if socket_type is None:
            raise SchemaError(
                f"어노테이션을 소켓 타입으로 해석할 수 없다: {annotation!r}. "
                "카탈로그 타입(Image, Model, Any) 이거나 입력 서술자(Int, Combo) 여야 한다",
                node_id=node_id,
                socket=name,
            )
        descriptor = InputDescriptor(
            type=socket_type,
            default=(InputDescriptor.MISSING if declared_default is None else declared_default),
        )

    return InputSpec(
        name=name,
        type=descriptor.type,
        default=descriptor.default,
        required=descriptor.required,
        lazy=descriptor.lazy,
        doc=descriptor.doc,
        widget=descriptor.widget,
    )


def _run_parameters(run: TypingAny) -> Mapping[str, inspect.Parameter]:
    """`run` 의 파라미터. `self` 는 뺀다."""
    params = dict(inspect.signature(run).parameters)
    params.pop("self", None)
    return params


def _check_run_signature(
    node_id: str,
    run: TypingAny,
    params: Mapping[str, inspect.Parameter],
    inputs: Mapping[str, InputSpec],
) -> None:
    """입력 소켓과 `run` 파라미터가 맞는지 본다.

    오타를 런타임이 아니라 노드 정의 시점에 잡는 것이 목적이다.
    """
    accepts_kwargs = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())
    if accepts_kwargs:
        return

    for socket in inputs:
        if socket not in params:
            raise SchemaError(
                f"입력 소켓이 `run` 시그니처에 없다. run({', '.join(params) or ''}) 를 확인하라",
                node_id=node_id,
                socket=socket,
            )

    for param in params:
        if param != _CTX_PARAM and param not in inputs:
            raise SchemaError(
                f"`run` 파라미터에 대응하는 입력 소켓이 없다. "
                f"클래스 어노테이션에 {param!r} 을 선언하거나 파라미터를 지워라",
                node_id=node_id,
                socket=param,
            )
