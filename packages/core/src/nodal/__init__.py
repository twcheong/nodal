"""nodal — 도메인 중립 그래프 엔진.

이 패키지는 torch 를 import 하지 않는다. 그래프 문서, 타입 시스템, 실행 루프만
안다. 이미지도 모델도 모른다 (AGENTS.md 아키텍처 절).

M0 시점의 공개 표면은 캐논 그래프 포맷뿐이다. 노드 SDK(`@node`, 타입 서술자)와
실행 엔진은 M1 에서 이 모듈에 합류한다.
"""

from .errors import GraphIssue, GraphValidationError, IssueCode
from .graph import (
    GRAPH_VERSION,
    LINK_KEY,
    Graph,
    InputValue,
    Link,
    Node,
    NodeMeta,
    check_graph,
    parse_graph,
    validate_graph,
)

__all__ = [
    "GRAPH_VERSION",
    "LINK_KEY",
    "Graph",
    "GraphIssue",
    "GraphValidationError",
    "InputValue",
    "IssueCode",
    "Link",
    "Node",
    "NodeMeta",
    "check_graph",
    "parse_graph",
    "validate_graph",
]

__version__ = "0.0.0"
