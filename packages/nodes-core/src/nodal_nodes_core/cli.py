"""`nodal run graph.json` — CLI 실행기 (docs/roadmap.md M1).

M1 은 UI 도 GPU 도 없이 완성한다. 이 CLI 가 M1 의 유일한 사용자 인터페이스이고,
완료 기준("입력 하나를 바꾸면 그 아래만 재실행되는 것을 로그로 증명")을 눈으로
확인하는 도구다.

    nodal run examples/arithmetic.nodal.json
    nodal run graph.json --twice --set seed.value=6   # 캐시 무효화를 눈으로
    nodal nodes                                # 등록된 노드 목록
    nodal validate graph.json                  # 실행 없이 검증만
    nodal serve                                # 개발 서버 (M2)

설치된 1st-party 노드 팩은 모든 명령에서 자동으로 올라간다
(`DEFAULT_OPTIONAL_PACKS`). 서드파티 팩은 `--pack` 으로 이름을 댄다.

이 CLI 가 `packages/core` 가 아니라 노드 팩에 있는 이유: core 는 노드를 하나도
모른다. 실행하려면 레지스트리에 무언가 들어 있어야 하고, 그 "무언가"를 아는
것은 노드 패키지다 (AGENTS.md 아키텍처 절).
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from nodal import (
    Cache,
    Cancelled,
    CancelToken,
    Event,
    Graph,
    GraphValidationError,
    LRUCache,
    NodeCached,
    NodeDone,
    NodeError,
    NodeExecutionError,
    NodeProgress,
    NodeRegistry,
    NodeStarted,
    NullCache,
    RunResult,
    RunStarted,
    execute,
    parse_graph,
    validate_for_execution,
)

from . import register_all

__all__ = ["main"]


# ------------------------------------------------------------------ 출력

_DIM = "\033[2m"
_BOLD = "\033[1m"
_RED = "\033[31m"
_GREEN = "\033[32m"
_YELLOW = "\033[33m"
_BLUE = "\033[34m"
_RESET = "\033[0m"


def _supports_color() -> bool:
    return sys.stdout.isatty()


class ConsoleEventSink:
    """실행 이벤트를 사람이 읽는 로그로 찍는다.

    `node.cached` 와 `node.started` 를 다른 색·다른 기호로 보여주는 것이 요점이다.
    어느 노드가 재실행되고 어느 노드가 캐시로 스킵됐는지 눈에 보여야 캐시가
    마법이 아니라 이해 가능한 도구가 된다 (design.md §6).
    """

    def __init__(self, *, color: bool = True, verbose: bool = False) -> None:
        self._color = color
        self._verbose = verbose

    def _paint(self, text: str, code: str) -> str:
        return f"{code}{text}{_RESET}" if self._color else text

    def emit(self, event: Event) -> None:
        match event:
            case RunStarted():
                print(
                    self._paint(f"▶ 실행 시작 ({event.node_count}개 노드)", _BOLD),
                )
            case NodeStarted():
                print(f"  {self._paint('●', _YELLOW)} {event.node_id} 실행")
            case NodeCached():
                print(
                    f"  {self._paint('◌', _BLUE)} {event.node_id} "
                    f"{self._paint('캐시 히트 — 건너뜀', _DIM)}"
                )
            case NodeProgress():
                if self._verbose:
                    print(self._paint(f"    {event.node_id} {event.step}/{event.total}", _DIM))
            case NodeDone():
                if self._verbose:
                    # 출력은 값이 아니라 참조다 (design.md §6). 인라인이 없으면
                    # 아직 전송 수단이 없는 값이므로 타입만 보여준다.
                    values = ", ".join(
                        f"{ref.socket}={ref.inline!r}"
                        if ref.inline is not None
                        else f"{ref.socket}: {ref.type}"
                        for ref in event.outputs
                    )
                    print(self._paint(f"    → {values}", _DIM))
            case NodeError():
                print(f"  {self._paint('✗', _RED)} {event.node_id}: {event.message}")
            case _:
                pass


# ------------------------------------------------------------------ 명령


def _load_graph(path: Path) -> Graph:
    """캐논 문서를 읽는다. 에러는 어느 노드·어느 소켓인지 지목한다."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SystemExit(f"파일을 읽을 수 없다: {exc}") from exc
    return parse_graph(text)


