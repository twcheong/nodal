"""배치·리스트 유틸리티 노드 (roadmap M5 ②).

N개 변형은 실행 중 노드 확장으로 N개 노드를 만드는 대신 리스트 값 하나로
표현한다. 리스트는 core 타입 시스템의 1급 ``List[T]`` 소켓을 그대로 쓴다.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any as TypingAny

from nodal import INT, Any, Int, ListType, NodeResult, Socket, node

__all__ = ["BatchRange", "GetListItem", "ListCount", "RepeatBatch"]

MAX_BATCH_SIZE = 10_000


def _check_count(count: int) -> None:
    if not 0 <= count <= MAX_BATCH_SIZE:
        raise ValueError(f"count 는 0..{MAX_BATCH_SIZE} 여야 한다: {count}")


@node(
    id="batch.Range",
    title="Batch Range",
    category="batch",
    aliases=["범위", "range", "변형 인덱스"],
)
class BatchRange:
    """등간격 정수 N개를 배치 값으로 만든다."""

    start: Int = Int(0)
    count: Int = Int(1, min=0, max=MAX_BATCH_SIZE)
    step: Int = Int(1)

    returns = {"items": ListType(INT)}

    def run(self, start: int, count: int, step: int) -> NodeResult:
        _check_count(count)
        return NodeResult([start + index * step for index in range(count)])


@node(
    id="batch.Repeat",
    title="Repeat Batch",
    category="batch",
    aliases=["반복", "repeat", "batch"],
)
class RepeatBatch:
    """값 하나를 N개짜리 리스트로 승격한다.

    값 자체를 복사하지는 않는다. 이미지·모델 핸들처럼 큰 객체는 같은 참조를
    배치에 담는 것이 의도이며, 값을 변경하는 책임은 소비 노드에 있다.
    """

    value: Socket = Socket(Any)
    count: Int = Int(1, min=0, max=MAX_BATCH_SIZE)

    returns = {"items": ListType(Any)}

    def run(self, value: TypingAny, count: int) -> NodeResult:
        _check_count(count)
        return NodeResult([value] * count)


@node(
    id="list.GetItem",
    title="Get List Item",
    category="list",
    aliases=["항목", "인덱스", "get item"],
)
class GetListItem:
    """리스트의 0 기반 인덱스 항목 하나를 꺼낸다."""

    items: Socket = Socket(ListType(Any))
    index: Int = Int(0, min=0)

    returns = {"item": Any}

    def run(self, items: Sequence[TypingAny], index: int) -> NodeResult:
        if not 0 <= index < len(items):
            raise IndexError(f"index {index} 가 리스트 길이 {len(items)} 범위를 벗어났다")
        return NodeResult(items[index])


@node(
    id="list.Count",
    title="List Count",
    category="list",
    aliases=["개수", "길이", "length"],
)
class ListCount:
    """리스트에 든 항목 수를 센다."""

    items: Socket = Socket(ListType(Any))

    returns = {"count": INT}

    def run(self, items: Sequence[TypingAny]) -> NodeResult:
        return NodeResult(len(items))
