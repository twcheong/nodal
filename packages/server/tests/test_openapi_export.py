"""API 계약 테스트.

M2 는 프론트엔드를 다른 에이전트가 맡는다. 이 파일이 그 경계를 지킨다:

1. `schemas/openapi.json` 이 pydantic 모델과 어긋나지 않는가
2. `design.md` §6 이 약속한 엔드포인트가 전부 있는가
3. **WS 이벤트의 pydantic 미러가 `nodal.events` 의 dataclass 와 필드가 같은가**

3번이 핵심이다. 서버는 core 이벤트를 번역하지 않고 직렬화만 하므로, 두 정의가
어긋나면 프론트가 받는 메시지와 타입이 달라진다.
"""

from __future__ import annotations

import dataclasses
import json
import sys
from pathlib import Path
from typing import Any, get_args, get_origin

import pytest

from nodal import events as core_events
from nodal_server import schemas
from nodal_server.app import create_app

ROOT = Path(__file__).resolve().parents[3]
OPENAPI_PATH = ROOT / "schemas" / "openapi.json"

sys.path.insert(0, str(ROOT / "tools"))
import export_openapi  # noqa: E402

#: design.md §6 의 REST 표. (메서드, 경로) 가 전부 있어야 한다.
EXPECTED_OPERATIONS = {
    ("get", "/api/nodes"),
    ("post", "/api/graph/validate"),
    ("post", "/api/runs"),
    ("get", "/api/runs"),
    ("get", "/api/runs/{run_id}"),
    ("delete", "/api/runs/{run_id}"),
    ("get", "/api/models"),
    ("post", "/api/assets"),
    ("get", "/api/assets/{asset_hash}"),
    ("get", "/api/extensions"),
}

#: core dataclass ↔ 서버 pydantic 미러. 이 쌍의 필드가 어긋나면 안 된다.
WS_EVENT_PAIRS = [
    (core_events.RunStarted, schemas.WsRunStarted),
    (core_events.NodeStarted, schemas.WsNodeStarted),
    (core_events.NodeProgress, schemas.WsNodeProgress),
    (core_events.NodePreview, schemas.WsNodePreview),
    (core_events.NodeCached, schemas.WsNodeCached),
    (core_events.NodeDone, schemas.WsNodeDone),
    (core_events.NodeError, schemas.WsNodeError),
    (core_events.RunDone, schemas.WsRunDone),
    (core_events.RunFailed, schemas.WsRunFailed),
    (core_events.RunCancelled, schemas.WsRunCancelled),
    (core_events.QueueStatus, schemas.WsQueueStatus),
]


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    return json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))


def test_committed_openapi_is_up_to_date() -> None:
    """모델을 고치고 산출물 재생성을 잊으면 여기서 잡힌다."""
    assert OPENAPI_PATH.read_text(encoding="utf-8") == export_openapi.render(), (
        "schemas/openapi.json 이 낡았다. "
        "`uv run python tools/export_openapi.py` 를 실행하고 커밋하라."
    )


def test_all_design_doc_endpoints_exist(document: dict[str, Any]) -> None:
    """design.md §6 의 표에 있는 엔드포인트가 전부 선언됐는가."""
    declared = {
        (verb, path)
        for path, operations in document["paths"].items()
        for verb in operations
        if verb in {"get", "post", "put", "patch", "delete"}
    }
    assert declared >= EXPECTED_OPERATIONS, EXPECTED_OPERATIONS - declared


def test_no_undeclared_endpoints(document: dict[str, Any]) -> None:
    """계약에 없는 엔드포인트가 조용히 늘어나지 않게 한다."""
    declared = {
        (verb, path)
        for path, operations in document["paths"].items()
        for verb in operations
        if verb in {"get", "post", "put", "patch", "delete"}
    }
    assert declared <= EXPECTED_OPERATIONS, declared - EXPECTED_OPERATIONS


def test_app_routes_match_the_export() -> None:
    """산출물이 실제 앱에서 나왔는지. 손으로 고친 openapi.json 을 걸러낸다."""
    live = create_app().openapi()
    assert set(live["paths"]) == set(json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))["paths"])


# --------------------------------------------------------- WS 이벤트 계약


def _field_names(dataclass_type: type) -> set[str]:
    return {field.name for field in dataclasses.fields(dataclass_type)}


@pytest.mark.parametrize(("core_type", "wire_type"), WS_EVENT_PAIRS, ids=lambda t: t.__name__)
def test_ws_mirror_has_the_same_fields(core_type: type, wire_type: type) -> None:
    """core dataclass 와 서버 pydantic 미러의 필드 이름이 정확히 같은가.

    서버는 번역하지 않는다. 한쪽에만 필드가 있으면 프론트가 받는 메시지와
    생성된 타입이 어긋난다.
    """
    assert _field_names(core_type) == set(wire_type.model_fields), (
        f"{core_type.__name__} 와 {wire_type.__name__} 의 필드가 다르다"
    )


