"""확장 로더 — 서드파티 노드 팩 발견 (docs/design.md §8, M7.2).

확장은 `nodal serve` 와 **같은 프로세스로 import** 된다 (2026-08-26,
`decisions.md`). `uv` 격리는 설치 시점(의존성 해석·충돌 검출)까지고, 이
로더는 그 뒤 단계다 — 이미 설치된 파이썬 환경에서 매니페스트를 읽고 노드를
등록하는 일만 한다. 서브프로세스도 IPC 도 만들지 않는다.

디렉토리 하나가 발견 경로다::

    ~/.nodal/extensions/<pack>/
    ├── nodal.toml               # 매니페스트 (필수)
    ├── nodes/*.py                # @node 데코레이터 (선택)
    ├── templates/*.nodal.json    # §12.8 카탈로그에 합류하는 템플릿 (선택)
    └── web/index.js              # 프론트 ESM 엔트리 (선택). 존재 여부만 이
                                   # 로더가 본다 — 실제로 내보내는 것은
                                   # `nodal_server.app` 의 정적 라우트다 (§8)

확장 하나가 예외를 던져도 나머지는 로드된다 — 템플릿 카탈로그가 파일 하나의
실패로 전체를 잃지 않는 것과 같은 규칙이다 (`nodal_server.templates`).
"""

from __future__ import annotations

import importlib.util
import logging
import re
import sys
import tomllib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from .registry import NodeRegistry

__all__ = [
    "EXTENSION_ID_RE",
    "MANIFEST_FILE",
    "NODAL_API_VERSION",
    "ExtensionRecord",
    "ExtensionsResult",
    "default_extensions_dir",
    "format_extension_failures",
    "is_api_compatible",
    "load_extensions",
    "parse_caret_range",
]

log = logging.getLogger(__name__)

#: 매니페스트 파일명 (design.md §8).
MANIFEST_FILE: Final = "nodal.toml"

#: 확장 ID. §8 예시(`com.example.my-pack`)가 역-DNS 스타일이라 점을 허용한다 —
#: 템플릿 ID(`nodal_server.templates.TEMPLATE_ID_RE`)와 달리 파일시스템 이름이
#: 아니라 매니페스트 안의 값이라 대소문자 충돌 문제가 없다.
EXTENSION_ID_RE: Final = re.compile(r"^[a-z][a-z0-9_.-]*$")

#: 이 서버가 구현하는 **확장 API 계약** 버전 — 패키지 릴리스 버전
#: (`nodal.__version__`, 아직 `0.0.0`)과는 별개다. 확장 호환성 계약은 배포
#: 버전과 다른 속도로 움직인다. 첫 서드파티 계약은 안정화 전 버전인 0.1.0
#: 에서 시작한다 (2026-08-27 사용자 승인 — decisions.md).
NODAL_API_VERSION: Final[tuple[int, int, int]] = (0, 1, 0)


@dataclass(frozen=True, slots=True)
class ExtensionRecord:
    """로드됐거나 실패한 확장 하나 (`GET /api/extensions` 의 소스, design.md §8)."""

    id: str
    name: str
    version: str
    nodal_api: str
    root: Path
    node_count: int = 0
    templates_dir: Path | None = None
    #: `web/index.js` 가 있을 때만 채운다 — 서버가 이 값의 유무로 `ExtensionInfo`
    #: 의 `web_entry_url` 을 null 로 낼지 정한다 (design.md §8). 값은 `web/`
    #: 서브트리 전체를 가리킨다: 엔트리 하나만 내면 그 엔트리가 import 하는
    #: 형제 파일이 깨지므로, 서버는 이 디렉토리 밑을 통째로 낸다.
    web_dir: Path | None = None
    error: str | None = None

    @property
    def loaded(self) -> bool:
        return self.error is None

    def describe(self) -> str:
        return f"{self.root.name}: {self.error}"


@dataclass(frozen=True, slots=True)
class ExtensionsResult:
    """`~/.nodal/extensions` 한 디렉토리를 읽은 결과."""

    root: Path
    loaded: tuple[ExtensionRecord, ...] = ()
    failed: tuple[ExtensionRecord, ...] = ()

    @property
    def template_sources(self) -> tuple[tuple[str, Path], ...]:
        """`templates/` 를 가진 로드된 확장들. id 순 — 결정적 우선순위 (§12.8).

        `nodal_server.templates.load_catalog` 의 `extension_sources` 가 그대로
        받는 모양이다.
        """
        pairs = [
            (rec.id, rec.templates_dir) for rec in self.loaded if rec.templates_dir is not None
        ]
        pairs.sort(key=lambda pair: pair[0])
        return tuple(pairs)


def default_extensions_dir() -> Path:
    """`~/.nodal/extensions`. 발견 경로는 이것 하나다 (§12.8 과 같은 원칙)."""
    return Path.home() / ".nodal" / "extensions"


