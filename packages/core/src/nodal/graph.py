"""캐논 그래프 포맷 — 단 하나의 그래프 표현 (docs/design.md §4.1).

실행용 포맷과 UI용 포맷을 분리하지 않는다. 프론트가 저장하는 문서와 백엔드가
실행하는 문서는 같은 문서다. UI 상태는 `ui` 필드 하나에 격리되며 백엔드는
그 안을 들여다보지 않는다.

링크는 별도 배열이 아니라 입력 슬롯에 인라인으로 들어간다::

    "inputs": { "image": { "$link": ["n_c3d4", "image"] }, "width": 512 }

링크 ID가 존재하지 않으므로 링크 ID 재할당 버그도 존재하지 않는다.

M5 부터 문서는 서브그래프 **정의**도 담는다 (`definitions`, docs/design.md §5.5).
정의는 문서 안에 살고 외부 파일을 참조하지 않는다 — 그래야 문서 하나가 그대로
재현 가능한 레시피이고 PNG `iTXt` 복원이 성립한다. 이 모듈은 정의의 **표현과
검증**만 안다. 평탄화는 여기가 아니다 (M5.3).
"""

from __future__ import annotations

import json
import re
from collections import deque
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
    "PARAM_KEY",
    "SUBGRAPH_TYPE_PREFIX",
    "Graph",
    "InputValue",
    "Link",
    "Node",
    "NodeMeta",
    "Param",
    "ParamDef",
    "SubgraphDef",
    "check_graph",
    "parse_graph",
    "subgraph_name",
    "validate_graph",
]

#: 캐논 포맷 버전. 호환되지 않는 변경에서만 올린다.
GRAPH_VERSION: Final = "1"

#: 리터럴 값과 링크를 구분하는 예약 키.
LINK_KEY: Final = "$link"

#: 서브그래프 정의 안에서 그 정의의 파라미터를 가리키는 예약 키 (§5.5).
#: `$link` 에 이은 **두 번째** 예약 키다. 리터럴이 될 수 없는 키는 이 둘뿐이다.
PARAM_KEY: Final = "$param"

#: 서브그래프 인스턴스의 노드 타입 접두. `subgraph.thumbnail` 처럼 쓴다.
#: 노드 레지스트리가 아니라 문서의 `definitions` 가 이 타입을 해석한다.
SUBGRAPH_TYPE_PREFIX: Final = "subgraph."

_NODE_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$")
#: 타입 ID는 네임스페이스를 강제한다: `image.Resize`, `diffusion.LoadCheckpoint`.
_NODE_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$")
_SOCKET_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
#: 정의 이름. `subgraph.<이름>` 이 `_NODE_TYPE_RE` 를 만족해야 하므로 같은 모양이다.
_DEF_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

NodeId = Annotated[str, Field(pattern=_NODE_ID_RE.pattern)]
SocketName = Annotated[str, Field(pattern=_SOCKET_RE.pattern)]
DefinitionName = Annotated[str, Field(pattern=_DEF_NAME_RE.pattern)]


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