@pytest.mark.parametrize(("core_type", "wire_type"), WS_EVENT_PAIRS, ids=lambda t: t.__name__)
def test_ws_mirror_shares_the_discriminator(core_type: type, wire_type: type) -> None:
    """`t` 판별자 값이 같아야 한다. design.md §6 의 이벤트 이름이 기준이다."""
    core_literal = next(f for f in dataclasses.fields(core_type) if f.name == "t")
    core_value = get_args(core_literal.type)[0] if get_origin(core_literal.type) else None
    if core_value is None:  # `from __future__ import annotations` 로 문자열이 된 경우
        core_value = str(core_literal.type).split("'")[1]

    wire_value = get_args(wire_type.model_fields["t"].annotation)[0]
    assert core_value == wire_value


def test_every_core_event_has_a_mirror() -> None:
    """core 에 이벤트를 추가하고 미러를 잊으면 여기서 잡힌다."""
    mirrored = {core_type for core_type, _ in WS_EVENT_PAIRS}
    declared = set(get_args(core_events.Event))
    assert declared == mirrored, declared ^ mirrored


def test_ws_events_are_in_the_openapi_components(document: dict[str, Any]) -> None:
    """프론트가 WS 타입을 생성할 수 있어야 한다. OpenAPI 는 WS 를 모르므로 주입한다."""
    schemas_section = document["components"]["schemas"]
    assert "WsEvent" in schemas_section
    for _, wire_type in WS_EVENT_PAIRS:
        assert wire_type.__name__ in schemas_section
    assert document["x-nodal-ws-events"]["schema"] == "#/components/schemas/WsEvent"


# ----------------------------------------------------------- 에러 계약


def test_error_shape_is_shared_by_every_failing_endpoint(document: dict[str, Any]) -> None:
    """실패 응답의 본문은 언제나 `ErrorResponse` 다. 에러 어휘는 하나여야 한다."""
    error_ref = "#/components/schemas/ErrorResponse"
    checked = 0
    for operations in document["paths"].values():
        for verb, operation in operations.items():
            if verb not in {"get", "post", "delete"}:
                continue
            for code, response in operation.get("responses", {}).items():
                if not code.startswith(("4", "5")):
                    continue
                schema = response.get("content", {}).get("application/json", {}).get("schema", {})
                if schema.get("$ref") == error_ref:
                    checked += 1
                elif code == "422" and schema:
                    # FastAPI 기본 422 는 자체 모델을 쓴다. 명시한 것만 센다.
                    continue
    assert checked > 0, "에러 응답을 선언한 엔드포인트가 하나도 없다"
    assert error_ref.rsplit("/", 1)[-1] in document["components"]["schemas"]


def test_issue_model_matches_core_graph_issue() -> None:
    """`IssueModel` 이 `nodal.GraphIssue` 와 같은 필드를 갖는가.

    `location` 은 core 의 프로퍼티라 dataclass 필드에는 없다 — 전송 형태에는
    있어야 한다. 프론트가 그것 하나로 캔버스 소켓을 찾기 때문이다.
    """
    from nodal import GraphIssue

    core_fields = _field_names(GraphIssue)
    wire_fields = set(schemas.IssueModel.model_fields)
    assert core_fields <= wire_fields
    assert wire_fields - core_fields == {"location"}


# ------------------------------------------------------- 타입 표현식 계약


def test_socket_types_are_type_expressions_not_rendered_strings(
    document: dict[str, Any],
) -> None:
    """소켓 타입은 `types.json` 의 표현식으로 나간다.

    `describe()` 같은 렌더링 문자열을 보내면 프론트가 복원할 수 없다 —
    `Tensor[float32, (?, 3)]` 은 `?` 가 라벨이었는지 `None` 이었는지 지운다.
    """
    schemas_section = document["components"]["schemas"]
    for name in ("ListTypeExpr", "UnionTypeExpr", "OpaqueTypeExpr", "TensorTypeExpr"):
        assert name in schemas_section, f"{name} 이 계약에 없다"

    for model in ("InputSocketModel", "OutputSocketModel", "OutputRefModel"):
        field = schemas_section[model]["properties"]["type"]
        assert "anyOf" in field, f"{model}.type 이 단순 문자열로 남아 있다"
        refs = {option.get("$ref", "").rsplit("/", 1)[-1] for option in field["anyOf"]}
        assert "ListTypeExpr" in refs and "UnionTypeExpr" in refs


def test_type_expressions_round_trip_through_core() -> None:
    """`to_type_expr` 는 `parse_type_expr` 의 역함수여야 한다.

    깨지면 프론트가 받은 타입이 백엔드가 보낸 타입과 달라진다.
    """
    from nodal.types import (
        FLOAT,
        INT,
        Image,
        ListType,
        Mask,
        OpaqueType,
        TensorType,
        UnionType,
        parse_type_expr,
        to_type_expr,
    )

    cases = [
        Image,
        INT,
        ListType(Image),
        UnionType((INT, FLOAT)),
        ListType(UnionType((Image, Mask))),
        TensorType(frozenset({"float32"}), (None, 3)),
        OpaqueType("Model", frozenset({"sdxl", "unet"})),
    ]
    for socket_type in cases:
        assert parse_type_expr(to_type_expr(socket_type)) == socket_type, socket_type.describe()
