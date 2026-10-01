"""템플릿 파라미터 → MCP 툴 `inputSchema` (docs/design.md §12.3).

**변환은 기계적이다.** 템플릿이 선언한 `params` 하나하나가 JSON Schema 프로퍼티
하나가 되고, 사람이 손으로 스키마를 쓰는 자리는 없다. 그래서 잘못된 인자가
**서버에 닿기 전에** MCP 클라이언트에서 걸린다 — 툴을 템플릿당 하나씩 만드는
이유가 그것이다 (§12.2 G1).

세 가지를 지킨다:

1. **엔진보다 엄격해지지 않는다.** 옮길 수 없는 제약은 옮기지 않고 이유를
   남긴다. 스키마가 엔진이 받아들이는 값을 거부하면 클라이언트는 정상 호출을
   못 하고, 그 실패는 서버 로그에 아무 흔적도 남기지 않는다
2. **변환할 수 없는 타입이 하나라도 있으면 그 템플릿은 노출되지 않는다.** 구멍이
   난 스키마를 내보내느니 툴이 없는 편이 낫다 — AI 는 스키마가 허용하는 것을
   그대로 시도한다
3. **조용히 넘어가지 않는다.** 거부도 제약 누락도 이유가 남는다 (§12.8)
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from nodal import ParamDef
from nodal.types import (
    AnyType,
    ListType,
    OpaqueType,
    PrimitiveType,
    TensorType,
    Type,
    TypeSpecError,
    UnionType,
    parse_type_expr,
)

__all__ = [
    "ASSET_PREFIX",
    "IMAGE_VALUE_DOC",
    "PRIMITIVE_JSON_TYPE",
    "InputSchema",
    "SchemaNote",
    "build_input_schema",
]

#: nodal 원시 타입 → JSON Schema `type`. 이 넷이 변환 가능한 전부의 바닥이다.
PRIMITIVE_JSON_TYPE: Final[Mapping[str, str]] = {
    "INT": "integer",
    "FLOAT": "number",
    "STRING": "string",
    "BOOL": "boolean",
}

#: 숫자 제약이 의미를 갖는 JSON Schema 타입.
_NUMERIC: Final = frozenset({"integer", "number"})

#: 표현만 바꾸는 위젯 힌트. JSON Schema 에 대응물이 없고, 없어도 잃는 것이 없다.
_PRESENTATION_HINTS: Final = frozenset({"seed", "control", "multiline", "placeholder"})

#: 에셋 참조 값의 **예약 접두** (§12.3 H2). `$link` · `$param` 이 캐논 문서에서
#: 예약 키인 것과 같은 방식이다 — 한 문자열 안에 두 형식(경로 · 에셋 참조)을
#: 섞을 때 생기는 판별 모호성을 접두 하나로 없앤다.
#:
ASSET_PREFIX: Final = "asset:"

#: `Image` 파라미터의 값 형식 설명. 스키마의 `description` 으로 나간다.
#:
#: 이것은 선택이 아니다 — 타입이 `{"type": "string"}` 이라 **무엇을 담는
#: 문자열인지** 말해 주지 않으면 클라이언트가 알 방법이 없다.
IMAGE_VALUE_DOC: Final = (
    f"이미지 값: 파일 경로이거나 에셋 참조 `{ASSET_PREFIX}<hash>` 다. "
    "클라이언트 파일은 같은 서버의 `POST /api/assets`에 multipart 필드 `file`로 "
    f"올리고, 응답의 `hash`를 `{ASSET_PREFIX}<hash>`로 넘긴다 (docs/design.md §12.3)."
)


@dataclass(frozen=True, slots=True)
class SchemaNote:
    """변환 중에 생긴 할 말 하나. 파라미터 이름을 반드시 지목한다.

    `errors` 로 모이면 템플릿이 노출되지 않고, `notes` 로 모이면 노출되지만
    제약 하나가 스키마에 실리지 않았다는 뜻이다.
    """

    param: str
    reason: str

    def __str__(self) -> str:
        return f"{self.param}: {self.reason}"


@dataclass(frozen=True, slots=True)
class InputSchema:
    """`build_input_schema` 의 결과.

    `errors` 가 비어 있지 않으면 `schema` 는 `None` 이다 — 반쪽짜리 스키마를
    돌려주면 호출자가 그것을 노출해 버릴 수 있다.
    """

    schema: dict[str, Any] | None
    errors: tuple[SchemaNote, ...] = ()
    notes: tuple[SchemaNote, ...] = ()

    @property
    def ok(self) -> bool:
        return self.schema is not None


def build_input_schema(params: Mapping[str, ParamDef]) -> InputSchema:
    """템플릿의 `params` 선언에서 MCP 툴 `inputSchema` 를 만든다 (§12.3).

    규약:

    - `default` 가 없으면(= `None`) **필수**, 있으면 optional 이고 그 값이
      JSON Schema `default` 로 실린다 (§5.5 의 규약 그대로다 — 빈 값을 두 가지로
      나누지 않는다)
    - `widget` 의 `min`·`max`·`step`·`options` 는 JSON Schema 제약이 된다
    - `additionalProperties: false` — 템플릿이 선언한 파라미터만 받는다 (§12.3)
    - `doc` 은 `description` 이 된다. **없으면 비어 있다** — AI 에게는 이름과
      타입만 보이므로, 이름이 스스로 말하지 못하는 파라미터는 `doc` 을 적는다

    Returns:
        `InputSchema`. 예외는 던지지 않는다 — 카탈로그는 파일 하나가 잘못됐다고
        멈추지 않고 그 파일만 거부한다.
    """
    properties: dict[str, Any] = {}
    required: list[str] = []
    errors: list[SchemaNote] = []
    notes: list[SchemaNote] = []

    for name, param in params.items():
        try:
            parsed = parse_type_expr(param.type)
        except TypeSpecError as exc:
            errors.append(SchemaNote(name, f"타입 표현식이 올바르지 않다 — {exc}"))
            continue

        prop = _type_schema(parsed)
        if prop is None:
            errors.append(
                SchemaNote(
                    name,
                    f"{parsed.describe()} 은 JSON 인자로 표현할 수 없다 "
                    "(MCP 클라이언트는 텐서나 핸들을 만들 수 없다). "
                    "밖에서 받아야 하는 값이면 STRING 으로 받아 템플릿 안에서 로드하라",
                )
            )
            continue

        notes.extend(_apply_widget(name, prop, param.widget))
        _apply_doc(prop, param.doc)

        if param.required:
            required.append(name)
        else:
            prop["default"] = param.default

        properties[name] = prop

    if errors:
        return InputSchema(None, tuple(errors), tuple(notes))

    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        # 템플릿이 선언한 파라미터만 받는다 (§12.3). 임의 노드 주입 경로가 아니다.
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return InputSchema(schema, (), tuple(notes))


def _type_schema(parsed: Type) -> dict[str, Any] | None:
    """nodal 타입 → JSON Schema 조각. 표현할 수 없으면 `None`.

    표에 담긴 결정은 `docs/design.md` §12.3 에 있다. 여기 없는 것은 전부
    `None` 이고, 그 판단의 근거는 하나다 — **MCP 클라이언트가 JSON 으로 만들 수
    있는가.** 텐서와 불투명 핸들은 엔진 안에서만 사는 값이고, `Any` 는 검증할
    것이 없어서 툴을 템플릿당 하나 만든 이유를 지운다.
    """
    if isinstance(parsed, PrimitiveType):
        json_type = PRIMITIVE_JSON_TYPE.get(parsed.name)
        return None if json_type is None else {"type": json_type}
    if isinstance(parsed, TensorType) and parsed.name == "Image":
        # 유일한 예외다 (§12.3 H2). 텐서 자체는 JSON 이 될 수 없지만 **이미지는
        # 클라이언트가 이미 가지고 있는 값**이고, 그것을 가리키는 문자열은 만들 수
        # 있다. 이름 없는 즉석 텐서 서술자(`{"tensor": ...}`)는 여기 해당하지
        # 않는다 — 계약이 붙은 것은 카탈로그의 `Image` 하나다.
        return {"type": "string", "description": IMAGE_VALUE_DOC}
    if isinstance(parsed, ListType):
        item = _type_schema(parsed.item)
        return None if item is None else {"type": "array", "items": item}
    if isinstance(parsed, UnionType):
        members = [_type_schema(m) for m in parsed.members]
        if any(m is None for m in members):
            return None
        return {"anyOf": members}
    # AnyType · (Image 를 제외한) TensorType · OpaqueType 은 의도적으로 여기 없다.
    if isinstance(parsed, AnyType | TensorType | OpaqueType):
        return None
    return None


def _apply_doc(prop: dict[str, Any], doc: str | None) -> None:
    """`doc` 을 `description` 으로 옮긴다.

    타입이 이미 설명을 붙여 놓았으면(`Image` 의 값 형식) **둘 다 남긴다.** 사람이
    쓴 설명이 앞이고 형식 설명이 뒤다 — 앞의 것이 "무엇인지", 뒤의 것이 "어떻게
    쓰는지" 라서 순서가 그래야 읽힌다.
    """
    if not doc:
        return
    existing = prop.get("description")
    prop["description"] = f"{doc} {existing}" if existing else doc


def _apply_widget(name: str, prop: dict[str, Any], widget: Mapping[str, Any]) -> list[SchemaNote]:
    """위젯 힌트를 JSON Schema 제약으로 옮긴다. 옮기지 못한 것은 이유를 돌려준다."""
    notes: list[SchemaNote] = []
    json_type = prop.get("type")

    options = widget.get("options")
    if isinstance(options, list | tuple) and options:
        prop["enum"] = list(options)

    provider = widget.get("provider")
    if provider is not None and "enum" not in prop:
        # 공급자 옵션은 **실행 시점에** 레지스트리에서 나온다 (§4.2). 카탈로그는
        # 레지스트리 없이 로드되므로 여기서 열거할 수 없다. 열거하지 못한 것을
        # 열거한 척하지 않는다.
        notes.append(
            SchemaNote(
                name, f"공급자 {provider!r} 의 옵션은 실행 시점에 정해져 enum 으로 싣지 못한다"
            )
        )

    minimum = _number(widget.get("min"))
    maximum = _number(widget.get("max"))
    step = _number(widget.get("step"))

    if json_type in _NUMERIC:
        if minimum is not None:
            prop["minimum"] = minimum
        if maximum is not None:
            prop["maximum"] = maximum
        notes.extend(_apply_step(name, prop, json_type, step, minimum))
    elif minimum is not None or maximum is not None or step is not None:
        notes.append(
            SchemaNote(name, f"숫자 제약(min·max·step)은 {json_type or '이 타입'} 에 옮길 수 없다")
        )

    for key in widget:
        if key in _PRESENTATION_HINTS or key in {"min", "max", "step", "options", "provider"}:
            continue
        notes.append(SchemaNote(name, f"알 수 없는 위젯 힌트 {key!r} — 스키마에 싣지 않았다"))

    return notes


def _apply_step(
    name: str,
    prop: dict[str, Any],
    json_type: str,
    step: float | None,
    minimum: float | None,
) -> list[SchemaNote]:
    """`step` → `multipleOf`. **옮길 수 있을 때만** 옮긴다.

    두 자리에서 멈춘다. 둘 다 옮기면 스키마가 엔진보다 엄격해지는 경우다:

    - **`min` 이 `step` 의 배수가 아닐 때.** JSON Schema 의 `multipleOf` 는
      `값 % step == 0` 이지 스테퍼가 뜻하는 `(값 - min) % step == 0` 이 아니다.
      `Int(512, min=1, max=16384, step=8)` 에 `multipleOf: 8` 을 붙이면 엔진이
      받아들이는 100 을 클라이언트가 거부한다
    - **FLOAT 일 때.** `multipleOf: 0.1` 은 IEEE-754 때문에 0.3 을 거부하는
      검증기가 있다. 표현 오차로 정상 값이 막히는 쪽이 제약이 없는 쪽보다 나쁘다
    """
    if step is None or step <= 0:
        return []
    if json_type != "integer":
        return [
            SchemaNote(name, f"step {step} 은 부동소수 오차 때문에 multipleOf 로 옮기지 않는다")
        ]
    if minimum is not None and minimum % step != 0:
        return [
            SchemaNote(
                name,
                f"step {step} 은 min {minimum} 이 그 배수가 아니라 multipleOf 로 옮기지 않는다 "
                "(옮기면 엔진이 받는 값을 스키마가 거부한다)",
            )
        ]
    prop["multipleOf"] = step
    return []


def _number(value: Any) -> float | None:
    """위젯 힌트는 열린 딕셔너리다 — 숫자가 아니면 없는 것으로 본다."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return value
    return None
