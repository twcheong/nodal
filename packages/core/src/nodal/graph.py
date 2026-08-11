"""캐논 그래프 포맷 — 단 하나의 그래프 표현 (docs/design.md §4.1).

실행용 포맷과 UI용 포맷을 분리하지 않는다. 프론트가 저장하는 문서와 백엔드가
실행하는 문서는 같은 문서다. UI 상태는 `ui` 필드 하나에 격리되며 백엔드는
그 안을 들여다보지 않는다.

링크는 별도 배열이 아니라 입력 슬롯에 인라인으로 들어간다::

    "inputs": { "image": { "$link": ["n_c3d4", "image"] }, "width": 512 }

링크 ID가 존재하지 않으므로 링크 ID 재할당 버그도 존재하지 않는다.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator, Mapping
from typing import Annotated, Any, Final, Literal, Self, Union
from uuid import UUID, uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Discriminator,
    Field,
    JsonValue,
    Tag,
    ValidationError,
    WithJsonSchema,
    field_validator,
)

from .errors import GraphIssue, GraphValidationError, IssueCode

__all__ = [
    "GRAPH_VERSION",
    "LINK_KEY",
    "Graph",
    "InputValue",
    "Link",
    "Node",
    "NodeMeta",
    "check_graph",
    "parse_graph",
    "validate_graph",
]

#: 캐논 포맷 버전. 호환되지 않는 변경에서만 올린다.
GRAPH_VERSION: Final = "1"

#: 리터럴 값과 링크를 구분하는 예약 키.
LINK_KEY: Final = "$link"

_NODE_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$")
#: 타입 ID는 네임스페이스를 강제한다: `image.Resize`, `diffusion.LoadCheckpoint`.
_NODE_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$")
_SOCKET_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

NodeId = Annotated[str, Field(pattern=_NODE_ID_RE.pattern)]


class Link(BaseModel):
    """다른 노드의 출력 소켓에 대한 참조.

    JSON에서는 ``{"$link": ["<node_id>", "<output_socket>"]}`` 로 표현된다.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid", frozen=True)

    ref: tuple[NodeId, str] = Field(
        alias=LINK_KEY,
        description="[출처 노드 ID, 출처 출력 소켓 이름]",
    )

    @classmethod
    def to(cls, node_id: str, socket: str) -> Self:
        """`Link.to("n_c3d4", "image")` — 테스트와 그래프 조립용 편의 생성자."""
        return cls(ref=(node_id, socket))

    @property
    def source_node(self) -> str:
        return self.ref[0]

    @property
    def source_socket(self) -> str:
        return self.ref[1]

    def __str__(self) -> str:
        return f"{self.source_node}.{self.source_socket}"


def _input_kind(value: Any) -> str:
    """입력 슬롯의 값이 링크인지 리터럴인지 판별한다.

    `$link` 는 예약 키다. 리터럴 딕셔너리가 이 키를 가지면 링크로 해석된다.
    """
    if isinstance(value, Link):
        return "link"
    if isinstance(value, Mapping) and LINK_KEY in value:
        return "link"
    return "literal"


#: JSON Schema 상에서 "리터럴" 가지의 서술.
#:
#: 그냥 "아무 JSON"으로 두면 링크 객체가 두 가지 모두에 매칭되어 `oneOf` 가 항상
#: 실패한다. `$link` 가 예약 키라는 규칙(`_input_kind`)을 스키마에도 똑같이
#: 새겨 넣어 프론트/백엔드 판정을 일치시킨다.
_LITERAL_JSON_SCHEMA = {
    "description": ("JSON 리터럴. `$link` 키를 가진 객체는 링크로 해석되므로 리터럴이 될 수 없다."),
    "not": {"type": "object", "required": [LINK_KEY]},
}

#: 입력 슬롯에 들어갈 수 있는 값: 링크 또는 JSON 리터럴.
InputValue = Annotated[
    Union[  # noqa: UP007 — Discriminator 는 Union 형태를 요구한다
        Annotated[Link, Tag("link")],
        Annotated[JsonValue, Tag("literal"), WithJsonSchema(_LITERAL_JSON_SCHEMA)],
    ],
    Discriminator(_input_kind),
]


