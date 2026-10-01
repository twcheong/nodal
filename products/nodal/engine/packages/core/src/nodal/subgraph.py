"""서브그래프 평탄화 (docs/design.md §5.5).

인스턴스(`subgraph.<이름>` 타입 노드)를 정의의 사본으로 바꿔 **평범한 그래프**를
만든다. 평탄화가 끝난 그래프에 `subgraph.*` 타입은 남지 않고, 실행 엔진 · 캐시 ·
이벤트는 서브그래프가 있었다는 사실을 모른다.

**예외를 던지지 않는다.** 평탄화가 만나는 문제는 전부 `GraphIssue` 다 — 평탄화는
로드가 아니라 **검증의 첫 걸음**이기 때문이다 (§5.5). MCP 클라이언트는
`run_template` 을 부르기 **전에** "이 파라미터가 빠졌다" 를 들어야 하고, 실행을
시작한 뒤 예외로 죽는 것은 답이 아니다 (§12.3).

첫 문제에서 멈추지 않는 것도 같은 이유다. 파라미터가 셋 빠졌으면 셋 다 보고한다 —
한 번에 고칠 수 있어야 한다 (`validate_graph` 와 같은 성질).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from .errors import GraphIssue, IssueCode
from .graph import Graph, Link, Node, Param, SubgraphDef
from .types import TypeSpecError, parse_type_expr

__all__ = [
    "MAX_DEPTH",
    "MAX_NODES",
    "FlattenResult",
    "flatten",
]

#: 중첩 깊이 상한. 사람이 손으로 만드는 중첩은 2~3 단이고 MCP 템플릿은 중첩을
#: 거의 만들지 않는다. 8 이면 실수만 잡고 정상 사용을 막지 않는다.
MAX_DEPTH: Final = 8

#: 평탄화 **결과** 노드 수 상한. M2 벤치마크(200노드)의 50 배다.
#:
#: 깊이만으로는 부족해서 둘을 함께 둔다 — 중첩 2 단이어도 각 정의가 50 노드면
#: 결과가 폭발한다 (§11 열린 질문 12).
MAX_NODES: Final = 10_000

#: 평탄화된 노드 ID 의 구분자. `<인스턴스>:<안쪽>` (§5.5 ②).
SEP: Final = ":"


@dataclass(frozen=True, slots=True)
class FlattenResult:
    """평탄화 결과.

    `issues` 가 비어 있지 않으면 `graph` 는 **불완전하다** — 문제를 만난 자리를
    건너뛰고 나머지를 계속 폈기 때문이다. 호출자는 이슈를 먼저 보고, 비어 있을
    때만 그래프를 쓴다.
    """

    graph: Graph
    #: 요청된 출력 노드 ID 를 평탄화 후 ID 로 옮긴 것.
    outputs: tuple[str, ...]
    #: 요청된 서브그래프 출력 → returns 이름 → 실제 (노드 ID, 소켓).
    output_sockets: Mapping[str, Mapping[str, tuple[str, str]]]
    issues: tuple[GraphIssue, ...]


def flatten(
    graph: Graph,
    requested_outputs: tuple[str, ...] = (),
    *,
    max_depth: int = MAX_DEPTH,
    max_nodes: int = MAX_NODES,
) -> FlattenResult:
    """서브그래프 인스턴스를 펼쳐 평범한 그래프로 만든다 (§5.5).

    정의가 없고 인스턴스도 없으면 원본을 그대로 돌려준다 — 대부분의 그래프가
    그렇고, 그 경우 이 함수는 사실상 무비용이다.

    Args:
        requested_outputs: 실행을 요청한 노드들. 인스턴스가 섞여 있으면 그
            `returns` 가 가리키는 안쪽 노드로 옮겨진다.

    Returns:
        `FlattenResult`. 예외는 던지지 않는다.
    """
    if not graph.definitions:
        return FlattenResult(graph, tuple(requested_outputs), {}, ())

    state = _Flattener(graph, max_depth=max_depth, max_nodes=max_nodes)
    state.run()

    flat = Graph(
        nodal_version=graph.nodal_version,
        id=graph.id,
        nodes=state.nodes,
        outputs=list(state.map_outputs(graph.outputs)),
        ui=graph.ui,
    )
    return FlattenResult(
        flat,
        state.map_outputs(requested_outputs),
        state.map_output_sockets(requested_outputs),
        tuple(state.issues),
    )


class _Flattener:
    """평탄화 한 번의 상태.

    두 단계로 돈다. **①** 정의를 펼치며 실제 노드를 내보내고, 인스턴스의 출력
    소켓이 어디를 가리키는지 `_alias` 에 적어 둔다. **②** 다 편 뒤 링크를
    `_alias` 를 따라 실제 노드로 되짚는다.

    한 번에 하지 않는 이유는 **중첩** 때문이다. 정의의 `returns` 가 그 안에 있는
    또 다른 인스턴스의 출력을 가리킬 수 있고, 그 인스턴스는 아직 펴지지 않았을
    수 있다. 별칭을 모아 두었다가 마지막에 따라가면 순서를 신경 쓰지 않아도 된다.
    """

    def __init__(self, graph: Graph, *, max_depth: int, max_nodes: int) -> None:
        self._graph = graph
        self._max_depth = max_depth
        self._max_nodes = max_nodes
        self.nodes: dict[str, Node] = {}
        self.issues: list[GraphIssue] = []
        #: (인스턴스 평탄화 ID, 출력 소켓) → (가리키는 ID, 소켓). 아직 다른
        #: 별칭일 수 있다 — ② 에서 끝까지 따라간다.
        self._alias: dict[tuple[str, str], tuple[str, str]] = {}
        self._aborted = False

    # ------------------------------------------------------------------ ①·②

    def run(self) -> None:
        self._check_param_types()
        self._expand(self._graph.nodes, prefix="", bindings={}, depth=0)
        self._resolve_links()

    def map_outputs(self, outputs: tuple[str, ...] | list[str]) -> tuple[str, ...]:
        """출력 노드 목록을 평탄화 후 ID 로 옮긴다.

        인스턴스는 사라지므로 그 `returns` 가 가리키는 **안쪽 노드들**로 바뀐다.
        하나의 인스턴스가 여러 노드로 늘 수 있어 중복은 제거한다.
        """
        mapped: list[str] = []
        for out_id in outputs:
            node = self._graph.nodes.get(out_id)
            if node is None or node.subgraph() is None:
                mapped.append(out_id)
                continue
            targets = [self._follow(out_id, socket)[0] for socket in self._returns_of(node) or ()]
            if not targets:
                self.issues.append(
                    GraphIssue(
                        code=IssueCode.UNKNOWN_OUTPUT,
                        message=(
                            "출력으로 요청한 서브그래프 인스턴스가 아무것도 "
                            "내보내지 않는다 — 정의에 `returns` 가 비어 있다"
                        ),
                        node_id=out_id,
                    )
                )
            mapped.extend(targets)
        return tuple(dict.fromkeys(mapped))

    def map_output_sockets(
        self, outputs: tuple[str, ...] | list[str]
    ) -> dict[str, dict[str, tuple[str, str]]]:
        """요청된 인스턴스의 공개 소켓을 평탄화된 실제 소켓으로 옮긴다.

        `map_outputs` 는 실행할 노드 목록이라 같은 노드를 중복 제거하지만, 이
        매핑은 결과 조립 계약이라 소켓을 보존한다 (design.md §12.3). 내부
        딕셔너리는 정의의 `returns` 선언 순서대로 만든다.
        """
        mapped: dict[str, dict[str, tuple[str, str]]] = {}
        for out_id in outputs:
            node = self._graph.nodes.get(out_id)
            returns = self._returns_of(node) if node is not None else None
            if node is None or node.subgraph() is None or returns is None:
                continue
            mapped[out_id] = {name: self._follow(out_id, name) for name in returns}
        return mapped

    # ------------------------------------------------------------------ ① 펴기

    def _expand(
        self,
        nodes: Mapping[str, Node],
        *,
        prefix: str,
        bindings: Mapping[str, Any],
        depth: int,
    ) -> None:
        for node_id, node in nodes.items():
            if self._aborted:
                return
            flat_id = f"{prefix}{node_id}"
            inputs = {
                socket: self._resolve_value(value, prefix, bindings, flat_id, socket)
                for socket, value in node.inputs.items()
            }

            name = node.subgraph()
            if name is None:
                self._emit(flat_id, Node(type=node.type, inputs=inputs, meta=node.meta))
                continue

            definition = self._graph.definitions.get(name)
            if definition is None:
                # `validate_graph` 가 이미 `unknown_subgraph` 로 보고했다.
                continue

            if depth + 1 > self._max_depth:
                self.issues.append(
                    GraphIssue(
                        code=IssueCode.SUBGRAPH_TOO_DEEP,
                        message=(
                            f"서브그래프 중첩이 깊이 상한 {self._max_depth} 를 넘었다 "
                            f"— {name!r} 를 펼치려면 {depth + 1} 단이 된다. "
                            "정의가 서로를 참조하고 있지 않은지 확인하라"
                        ),
                        node_id=flat_id,
                    )
                )
                continue

            self._register_returns(flat_id, definition)
            child = self._bind_params(flat_id, name, definition, inputs)
            self._expand(
                definition.nodes,
                prefix=f"{flat_id}{SEP}",
                bindings=child,
                depth=depth + 1,
            )

    def _emit(self, flat_id: str, node: Node) -> None:
        if len(self.nodes) >= self._max_nodes:
            if not self._aborted:
                self._aborted = True
                self.issues.append(
                    GraphIssue(
                        code=IssueCode.SUBGRAPH_TOO_LARGE,
                        message=(
                            f"평탄화 결과가 노드 수 상한 {self._max_nodes} 를 넘었다. "
                            "중첩 깊이는 상한 안이지만 정의마다 노드가 많으면 "
                            "결과는 곱으로 늘어난다"
                        ),
                        node_id=flat_id,
                    )
                )
            return
        self.nodes[flat_id] = node

    def _resolve_value(
        self,
        value: Any,
        prefix: str,
        bindings: Mapping[str, Any],
        flat_id: str,
        socket: str,
    ) -> Any:
        """입력 하나를 평탄화된 값으로 바꾼다 (§5.5 ③).

        링크는 같은 이름공간 안이므로 접두만 붙인다. `$param` 은 인스턴스가 준
        값으로 **치환**된다 — 리터럴을 줬으면 리터럴이, 링크를 줬으면 그 링크가
        그대로 들어간다.
        """
        if isinstance(value, Link):
            return Link.to(f"{prefix}{value.source_node}", value.source_socket)
        if isinstance(value, Param):
            if value.name in bindings:
                return bindings[value.name]
            # 선언되지 않은 파라미터는 `validate_graph` 가 `unknown_param` 으로
            # 이미 보고했다. 값이 없으므로 리터럴 None 으로 두고 계속 편다.
            return None
        return value

    def _register_returns(self, flat_id: str, definition: SubgraphDef) -> None:
        """인스턴스의 출력 소켓이 안쪽 어디를 가리키는지 적어 둔다 (§5.5 ④)."""
        for out_socket, link in definition.returns.items():
            self._alias[(flat_id, out_socket)] = (
                f"{flat_id}{SEP}{link.source_node}",
                link.source_socket,
            )

    def _bind_params(
        self,
        flat_id: str,
        def_name: str,
        definition: SubgraphDef,
        inputs: Mapping[str, Any],
    ) -> dict[str, Any]:
        """인스턴스가 준 값 + 정의의 기본값 → 파라미터 바인딩."""
        bound: dict[str, Any] = {}
        for name, spec in definition.params.items():
            if name in inputs:
                bound[name] = inputs[name]
            elif not spec.required:
                bound[name] = spec.default
            else:
                self.issues.append(
                    GraphIssue(
                        code=IssueCode.MISSING_PARAM,
                        message=(
                            f"필수 파라미터가 비어 있다 — 정의 {def_name!r} 의 "
                            f"{name!r} 에 기본값이 없고 인스턴스도 값을 주지 않았다"
                        ),
                        node_id=flat_id,
                        socket=name,
                    )
                )
                bound[name] = None

        for socket in inputs:
            if socket not in definition.params:
                known = ", ".join(sorted(definition.params)) or "(파라미터 없음)"
                self.issues.append(
                    GraphIssue(
                        code=IssueCode.UNKNOWN_INPUT_SOCKET,
                        message=(
                            f"서브그래프가 선언하지 않은 파라미터에 값을 줬다. 선언된 것: {known}"
                        ),
                        node_id=flat_id,
                        socket=socket,
                    )
                )
        return bound

    def _check_param_types(self) -> None:
        """`params[].type` 이 `types.json` 문법을 만족하는지 (§5.5).

        타입 카탈로그를 아는 층이 여기다 — `validate_graph` 는 레지스트리도
        카탈로그도 보지 않는다.
        """
        for def_name, definition in self._graph.definitions.items():
            for name, spec in definition.params.items():
                try:
                    parse_type_expr(spec.type)
                except TypeSpecError as exc:
                    self.issues.append(
                        GraphIssue(
                            code=IssueCode.INVALID_PARAM_TYPE,
                            message=f"파라미터 타입 표현식이 올바르지 않다: {exc}",
                            socket=name,
                            definition=def_name,
                        )
                    )

    # ------------------------------------------------------------------ ② 되짚기

    def _resolve_links(self) -> None:
        """링크가 인스턴스를 가리키면 실제 노드까지 따라간다 (§5.5 ④·⑤)."""
        for flat_id, node in list(self.nodes.items()):
            rewired: dict[str, Any] = {}
            changed = False
            for socket, value in node.inputs.items():
                if isinstance(value, Link):
                    target, target_socket = self._follow(value.source_node, value.source_socket)
                    if (target, target_socket) != (value.source_node, value.source_socket):
                        changed = True
                        rewired[socket] = Link.to(target, target_socket)
                        continue
                rewired[socket] = value
            if changed:
                self.nodes[flat_id] = Node(type=node.type, inputs=rewired, meta=node.meta)

    def _follow(self, node_id: str, socket: str) -> tuple[str, str]:
        """별칭 사슬을 끝까지 따라간다.

        중첩 인스턴스의 `returns` 가 또 인스턴스를 가리킬 수 있어 사슬이 된다.
        상한은 깊이 상한 + 여유 — 사이클은 `validate_graph` 가 잡지만, 그것을
        건너뛰고 부른 호출자에게도 무한 루프를 주지 않는다.
        """
        seen = 0
        while (node_id, socket) in self._alias:
            node_id, socket = self._alias[(node_id, socket)]
            seen += 1
            if seen > self._max_depth + 1:
                break
        return node_id, socket

    def _returns_of(self, node: Node) -> Mapping[str, Link] | None:
        name = node.subgraph()
        if name is None:
            return None
        definition = self._graph.definitions.get(name)
        return definition.returns if definition is not None else None