def load_extensions(registry: NodeRegistry, root: Path | None = None) -> ExtensionsResult:
    """디렉토리 하나를 읽어 노드를 등록한다. 예외를 던지지 않는다.

    확장 하나가 예외를 던져도 나머지는 로드된다 — 실패는 `failed` 로 간다.
    노드 등록은 `NodeRegistry.register` 하나뿐이다 — 두 번째 등록 경로를
    만들지 않는다.
    """
    root = default_extensions_dir() if root is None else root
    if not root.is_dir():
        log.info("확장 디렉토리가 없다: %s (확장 0개로 시작한다)", root)
        return ExtensionsResult(root)

    loaded: list[ExtensionRecord] = []
    failed: list[ExtensionRecord] = []
    for ext_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        record = _load_one(registry, ext_dir)
        if record.loaded:
            loaded.append(record)
            log.info(
                "확장 로드: %s v%s (%s) — 노드 %d개",
                record.id,
                record.version,
                ext_dir,
                record.node_count,
            )
        else:
            failed.append(record)
            log.warning("확장 로드 실패 — %s", record.describe())

    log.info("확장 %d개 로드, %d개 실패 (%s)", len(loaded), len(failed), root)
    return ExtensionsResult(root, tuple(loaded), tuple(failed))


def _load_one(registry: NodeRegistry, ext_dir: Path) -> ExtensionRecord:
    manifest_path = ext_dir / MANIFEST_FILE
    if not manifest_path.is_file():
        return _failure(ext_dir, error=f"{MANIFEST_FILE} 이 없다")

    try:
        data: dict[str, Any] = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        return _failure(ext_dir, error=f"{MANIFEST_FILE} 을 읽지 못했다 — {exc}")

    section = data.get("extension")
    if not isinstance(section, dict):
        return _failure(ext_dir, error="[extension] 섹션이 없다")

    raw_id: Any = section.get("id")
    name = str(section.get("name") or raw_id or ext_dir.name)
    version = str(section.get("version") or "")
    nodal_api: Any = section.get("nodal_api")

    if not isinstance(raw_id, str) or not EXTENSION_ID_RE.match(raw_id):
        return _failure(
            ext_dir,
            name=name,
            version=version,
            nodal_api=str(nodal_api or ""),
            error=(
                f"extension.id 가 없거나 형식에 맞지 않는다: {raw_id!r} ({EXTENSION_ID_RE.pattern})"
            ),
        )
    ext_id: str = raw_id

    if not isinstance(nodal_api, str) or not nodal_api.strip():
        return _failure(
            ext_dir,
            id_=ext_id,
            name=name,
            version=version,
            nodal_api="",
            error="nodal_api 범위 선언이 없다 — 로드 거부 (design.md §8)",
        )

    try:
        lower, upper = parse_caret_range(nodal_api)
    except ValueError as exc:
        return _failure(
            ext_dir,
            id_=ext_id,
            name=name,
            version=version,
            nodal_api=nodal_api,
            error=f"nodal_api 범위를 해석할 수 없다: {nodal_api!r} — {exc}",
        )

    if not (lower <= NODAL_API_VERSION < upper):
        return _failure(
            ext_dir,
            id_=ext_id,
            name=name,
            version=version,
            nodal_api=nodal_api,
            error=(
                f"nodal_api 범위 {nodal_api!r} 가 이 서버의 API 버전 "
                f"{_format_version(NODAL_API_VERSION)} 을 포함하지 않는다 "
                f"(허용 범위: >={_format_version(lower)}, <{_format_version(upper)})"
            ),
        )

    nodes_dir = ext_dir / "nodes"
    node_count = 0
    if nodes_dir.is_dir():
        try:
            node_count = _load_node_files(registry, ext_id, nodes_dir)
        except Exception as exc:  # 확장 코드는 무엇이든 던질 수 있다 — 나머지는 계속 로드한다
            return _failure(
                ext_dir,
                id_=ext_id,
                name=name,
                version=version,
                nodal_api=nodal_api,
                error=f"nodes/ 로드 중 예외 — {exc!r}",
            )

    templates_dir = ext_dir / "templates"
    web_dir = ext_dir / "web"
    return ExtensionRecord(
        id=ext_id,
        name=name,
        version=version,
        nodal_api=nodal_api,
        root=ext_dir,
        node_count=node_count,
        templates_dir=templates_dir if templates_dir.is_dir() else None,
        # index.js 가 없으면 서빙할 진입점이 없다 — 서브트리 자체는 있어도 null.
        web_dir=web_dir if (web_dir / "index.js").is_file() else None,
    )


def _failure(
    ext_dir: Path,
    *,
    error: str,
    id_: str | None = None,
    name: str | None = None,
    version: str = "",
    nodal_api: str = "",
) -> ExtensionRecord:
    return ExtensionRecord(
        id=id_ or ext_dir.name,
        name=name or ext_dir.name,
        version=version,
        nodal_api=nodal_api,
        root=ext_dir,
        error=error,
    )


