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


@dataclass(frozen=True, slots=True)
class GraphIssue:
    """검증에서 발견된 문제 하나.

    Args:
        code: 안정적인 기계 판독용 코드.
        message: 사람이 읽는 설명.
        node_id: 문제가 귀속되는 노드. 그래프 전역 문제면 ``None``.
        socket: 문제가 귀속되는 입력 소켓 이름. 노드 전체 문제면 ``None``.
    """

    code: IssueCode
    message: str
    node_id: str | None = None
    socket: str | None = None

    @property
    def location(self) -> str:
        """캐논 문서 안에서의 경로. 프론트가 그대로 소비한다."""
        if self.node_id is None:
            return "graph"
        if self.socket is None:
            return f"nodes.{self.node_id}"
        return f"nodes.{self.node_id}.inputs.{self.socket}"

    def __str__(self) -> str:
        return f"{self.location}: {self.message} [{self.code}]"


class GraphValidationError(Exception):
    """검증 실패. 발견된 모든 문제를 담는다 — 첫 번째에서 멈추지 않는다."""

    def __init__(self, issues: list[GraphIssue]) -> None:
        self.issues = issues
        count = len(issues)
        detail = "\n".join(f"  - {issue}" for issue in issues)
        super().__init__(f"그래프 검증 실패 ({count}건):\n{detail}")