class Param(BaseModel):
    """서브그래프 **정의 안에서** 그 정의의 파라미터를 가리키는 참조.

    JSON에서는 ``{"$param": "<이름>"}`` 로 표현된다.

    정의 밖에서는 의미가 없다. 최상위 그래프의 입력 슬롯에 나타나면 검증이
    거부한다 (`PARAM_OUTSIDE_DEFINITION`) — 조용히 리터럴 딕셔너리로 취급하면
    실행 시점에 정체불명의 값이 노드로 들어간다.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid", frozen=True)

    name: str = Field(
        alias=PARAM_KEY,
        pattern=_SOCKET_RE.pattern,
        description="이 정의의 `params` 에 선언된 파라미터 이름",
    )

    @classmethod
    def of(cls, name: str) -> Self:
        """`Param.of("prompt")` — 테스트와 그래프 조립용 편의 생성자."""
        return cls(name=name)

    def __str__(self) -> str:
        return f"{PARAM_KEY}({self.name})"


def _input_kind(value: Any) -> str:
    """입력 슬롯의 값이 링크인지 파라미터 참조인지 리터럴인지 판별한다.

    `$link` 와 `$param` 은 예약 키다. 리터럴 딕셔너리가 이 키를 가지면 각각
    링크와 파라미터 참조로 해석된다. 판정 순서는 고정이다 — 둘 다 가진 객체는
    링크가 된다. 그런 객체를 쓸 이유가 없으므로 어느 쪽으로 정하든 상관없지만,
    **정해져 있지 않으면** Python 과 JSON Schema 의 판정이 갈릴 수 있다.
    """
    if isinstance(value, Link):
        return "link"
    if isinstance(value, Param):
        return "param"
    if isinstance(value, Mapping):
        if LINK_KEY in value:
            return "link"
        if PARAM_KEY in value:
            return "param"
    return "literal"


def subgraph_name(node_type: str) -> str | None:
    """`subgraph.<이름>` 이면 그 이름을, 아니면 ``None`` 을 돌려준다.

    타입 문자열을 직접 슬라이스하는 코드가 여러 군데 생기지 않게 한 곳에 둔다.
    """
    if node_type.startswith(SUBGRAPH_TYPE_PREFIX):
        return node_type[len(SUBGRAPH_TYPE_PREFIX) :]
    return None


#: JSON Schema 상에서 "리터럴" 가지의 서술.
#:
#: 그냥 "아무 JSON"으로 두면 링크 객체가 두 가지 모두에 매칭되어 `oneOf` 가 항상
#: 실패한다. `$link` 가 예약 키라는 규칙(`_input_kind`)을 스키마에도 똑같이
#: 새겨 넣어 프론트/백엔드 판정을 일치시킨다.
_LITERAL_JSON_SCHEMA = {
    "description": (
        "JSON 리터럴. `$link` · `$param` 키를 가진 객체는 각각 링크와 파라미터 "
        "참조로 해석되므로 리터럴이 될 수 없다."
    ),
    "not": {
        "anyOf": [
            {"type": "object", "required": [LINK_KEY]},
            {"type": "object", "required": [PARAM_KEY]},
        ]
    },
}

#: 입력 슬롯에 들어갈 수 있는 값: 링크, 파라미터 참조, 또는 JSON 리터럴.
InputValue = Annotated[
    Union[  # noqa: UP007 — Discriminator 는 Union 형태를 요구한다
        Annotated[Link, Tag("link")],
        Annotated[Param, Tag("param")],
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
        """(소켓 이름, 링크) 쌍을 순회한다. 리터럴과 파라미터 참조는 건너뛴다."""
        for socket, value in self.inputs.items():
            if isinstance(value, Link):
                yield socket, value

    def params(self) -> Iterator[tuple[str, Param]]:
        """(소켓 이름, 파라미터 참조) 쌍을 순회한다. 정의 안에서만 비어 있지 않다."""
        for socket, value in self.inputs.items():
            if isinstance(value, Param):
                yield socket, value

    def subgraph(self) -> str | None:
        """이 노드가 서브그래프 인스턴스면 정의 이름, 아니면 ``None``."""
        return subgraph_name(self.type)


class ParamDef(BaseModel):
    """서브그래프 파라미터 하나의 선언 — 인스턴스가 채우는 구멍이다.

    MCP `run_template(id, params)` 이 받는 파라미터가 정확히 이 목록이다
    (docs/design.md §12.3).

    `default` 가 **없거나 `null`** 이면 필수 파라미터다. 둘을 구분하지 않는 이유는
    캐논 문서에 빈 값이 두 가지 생기면 안 되기 때문이고, 카탈로그 타입 중 `null`
    을 정상 값으로 갖는 것이 없어 잃는 것이 없기 때문이다.
    """

    model_config = ConfigDict(extra="forbid")

    type: JsonValue = Field(
        description=(
            '`types.json` 의 타입 표현식. 문자열(`"INT"`)이거나 구조화 형태(`{"list": "Image"}`)다'
        ),
    )
    default: JsonValue = Field(
        default=None,
        description="기본값. 없거나 null 이면 필수 파라미터다",
    )
    widget: dict[str, JsonValue] = Field(
        default_factory=dict,
        description="위젯 힌트 (min·max·options 등). 열린 딕셔너리이고 실행은 읽지 않는다",
    )

    @property
    def required(self) -> bool:
        """기본값이 없으면 인스턴스가 반드시 채워야 한다."""
        return self.default is None


class SubgraphDef(BaseModel):
    """재사용 가능한 워크플로 조각. **MCP 툴의 단위**다 (design.md §12.2).

    정의는 캐논 문서 **안에** 산다. 외부 파일 참조가 아니다 — 문서 하나가 그대로
    재현 가능한 레시피여야 PNG `iTXt` 워크플로 복원(§6)이 성립하기 때문이다.

    경계는 두 방향으로 뚫린다:

    - **들어오는 값**은 `params` 로 선언하고 정의 안에서 `{"$param": ...}` 로 쓴다
    - **나가는 값**은 `returns` 가 정의 안의 (노드, 소켓)에 이름을 붙인 것이다.
      인스턴스를 소비하는 링크 `{"$link": ["<인스턴스>", "<이름>"]}` 가 이 이름을
      가리키고, 평탄화가 그것을 안쪽 노드로 재배선한다 (§5.5)

    `Graph.outputs` 가 아니라 `returns` 인 이유: 그쪽은 **실행을 요청할 노드
    목록**이고 이쪽은 **노출할 소켓**이다. 한 문서 안에서 한 단계 차이로 나란히
    놓이는 두 필드가 같은 단어면 반드시 헷갈린다. 노드 SDK 가 같은 역할을 이미
    `returns` 로 부른다는 점도 맞물린다 — 인스턴스는 밖에서 보면 노드다.
    """

    model_config = ConfigDict(extra="forbid")

    params: dict[SocketName, ParamDef] = Field(
        default_factory=dict,
        description="이 정의가 받는 파라미터. 인스턴스의 입력 소켓이 된다",
        json_schema_extra={"additionalProperties": False},
    )
    nodes: dict[NodeId, Node] = Field(
        default_factory=dict,
        description="정의 안의 노드. 최상위 그래프와 **별개의 이름공간**이다",
        json_schema_extra={"additionalProperties": False},
    )
    returns: dict[SocketName, Link] = Field(
        default_factory=dict,
        description=(
            "인스턴스가 내보내는 출력 소켓 이름 → 정의 안의 (노드, 소켓). "
            "`Graph.outputs`(실행 요청 노드 목록)와 다른 것이라 이름도 다르다"
        ),
        json_schema_extra={"additionalProperties": False},
    )

    def iter_links(self) -> Iterator[tuple[str, str, Link]]:
        """정의 안의 모든 링크를 (소비 노드 ID, 소비 소켓, 링크)로 순회한다."""
        for node_id, node in self.nodes.items():
            for socket, link in node.links():
                yield node_id, socket, link

    def iter_params(self) -> Iterator[tuple[str, str, Param]]:
        """정의 안의 모든 파라미터 참조를 (노드 ID, 소켓, 참조)로 순회한다."""
        for node_id, node in self.nodes.items():
            for socket, param in node.params():
                yield node_id, socket, param

    def instances(self) -> Iterator[tuple[str, str]]:
        """(노드 ID, 정의 이름) — 이 정의 안에 중첩된 서브그래프 인스턴스."""
        for node_id, node in self.nodes.items():
            name = node.subgraph()
            if name is not None:
                yield node_id, name


class Graph(BaseModel):
    """캐논 그래프 문서.

    `ui` 는 프론트엔드 전용이다. 백엔드는 이 필드를 읽지 않으며, 없어도 완전히
    동작한다. 이 격리가 스키마 레벨에서 명시되는 것이 설계의 핵심이다.
    """

    model_config = ConfigDict(extra="forbid")

    nodal_version: Literal["1"] = GRAPH_VERSION
    id: UUID = Field(default_factory=uuid4)
    definitions: dict[DefinitionName, SubgraphDef] = Field(
        default_factory=dict,
        description=(
            "서브그래프 정의 (M5, §5.5). 노드 타입 `subgraph.<이름>` 이 참조한다. "
            "문서 안에 사는 이유는 문서 하나가 자기완결적이어야 하기 때문이다"
        ),
        json_schema_extra={"additionalProperties": False},
    )
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

    def instances(self) -> Iterator[tuple[str, str]]:
        """(노드 ID, 정의 이름) — 최상위 그래프의 서브그래프 인스턴스.

        정의 안에 중첩된 인스턴스는 여기 나오지 않는다 (`SubgraphDef.instances`).
        """
        for node_id, node in self.nodes.items():
            name = node.subgraph()
            if name is not None:
                yield node_id, name

    # ------------------------------------------------------------------ 직렬화

    def to_dict(self, *, compact: bool = True) -> dict[str, Any]:
        """캐논 JSON 딕셔너리.

        `compact` 면 기본값과 같은 필드를 생략한다. 캐논 문서는 파일로 저장되고
        git 으로 diff 되므로, 쓰지 않은 `meta` 나 빈 `ui` 가 노이즈로 남으면 안
        된다. 버전은 기본값과 같더라도 언제나 명시한다.
        """
        data = self.model_dump(mode="json", by_alias=True, exclude_defaults=compact)
        ordered: dict[str, Any] = {"nodal_version": self.nodal_version, "id": str(self.id)}
        # 정의는 노드보다 먼저 나온다 — 노드가 정의를 참조하기 때문이다.
        for key in ("definitions", "nodes", "outputs", "ui"):
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

        **정의 간 순환은 예외다** — 그것은 실행에 도달하지 못한다. 평탄화가
        무한히 펼쳐지므로 문서를 읽는 시점에 잡아야 한다 (§5.5).
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

    issues.extend(_subgraph_issues(graph))

    return issues


# ------------------------------------------------------------------ 서브그래프 검증
#
# 여기 있는 검사는 전부 **레지스트리를 몰라도** 판정할 수 있는 것들이다. 노드
# 타입이 실재하는지, 소켓 타입이 맞는지는 `validate_for_execution` 의 몫이다
# (M1, executor.py). 층을 지키는 이유는 `/api/graph/validate` 가 노드 팩 없이도
# 문서의 자기모순을 답할 수 있어야 하기 때문이다.


def _subgraph_issues(graph: Graph) -> list[GraphIssue]:
    """서브그래프 정의와 인스턴스의 자기모순을 전부 모은다."""
    issues: list[GraphIssue] = []

    # 최상위 그래프에는 파라미터가 없다. 채울 사람이 없기 때문이다.
    for node_id, node in graph.nodes.items():
        for socket, param in node.params():
            issues.append(
                GraphIssue(
                    code=IssueCode.PARAM_OUTSIDE_DEFINITION,
                    message=(f"{PARAM_KEY} 은 서브그래프 정의 안에서만 쓸 수 있다: {param.name!r}"),
                    node_id=node_id,
                    socket=socket,
                )
            )

    for node_id, name in graph.instances():
        issues.extend(_instance_issues(graph, node_id, name, definition=None))

    for node_id, socket, link in graph.iter_links():
        issue = _instance_output_issue(graph, graph.nodes, link, node_id, socket, None)
        if issue is not None:
            issues.append(issue)

    for def_name, definition in graph.definitions.items():
        issues.extend(_definition_issues(graph, def_name, definition))

    issues.extend(_definition_cycle_issues(graph))
    return issues


def _instance_issues(
    graph: Graph, node_id: str, name: str, *, definition: str | None
) -> list[GraphIssue]:
    """서브그래프 인스턴스 하나 — 가리키는 정의가 실재하는지."""
    if name in graph.definitions:
        return []
    return [
        GraphIssue(
            code=IssueCode.UNKNOWN_SUBGRAPH,
            message=f"정의되지 않은 서브그래프를 참조한다: {name!r}",
            node_id=node_id,
            definition=definition,
        )
    ]


def _definition_issues(graph: Graph, def_name: str, definition: SubgraphDef) -> list[GraphIssue]:
    """정의 하나의 내부 무결성."""
    issues: list[GraphIssue] = []
    inner = definition.nodes

    for node_id, socket, link in definition.iter_links():
        target = link.source_node
        if target == node_id:
            issues.append(
                GraphIssue(
                    code=IssueCode.SELF_LINK,
                    message="노드가 자기 자신의 출력을 입력으로 받는다",
                    node_id=node_id,
                    socket=socket,
                    definition=def_name,
                )
            )
        elif target not in inner:
            issues.append(_out_of_scope_link(graph, target, node_id, socket, def_name))

    for node_id, socket, param in definition.iter_params():
        if param.name not in definition.params:
            issues.append(
                GraphIssue(
                    code=IssueCode.UNKNOWN_PARAM,
                    message=(
                        f"선언되지 않은 파라미터를 가리킨다: {param.name!r} "
                        f"(선언된 것: {_names(definition.params)})"
                    ),
                    node_id=node_id,
                    socket=socket,
                    definition=def_name,
                )
            )

    for node_id, nested in definition.instances():
        issues.extend(_instance_issues(graph, node_id, nested, definition=def_name))

    for out_socket, link in definition.returns.items():
        if link.source_node not in inner:
            issues.append(_out_of_scope_link(graph, link.source_node, None, out_socket, def_name))

    for node_id, socket, link in definition.iter_links():
        issue = _instance_output_issue(graph, inner, link, node_id, socket, def_name)
        if issue is not None:
            issues.append(issue)

    return issues


def _out_of_scope_link(
    graph: Graph, target: str, node_id: str | None, socket: str, def_name: str
) -> GraphIssue:
    """정의 안에서 정의 밖을 가리키는 링크.

    "밖에 있지만 존재하는" 경우와 "아예 없는" 경우를 구분한다. 앞의 것은 정의를
    복사해 오면서 링크를 함께 옮기지 않은 흔한 실수이고, 사용자가 볼 메시지가
    달라야 한다.
    """
    if target in graph.nodes:
        return GraphIssue(
            code=IssueCode.SUBGRAPH_EXTERNAL_LINK,
            message=(
                f"정의 밖의 노드를 가리킨다: {target!r} — 정의는 자기 노드만 볼 수 있다. "
                f"밖에서 오는 값은 {PARAM_KEY} 으로 받는다"
            ),
            node_id=node_id,
            socket=socket,
            definition=def_name,
        )
    return GraphIssue(
        code=IssueCode.UNKNOWN_LINK_TARGET,
        message=f"존재하지 않는 노드를 가리킨다: {target!r}",
        node_id=node_id,
        socket=socket,
        definition=def_name,
    )


def _instance_output_issue(
    graph: Graph,
    scope: Mapping[str, Node],
    link: Link,
    node_id: str,
    socket: str,
    def_name: str | None,
) -> GraphIssue | None:
    """링크가 서브그래프 인스턴스의 **선언되지 않은** 출력을 가리키는지.

    보통의 노드는 출력 소켓 존재 여부를 스키마로 판정하므로 여기가 아니라
    `validate_for_execution` 의 몫이다. 서브그래프는 레지스트리에 없고 출력
    이름을 **문서가 직접 선언**하므로, 문서만으로 판정되는 이 검사가 여기 있다.
    """
    source = scope.get(link.source_node)
    if source is None:
        return None
    name = source.subgraph()
    if name is None:
        return None
    target_def = graph.definitions.get(name)
    if target_def is None or link.source_socket in target_def.returns:
        return None
    return GraphIssue(
        code=IssueCode.UNKNOWN_OUTPUT_SOCKET,
        message=(
            f"서브그래프 {name!r} 가 선언하지 않은 출력을 가리킨다: "
            f"{link.source_socket!r} (선언된 것: {_names(target_def.returns)})"
        ),
        node_id=node_id,
        socket=socket,
        definition=def_name,
    )


def _definition_cycle_issues(graph: Graph) -> list[GraphIssue]:
    """정의 간 순환. 평탄화가 무한히 펼쳐지므로 문서 검증에서 잡는다."""
    edges = {
        name: sorted({inner for _, inner in definition.instances()})
        for name, definition in graph.definitions.items()
    }
    issues: list[GraphIssue] = []
    for start in sorted(edges):
        path = _cycle_path(edges, start)
        if path is not None:
            issues.append(
                GraphIssue(
                    code=IssueCode.SUBGRAPH_CYCLE,
                    message="정의가 순환 참조한다: " + " → ".join(path),
                    definition=start,
                )
            )
    return issues


def _cycle_path(edges: Mapping[str, list[str]], start: str) -> list[str] | None:
    """`start` 에서 출발해 `start` 로 돌아오는 최단 경로. 없으면 ``None``.

    너비 우선이라 경로가 결정적이다 — 같은 문서는 언제나 같은 메시지를 낸다.
    """
    parents: dict[str, str] = {}
    seen = {start}
    queue = deque([start])
    while queue:
        name = queue.popleft()
        for nxt in edges.get(name, ()):
            if nxt == start:
                chain = [name]
                while chain[-1] != start:
                    chain.append(parents[chain[-1]])
                chain.reverse()
                return [*chain, start]
            if nxt in seen or nxt not in edges:
                continue
            seen.add(nxt)
            parents[nxt] = name
            queue.append(nxt)
    return None


def _names(mapping: Mapping[str, Any]) -> str:
    """에러 메시지용 이름 목록. 비어 있으면 그렇다고 말한다 — 빈 괄호는 불친절하다."""
    return ", ".join(repr(name) for name in sorted(mapping)) or "없음"


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
    `("definitions", "thumb", "nodes", ...)` → definition=thumb 이 앞에 붙는다.
    최상위의 `outputs` 와 정의의 `returns` 는 둘 다 노드에 귀속되지 않는다.
    """
    loc: tuple[Any, ...] = tuple(error.get("loc", ()))
    node_id: str | None = None
    socket: str | None = None

    definition: str | None = None

    rest = loc
    if len(loc) >= 2 and loc[0] == "definitions":
        definition = str(loc[1])
        rest = loc[2:]

    if len(rest) >= 2 and rest[0] == "nodes":
        node_id = str(rest[1])
        if len(rest) >= 4 and rest[2] == "inputs":
            socket = str(rest[3])
    elif len(rest) >= 2 and rest[0] in ("outputs", "returns"):
        node_id = None

    path = ".".join(str(part) for part in loc) or "graph"
    message = f"{error.get('msg', '유효하지 않은 값')} (at {path})"
    return GraphIssue(
        code=IssueCode.SCHEMA,
        message=message,
        node_id=node_id,
        socket=socket,
        definition=definition,
    )
