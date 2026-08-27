"""`GET /api/extensions` — 확장 로더 결과를 그대로 보여준다 (design.md §8, M7.2).

`create_app` 은 확장을 스스로 로드하지 않는다 — `registry` 와 같은 이유로
호출자가 이미 계산한 `ExtensionsResult` 를 넘긴다. 여기서는 그 결과가
`ExtensionInfo` 로 정확히 옮겨지는지만 본다. 실제 로더(파일을 읽고 노드를
등록하는 부분)는 `packages/core/tests/test_extensions.py` 의 몫이다.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

from fastapi.testclient import TestClient

from nodal import ExtensionRecord, ExtensionsResult, NodeRegistry, load_extensions
from nodal_server.app import create_app


def test_no_extensions_result_reports_empty(tmp_path: Path) -> None:
    with TestClient(create_app(NodeRegistry())) as client:
        assert client.get("/api/extensions").json() == {"loaded": [], "failed": []}


def test_loaded_and_failed_extensions_are_both_reported(tmp_path: Path) -> None:
    result = ExtensionsResult(
        root=tmp_path,
        loaded=(
            ExtensionRecord(
                id="com.example.good",
                name="Good Pack",
                version="0.1.0",
                nodal_api="^0.1",
                root=tmp_path / "good-pack",
                node_count=3,
            ),
        ),
        failed=(
            ExtensionRecord(
                id="com.example.bad",
                name="Bad Pack",
                version="0.0.1",
                nodal_api="^99.0",
                root=tmp_path / "bad-pack",
                error="nodal_api 범위 불일치",
            ),
        ),
    )

    with TestClient(create_app(NodeRegistry(), extensions=result)) as client:
        body = client.get("/api/extensions").json()

    assert len(body["loaded"]) == 1
    loaded = body["loaded"][0]
    assert loaded["id"] == "com.example.good"
    assert loaded["node_count"] == 3
    assert loaded["loaded"] is True
    assert loaded["error"] is None

    assert len(body["failed"]) == 1
    failed = body["failed"][0]
    assert failed["id"] == "com.example.bad"
    assert failed["loaded"] is False
    assert failed["error"] == "nodal_api 범위 불일치"


# ------------------------------------------ 완료 증거: 실제 확장 둘, 끝까지 (M7.2)


_GOOD_NODE_SOURCE = textwrap.dedent("""\
    from nodal import Int, NodeResult, node


    @node(id="acceptance_ext.Double", title="Double", category="test")
    class Double:
        value: Int = Int(0)
        returns = {"value": Int}

        def run(self, value: int) -> NodeResult:
            return NodeResult(value * 2)
    """)


def _write_extension(
    ext_dir: Path, *, ext_id: str, nodal_api: str, node_source: str | None
) -> None:
    ext_dir.mkdir(parents=True)
    (ext_dir / "nodal.toml").write_text(
        textwrap.dedent(f"""\
            [extension]
            id = "{ext_id}"
            name = "{ext_id}"
            version = "0.1.0"
            nodal_api = "{nodal_api}"
            """),
        encoding="utf-8",
    )
    if node_source is not None:
        (ext_dir / "nodes").mkdir()
        (ext_dir / "nodes" / "main.py").write_text(node_source, encoding="utf-8")


def test_one_good_one_broken_extension_end_to_end(tmp_path: Path) -> None:
    """M7.2 완료 증거: 정상 확장 하나 · 일부러 깨진 확장 하나.

    `GET /api/extensions` 가 loaded 에 하나 · failed 에 하나를 사유와 함께
    보여주고, 정상 확장의 노드가 `GET /api/nodes` 에 나오는지까지 본다.
    """
    ext_root = tmp_path / "extensions"
    _write_extension(
        ext_root / "good-pack",
        ext_id="com.example.good",
        nodal_api="^0.1",
        node_source=_GOOD_NODE_SOURCE,
    )
    _write_extension(
        ext_root / "broken-pack",
        ext_id="com.example.broken",
        nodal_api="^1.0",  # 이 서버의 NODAL_API_VERSION (0.1.0) 을 포함하지 않는다
        node_source=None,
    )

    registry = NodeRegistry()
    ext_result = load_extensions(registry, ext_root)

    with TestClient(create_app(registry, extensions=ext_result)) as client:
        extensions_body = client.get("/api/extensions").json()
        nodes_body = client.get("/api/nodes").json()

    assert [item["id"] for item in extensions_body["loaded"]] == ["com.example.good"]
    assert extensions_body["loaded"][0]["node_count"] == 1

    assert len(extensions_body["failed"]) == 1
    failed = extensions_body["failed"][0]
    assert failed["id"] == "com.example.broken"
    assert failed["loaded"] is False
    assert "nodal_api" in failed["error"]

    node_ids = [node["id"] for node in nodes_body["nodes"]]
    assert "acceptance_ext.Double" in node_ids
