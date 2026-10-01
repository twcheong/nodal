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

import hashlib
import logging
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from nodal import (
    Graph,
    GraphIssue,
    GraphValidationError,
    Link,
    Node,
    SubgraphDef,
    TensorType,
    parse_graph,
    parse_type_expr,
    validate_graph,
)

from .schemas import OutputRefModel
from .toolschema import ASSET_PREFIX, InputSchema, SchemaNote, build_input_schema
from .wire import output_refs

if TYPE_CHECKING:
    from .queue import RunRecord

__all__ = [
    "CALL_NODE_ID",
    "TEMPLATE_ID_RE",
    "TEMPLATE_SUFFIX",
    "TOOL_PREFIX",
    "AssetReferenceParameterError",
    "Rejection",
    "Template",
    "TemplateCatalog",
    "build_call_graph",
    "collect_results",
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


class AssetReferenceParameterError(ValueError):
    """`asset:` 예약 접두가 `Image`가 아닌 파라미터에 쓰였다 (§12.3)."""


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


def load_catalog(
    root: Path | None = None,
    *,
    extension_sources: Sequence[tuple[str, Path]] = (),
) -> TemplateCatalog:
    """디렉토리 하나(+ 확장이 등록한 추가 디렉토리들)를 읽어 카탈로그를 만든다.
    예외를 던지지 않는다.

    발견 메커니즘은 여전히 하나다 (§12.8) — 확장은 두 번째 경로가 아니라 같은
    카탈로그에 등록하는 **공급자**다. `extension_sources` 는
    `(확장 id, templates 디렉토리)` 쌍을 **우선순위 순**으로 받는다
    (`nodal.extensions.ExtensionsResult.template_sources` 가 id 순으로 만들어
    준다).

    **충돌 규칙 (2026-08-27, decisions.md)**: 같은 템플릿 ID 가 두 곳에 있으면
    **사용자 디렉토리(`root`)가 언제나 이긴다.** 확장끼리 겹치면 먼저 온 쪽이
    이긴다. 진 쪽은 조용히 사라지지 않고 `rejections` 에 누가 이겼는지와 함께
    남는다 — 템플릿 카탈로그가 다른 어떤 실패도 숨기지 않는 것과 같은 규칙이다.

    파일 하나가 잘못됐다고 카탈로그 전체가 사라지면 나머지 템플릿을 쓰던 사람이
    이유 없이 툴을 잃는다. 잘못된 파일만 `rejections` 로 간다.
    """
    root = default_templates_dir() if root is None else root
    sources: list[tuple[str, Path]] = [("user", root)]
    sources.extend(extension_sources)

    templates: list[Template] = []
    rejections: list[Rejection] = []
    winners: dict[str, tuple[str, Path]] = {}

    for label, directory in sources:
        if not directory.is_dir():
            if label == "user":
                log.info("템플릿 디렉토리가 없다: %s (템플릿 0개로 시작한다)", directory)
            continue
        # 정렬한다 — 툴 목록의 순서가 파일시스템 순서에 따라 달라지지 않게.
        for path in sorted(directory.glob(f"*{TEMPLATE_SUFFIX}")):
            template_id = path.name[: -len(TEMPLATE_SUFFIX)]
            existing = winners.get(template_id)
            if existing is not None:
                winner_label, winner_path = existing
                rejections.append(
                    Rejection(
                        path,
                        f"템플릿 ID {template_id!r} 는 이미 {winner_label}({winner_path})가 "
                        "쓰고 있다 — 사용자 디렉토리가 언제나 확장보다 우선하고, 확장끼리는 "
                        "먼저 로드된 쪽이 이긴다. 이 파일은 건너뛴다 (design.md §12.8, "
                        "decisions.md 2026-08-27)",
                    )
                )
                continue

            result = _load_one(path)
            if isinstance(result, Rejection):
                rejections.append(result)
                log.warning("템플릿을 로드하지 않았다 — %s", result.describe())
                continue

            winners[template_id] = (label, path)
            templates.append(result)
            for note in result.notes:
                log.info("템플릿 %s 의 제약 하나를 스키마에 싣지 못했다 — %s", result.id, note)

    log.info(
        "템플릿 %d개 로드, %d개 거부 (사용자: %s, 확장 소스 %d개)",
        len(templates),
        len(rejections),
        root,
        len(extension_sources),
    )
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

    일반 파라미터만 있으면 인스턴스 하나와 `outputs` 하나다. `Image` 파라미터는
    그 앞에 `input:<파라미터>` 로드 노드가 붙고 `call`은 그 출력 링크를 받는다::

        {"nodal_version": <파일의 버전>,
         "id": <파일의 ID>,
         "definitions": <파일의 정의 전부>,
         "nodes": {"call": {"type": "subgraph.<id>", "inputs": <인자>}},
         "outputs": ["call"]}

    파일의 정의를 **통째로** 싣는 이유는 노출된 정의가 다른 정의를 중첩해 쓸 수
    있기 때문이고, 정의가 문서 안에 살아야 문서가 자기완결적이기 때문이다 (§5.5).

    이 함수는 인자를 **검증하지 않는다.** 필수 파라미터 누락과 타입 불일치는
    `validate_for_execution` 이 `GraphIssue` 로 답한다 (§5.5). 그 이슈의
    `node_id` 는 `CALL_NODE_ID` 이고 `socket` 이 곧 파라미터 이름이라, MCP 에러는
    **어느 인자인지** 그대로 지목할 수 있다 (§12.3).

    예외가 하나 있다 — `Image` 파라미터의 문자열 표현이다. 파일 경로는
    `image.Load`, `asset:<hash>`는 `image.LoadAsset` 노드로 바꾸고, 서브그래프에는
    둘 다 실제 `Image` 링크를 전달한다. `asset:`는 예약 접두이므로 다른 타입의
    파라미터에서 발견하면 명확히 거부한다.

    Raises:
        AssetReferenceParameterError: `Image`가 아닌 인자에 `asset:` 값이 있을 때.
    """
    inputs = dict(arguments)
    nodes: dict[str, Node] = {}
    _route_image_values(template, inputs, nodes)
    nodes[CALL_NODE_ID] = Node(
        type=f"subgraph.{template.id}",
        inputs=inputs,
    )
    return Graph(
        nodal_version=template.graph.nodal_version,
        id=template.graph.id,
        definitions=dict(template.graph.definitions),
        nodes=nodes,
        outputs=[CALL_NODE_ID],
    )


def collect_results(template: Template, record: RunRecord) -> dict[str, OutputRefModel]:
    """완료된 툴 실행의 공개 `returns` 이름으로 출력 참조를 조립한다 (§12.3).

    실행기가 만든 평탄화 매핑과 `OutputRef` 를 그대로 잇는다. 중첩 별칭을 여기서
    다시 해석하거나, MCP 전용 응답 표현을 만들지 않는다.
    """
    result = record.result
    if result is None:
        log.warning(
            "템플릿 %s 실행 %s 에 결과가 없어 returns 를 조립하지 않았다",
            template.id,
            record.run_id,
        )
        return {}

    socket_map = result.output_sockets.get(CALL_NODE_ID, {})
    collected: dict[str, OutputRefModel] = {}
    for name in template.definition.returns:
        target = socket_map.get(name)
        if target is None:
            log.warning(
                "템플릿 %s 실행 %s 의 return %s 에 평탄화 소켓 매핑이 없어 생략했다",
                template.id,
                record.run_id,
                name,
            )
            continue
        node_id, socket = target
        reference = next(
            (ref for ref in result.references.get(node_id, ()) if ref.socket == socket),
            None,
        )
        if reference is None:
            log.warning(
                "템플릿 %s 실행 %s 의 return %s 가 가리키는 %s.%s 참조가 없어 생략했다",
                template.id,
                record.run_id,
                name,
                node_id,
                socket,
            )
            continue
        collected[name] = output_refs((reference,))[0]
    return collected


def _route_image_values(
    template: Template,
    arguments: dict[str, Any],
    nodes: dict[str, Node],
) -> None:
    """MCP의 `Image` 문자열을 실제 이미지 출력 링크로 바꾼다 (§12.3).

    예약 접두 검사는 **타입이 아니라 값을 먼저** 본다. 그래야 `STRING`이나
    `List[...]` 안의 `asset:`가 다른 뜻으로 조용히 살아남지 않는다.
    """
    effective = {
        name: param.default
        for name, param in template.definition.params.items()
        if name not in arguments and param.default is not None
    }
    effective.update(arguments)
    for name, value in effective.items():
        refs = tuple(_asset_references(value))
        param = template.definition.params.get(name)
        is_image = param is not None and _is_image_param(param.type)

        if refs and not is_image:
            raise AssetReferenceParameterError(
                f"파라미터 {name!r} 의 값 {refs[0]!r} 는 예약된 에셋 참조지만 "
                "이 파라미터는 Image 로 선언되지 않았다 (design.md §12.3)"
            )
        if refs and is_image and not isinstance(value, str):
            raise AssetReferenceParameterError(
                f"Image 파라미터 {name!r} 는 경로 또는 asset:<hash> 문자열 하나를 받는다; "
                f"받은 에셋 참조: {refs[0]!r}"
            )
    for name, param in template.definition.params.items():
        if not _is_image_param(param.type):
            continue

        image_value: Any = arguments.get(name, param.default)
        if not isinstance(image_value, str):
            continue

        node_id = _image_input_node_id(name)
        if image_value.startswith(ASSET_PREFIX):
            nodes[node_id] = Node(
                type="image.LoadAsset",
                inputs={"asset_hash": image_value.removeprefix(ASSET_PREFIX)},
            )
        else:
            nodes[node_id] = Node(type="image.Load", inputs={"path": image_value})
        arguments[name] = Link.to(node_id, "image")


def _asset_references(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        if value.startswith(ASSET_PREFIX):
            yield value
        return
    if isinstance(value, list):
        for item in value:
            yield from _asset_references(item)


def _is_image_param(type_expr: Any) -> bool:
    parsed = parse_type_expr(type_expr)
    return isinstance(parsed, TensorType) and parsed.name == "Image"


def _image_input_node_id(name: str) -> str:
    """파라미터 귀속이 보이는 안정적인 노드 ID. 긴 이름은 그래프 상한에 맞춘다."""
    prefix = "input:"
    candidate = f"{prefix}{name}"
    if len(candidate) <= 64:
        return candidate
    suffix = hashlib.blake2b(name.encode("utf-8"), digest_size=6).hexdigest()
    stem_size = 64 - len(prefix) - len(suffix) - 1
    return f"{prefix}{name[:stem_size]}:{suffix}"


def _details(issues: Iterable[GraphIssue]) -> tuple[SchemaNote, ...]:
    """`GraphIssue` 를 거부 사유로 옮긴다. **위치를 잃지 않는다** — 템플릿을 고칠
    사람은 문서 어디가 문제인지 알아야 한다."""
    return tuple(SchemaNote(issue.location, f"[{issue.code}] {issue.message}") for issue in issues)


def format_rejections(rejections: Iterable[Rejection]) -> str:
    """서버 시작 로그용. 거부된 파일을 사람이 읽는 여러 줄로."""
    return "\n".join(rejection.describe() for rejection in rejections)
