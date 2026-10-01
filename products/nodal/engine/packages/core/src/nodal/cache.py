"""입력 시그니처 캐시 (docs/design.md §5.3).

캐시 키는 **노드 ID 가 아니라 입력의 내용**으로 만든다. 그래서 노드를 복사하거나
순서를 바꿔도 캐시가 산다. 사용 경험의 절반이 여기서 나온다::

    cache_key(node) = hash(
        node.type,
        node.schema_version,
        { 이름: (링크면 출처의 캐시 키, 리터럴이면 값) },
        is_changed_token,
    )

캐시는 최적화가 아니라 기본 동작이다. 파라미터 하나를 바꿨을 때 그 노드 아래만
재실행되는 것이 정상이다 (design.md §2 원칙 4).
"""

from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from collections.abc import Iterator, Mapping
from enum import StrEnum
from typing import Any, Protocol, runtime_checkable

from .errors import GraphIssue, GraphValidationError, IssueCode
from .graph import Graph, Link
from .schema import NodeSchema

__all__ = [
    "MISS",
    "Cache",
    "CachePolicy",
    "LRUCache",
    "NullCache",
    "cache_key",
    "graph_cache_keys",
]


class CachePolicy(StrEnum):
    """축출 정책 (design.md §5.3). 기본은 `MEMORY_PRESSURE`."""

    #: 캐시 없음. 디버깅용.
    NONE = "none"
    #: 최근 n개 노드 결과 유지.
    LRU = "lru"
    #: 여유 RAM 임계값 아래로 떨어지면 축출. 기본값이지만 구현은 M1 이후.
    MEMORY_PRESSURE = "memory_pressure"
    #: 큰 텐서를 memmap 으로 디스크에 스필. M1 이후.
    DISK = "disk"


class _Miss:
    """캐시 미스 센티넬. `None` 은 유효한 캐시 값이므로 쓸 수 없다."""

    def __repr__(self) -> str:
        return "MISS"


#: `Cache.get` 이 미스일 때 돌려주는 값.
MISS: Any = _Miss()


@runtime_checkable
class Cache(Protocol):
    """캐시 구현이 만족해야 하는 프로토콜.

    키는 `cache_key` 가 만든 문자열이다. 값은 노드의 출력 딕셔너리
    (`{소켓 이름: 값}`) 이며 core 는 그 내용을 해석하지 않는다.
    """

    def get(self, key: str) -> Any:
        """저장된 값, 없으면 `MISS`."""
        ...

    def set(self, key: str, value: Mapping[str, Any]) -> None: ...

    def __contains__(self, key: object) -> bool: ...

    def __len__(self) -> int: ...

    def clear(self) -> None: ...


class NullCache:
    """아무것도 저장하지 않는다. `CachePolicy.NONE` 의 구현이자 디버깅용."""

    def get(self, key: str) -> Any:
        return MISS

    def set(self, key: str, value: Mapping[str, Any]) -> None:
        return None

    def __contains__(self, key: object) -> bool:
        return False

    def __len__(self) -> int:
        return 0

    def clear(self) -> None:
        return None


class LRUCache:
    """최근 사용 순서로 축출하는 인메모리 캐시. M1 의 기본 구현."""

    def __init__(self, maxsize: int = 128) -> None:
        if maxsize < 0:
            raise ValueError(f"maxsize 는 음수일 수 없다: {maxsize}")
        self._maxsize = maxsize
        self._entries: OrderedDict[str, Mapping[str, Any]] = OrderedDict()

    @property
    def maxsize(self) -> int:
        return self._maxsize

    def get(self, key: str) -> Any:
        if key not in self._entries:
            return MISS
        self._entries.move_to_end(key)
        return self._entries[key]

    def set(self, key: str, value: Mapping[str, Any]) -> None:
        if self._maxsize == 0:
            return
        self._entries[key] = value
        self._entries.move_to_end(key)
        while len(self._entries) > self._maxsize:
            self._entries.popitem(last=False)

    def __contains__(self, key: object) -> bool:
        return key in self._entries

    def __len__(self) -> int:
        return len(self._entries)

    def __iter__(self) -> Iterator[str]:
        """오래된 것부터 최근 것 순서로 키를 순회한다. 축출 순서를 테스트할 수 있게."""
        return iter(list(self._entries))

    def clear(self) -> None:
        self._entries.clear()

    def __repr__(self) -> str:
        return f"LRUCache({len(self._entries)}/{self._maxsize})"


