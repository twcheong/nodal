"""nodal 기본 노드 팩 — 유틸 · 수학 · 문자열 · 파일.

이 패키지는 `nodal` 만 import 한다. server 를 import 하지 않는다.

M1 에서는 산술 노드만 있다. 실행 엔진을 GPU 도 UI 도 없이 검증하는 것이
목적이다 (docs/roadmap.md M1).

    from nodal import NodeRegistry
    from nodal_nodes_core import register_all

    registry = NodeRegistry()
    register_all(registry)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .batch_nodes import BatchRange, GetListItem, ListCount, RepeatBatch
from .flow_nodes import Switch
from .math_nodes import (
    Add,
    Clamp,
    Const,
    Divide,
    Format,
    Multiply,
    Negate,
    Power,
    Print,
    Subtract,
    Sum3,
)

if TYPE_CHECKING:
    from nodal import NodeRegistry

#: 이 팩이 제공하는 모든 노드 클래스. 등록 순서는 무관하다.
NODES: tuple[type, ...] = (
    Const,
    Add,
    Subtract,
    Multiply,
    Divide,
    Negate,
    Power,
    Clamp,
    Sum3,
    Format,
    Print,
    Switch,
    BatchRange,
    RepeatBatch,
    GetListItem,
    ListCount,
)

__all__ = [
    "NODES",
    "Add",
    "BatchRange",
    "Clamp",
    "Const",
    "Divide",
    "Format",
    "GetListItem",
    "ListCount",
    "Multiply",
    "Negate",
    "Power",
    "Print",
    "RepeatBatch",
    "Subtract",
    "Sum3",
    "Switch",
    "register_all",
]

__version__ = "0.0.0"


def register_all(registry: NodeRegistry, *, replace: bool = False) -> None:
    """이 팩의 노드를 전부 레지스트리에 등록한다.

    전역 레지스트리에 자동 등록하지 않는다 — 호출자가 어느 레지스트리에
    넣을지 정한다 (design.md §1.2 ④).
    """
    registry.register_all(NODES, replace=replace)