#: 설치되어 있으면 모든 명령이 함께 올리는 1st-party 팩.
#:
#: **이것은 M6 의 팩 자동 발견이 아니다** — 이름이 여기 박혀 있고, 같은 워크스페이스에서
#: 함께 배포되는 팩뿐이다. 발견 규칙이 아니라 이 애플리케이션이 무엇으로 이루어져
#: 있는지에 대한 선언이다. 서드파티 팩은 여전히 `--pack` 으로만 들어온다.
#:
#: 모든 명령에 똑같이 적용하는 것이 요점이다. `nodes` 에는 보이는데 `run` 에서는
#: "등록되지 않은 노드 타입" 이 나거나, CLI 로는 되는데 브라우저 팔레트에는 없는
#: 상태가 가장 나쁘다 (docs/decisions.md 2026-08-16).
#:
#: `nodal_nodes_diffusion` 은 torch 없이도 import 된다 — 스키마만 노출하고
#: 실행할 때만 런타임을 요구한다. 그래서 여기 있어도 기본 설치가 무거워지지
#: 않는다 (루트 pyproject.toml 의 diffusion 그룹 주석).
DEFAULT_OPTIONAL_PACKS: tuple[str, ...] = ("nodal_nodes_image", "nodal_nodes_diffusion")


def _load_pack(registry: NodeRegistry, name: str) -> None:
    """팩 모듈을 import 해서 레지스트리에 붓는다."""
    module = importlib.import_module(name)
    factory = getattr(module, "registry", None)
    if not callable(factory):
        raise SystemExit(f"{name} 에 registry(into=...) 가 없다. 노드 팩이 맞나?")
    factory(into=registry)


def _build_registry(
    packs: Sequence[str] = (),
    *,
    optional_packs: Sequence[str] = (),
) -> NodeRegistry:
    """기본 노드 팩 + `--pack` 으로 지정한 팩들.

    팩은 **모듈 이름으로 늦게** import 한다. 그래야 `nodal-nodes-core` 가
    `nodal-nodes-image` 를 정적으로 의존하지 않는다 — 노드 팩끼리는 서로를 몰라야
    한다 (AGENTS.md 아키텍처 절). 팩 자동 발견은 M6 확장 시스템의 몫이고, 여기서는
    사용자가 이름을 대는 것까지만 한다.

    `optional_packs` 는 없으면 조용히 넘어간다 — 설치되지 않았을 수 있는 팩이다.
    `packs`(사용자가 명시한 것)는 반대로 없으면 실패해야 한다. 사용자가 이름을
    댔는데 조용히 무시하면 왜 노드가 없는지 알 수 없다.
    """
    registry = NodeRegistry()
    register_all(registry)
    for name in optional_packs:
        if name in packs:
            continue  # 사용자가 이미 명시했다
        try:
            _load_pack(registry, name)
        except ImportError:
            continue
    for name in packs:
        try:
            _load_pack(registry, name)
        except ImportError as exc:
            raise SystemExit(f"노드 팩을 import 할 수 없다: {name} ({exc})") from exc
    return registry


def _build_asset_store(root: Path | None) -> Any:
    """`--assets` 가 있으면 파일시스템 저장소를 만든다.

    `nodal_server` 를 **늦게** import 한다. `serve` 가 uvicorn 을 그렇게 하는 것과
    같은 이유다 — 서버는 `nodal-nodes-core[serve]` 선택적 extra 이고, 저장소 없이
    쓰는 사람에게 서버를 강제하지 않는다.
    """
    if root is None:
        return None
    try:
        from nodal_server.assets import FileAssetStore
    except ImportError as exc:  # pragma: no cover - extra 미설치 환경
        raise SystemExit(
            f"--assets 는 nodal-server 가 필요하다: pip install 'nodal-nodes-core[serve]' ({exc})"
        ) from exc
    return FileAssetStore(root)


def _apply_overrides(graph: Graph, overrides: Sequence[str]) -> Graph:
    """`--set node.socket=값` 을 그래프에 적용한 새 그래프를 만든다.

    원본 문서를 건드리지 않는다. 캐시 무효화 전파를 눈으로 보려면 리터럴 하나를
    바꿔 다시 실행하는 것이 가장 빠른 길이다.
    """
    if not overrides:
        return graph

    document: dict[str, Any] = json.loads(graph.to_json())
    for override in overrides:
        if "=" not in override or "." not in override.split("=", 1)[0]:
            raise SystemExit(f"--set 형식은 node.socket=값 이다: {override!r}")
        target, raw = override.split("=", 1)
        node_id, socket = target.rsplit(".", 1)

        if node_id not in document.get("nodes", {}):
            raise SystemExit(f"--set 이 가리킨 노드가 그래프에 없다: {node_id!r}")

        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            value = raw  # 따옴표 없는 문자열도 받아준다
        document["nodes"][node_id].setdefault("inputs", {})[socket] = value

    return parse_graph(document)


