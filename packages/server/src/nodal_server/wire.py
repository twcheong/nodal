"""core 값 → 전송 형태.

서버는 **번역하지 않고 직렬화만 한다.** core 의 dataclass 와 `schemas.py` 의
pydantic 미러는 필드가 같고, 그것을 `test_openapi_export.py` 가 쌍으로 검사한다.
여기 있는 함수들은 그 사실에 기대어 구조를 그대로 딕셔너리로 옮길 뿐이다.

번역이 필요해 보이면 그건 계약이 어긋났다는 신호다 — 여기서 형태를 맞추지 말고
멈추고 확인할 것 (AGENTS.md 협업 규칙 7).
"""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping, Sequence
from typing import Any

from nodal import Event, GraphIssue, NodeSchema

# `OutputRef` 는 아직 nodal 최상위로 export 되지 않았다. M2 계약에서 core 이벤트를
# 동결했으므로 여기서는 서브모듈에서 직접 가져온다 — core 를 건드리지 않는다.
from nodal.assets import AssetRef
from nodal.events import OutputRef
from nodal.types import to_type_expr

from .schemas import (
    AssetRefModel,
    ErrorBody,
    InputSocketModel,
    IssueModel,
    NodeSchemaModel,
    OutputRefModel,
    OutputSocketModel,
)

__all__ = [
    "error_body",
    "event_to_wire",
    "issue_models",
    "node_schema_model",
    "output_refs",
]


def event_to_wire(event: Event) -> dict[str, Any]:
    """core 이벤트를 WS 로 내보낼 딕셔너리로. 필드 이름을 그대로 유지한다."""
    message = _wire_value(event)
    if not isinstance(message, dict):
        raise TypeError(f"이벤트는 dataclass 여야 한다: {type(event).__name__}")
    return message


def issue_models(issues: Sequence[GraphIssue]) -> list[IssueModel]:
    """`GraphIssue` → 전송 형태.

    `location` 은 core 의 프로퍼티라 dataclass 필드에 없다. 프론트가 그것 하나로
    캔버스 소켓을 찾으므로 전송 형태에는 반드시 실린다.
    """
    return [
        IssueModel(
            code=str(issue.code),
            message=issue.message,
            node_id=issue.node_id,
            socket=issue.socket,
            location=issue.location,
        )
        for issue in issues
    ]


def error_body(code: str, message: str, issues: Sequence[GraphIssue] = ()) -> ErrorBody:
    return ErrorBody(code=code, message=message, issues=issue_models(issues))


def asset_ref_model(ref: AssetRef | None) -> AssetRefModel | None:
    """core 의 `AssetRef` → 전송 모델. 변환 레이어가 아니라 직렬화다."""
    if ref is None:
        return None
    return AssetRefModel(
        hash=ref.hash,
        media_type=ref.media_type,
        size_bytes=ref.size_bytes,
        width=ref.width,
        height=ref.height,
    )


def output_refs(refs: Sequence[OutputRef]) -> list[OutputRefModel]:
    return [
        OutputRefModel(
            socket=ref.socket,
            type=ref.type,
            inline=ref.inline,
            asset=asset_ref_model(ref.asset),
        )
        for ref in refs
    ]


def refs_from_values(
    outputs: Mapping[str, Any],
    schema: NodeSchema | None,
    refs: Sequence[OutputRef] | None = None,
) -> list[OutputRefModel]:
    """엔진의 원시 출력(`RunResult.outputs`)을 참조로 바꾼다.

    `RunResult` 는 엔진 내부 결과라 실제 파이썬 값과 실행 때 만든 `references`를
    함께 들고 있다. REST 응답은 WS 의 `node.done` 과 같은 참조를 재사용한다 —
    프론트가 두 경로에서 다른 모양을 보면 안 되고 이미지를 다시 인코딩해서도 안 된다.
    """
    if refs is not None:
        return output_refs(refs)
    wire_refs: list[OutputRefModel] = []
    for socket, value in outputs.items():
        spec = schema.outputs.get(socket) if schema else None
        wire_refs.append(
            OutputRefModel(
                socket=socket,
                type=to_type_expr(spec.type) if spec else "Any",
                inline=value if _is_json_safe(value) else None,
            )
        )
    return wire_refs


def node_schema_model(schema: NodeSchema) -> NodeSchemaModel:
    """`NodeSchema` → 팔레트가 읽는 형태.

    입출력을 **리스트**로 내보낸다. 선언 순서가 UI 의 소켓 순서이기 때문이다.
    """
    return NodeSchemaModel(
        id=schema.id,
        title=schema.title,
        category=schema.category,
        aliases=list(schema.aliases),
        version=schema.version,
        output_node=schema.output_node,
        cacheable=schema.cacheable,
        doc=schema.doc,
        inputs=[
            InputSocketModel(
                name=spec.name,
                type=to_type_expr(spec.type),
                required=spec.required,
                default=_json_value(spec.default) if _is_json_safe(spec.default) else None,
                lazy=spec.lazy,
                doc=spec.doc,
                widget={k: _json_value(v) for k, v in spec.widget.items() if _is_json_safe(v)},
            )
            for spec in schema.inputs.values()
        ],
        outputs=[
            OutputSocketModel(name=spec.name, type=to_type_expr(spec.type), doc=spec.doc)
            for spec in schema.outputs.values()
        ],
    )


def _is_json_safe(value: Any) -> bool:
    """JSON 으로 그대로 실을 수 있는 값인지.

    `InputDescriptor.MISSING` 센티넬과 불투명 핸들이 여기서 걸러진다.
    """
    if isinstance(value, str | int | float | bool | type(None)):
        return True
    if isinstance(value, Mapping):
        return all(isinstance(k, str) and _is_json_safe(v) for k, v in value.items())
    if isinstance(value, list | tuple):
        return all(_is_json_safe(item) for item in value)
    return False


def _json_value(value: Any) -> Any:
    """JSON 이 구분하지 않는 Python 컨테이너를 전송 형태로 정규화한다."""
    if isinstance(value, Mapping):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_json_value(item) for item in value]
    return value


def _wire_value(value: Any) -> Any:
    """이벤트 안의 계약 값까지 재귀적으로 JSON 형태로 직렬화한다.

    `dataclasses.asdict()` 는 dataclass 가 아닌 `AssetRef` 를 그대로 남긴다. M3 에서
    그 참조가 프리뷰와 출력 이벤트 안에 들어오므로, 필드 이름을 바꾸지 않은 채
    명시적으로 펼쳐야 한다.
    """
    if isinstance(value, AssetRef):
        return {
            "hash": value.hash,
            "media_type": value.media_type,
            "size_bytes": value.size_bytes,
            "width": value.width,
            "height": value.height,
        }
    if dataclasses.is_dataclass(value):
        return {
            field.name: _wire_value(getattr(value, field.name))
            for field in dataclasses.fields(value)
        }
    if isinstance(value, Mapping):
        return {key: _wire_value(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_wire_value(item) for item in value]
    return value
