"""노드 레지스트리 — 등록과 조회 (docs/design.md §1.2 ④).

> **계약 파일.** 본문은 M1 에서 채운다.

전역 `NODE_CLASS_MAPPINGS` 딕셔너리를 쓰지 않는다. 레지스트리는 **객체**이고,
실행할 때 명시적으로 건네받는다. 그래야 테스트가 서로의 노드를 보지 않는
레지스트리를 각자 만들 수 있다::

    registry = NodeRegistry()
    registry.register(Add)
    registry.register(Multiply)

    result = await execute(graph, ["n_out"], registry=registry, ...)
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence

from .schema import NodeSchema

__all__ = [
    "DuplicateNodeTypeError",
    "NodeRegistry",
    "NodeTypeNotFoundError",
    "default_registry",
]


class NodeTypeNotFoundError(KeyError):
    """그래프가 참조한 노드 타입이 레지스트리에 없을 때.

    메시지는 어느 노드 ID 가 그 타입을 요구했는지까지 담는다 — 사용자는 타입
    이름이 아니라 캔버스의 노드를 본다.
    """

    def __init__(self, type_id: str, *, node_id: str | None = None) -> None:
        self.type_id = type_id
        self.node_id = node_id
        where = f"nodes.{node_id}: " if node_id else ""
        super().__init__(f"{where}등록되지 않은 노드 타입: {type_id!r}")


class DuplicateNodeTypeError(ValueError):
    """같은 타입 ID 를 두 번 등록했을 때. 확장 충돌을 조용히 덮지 않는다."""

    def __init__(self, type_id: str) -> None:
        self.type_id = type_id
        super().__init__(f"이미 등록된 노드 타입: {type_id!r}")


class NodeRegistry:
    """노드 타입 ID → 스키마."""

    def __init__(self, schemas: Sequence[NodeSchema] = ()) -> None:
        raise NotImplementedError

    def register(self, node_class: type, *, replace: bool = False) -> NodeSchema:
        """`@node` 가 붙은 클래스를 등록하고 그 스키마를 돌려준다.

        Raises:
            SchemaError: `@node` 가 붙지 않았을 때.
            DuplicateNodeTypeError: 같은 ID 가 이미 있고 `replace` 가 거짓일 때.
        """
        raise NotImplementedError

    def register_all(self, node_classes: Sequence[type], *, replace: bool = False) -> None:
        """여러 개를 한 번에 등록한다."""
        raise NotImplementedError

    def get(self, type_id: str, *, node_id: str | None = None) -> NodeSchema:
        """타입 ID 로 스키마를 찾는다.

        Args:
            type_id: 캐논 그래프의 `node.type`.
            node_id: 이 조회를 유발한 그래프 노드. 에러 메시지에만 쓴다.

        Raises:
            NodeTypeNotFoundError: 등록되지 않은 타입일 때.
        """
        raise NotImplementedError

    def schemas(self) -> Mapping[str, NodeSchema]:
        """전체 스키마. `/api/nodes` 가 그대로 내보낸다 (design.md §6)."""
        raise NotImplementedError

    def search(self, query: str, *, limit: int = 20) -> Sequence[NodeSchema]:
        """퍼지 검색. 제목·ID·별칭·분류를 본다. 별칭에는 한글이 들어온다.

        프론트의 더블클릭 검색이 쓴다 (design.md §7 UX 2).
        """
        raise NotImplementedError

    def __contains__(self, type_id: object) -> bool:
        raise NotImplementedError

    def __iter__(self) -> Iterator[NodeSchema]:
        raise NotImplementedError

    def __len__(self) -> int:
        raise NotImplementedError


def default_registry() -> NodeRegistry:
    """프로세스 기본 레지스트리.

    편의를 위한 것이지 전역 상태를 권장하는 것이 아니다. 테스트는 자기
    `NodeRegistry()` 를 만들어 쓴다 — 그래야 서로 간섭하지 않는다.
    """
    raise NotImplementedError