def _print_result(result: RunResult, *, color: bool) -> None:
    def paint(text: str, code: str) -> str:
        return f"{code}{text}{_RESET}" if color else text

    print()
    print(paint("결과", _BOLD))
    for node_id, outputs in result.outputs.items():
        for socket, value in outputs.items():
            print(f"  {node_id}.{socket} = {value!r}")
    if not result.outputs:
        print(paint("  (출력 없음)", _DIM))

    print()
    executed = paint(str(len(result.executed)), _YELLOW)
    cached = paint(str(len(result.cached)), _BLUE)
    summary = f"실행 {executed} · 캐시 {cached}"
    if result.blocked:
        summary += f" · 차단 {len(result.blocked)}"
    print(f"{summary} · {result.elapsed_ms}ms")
    if result.cached:
        print(paint(f"  캐시된 노드: {', '.join(result.cached)}", _DIM))


async def _run(args: argparse.Namespace) -> int:
    color = _supports_color() and not args.no_color
    registry = _build_registry(args.pack, optional_packs=DEFAULT_OPTIONAL_PACKS)
    graph = _load_graph(args.graph)
    overridden = _apply_overrides(graph, args.set or [])

    # --twice 는 같은 캐시로 두 번 돌린다. --set 이 함께 오면 2회차에만 적용해서
    # "입력 하나를 바꿨더니 그 아래만 재실행됐다"가 로그에 그대로 보이게 한다
    # (M1 완료 기준). --set 만 주면 처음부터 바뀐 그래프로 한 번 실행한다.
    runs = [graph, overridden] if args.twice else [overridden]

    outputs = args.output or list(graph.outputs)
    if not outputs:
        raise SystemExit(
            "실행할 출력 노드가 없다. 그래프의 `outputs` 를 채우거나 --output 을 주라."
        )

    cache: Cache = NullCache() if args.no_cache else LRUCache(args.cache_size)
    events = ConsoleEventSink(color=color, verbose=args.verbose)
    token = CancelToken()

    result: RunResult | None = None
    assets = _build_asset_store(getattr(args, "assets", None))
    for attempt, current in enumerate(runs):
        if attempt:
            changed = f" ({', '.join(args.set)} 적용)" if args.set else ""
            print()
            print(f"{_BOLD if color else ''}▶ 같은 캐시로 재실행{changed}{_RESET if color else ''}")
        result = await execute(
            current,
            outputs,
            registry=registry,
            cache=cache,
            events=events,
            cancel_token=token,
            assets=assets,
        )

    assert result is not None
    _print_result(result, color=color)
    return 0


def _validate(args: argparse.Namespace) -> int:
    registry = _build_registry(optional_packs=DEFAULT_OPTIONAL_PACKS)
    graph = _load_graph(args.graph)
    issues = validate_for_execution(graph, registry, list(graph.outputs))
    if not issues:
        print(f"유효한 그래프다. 노드 {len(graph.nodes)}개.")
        return 0
    print(f"검증 실패 ({len(issues)}건):")
    for issue in issues:
        print(f"  - {issue}")
    return 1


