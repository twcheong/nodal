"""타입 시스템 — 소켓 타입 서술자와 호환 규칙 (docs/design.md §4.3).

규칙과 내장 타입 카탈로그는 이 모듈에 있지 않다. **`types.json` 하나에만** 있고
여기서는 그것을 읽어 해석할 뿐이다. TypeScript 쪽
(`apps/web/src/graph/typesystem.ts`)도 같은 파일을 읽는다. 규칙을 두 번 쓰지
않는다 (AGENTS.md 코딩 컨벤션).

호환은 항상 방향이 있다: `source`(출력 소켓) → `target`(입력 소켓)::

    is_compatible(Int, Float)   # True  — 숫자 승격
    is_compatible(Float, Int)   # False — 정밀도가 조용히 사라진다

`core` 는 이 타입들의 **서술자**만 안다. `Image` 가 실제로 PIL 이미지인지
numpy 배열인지는 모르며 알 필요도 없다 (AGENTS.md 아키텍처 절).
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any as TypingAny
from typing import ClassVar, Final, Self

__all__ = [
    "BOOL",
    "CLIP",
    "FLOAT",
    "INT",
    "STRING",
    "VAE",
    "Any",
    "AnyType",
    "CatalogType",
    "Conditioning",
    "Image",
    "Latent",
    "ListType",
    "Mask",
    "Model",
    "OpaqueType",
    "PrimitiveType",
    "Scheduler",
    "TensorType",
    "Type",
    "TypeCatalog",
    "TypeSpecError",
    "UnionType",
    "as_type",
    "builtin",
    "check_conformance",
    "explain_incompatibility",
    "is_compatible",
    "iter_named_types",
    "load_catalog",
    "parse_type_expr",
    "to_type_expr",
    "type_names",
]

#: `types.json` 의 파일 이름. 패키지 안에 함께 배포된다.
TYPES_FILE: Final = "types.json"


class TypeSpecError(Exception):
    """`types.json` 또는 타입 표현식이 잘못됐을 때."""


# --------------------------------------------------------------------- 타입


@dataclass(frozen=True, slots=True)
class Type:
    """모든 소켓 타입의 기반. 직접 인스턴스화하지 않는다."""

    def describe(self) -> str:
        """에러 메시지에 쓰는 사람이 읽는 표기."""
        raise NotImplementedError


@dataclass(frozen=True, slots=True)
class AnyType(Type):
    """와일드카드. 1급 타입이지 해킹이 아니다."""

    def describe(self) -> str:
        return "Any"


@dataclass(frozen=True, slots=True)
class PrimitiveType(Type):
    """`INT` · `FLOAT` · `STRING` · `BOOL`."""

    name: str

    def describe(self) -> str:
        return self.name


@dataclass(frozen=True, slots=True)
class TensorType(Type):
    """dtype 집합과 shape 서술을 가진 텐서.

    Args:
        dtypes: 이 소켓이 다룰 수 있는 dtype 이름들.
        shape: 차원별 서술. 정수는 고정 크기, 문자열 라벨과 `None` 은 임의 크기.
        name: 카탈로그에서 온 경우 그 이름 (`Image`). 즉석 서술이면 `None`.
    """

    dtypes: frozenset[str]
    shape: tuple[int | str | None, ...]
    name: str | None = None

    def describe(self) -> str:
        if self.name:
            return self.name
        dims = ", ".join("?" if d is None else str(d) for d in self.shape)
        return f"Tensor[{'|'.join(sorted(self.dtypes))}, ({dims})]"


@dataclass(frozen=True, slots=True)
class OpaqueType(Type):
    """이름 있는 불투명 핸들 + 능력 태그 집합.

    `Model[sdxl, unet]` 은 `Model[unet]` 을 요구하는 소켓에 연결할 수 있다.
    """

    name: str
    capabilities: frozenset[str] = field(default_factory=frozenset)

    def describe(self) -> str:
        if not self.capabilities:
            return self.name
        return f"{self.name}[{', '.join(sorted(self.capabilities))}]"


@dataclass(frozen=True, slots=True)
class ListType(Type):
    """`List[T]`."""

    item: Type

    def __post_init__(self) -> None:
        # 카탈로그 이름은 클래스다 (`CatalogType` 주석 참조). `ListType(Image)` 처럼
        # 이름을 그대로 넘길 수 있게 여기서 서술자로 바꾼다.
        object.__setattr__(self, "item", as_type(self.item))

    def describe(self) -> str:
        return f"List[{self.item.describe()}]"


@dataclass(frozen=True, slots=True)
class UnionType(Type):
    """`Union[A, B, ...]`."""

    members: tuple[Type, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "members", tuple(as_type(m) for m in self.members))

    def describe(self) -> str:
        return f"Union[{', '.join(m.describe() for m in self.members)}]"


# ------------------------------------------------------------------ 카탈로그


@dataclass(frozen=True)
class TypeCatalog:
    """`types.json` 을 읽어 해석한 결과.

    Attributes:
        version: `types_version`.
        named: 이름 → 타입 (INT, Image, Model ...).
        numeric_promotions: 허용된 (출처, 대상) 원시 타입 승격 쌍.
        rules: 규칙 스위치 원본. 개별 규칙을 끄면 호환 판정이 즉시 좁아진다.
        conformance: 양쪽 구현이 같은 답을 내야 하는 케이스 목록.
    """

    version: str
    named: Mapping[str, Type]
    numeric_promotions: frozenset[tuple[str, str]]
    rules: Mapping[str, TypingAny]
    conformance: tuple[Mapping[str, TypingAny], ...]

    def resolve(self, name: str) -> Type:
        """카탈로그 이름을 타입으로 푼다.

        Raises:
            TypeSpecError: 카탈로그에 없는 이름일 때.
        """
        if name == "Any":
            return AnyType()
        try:
            return self.named[name]
        except KeyError:
            known = ", ".join(sorted(self.named))
            raise TypeSpecError(f"알 수 없는 타입 이름: {name!r}. 카탈로그: {known}") from None

    def rule_enabled(self, name: str) -> bool:
        rule = self.rules.get(name)
        return bool(rule.get("enabled", False)) if isinstance(rule, Mapping) else False

    @classmethod
    def from_dict(cls, data: Mapping[str, TypingAny]) -> Self:
        """`types.json` 내용에서 카탈로그를 만든다.

        Raises:
            TypeSpecError: 필수 절이 없거나 형태가 잘못됐을 때.
        """
        try:
            version = str(data["types_version"])
            catalog = data["catalog"]
            rules = data["rules"]
        except KeyError as exc:
            raise TypeSpecError(f"types.json 에 {exc} 절이 없다") from exc

        named: dict[str, Type] = {}
        for name in catalog.get("primitives", {}):
            named[name] = PrimitiveType(name)
        for name, spec in catalog.get("tensors", {}).items():
            named[name] = TensorType(
                dtypes=frozenset(spec["dtypes"]),
                shape=tuple(spec["shape"]),
                name=name,
            )
        for name, spec in catalog.get("opaque", {}).items():
            named[name] = OpaqueType(name, frozenset(spec.get("capabilities", ())))

        promo = rules.get("numeric_promotion", {})
        edges = frozenset(
            (str(a), str(b)) for a, b in promo.get("edges", ()) if promo.get("enabled", False)
        )

        return cls(
            version=version,
            named=named,
            numeric_promotions=edges,
            rules=rules,
            conformance=tuple(data.get("conformance", ())),
        )


@lru_cache(maxsize=1)
def load_catalog() -> TypeCatalog:
    """패키지에 동봉된 `types.json` 을 읽는다. 결과는 캐시된다."""
    from importlib.resources import files

    raw = (files(__package__) / TYPES_FILE).read_text(encoding="utf-8")
    return TypeCatalog.from_dict(json.loads(raw))


def parse_type_expr(expr: TypingAny, catalog: TypeCatalog | None = None) -> Type:
    """`types.json` 의 타입 표현식을 `Type` 으로 파싱한다.

    문법은 `types.json` 의 `type_expression` 절에 서술되어 있다.

    Raises:
        TypeSpecError: 표현식이 문법을 벗어날 때.
    """
    cat = catalog or load_catalog()

    if isinstance(expr, str):
        return cat.resolve(expr)

    if isinstance(expr, Mapping):
        if "list" in expr:
            return ListType(parse_type_expr(expr["list"], cat))
        if "union" in expr:
            members = tuple(parse_type_expr(m, cat) for m in expr["union"])
            if not members:
                raise TypeSpecError("빈 union 은 만들 수 없다")
            return UnionType(members)
        if "opaque" in expr:
            return OpaqueType(str(expr["opaque"]), frozenset(expr.get("capabilities", ())))
        if "tensor" in expr:
            spec = expr["tensor"]
            return TensorType(frozenset(spec["dtypes"]), tuple(spec["shape"]))

    raise TypeSpecError(f"타입 표현식으로 해석할 수 없다: {expr!r}")


# -------------------------------------------------------------------- 호환성


def is_compatible(source: TypingAny, target: TypingAny, catalog: TypeCatalog | None = None) -> bool:
    """출력 소켓 `source` 를 입력 소켓 `target` 에 연결할 수 있는지 판정한다.

    방향이 있다. `is_compatible(a, b)` 와 `is_compatible(b, a)` 는 다른 질문이다.
    """
    return explain_incompatibility(source, target, catalog) is None


def explain_incompatibility(
    source: TypingAny,
    target: TypingAny,
    catalog: TypeCatalog | None = None,
) -> str | None:
    """호환되면 `None`, 아니면 사람이 읽는 이유를 돌려준다.

    에러가 익명이 되지 않도록 판정과 이유를 한 함수에서 만든다. 호출자는 이
    문자열을 "어느 노드의 어느 소켓" 에 붙여 쓴다 (AGENTS.md 코딩 컨벤션).
    """
    cat = catalog or load_catalog()
    # 카탈로그 이름은 클래스다. M1 이 동결한 `is_compatible(Image, Image)` 표면을
    # 유지하려고 입구에서 한 번 서술자로 바꾼다 (`as_type` 주석 참조).
    src = as_type(source)
    dst = as_type(target)
    why = _incompatible_reason(src, dst, cat)
    if why is None:
        return None
    return f"{src.describe()} → {dst.describe()}: {why}"


def _incompatible_reason(source: Type, target: Type, cat: TypeCatalog) -> str | None:
    # Any 는 양방향. 가장 먼저 본다.
    if cat.rule_enabled("any_bidirectional") and (
        isinstance(source, AnyType) or isinstance(target, AnyType)
    ):
        return None

    # 출처가 union 이면 기본적으로 **모든** 멤버가 대상에 호환이어야 한다.
    # 하나라도 못 가면, 그 멤버가 실제로 흘러왔을 때 대상이 받을 수 없다.
    # `union_narrowing` 을 켜면 멤버 하나만 호환돼도 통과한다 (런타임 위험을 감수).
    if isinstance(source, UnionType):
        reasons = [_incompatible_reason(m, target, cat) for m in source.members]
        if cat.rule_enabled("union_narrowing"):
            if any(r is None for r in reasons):
                return None
            return "union 의 어떤 멤버도 호환되지 않는다"
        for member, reason in zip(source.members, reasons, strict=True):
            if reason is not None:
                return (
                    f"union 멤버 {member.describe()} 가 호환되지 않는다 "
                    f"({reason}) — 좁힘은 허용되지 않는다"
                )
        return None

    # 대상이 union 이면 멤버 중 하나에만 들어가면 된다.
    if isinstance(target, UnionType):
        if not cat.rule_enabled("union_widening"):
            return "union 넓힘이 꺼져 있다"
        for member in target.members:
            if _incompatible_reason(source, member, cat) is None:
                return None
        return "union 의 어떤 멤버와도 호환되지 않는다"

    if isinstance(target, ListType):
        # List[A] → List[B] 는 공변, A → List[A] 는 승격.
        if isinstance(source, ListType):
            if not cat.rule_enabled("list_covariance"):
                return "리스트 공변이 꺼져 있다"
            inner = _incompatible_reason(source.item, target.item, cat)
            return None if inner is None else f"리스트 항목이 호환되지 않는다 ({inner})"
        if not cat.rule_enabled("list_promotion"):
            return "리스트 승격이 꺼져 있다"
        inner = _incompatible_reason(source, target.item, cat)
        return None if inner is None else f"리스트 항목으로 승격할 수 없다 ({inner})"

    if isinstance(source, ListType):
        return "리스트를 단일 값 소켓에 연결할 수 없다"

    if isinstance(source, PrimitiveType) and isinstance(target, PrimitiveType):
        if source.name == target.name:
            return None
        if (source.name, target.name) in cat.numeric_promotions:
            return None
        return "원시 타입이 다르고 승격 경로도 없다"

    if isinstance(source, TensorType) and isinstance(target, TensorType):
        return _tensor_reason(source, target, cat)

    if isinstance(source, OpaqueType) and isinstance(target, OpaqueType):
        if source.name != target.name:
            return "핸들 이름이 다르다"
        if not cat.rule_enabled("opaque_capability_subset"):
            return None if source.capabilities == target.capabilities else "능력 태그가 다르다"
        missing = target.capabilities - source.capabilities
        if missing:
            return f"요구되는 능력이 없다: {', '.join(sorted(missing))}"
        return None

    return "타입 종류가 다르다"


def _tensor_reason(source: TensorType, target: TensorType, cat: TypeCatalog) -> str | None:
    spec = cat.rules.get("tensor", {})

    if spec.get("dtype") == "subset" and not source.dtypes <= target.dtypes:
        extra = ", ".join(sorted(source.dtypes - target.dtypes))
        return f"대상이 받지 못하는 dtype 이 있다: {extra}"

    if spec.get("rank") == "equal" and len(source.shape) != len(target.shape):
        return f"랭크가 다르다 ({len(source.shape)} vs {len(target.shape)})"

    symbolic_any = bool(spec.get("symbolic_dim_matches_any", True))
    for axis, (a, b) in enumerate(zip(source.shape, target.shape, strict=False)):
        if isinstance(a, int) and isinstance(b, int):
            if a != b:
                return f"{axis}번 차원 크기가 다르다 ({a} vs {b})"
        elif not symbolic_any:
            return f"{axis}번 차원이 심볼이라 크기를 확정할 수 없다"
    return None


def check_conformance(catalog: TypeCatalog | None = None) -> list[str]:
    """`types.json` 의 적합성 케이스를 이 구현으로 돌려 불일치 목록을 만든다.

    TypeScript 로더도 같은 케이스를 돌린다. 양쪽이 모두 빈 목록을 내야 두
    구현이 같은 판정을 한다고 말할 수 있다.
    """
    cat = catalog or load_catalog()
    failures: list[str] = []
    for index, case in enumerate(cat.conformance):
        source = parse_type_expr(case["from"], cat)
        target = parse_type_expr(case["to"], cat)
        expected = bool(case["compatible"])
        actual = is_compatible(source, target, cat)
        if actual != expected:
            failures.append(
                f"[{index}] {source.describe()} → {target.describe()}: "
                f"기대 {expected}, 실제 {actual} (rule={case.get('rule')})"
            )
    return failures


def to_type_expr(socket_type: TypingAny, catalog: TypeCatalog | None = None) -> TypingAny:
    """`Type` → `types.json` 의 타입 표현식. `parse_type_expr` 의 역함수다.

    전송용이다. `describe()` 는 **사람이 읽는 렌더링**이라 복원할 수 없다
    (`Tensor[float32, (?, 3)]` 은 `?` 가 라벨이었는지 `None` 이었는지 지운다).
    이 함수는 프론트의 `parseTypeExpr()` 가 그대로 먹는 구조를 돌려준다.

    카탈로그에 있는 타입은 **이름 문자열**로 짧게 나간다 — `Image`, `INT`.
    """
    cat = catalog or load_catalog()
    socket_type = as_type(socket_type)

    if isinstance(socket_type, AnyType):
        return "Any"

    if isinstance(socket_type, ListType):
        return {"list": to_type_expr(socket_type.item, cat)}

    if isinstance(socket_type, UnionType):
        return {"union": [to_type_expr(member, cat) for member in socket_type.members]}

    # 카탈로그와 정확히 같으면 이름 하나로 줄인다.
    for name, known in cat.named.items():
        if known == socket_type:
            return name

    if isinstance(socket_type, OpaqueType):
        return {
            "opaque": socket_type.name,
            "capabilities": sorted(socket_type.capabilities),
        }

    if isinstance(socket_type, TensorType):
        return {
            "tensor": {
                "dtypes": sorted(socket_type.dtypes),
                "shape": list(socket_type.shape),
            }
        }

    if isinstance(socket_type, PrimitiveType):
        return socket_type.name

    raise TypeSpecError(f"타입 표현식으로 되돌릴 수 없다: {socket_type!r}")


def builtin(name: str) -> Type:
    """카탈로그 이름을 타입으로 푼다. `load_catalog().resolve(name)` 의 축약."""
    return load_catalog().resolve(name)


# ------------------------------------------------- 카탈로그 타입 (편의 이름)
#
# 값은 전부 `types.json` 에서 온다 — 여기에는 **이름만** 있다. 정의를 두 번 쓰지
# 않으면서 `returns = {"image": Image}` 처럼 쓸 수 있게 하고 IDE 자동완성도
# 살리기 위한 것이다. 이름이 카탈로그에서 사라지면 import 시점에 즉시 터진다.
#
# 주의: `Image` · `Model` 같은 이름이 core 에 있다고 해서 core 가 도메인을 아는
# 것은 아니다. core 가 가진 것은 dtype·shape·능력 태그 **서술자**뿐이고, 실제
# 런타임 값(PIL 이미지, torch 텐서)은 노드 패키지만 안다.

Any: Final[AnyType] = AnyType()

INT: Final[Type] = builtin("INT")
FLOAT: Final[Type] = builtin("FLOAT")
STRING: Final[Type] = builtin("STRING")
BOOL: Final[Type] = builtin("BOOL")


class CatalogType:
    """카탈로그 타입 이름을 **클래스**로 노출하는 기반.

    클래스인 이유는 **타입마다 문서가 붙을 자리**가 필요하기 때문이다. 각 하위
    클래스의 docstring 이 그 소켓의 런타임 계약(축 순서·dtype·범위)을 적어 두는
    유일한 곳이다. `Image` 가 인스턴스였다면 그 서술이 갈 곳이 없다.

    **core 는 런타임 타입을 제공하지 않는다.** 한때 `T = Any` 별칭이 있었지만
    없앴다 — `Any` 인데 타입처럼 보여서, 이미지가 흐르는 바로 그 자리에서
    타입 검사를 조용히 껐다. 런타임 타입은 그 표현을 **소유한 노드 팩**이
    준다 (design.md §4.4):

        from nodal_nodes_image import ImageArray   # np.ndarray[..., float32]

        def run(self, image: ImageArray) -> NodeResult: ...

    프리미티브(`INT`·`FLOAT`·`STRING`·`BOOL`)와 `Any` 는 인스턴스로 남는다.
    런타임 타입이 `int`·`float`·`str`·`bool` 이라 파이썬으로 그냥 적으면 된다.
    """

    #: `types.json` 에서 온 서술자. 판정은 전부 이것으로 한다.
    descriptor: ClassVar[Type]

    def __init_subclass__(cls, catalog: str = "", **kwargs: TypingAny) -> None:
        super().__init_subclass__(**kwargs)
        if catalog:
            cls.descriptor = builtin(catalog)

    def __new__(cls) -> Self:
        raise TypeError(f"{cls.__name__} 은 소켓 타입 **이름**이다. 인스턴스를 만들지 않는다")


class Image(CatalogType, catalog="Image"):
    """이미지 소켓.

    서술자는 `Tensor[float32, (B, H, W, C)]` 다 (`types.json`).
    런타임 값은 **채널 마지막 numpy 배열**이고 배치 축이 언제나 있다 (M3 계약,
    `design.md` §4.4). 정본은 `float32` 0..1 이다. `uint8` 0..255 와 PIL 은
    Load/Save 노드 내부의 파일 경계에서만 나타나고 소켓으로 흐르지 않는다.
    """


class Mask(CatalogType, catalog="Mask"):
    """마스크 소켓. `Tensor[float32, (B, H, W)]` — 채널 축이 없다."""


class Latent(CatalogType, catalog="Latent"):
    """잠재 텐서 소켓. `Tensor[float16|float32, (B, C, H, W)]` — 채널이 앞이다."""


class Model(CatalogType, catalog="Model"):
    """확산 모델 핸들."""


class CLIP(CatalogType, catalog="CLIP"):
    """텍스트 인코더 핸들."""


class Conditioning(CatalogType, catalog="Conditioning"):
    """인코딩된 조건 핸들 — `CLIPTextEncode` 의 출력, `KSampler` 의 입력.

    `CLIP` 과 **다른 타입**인 것이 요점이다. `CLIP` 은 인코더이고 이것은 그
    출력이다. 하나로 합치면 KSampler 의 `positive` 에 텍스트 인코더가 그대로
    꽂힌다 (`types.json` 의 conformance 케이스가 이것을 고정한다).
    """


class VAE(CatalogType, catalog="VAE"):
    """VAE 핸들."""


class Scheduler(CatalogType, catalog="Scheduler"):
    """샘플링 스케줄러 핸들."""


def as_type(value: TypingAny) -> Type:
    """카탈로그 이름 클래스나 `Type` 을 `Type` 으로 정규화한다 (M3 계약).

    `Image` 는 클래스이고 `Image.descriptor` 가 서술자다. 그런데 M1 이 동결한
    표면은 `is_compatible(Image, Image)` · `ListType(Image)` 처럼 **이름을 값으로**
    받는다. 그 계약을 깨지 않으려고 입구에서 한 번 변환한다.

    Raises:
        TypeSpecError: 타입으로 해석할 수 없는 값일 때.
    """
    if isinstance(value, Type):
        return value
    if isinstance(value, type) and issubclass(value, CatalogType):
        descriptor: Type | None = value.__dict__.get("descriptor") or getattr(
            value, "descriptor", None
        )
        if not isinstance(descriptor, Type):
            raise TypeSpecError(f"{value.__name__} 에 카탈로그 서술자가 없다")
        return descriptor
    raise TypeSpecError(f"타입으로 해석할 수 없다: {value!r}")


def iter_named_types(catalog: TypeCatalog | None = None) -> Iterable[tuple[str, Type]]:
    """카탈로그의 이름 있는 타입을 순회한다. 프론트 팔레트와 문서 생성용."""
    cat = catalog or load_catalog()
    yield from sorted(cat.named.items())


def type_names(catalog: TypeCatalog | None = None) -> Sequence[str]:
    """카탈로그에 있는 모든 타입 이름."""
    return sorted((catalog or load_catalog()).named)