def _load_node_files(registry: NodeRegistry, ext_id: str, nodes_dir: Path) -> int:
    """`nodes/*.py` 를 늦게 import 하고 `@node` 클래스를 등록한다.

    파일마다 고유한 모듈 이름을 만든다 — 서로 다른 확장이 같은 파일명
    (`nodes.py`)을 써도 `sys.modules` 에서 부딪치지 않는다.

    등록은 `NodeRegistry.register` 하나뿐이다 — 노드 팩이 `registry(into=...)`
    를 거쳐 등록하는 것과 최종적으로 같은 경로다. 여기서는 그 팩토리 함수
    대신 `@node` 가 붙인 `__nodal_schema__` 마커로 클래스를 찾을 뿐이다.
    """
    node_classes: list[type] = []
    module_names: list[str] = []
    try:
        for index, path in enumerate(sorted(nodes_dir.glob("*.py"))):
            if path.stem.startswith("_"):
                continue
            module_name = f"_nodal_ext__{_slug(ext_id)}__{index}__{_slug(path.stem)}"
            spec = importlib.util.spec_from_file_location(module_name, path)
            if spec is None or spec.loader is None:
                raise ImportError(f"{path} 를 모듈로 로드할 수 없다")
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            module_names.append(module_name)
            spec.loader.exec_module(module)
            node_classes.extend(
                obj
                for obj in vars(module).values()
                if isinstance(obj, type) and "__nodal_schema__" in obj.__dict__
            )

        # 공유 레지스트리를 건드리기 전에 기존 노드와 확장 내부의 중복을 모두
        # 검증한다. 실제 반영은 이 검증이 끝난 뒤 한 번만 일어나므로 확장이
        # failed 로 기록되면서 일부 노드만 남는 상태가 없다.
        staged = NodeRegistry(tuple(registry.schemas().values()))
        staged.register_all(node_classes)
        registry.register_all(node_classes)
    except Exception:
        for module_name in module_names:
            sys.modules.pop(module_name, None)
        raise
    return len(node_classes)


def _slug(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_") or "x"


_SEMVER_RE = re.compile(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?$")


def parse_caret_range(spec: str) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    """캐럿(`^`) semver 범위만 지원한다 — `design.md` §8 예시가 그것뿐이다.

    다른 문법(`>=`·`~`·콤마 범위)은 지원하지 않고 `ValueError` 로 명확히
    거부한다 (2026-08-27, 스펙이 캐럿 예시만 준 데 대한 임의 해석 —
    decisions.md).

    npm 의 캐럿 규칙을 따르며, 생략한 구성요소는 그 자리 전체를 허용한다:

    - ``^1.2.3`` → ``>=1.2.3, <2.0.0``
    - ``^0.2.3`` → ``>=0.2.3, <0.3.0``
    - ``^0.0.3`` → ``>=0.0.3, <0.0.4``
    - ``^0.0`` → ``>=0.0.0, <0.1.0``
    - ``^0`` → ``>=0.0.0, <1.0.0``

    Returns:
        ``(하한(포함), 상한(제외))``.
    """
    text = spec.strip()
    if not text.startswith("^"):
        raise ValueError(f"캐럿(^) 범위만 지원한다: {spec!r}")
    version_text = text[1:]
    lower = _parse_version(version_text)
    component_count = version_text.count(".") + 1
    major, minor, patch = lower
    if major > 0:
        upper = (major + 1, 0, 0)
    elif component_count == 1:
        upper = (1, 0, 0)
    elif minor > 0 or component_count == 2:
        upper = (0, minor + 1, 0)
    else:
        upper = (0, 0, patch + 1)
    return lower, upper


def is_api_compatible(spec: str, version: tuple[int, int, int]) -> bool:
    """`version` 이 `spec`(캐럿 범위) 안에 있는가.

    범위의 **양쪽 다** 검사한다 — 하한만 맞는 조건은 상한을 넘은 버전도
    통과시킨다. M6 에서 `PREVIEW_MAX_EDGE` 를 한쪽만 테스트해 "512 이하에서만
    동작하는 수정"이 초록으로 통과한 적이 있다 (M7.2 지시) — 같은 실수를
    여기서 반복하지 않는다.
    """
    lower, upper = parse_caret_range(spec)
    return lower <= version < upper


def _parse_version(text: str) -> tuple[int, int, int]:
    match = _SEMVER_RE.match(text)
    if not match:
        raise ValueError(f"버전 형식이 아니다 (X.Y.Z): {text!r}")
    major, minor, patch = match.groups()
    return (int(major), int(minor or 0), int(patch or 0))


def _format_version(version: tuple[int, int, int]) -> str:
    return ".".join(str(part) for part in version)


def format_extension_failures(failed: Iterable[ExtensionRecord]) -> str:
    """서버 시작 로그용. 실패한 확장을 사람이 읽는 여러 줄로.

    `nodal_server.templates.format_rejections` 와 같은 모양이다.
    """
    return "\n".join(record.describe() for record in failed)
