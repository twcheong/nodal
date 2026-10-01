"""노드 레지스트리 — 등록과 조회 (docs/design.md §1.2 ④).

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

from .schema import NodeSchema, get_schema

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
        self._schemas: dict[str, NodeSchema] = {}
        for schema in schemas:
            if schema.id in self._schemas:
                raise DuplicateNodeTypeError(schema.id)
            self._schemas[schema.id] = schema

    def register(self, node_class: type, *, replace: bool = False) -> NodeSchema:
        """`@node` 가 붙은 클래스를 등록하고 그 스키마를 돌려준다.

        Raises:
            SchemaError: `@node` 가 붙지 않았을 때.
            DuplicateNodeTypeError: 같은 ID 가 이미 있고 `replace` 가 거짓일 때.
        """
        schema = get_schema(node_class)
        if schema.id in self._schemas and not replace:
            raise DuplicateNodeTypeError(schema.id)
        self._schemas[schema.id] = schema
        return schema

    def register_all(self, node_classes: Sequence[type], *, replace: bool = False) -> None:
        """여러 개를 한 번에 등록한다."""
        for node_class in node_classes:
            self.register(node_class, replace=replace)

    def get(self, type_id: str, *, node_id: str | None = None) -> NodeSchema:
        """타입 ID 로 스키마를 찾는다.

        Args:
            type_id: 캐논 그래프의 `node.type`.
            node_id: 이 조회를 유발한 그래프 노드. 에러 메시지에만 쓴다.

        Raises:
            NodeTypeNotFoundError: 등록되지 않은 타입일 때.
        """
        try:
            return self._schemas[type_id]
        except KeyError:
            raise NodeTypeNotFoundError(type_id, node_id=node_id) from None

    def schemas(self) -> Mapping[str, NodeSchema]:
        """전체 스키마. `/api/nodes` 가 그대로 내보낸다 (design.md §6)."""
        return dict(self._schemas)

    def search(self, query: str, *, limit: int = 20) -> Sequence[NodeSchema]:
        """퍼지 검색. 제목·ID·별칭·분류를 본다. 별칭에는 한글이 들어온다.

        프론트의 더블클릭 검색이 쓴다 (design.md §7 UX 2).
        """
        needle = query.strip().lower()
        if not needle:
            return sorted(self._schemas.values(), key=lambda s: s.id)[:limit]

        scored: list[tuple[int, str, NodeSchema]] = []
        for schema in self._schemas.values():
            score = _match_score(needle, schema)
            if score > 0:
                scored.append((-score, schema.id, schema))
        scored.sort()
        return [schema for _, _, schema in scored[:limit]]

    def __contains__(self, type_id: object) -> bool:
        return type_id in self._schemas

    def __iter__(self) -> Iterator[NodeSchema]:
        return iter(self._schemas.values())

    def __len__(self) -> int:
        return len(self._schemas)

    def __repr__(self) -> str:
        return f"NodeRegistry({len(self._schemas)}개: {', '.join(sorted(self._schemas))})"


def default_registry() -> NodeRegistry:
    """프로세스 기본 레지스트리.

    편의를 위한 것이지 전역 상태를 권장하는 것이 아니다. 테스트는 자기
    `NodeRegistry()` 를 만들어 쓴다 — 그래야 서로 간섭하지 않는다.
    """
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = NodeRegistry()
    return _DEFAULT


_DEFAULT: NodeRegistry | None = None


def _match_score(needle: str, schema: NodeSchema) -> int:
    """검색 점수. 클수록 앞에 온다. 0 이면 후보가 아니다.

    정확 일치 > 접두사 > 부분 문자열 > 부분 수열 순으로 점수를 준다. 별칭은
    사용자가 직접 붙인 이름이므로 ID 보다 높게 친다.
    """
    fields: tuple[tuple[str, int], ...] = (
        (schema.title.lower(), 40),
        (schema.id.lower(), 35),
        *((alias.lower(), 38) for alias in schema.aliases),
        (schema.category.lower(), 15),
    )

    best = 0
    for text, weight in fields:
        if not text:
            continue
        if text == needle:
            best = max(best, weight + 60)
        elif text.startswith(needle):
            best = max(best, weight + 40)
        elif needle in text:
            best = max(best, weight + 20)
        elif _is_subsequence(needle, text):
            best = max(best, weight)
    return best


def _is_subsequence(needle: str, haystack: str) -> bool:
    """`rsz` 가 `resize` 에 순서대로 들어 있는가."""
    it = iter(haystack)
    return all(char in it for char in needle)