class NodeMeta(BaseModel):
    """실행에 영향을 주지 않는 노드 부가 정보."""

    model_config = ConfigDict(extra="allow")

    title: str | None = None
    notes: str | None = None


class Node(BaseModel):
    """그래프의 노드 하나. ID는 그래프의 `nodes` 딕셔너리 키다."""

    model_config = ConfigDict(extra="forbid")

    type: str = Field(
        pattern=_NODE_TYPE_RE.pattern,
        description="네임스페이스를 포함한 노드 타입 ID (예: image.Resize)",
    )
    inputs: dict[str, InputValue] = Field(default_factory=dict)
    meta: NodeMeta = Field(default_factory=NodeMeta)

    @field_validator("inputs")
    @classmethod
    def _check_socket_names(cls, inputs: dict[str, Any]) -> dict[str, Any]:
        for name in inputs:
            if not _SOCKET_RE.match(name):
                raise ValueError(f"소켓 이름이 올바르지 않다: {name!r}")
        return inputs

    def links(self) -> Iterator[tuple[str, Link]]:
        """(소켓 이름, 링크) 쌍을 순회한다. 리터럴 입력은 건너뛴다."""
        for socket, value in self.inputs.items():
            if isinstance(value, Link):
                yield socket, value


class Graph(BaseModel):
    """캐논 그래프 문서.

    `ui` 는 프론트엔드 전용이다. 백엔드는 이 필드를 읽지 않으며, 없어도 완전히
    동작한다. 이 격리가 스키마 레벨에서 명시되는 것이 설계의 핵심이다.
    """

    model_config = ConfigDict(extra="forbid")

    nodal_version: Literal["1"] = GRAPH_VERSION
    id: UUID = Field(default_factory=uuid4)
    nodes: dict[NodeId, Node] = Field(
        default_factory=dict,
        # pydantic 은 키 제약을 `patternProperties` 로만 내보낸다. 그것만으로는
        # 패턴에 맞지 않는 키가 그냥 허용된다 — 노드 ID 규칙이 프론트에 전달되지
        # 않는다는 뜻이다. 여기서 명시적으로 닫는다.
        json_schema_extra={"additionalProperties": False},
    )
    outputs: list[NodeId] = Field(
        default_factory=list,
        description="실행을 요청할 노드들. 여기서부터 역방향으로 조상만 수집된다.",
    )
    ui: dict[str, JsonValue] = Field(
        default_factory=dict,
        description="프론트엔드 전용 상태. 백엔드는 읽지 않는다.",
    )

    # ------------------------------------------------------------------ 순회

    def iter_links(self) -> Iterator[tuple[str, str, Link]]:
        """그래프의 모든 링크를 (소비 노드 ID, 소비 소켓, 링크)로 순회한다."""
        for node_id, node in self.nodes.items():
            for socket, link in node.links():
                yield node_id, socket, link

    def dependencies(self, node_id: str) -> set[str]:
        """`node_id` 가 직접 입력으로 받는 노드들. 존재하지 않는 대상도 그대로 포함한다."""
        node = self.nodes[node_id]
        return {link.source_node for _, link in node.links()}

    def dependents(self, node_id: str) -> set[str]:
        """`node_id` 의 출력을 직접 소비하는 노드들."""
        return {consumer for consumer, _, link in self.iter_links() if link.source_node == node_id}

    # ------------------------------------------------------------------ 직렬화

    def to_dict(self, *, compact: bool = True) -> dict[str, Any]:
        """캐논 JSON 딕셔너리.

        `compact` 면 기본값과 같은 필드를 생략한다. 캐논 문서는 파일로 저장되고
        git 으로 diff 되므로, 쓰지 않은 `meta` 나 빈 `ui` 가 노이즈로 남으면 안
        된다. 버전은 기본값과 같더라도 언제나 명시한다.
        """
        data = self.model_dump(mode="json", by_alias=True, exclude_defaults=compact)
        ordered: dict[str, Any] = {"nodal_version": self.nodal_version, "id": str(self.id)}
        for key in ("nodes", "outputs", "ui"):
            if key in data:
                ordered[key] = data[key]
        return ordered

    def to_json(self, *, indent: int | None = 2, compact: bool = True) -> str:
        """캐논 JSON 문자열. 링크는 `$link` 별칭으로 나간다."""
        return json.dumps(self.to_dict(compact=compact), indent=indent, ensure_ascii=False)


