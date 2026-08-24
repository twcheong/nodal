"""템플릿 카탈로그 — MCP 툴의 공급원 (docs/design.md §12.8).

발견 메커니즘은 **디렉토리 하나**다: `~/.nodal/templates/*.nodal.json`. 파일
하나가 툴 하나가 된다 (§12.2 G1).

규약은 짧다:

- **템플릿 ID 는 파일명**(`.nodal.json` 을 뗀 것)이다
- 그 파일의 `definitions` 중 **같은 이름의 정의**가 노출된다. 캐논 포맷에 새
  필드를 만들지 않는다 — 어느 정의가 툴인지는 **파일 이름이 말한다**
- 정의는 여럿이어도 된다. 나머지는 그 정의가 안에서 쓰는 중첩 서브그래프다
- 최상위 `nodes` · `outputs` 는 **MCP 표면이 읽지 않는다.** 같은 파일을
  `nodal run` 으로 돌려 볼 수 있게 남겨 두는 저작용 하네스다
- 이름이 맞는 정의가 없거나 스키마를 만들 수 없으면 **로드를 거부하고 이유를
  남긴다.** 조용히 건너뛰지 않는다 — 템플릿이 안 보이는 이유를 사람이 알아야
  한다. 카탈로그에 이유가 남아 있어야 `nodal serve` 가 시작할 때 그것을 찍는다
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from nodal import (
    Graph,
    GraphIssue,
    GraphValidationError,
    Node,
    SubgraphDef,
    parse_graph,
    validate_graph,
)

from .toolschema import ASSET_PREFIX, InputSchema, SchemaNote, build_input_schema

__all__ = [
    "CALL_NODE_ID",
    "TEMPLATE_ID_RE",
    "TEMPLATE_SUFFIX",
    "TOOL_PREFIX",
    "AssetReferenceNotSupportedError",
    "Rejection",
    "Template",
    "TemplateCatalog",
    "build_call_graph",
    "default_templates_dir",
    "format_rejections",
    "load_catalog",
]

log = logging.getLogger(__name__)

#: 카탈로그 파일 확장자. 캐논 문서와 같은 확장자다 — 템플릿은 별도 포맷이 아니다.
TEMPLATE_SUFFIX: Final = ".nodal.json"

#: MCP 툴 이름 접두. `run_template_<id>` (§12.2 · §12.6).
TOOL_PREFIX: Final = "run_template_"

#: 템플릿 ID. 정의 이름(`_DEF_NAME_RE`)보다 **좁다**:
#:
#: - **소문자만** — ID 가 곧 파일명인데 macOS · Windows 의 파일시스템은 대소문자를
#:   구분하지 않는다. `Foo` 와 `foo` 를 허용하면 리눅스에서만 되는 카탈로그가 된다
#: - **48 자 이하** — `run_template_` 를 붙인 툴 이름이 64 자를 넘지 않아야 한다.
#:   MCP 클라이언트들이 흔히 그 길이에서 자른다
TEMPLATE_ID_RE: Final = re.compile(r"^[a-z][a-z0-9_]{0,47}$")

#: 툴 호출을 감싸는 그래프에서 인스턴스 노드에 붙는 ID.
#:
#: **고정값인 것이 계약이다.** 평탄화 전 `GraphIssue` 의 `node_id` 가 이 값이면
#: 그 이슈는 **툴 인자**에 귀속되고, `socket` 이 곧 파라미터 이름이다 (§12.3).
#: 평탄화 후 내부 노드는 `call:<안쪽 ID>` 가 된다 (§5.5 ②).
CALL_NODE_ID: Final = "call"


class AssetReferenceNotSupportedError(NotImplementedError):
    """툴 인자가 `asset:<hash>` 인데 그 경로가 아직 없다 (§12.3 H2).

    **조용히 경로로 취급하지 않는다.** 그러면 `asset:ab12...` 라는 이름의 파일을
    찾다가 "그런 파일이 없다" 로 죽고, 클라이언트는 자기가 해시를 잘못 줬다고
    생각한다. 실제로는 서버가 아직 못 하는 일이다 — 둘은 다른 문제이고 답도 다르다.
    """


@dataclass(frozen=True, slots=True)
class Rejection:
    """로드되지 않은 파일 하나와 그 이유.

    카탈로그가 이것을 들고 있는 이유는 로그가 흘러가기 때문이다. 서버가 시작
    시점에 찍고, 나중에 진단 엔드포인트가 생기면 같은 것을 보여준다.
    """

    path: Path
    reason: str
    #: 스키마 변환에서 파라미터별로 나온 사유. 이유가 그쪽에 있을 때만 채워진다.
    details: tuple[SchemaNote, ...] = ()

    def describe(self) -> str:
        lines = [f"{self.path.name}: {self.reason}"]
        lines.extend(f"  - {note}" for note in self.details)
        return "\n".join(lines)


@dataclass(frozen=True, slots=True)
class Template:
    """노출되는 템플릿 하나 = MCP 툴 하나."""

    id: str
    path: Path
    #: 파일 전체. `definitions` 를 그대로 들고 호출 그래프를 만든다 (§5.5 — 정의는
    #: 문서 안에 산다).
    graph: Graph
    definition: SubgraphDef
    input_schema: dict[str, Any]
    #: 스키마는 만들었지만 옮기지 못한 제약들. 노출을 막지는 않는다.
    notes: tuple[SchemaNote, ...] = ()

    @property
    def tool_name(self) -> str:
        return f"{TOOL_PREFIX}{self.id}"

    @property
    def returns(self) -> tuple[str, ...]:
        """결과 소켓 이름들. `get_run` 의 `results` 키가 이것이다 (§12.6)."""
        return tuple(self.definition.returns)

    @property
    def seed_params(self) -> tuple[str, ...]:
        """시드로 선언된 파라미터들 (§12.3 · §9.4).

        신호는 둘이고 **둘 중 하나면 시드다** — 중복 표현이 아니라 합집합이다:

        - `widget.seed` 가 참 (노드 SDK 의 `Seed` 가 붙이는 힌트와 같은 어휘)
        - 이름이 그냥 `seed`

        이름만으로도 인정하는 이유는 힌트를 빠뜨린 템플릿이 조용히 "시드 없음"
        으로 발표되는 것이 최악이기 때문이다. 시드가 없다는 **말**은 재현되지
        않는다는 약속이므로 틀리면 안 된다.
        """
        return tuple(
            name
            for name, param in self.definition.params.items()
            if name == "seed" or param.widget.get("seed") is True
        )

    def describe(self) -> str:
        """MCP 툴 설명 (§12.2).

        **첫 줄은 정의가 스스로 쓴 `doc` 이다.** 카탈로그가 `doc` 없는 템플릿을
        노출하지 않으므로 (§12.8) 여기서 비어 있을 수 없다. 툴 설명은 AI 가 툴을
        고르는 유일한 근거라, 이 자리를 서버가 지어낸 문장으로 채우면 제품이 그만큼
        나빠진다.

        나머지는 스키마만으로는 알 수 없는 것들이다 — 호출이 비동기라는 것(§12.6)과
        시드 여부(§12.3).
        """
        lines = [
            self.definition.doc or f"템플릿 '{self.id}'.",
            "즉시 run_id 를 돌려준다 — 진행과 결과는 get_run(run_id) 로 받고, "
            "중단은 cancel_run(run_id) 이다.",
            f"결과 소켓: {', '.join(self.returns) or '(없음)'}",
        ]
        if self.seed_params:
            lines.append(
                f"시드: {', '.join(self.seed_params)} — 같은 인자로 다시 부르면 같은 결과가 나온다."
            )
        else:
            lines.append(
                "시드: 이 템플릿은 시드를 노출하지 않는다. "
                "서버는 시드를 만들어 넣지 않으므로, 같은 인자로 다시 불러도 "
                "같은 결과가 나온다는 보장이 없다."
            )
        return "\n".join(lines)


@dataclass(frozen=True, slots=True)
class TemplateCatalog:
    """`~/.nodal/templates` 한 디렉토리를 읽은 결과 (§12.8)."""

    root: Path
    templates: tuple[Template, ...] = ()
    rejections: tuple[Rejection, ...] = field(default=())

    def get(self, template_id: str) -> Template | None:
        return next((t for t in self.templates if t.id == template_id), None)

    def by_tool_name(self, tool_name: str) -> Template | None:
        return next((t for t in self.templates if t.tool_name == tool_name), None)

    def __len__(self) -> int:
        return len(self.templates)


def default_templates_dir() -> Path:
    """`~/.nodal/templates`. 발견 경로는 이것 하나다 (§12.8)."""
    return Path.home() / ".nodal" / "templates"


def load_catalog(root: Path | None = None) -> TemplateCatalog:
    """디렉토리 하나를 읽어 카탈로그를 만든다. 예외를 던지지 않는다.

    파일 하나가 잘못됐다고 카탈로그 전체가 사라지면 나머지 템플릿을 쓰던 사람이
    이유 없이 툴을 잃는다. 잘못된 파일만 `rejections` 로 간다.
    """
    root = default_templates_dir() if root is None else root
    if not root.is_dir():
        log.info("템플릿 디렉토리가 없다: %s (템플릿 0개로 시작한다)", root)
        return TemplateCatalog(root)

    templates: list[Template] = []
    rejections: list[Rejection] = []
    # 정렬한다 — 툴 목록의 순서가 파일시스템 순서에 따라 달라지지 않게.
    for path in sorted(root.glob(f"*{TEMPLATE_SUFFIX}")):
        result = _load_one(path)
        if isinstance(result, Rejection):
            rejections.append(result)
            log.warning("템플릿을 로드하지 않았다 — %s", result.describe())
        else:
            templates.append(result)
            for note in result.notes:
                log.info("템플릿 %s 의 제약 하나를 스키마에 싣지 못했다 — %s", result.id, note)

    log.info("템플릿 %d개 로드, %d개 거부 (%s)", len(templates), len(rejections), root)
    return TemplateCatalog(root, tuple(templates), tuple(rejections))


def _load_one(path: Path) -> Template | Rejection:
    template_id = path.name[: -len(TEMPLATE_SUFFIX)]
    if not TEMPLATE_ID_RE.match(template_id):
        return Rejection(
            path,
            f"템플릿 ID {template_id!r} 가 규칙에 맞지 않는다 "
            f"(소문자·숫자·밑줄, 48자 이하, 첫 글자는 소문자): {TEMPLATE_ID_RE.pattern}",
        )

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        return Rejection(path, f"파일을 읽지 못했다 — {exc}")

    try:
        graph = parse_graph(raw)
    except GraphValidationError as exc:
        return Rejection(path, "캐논 그래프 문서가 아니다", _details(exc.issues))

    issues = validate_graph(graph)
    if issues:
        return Rejection(path, "문서 검증에 실패했다", _details(issues))

    definition = graph.definitions.get(template_id)
    if definition is None:
        return Rejection(
            path,
            f"파일 이름과 같은 정의 {template_id!r} 가 없다 "
            f"(있는 정의: {', '.join(sorted(graph.definitions)) or '(없음)'}). "
            "템플릿 ID 는 파일명이고, 노출되는 것은 같은 이름의 정의다",
        )

    if not definition.doc or not definition.doc.strip():
        return Rejection(
            path,
            f"정의 {template_id!r} 에 doc 이 없다 — 카탈로그에 노출되려면 필수다. "
            "툴 설명은 AI 가 이 툴을 고를지 판단하는 유일한 근거이고, "
            "서버가 지어낸 문장으로 채울 수 없다 (design.md §12.8)",
        )

    if not definition.returns:
        return Rejection(
            path,
            f"정의 {template_id!r} 가 returns 를 선언하지 않았다 — "
            "내보내는 것이 없으면 툴이 돌려줄 것도 없다",
        )

    schema: InputSchema = build_input_schema(definition.params)
    if schema.schema is None:
        return Rejection(
            path,
            f"정의 {template_id!r} 의 params 에서 툴 inputSchema 를 만들 수 없다",
            schema.errors,
        )

    return Template(
        id=template_id,
        path=path,
        graph=graph,
        definition=definition,
        input_schema=schema.schema,
        notes=schema.notes,
    )


def build_call_graph(template: Template, arguments: Mapping[str, Any]) -> Graph:
    """툴 호출 하나를 실행 가능한 캐논 그래프로 감싼다 (§12.6).

    모양은 언제나 같다 — 인스턴스 하나와 그것을 요청하는 `outputs` 하나다::

        {"definitions": <파일의 정의 전부>,
         "nodes": {"call": {"type": "subgraph.<id>", "inputs": <인자>}},
         "outputs": ["call"]}

    파일의 정의를 **통째로** 싣는 이유는 노출된 정의가 다른 정의를 중첩해 쓸 수
    있기 때문이고, 정의가 문서 안에 살아야 문서가 자기완결적이기 때문이다 (§5.5).

    이 함수는 인자를 **검증하지 않는다.** 필수 파라미터 누락과 타입 불일치는
    `validate_for_execution` 이 `GraphIssue` 로 답한다 (§5.5). 그 이슈의
    `node_id` 는 `CALL_NODE_ID` 이고 `socket` 이 곧 파라미터 이름이라, MCP 에러는
    **어느 인자인지** 그대로 지목할 수 있다 (§12.3).

    예외가 하나 있다 — `asset:` 로 시작하는 값이다. 그 경로는 아직 구현되지
    않았고 (§12.3 H2), 그대로 흘려보내면 파일을 찾다가 죽어 **클라이언트가 자기
    해시를 의심한다.** 미구현은 검증 실패가 아니라 서버가 못 하는 일이므로
    `GraphIssue` 가 아니라 예외로 답한다.

    Raises:
        AssetReferenceNotSupportedError: 인자에 `asset:` 값이 있을 때.
    """
    _reject_asset_values(arguments)
    return Graph(
        definitions=dict(template.graph.definitions),
        nodes={
            CALL_NODE_ID: Node(
                type=f"subgraph.{template.id}",
                inputs=dict(arguments),
            )
        },
        outputs=[CALL_NODE_ID],
    )


def _reject_asset_values(arguments: Mapping[str, Any]) -> None:
    """`asset:` 예약 접두를 쓴 인자를 찾아 미구현으로 답한다 (§12.3 H2).

    **타입이 아니라 값을 본다.** `asset:` 는 예약 접두라 어떤 파라미터에서도
    다른 뜻을 가질 수 없고, 그래서 `Image` 로 선언되지 않은 파라미터에 들어온
    에셋 참조도 여기서 걸린다. 타입만 보면 `List[Image]` 나 `STRING` 경로
    파라미터에 들어온 것이 조용히 지나간다.
    """
    for name, value in arguments.items():
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, str) and item.startswith(ASSET_PREFIX):
                raise AssetReferenceNotSupportedError(
                    f"파라미터 {name!r} 의 값 {item!r} 는 에셋 참조다. "
                    "형식은 계약에 있지만 (design.md §12.3) 서버가 아직 에셋으로 "
                    "이미지를 읽지 못한다 — 지금은 파일 경로를 넘겨라"
                )


def _details(issues: Iterable[GraphIssue]) -> tuple[SchemaNote, ...]:
    """`GraphIssue` 를 거부 사유로 옮긴다. **위치를 잃지 않는다** — 템플릿을 고칠
    사람은 문서 어디가 문제인지 알아야 한다."""
    return tuple(SchemaNote(issue.location, f"[{issue.code}] {issue.message}") for issue in issues)


def format_rejections(rejections: Iterable[Rejection]) -> str:
    """서버 시작 로그용. 거부된 파일을 사람이 읽는 여러 줄로."""
    return "\n".join(rejection.describe() for rejection in rejections)
