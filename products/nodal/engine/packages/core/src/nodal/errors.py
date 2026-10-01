"""그래프 에러 — 항상 *어느 노드의 어느 소켓*인지 지목한다.

익명 에러는 금지다 (AGENTS.md 코딩 컨벤션). 모든 문제는 `GraphIssue` 하나로
표현되고, 위치는 `nodes.<node_id>.inputs.<socket>` 형태의 안정적인 경로가 된다.
프론트엔드는 이 경로를 그대로 캔버스 하이라이트에 쓸 수 있다.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

__all__ = ["GraphIssue", "GraphValidationError", "IssueCode"]


class IssueCode(StrEnum):
    """안정적인 기계 판독용 코드. 메시지 문구는 바뀌어도 코드는 유지한다."""

    #: 캐논 포맷 자체를 만족하지 못함 (pydantic 파싱 실패).
    SCHEMA = "schema"
    #: `$link`가 존재하지 않는 노드를 가리킴.
    UNKNOWN_LINK_TARGET = "unknown_link_target"
    #: 노드가 자기 자신을 입력으로 받음 (자명한 사이클).
    SELF_LINK = "self_link"
    #: `outputs`가 존재하지 않는 노드를 가리킴.
    UNKNOWN_OUTPUT = "unknown_output"
    #: `outputs`에 같은 노드가 두 번 이상 등장.
    DUPLICATE_OUTPUT = "duplicate_output"

    # --- 서브그래프 (M5, design.md §5.5). 레지스트리를 몰라도 판정할 수 있다.

    #: 노드 타입이 `subgraph.<이름>` 인데 그 정의가 문서에 없음.
    UNKNOWN_SUBGRAPH = "unknown_subgraph"
    #: `$param`이 그 정의에 선언되지 않은 파라미터를 가리킴.
    UNKNOWN_PARAM = "unknown_param"
    #: `$param`을 정의 밖(최상위 그래프)에서 사용함.
    PARAM_OUTSIDE_DEFINITION = "param_outside_definition"
    #: 정의 안의 링크가 그 정의 밖의 노드를 가리킴.
    SUBGRAPH_EXTERNAL_LINK = "subgraph_external_link"
    #: 정의들이 서로를(또는 자기를) 참조해 순환함.
    SUBGRAPH_CYCLE = "subgraph_cycle"

    # --- 평탄화(M5.3)가 만드는 것들. 예외가 아니라 이슈다 (design.md §5.5).

    #: 인스턴스가 필수 파라미터를 채우지 않았고 정의에 기본값도 없음.
    MISSING_PARAM = "missing_param"
    #: 파라미터 선언의 타입 표현식이 `types.json` 문법을 벗어남.
    INVALID_PARAM_TYPE = "invalid_param_type"
    #: 서브그래프 중첩이 깊이 상한을 넘음.
    SUBGRAPH_TOO_DEEP = "subgraph_too_deep"
    #: 평탄화 결과 노드 수가 상한을 넘음.
    SUBGRAPH_TOO_LARGE = "subgraph_too_large"

    #: `is_changed` 훅이 선언한 입력이 링크로 채워져 있음 (§5.3).
    IS_CHANGED_LINKED_INPUT = "is_changed_linked_input"

    # --- 아래는 레지스트리를 알아야만 판정할 수 있는 것들 (M1).
    #     `nodal.executor.validate_for_execution` 이 만든다.

    #: 그래프가 레지스트리에 없는 노드 타입을 참조.
    UNKNOWN_NODE_TYPE = "unknown_node_type"
    #: 노드 스키마에 없는 입력 소켓에 값이 들어옴.
    UNKNOWN_INPUT_SOCKET = "unknown_input_socket"
    #: 링크가 출처 노드에 없는 출력 소켓을 가리킴.
    UNKNOWN_OUTPUT_SOCKET = "unknown_output_socket"
    #: 기본값이 없는 입력이 비어 있음.
    MISSING_REQUIRED_INPUT = "missing_required_input"
    #: 소켓 타입이 호환되지 않음 (`types.json` 규칙 기준).
    TYPE_MISMATCH = "type_mismatch"
    #: 그래프에 사이클이 있음. 실행 목록이 역방향 용해로 발견한다.
    CYCLE = "cycle"


@dataclass(frozen=True, slots=True)
class GraphIssue:
    """검증에서 발견된 문제 하나.

    Args:
        code: 안정적인 기계 판독용 코드.
        message: 사람이 읽는 설명.
        node_id: 문제가 귀속되는 노드. 그래프 전역 문제면 ``None``.
        socket: 문제가 귀속되는 입력 소켓 이름. 노드 전체 문제면 ``None``.
        definition: 문제가 서브그래프 정의 안에 있으면 그 정의 이름 (M5).
            최상위 그래프의 문제면 ``None``.

    Note:
        `definition` 없이 `node_id` 만으로는 위치가 **모호하다.** 정의마다
        별개의 이름공간이라 서로 다른 정의가 같은 노드 ID 를 쓸 수 있기
        때문이다. 정의 안의 문제는 반드시 이 필드를 채운다.
    """

    code: IssueCode
    message: str
    node_id: str | None = None
    socket: str | None = None
    definition: str | None = None

    @property
    def location(self) -> str:
        """캐논 문서 안에서의 경로. 프론트가 그대로 소비한다."""
        if self.definition is None:
            if self.node_id is None:
                return "graph"
            if self.socket is None:
                return f"nodes.{self.node_id}"
            return f"nodes.{self.node_id}.inputs.{self.socket}"

        base = f"definitions.{self.definition}"
        if self.node_id is None:
            # 노드가 없는 정의 내부 문제는 정의의 선언부다 — `params` 나 `returns`.
            return f"{base}.returns.{self.socket}" if self.socket else base
        if self.socket is None:
            return f"{base}.nodes.{self.node_id}"
        return f"{base}.nodes.{self.node_id}.inputs.{self.socket}"

    def __str__(self) -> str:
        return f"{self.location}: {self.message} [{self.code}]"


class GraphValidationError(Exception):
    """검증 실패. 발견된 모든 문제를 담는다 — 첫 번째에서 멈추지 않는다."""

    def __init__(self, issues: list[GraphIssue]) -> None:
        self.issues = issues
        count = len(issues)
        detail = "\n".join(f"  - {issue}" for issue in issues)
        super().__init__(f"그래프 검증 실패 ({count}건):\n{detail}")