def _serve(args: argparse.Namespace) -> int:
    """개발 서버를 띄운다.

    여기가 **합성 지점**이다. `packages/server` 는 어떤 노드 팩도 import 하지
    않으므로 (의존성은 `server → core` 한 방향), 레지스트리를 채워 넘기는 일은
    노드를 아는 쪽이 한다.
    """
    try:
        import uvicorn

        from nodal_server.app import create_app
    except ImportError as exc:  # pragma: no cover — 설치 안내 경로
        raise SystemExit(
            "서버 의존성이 없다. `uv sync --extra serve` 또는 "
            "`pip install nodal-nodes-core[serve]` 를 실행하라."
        ) from exc

    registry = _build_registry(args.pack, optional_packs=DEFAULT_OPTIONAL_PACKS)
    app = create_app(registry, assets_root=args.assets)

    # flush=True — uvicorn 은 stderr 로 로그를 내보내고, 파이프로 받으면 stdout 은
    # 블록 버퍼링된다. 그대로 두면 이 두 줄이 uvicorn 출력보다 **뒤에** 찍혀서
    # 로그를 파일로 받은 사람에게는 순서가 뒤집힌 것처럼 보인다.
    print(f"노드 {len(registry)}개 등록. http://{args.host}:{args.port}/docs", flush=True)
    if args.assets is None:
        # 에셋이 메모리에만 있으면 서버를 끄는 순간 Save 결과가 사라진다.
        # 조용히 사라지는 것보다 시작할 때 말해 주는 편이 낫다.
        print("에셋 저장소: 메모리 (재시작하면 사라진다 — 남기려면 --assets DIR)", flush=True)
    else:
        print(f"에셋 저장소: {args.assets}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


def _nodes(args: argparse.Namespace) -> int:
    registry = _build_registry(args.pack, optional_packs=DEFAULT_OPTIONAL_PACKS)
    schemas = sorted(registry.search(args.query or "", limit=1000), key=lambda s: s.id)
    if not schemas:
        print(f"일치하는 노드가 없다: {args.query!r}")
        return 1

    for schema in schemas:
        inputs = ", ".join(
            f"{name}: {spec.type.describe()}" + ("" if spec.required else f" = {spec.default!r}")
            for name, spec in schema.inputs.items()
        )
        outputs = ", ".join(
            f"{name}: {spec.type.describe()}" for name, spec in schema.outputs.items()
        )
        flag = "  [출력 노드]" if schema.output_node else ""
        print(f"{schema.id}{flag}")
        print(f"  {schema.title} — {schema.doc.splitlines()[0] if schema.doc else ''}")
        print(f"  입력: {inputs or '(없음)'}")
        print(f"  출력: {outputs or '(없음)'}")
        if schema.aliases:
            print(f"  별칭: {', '.join(schema.aliases)}")
        print()
    return 0


# ------------------------------------------------------------------ 진입점


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nodal",
        description="nodal — 노드 그래프 실행기 (M1: CLI 전용)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="그래프를 실행한다")
    run.add_argument("graph", type=Path, help="캐논 그래프 JSON 파일")
    run.add_argument(
        "--output",
        action="append",
        help="실행할 출력 노드 ID. 여러 번 줄 수 있다. 기본은 그래프의 outputs",
    )
    run.add_argument(
        "--set",
        action="append",
        metavar="NODE.SOCKET=VALUE",
        help="리터럴 입력을 덮어쓴다. 캐시 무효화를 눈으로 보는 데 쓴다",
    )
    run.add_argument(
        "--twice",
        action="store_true",
        help="같은 캐시로 두 번 실행한다. 두 번째는 전부 캐시 히트여야 한다",
    )
    run.add_argument(
        "--pack",
        action="append",
        default=[],
        metavar="MODULE",
        help="추가 노드 팩 모듈 (예: nodal_nodes_image). 여러 번 쓸 수 있다",
    )
    run.add_argument(
        "--assets",
        type=Path,
        metavar="DIR",
        help="에셋 저장 디렉토리. Save 노드가 여기에 content-addressed 로 쓴다",
    )
    run.add_argument("--no-cache", action="store_true", help="캐시를 끈다")
    run.add_argument("--cache-size", type=int, default=128, help="LRU 캐시 크기")
    run.add_argument("-v", "--verbose", action="store_true", help="진행률과 출력값까지")
    run.add_argument("--no-color", action="store_true", help="색을 쓰지 않는다")
    run.set_defaults(handler=lambda args: asyncio.run(_run(args)))

    validate = sub.add_parser("validate", help="실행 없이 검증만 한다")
    validate.add_argument("graph", type=Path)
    validate.set_defaults(handler=_validate)

    serve = sub.add_parser("serve", help="개발 서버를 띄운다 (REST + WebSocket)")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8188)
    serve.add_argument("--log-level", default="info")
    serve.add_argument(
        "--pack",
        action="append",
        default=[],
        metavar="MODULE",
        help=(
            "추가 노드 팩 모듈. 설치되어 있으면 "
            f"{', '.join(DEFAULT_OPTIONAL_PACKS)} 는 지정하지 않아도 올라간다"
        ),
    )
    serve.add_argument(
        "--assets",
        type=Path,
        metavar="DIR",
        help="에셋 저장 디렉토리. 주지 않으면 메모리에만 두고 재시작 시 사라진다",
    )
    serve.set_defaults(handler=_serve)

    nodes = sub.add_parser("nodes", help="등록된 노드를 보여준다")
    nodes.add_argument("query", nargs="?", help="퍼지 검색어 (별칭·한글 포함)")
    nodes.add_argument(
        "--pack",
        action="append",
        default=[],
        metavar="MODULE",
        help="추가 노드 팩 모듈. 목록에 함께 보여준다",
    )
    nodes.set_defaults(handler=_nodes)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """`nodal` 진입점.

    에러는 트레이스백이 아니라 사람이 읽는 메시지로 나간다. 어느 노드의 어느
    소켓인지는 이미 예외가 알고 있다.
    """
    args = _parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except GraphValidationError as exc:
        print(f"\n{exc}", file=sys.stderr)
        return 1
    except NodeExecutionError as exc:
        print(f"\n노드 실행 실패 — {exc}", file=sys.stderr)
        return 1
    except Cancelled as exc:
        print(f"\n취소됨: {exc}", file=sys.stderr)
        return 130
    except KeyboardInterrupt:
        print("\n중단됨", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