def parse_graph(data: Mapping[str, Any] | str | bytes) -> Graph:
    """캐논 문서를 파싱한다.

    포맷 위반은 `GraphValidationError` 로 정규화되어 나온다 — pydantic
    `ValidationError` 를 그대로 흘려보내지 않는다. 호출자는 에러 타입 하나만
    알면 된다.

    Raises:
        GraphValidationError: 문서가 캐논 포맷을 만족하지 않을 때.
    """
    try:
        if isinstance(data, str | bytes):
            return Graph.model_validate_json(data)
        return Graph.model_validate(data)
    except ValidationError as exc:
        raise GraphValidationError([_issue_from_pydantic(e) for e in exc.errors()]) from exc


def validate_graph(graph: Graph) -> list[GraphIssue]:
    """참조 무결성을 검사하고 발견된 모든 문제를 돌려준다.

    빈 그래프는 유효하다 — 문제 목록이 비어서 나온다.

    첫 번째 문제에서 멈추지 않는다. 사용자가 한 번의 검증으로 모든 문제를 보는
    것이 목적이다.

    Note:
        일반 사이클 탐지는 여기 없다 (M1 실행 엔진의 역방향 용해가 담당한다).
        자기 자신을 가리키는 자명한 사이클만 참조 검사의 일부로 잡는다.
    """
    issues: list[GraphIssue] = []

    for node_id, socket, link in graph.iter_links():
        target = link.source_node
        if target == node_id:
            issues.append(
                GraphIssue(
                    code=IssueCode.SELF_LINK,
                    message="노드가 자기 자신의 출력을 입력으로 받는다",
                    node_id=node_id,
                    socket=socket,
                )
            )
        elif target not in graph.nodes:
            issues.append(
                GraphIssue(
                    code=IssueCode.UNKNOWN_LINK_TARGET,
                    message=f"존재하지 않는 노드를 가리킨다: {target!r}",
                    node_id=node_id,
                    socket=socket,
                )
            )

    seen: set[str] = set()
    for out_id in graph.outputs:
        if out_id not in graph.nodes:
            issues.append(
                GraphIssue(
                    code=IssueCode.UNKNOWN_OUTPUT,
                    message="outputs 가 존재하지 않는 노드를 가리킨다",
                    node_id=out_id,
                )
            )
        elif out_id in seen:
            issues.append(
                GraphIssue(
                    code=IssueCode.DUPLICATE_OUTPUT,
                    message="outputs 에 같은 노드가 중복 등장한다",
                    node_id=out_id,
                )
            )
        seen.add(out_id)

    return issues


def check_graph(graph: Graph) -> None:
    """`validate_graph` 와 같지만 문제가 있으면 예외를 던진다.

    Raises:
        GraphValidationError: 참조 무결성 위반이 하나라도 있을 때.
    """
    issues = validate_graph(graph)
    if issues:
        raise GraphValidationError(issues)


def _issue_from_pydantic(error: Mapping[str, Any]) -> GraphIssue:
    """pydantic 에러의 `loc` 을 노드/소켓 좌표로 되돌린다.

    `("nodes", "n_a1b2", "inputs", "image", ...)` → node_id=n_a1b2, socket=image.
    """
    loc: tuple[Any, ...] = tuple(error.get("loc", ()))
    node_id: str | None = None
    socket: str | None = None

    if len(loc) >= 2 and loc[0] == "nodes":
        node_id = str(loc[1])
        if len(loc) >= 4 and loc[2] == "inputs":
            socket = str(loc[3])
    elif len(loc) >= 2 and loc[0] == "outputs":
        node_id = None

    path = ".".join(str(part) for part in loc) or "graph"
    message = f"{error.get('msg', '유효하지 않은 값')} (at {path})"
    return GraphIssue(code=IssueCode.SCHEMA, message=message, node_id=node_id, socket=socket)