def cache_key(
    node_type: str,
    schema_version: str,
    inputs: Mapping[str, str | Any],
    *,
    is_changed_token: str | None = None,
) -> str:
    """노드 하나의 캐시 키를 만든다.

    이 함수는 순수하다 — 그래프도 캐시도 모른다. 재귀는 `graph_cache_keys` 가
    담당한다. 그래야 키 계산 자체를 단위 테스트할 수 있다.

    Args:
        node_type: 캐논 그래프의 `node.type`.
        schema_version: `NodeSchema.version`. 스키마가 바뀌면 옛 캐시를 버린다.
        inputs: 소켓 이름 → 링크면 **출처 노드의 캐시 키**, 리터럴이면 그 값.
            딕셔너리 순서는 키에 영향을 주지 않는다 — 같은 내용이면 같은 키다.
        is_changed_token: `IS_CHANGED` 훅 결과 (design.md §1.1 ⑦, M5).
            외부 상태에 의존하는 노드가 "입력은 같지만 결과는 다르다"고 말하는 통로.

    Returns:
        16진수 다이제스트 문자열.
    """
    payload = {
        "type": node_type,
        "version": schema_version,
        # 소켓 이름으로 정렬한다. 같은 내용이면 선언 순서와 무관하게 같은 키다.
        "inputs": {name: _stable(inputs[name]) for name in sorted(inputs)},
        "is_changed": is_changed_token,
    }
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=_stable_repr)
    return hashlib.blake2b(encoded.encode("utf-8"), digest_size=16).hexdigest()


def graph_cache_keys(
    graph: Graph,
    schemas: Mapping[str, NodeSchema],
    *,
    is_changed_tokens: Mapping[str, str] | None = None,
) -> Mapping[str, str]:
    """그래프 전체의 노드별 캐시 키를 한 번에 계산한다.

    링크를 따라 재귀하되 각 노드는 한 번만 계산한다 (다이아몬드 의존성에서
    지수 폭발을 피한다).

    Args:
        graph: 캐논 그래프.
        schemas: 노드 타입 ID → 스키마. 보통 `registry.schemas()`.
        is_changed_tokens: 노드 ID → `IS_CHANGED` 토큰.

    Raises:
        NodeTypeNotFoundError: 그래프가 등록되지 않은 타입을 참조할 때.
        GraphValidationError: 그래프에 사이클이 있어 키를 확정할 수 없을 때.
    """
    tokens = is_changed_tokens or {}
    keys: dict[str, str] = {}
    #: 재귀 중인 노드. 다시 들어오면 사이클이다.
    visiting: list[str] = []

    def key_for(node_id: str) -> str:
        if node_id in keys:
            return keys[node_id]
        if node_id in visiting:
            cycle = [*visiting[visiting.index(node_id) :], node_id]
            raise GraphValidationError(
                [
                    GraphIssue(
                        code=IssueCode.CYCLE,
                        message=f"사이클이라 캐시 키를 확정할 수 없다: {' → '.join(cycle)}",
                        node_id=node_id,
                    )
                ]
            )

        visiting.append(node_id)
        try:
            node = graph.nodes[node_id]
            schema = schemas.get(node.type)
            version = schema.version if schema else "?"
            resolved: dict[str, Any] = {}
            for socket, value in node.inputs.items():
                resolved[socket] = (
                    key_for(value.source_node) + "#" + value.source_socket
                    if isinstance(value, Link)
                    else value
                )
            computed = cache_key(
                node.type,
                version,
                resolved,
                is_changed_token=tokens.get(node_id),
            )
        finally:
            visiting.pop()

        keys[node_id] = computed
        return computed

    for node_id in graph.nodes:
        key_for(node_id)
    return keys


def _stable(value: Any) -> Any:
    """캐시 키에 넣을 수 있는 안정적인 형태로 바꾼다.

    같은 값이면 프로세스를 다시 띄워도 같은 키가 나와야 한다. 그래서 `id()` 나
    기본 `repr` 에 기대지 않는다.
    """
    if isinstance(value, str | int | float | bool | type(None)):
        return value
    if isinstance(value, Mapping):
        return {str(k): _stable(v) for k, v in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, list | tuple):
        return [_stable(item) for item in value]
    if isinstance(value, set | frozenset):
        return sorted(_stable(item) for item in value)
    return _stable_repr(value)


def _stable_repr(value: Any) -> str:
    """JSON 으로 표현할 수 없는 값의 최후 수단.

    노드가 불투명 핸들(Model 등)을 출력하면 여기로 온다. 그런 값은 캐시 키에
    직접 들어가지 않고 **출처 노드의 캐시 키**로 대신 표현되므로, 이 경로는
    리터럴 입력에 이상한 객체가 들어온 경우에만 쓰인다.
    """
    marker = getattr(value, "cache_token", None)
    if isinstance(marker, str):
        return marker
    return f"{type(value).__module__}.{type(value).__qualname__}"
