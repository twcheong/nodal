"""데이터 흐름 조건 분기 노드 (docs/design.md §1.1 ④).

분기는 별도 제어 흐름 그래프가 아니다. ``Switch`` 가 닫힌 출력 소켓에
``ExecutionBlocker`` 를 놓으면 엔진이 그 소켓을 읽는 하류만 실행 목록에서 막는다.
"""

from __future__ import annotations

from typing import Any as TypingAny

from nodal import Any, Bool, ExecutionBlocker, NodeResult, Socket, node

__all__ = ["Switch"]


@node(
    id="flow.Switch",
    title="Switch",
    category="flow",
    aliases=["분기", "스위치", "router"],
)
class Switch:
    """값을 조건에 맞는 출력 하나로만 보낸다.

    선택되지 않은 출력은 값이 없는 것이 아니라 명시적으로 막힌 출력이다. 따라서
    같은 노드의 열린 출력을 읽는 하류는 실행되고 닫힌 출력을 읽는 하류만 막힌다.
    """

    value: Socket = Socket(Any)
    condition: Bool = Bool(False)

    returns = {"true": Any, "false": Any}

    def run(self, value: TypingAny, condition: bool) -> NodeResult:
        blocker = ExecutionBlocker(f"flow.Switch condition={condition!r} 에서 선택되지 않은 출력")
        if condition:
            return NodeResult(value, blocker)
        return NodeResult(blocker, value)
