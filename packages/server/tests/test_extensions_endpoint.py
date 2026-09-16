"""`GET /api/extensions` — 확장 로더 결과를 그대로 보여준다 (design.md §8, M7.2).

`create_app` 은 확장을 스스로 로드하지 않는다 — `registry` 와 같은 이유로
호출자가 이미 계산한 `ExtensionsResult` 를 넘긴다. 여기서는 그 결과가
`ExtensionInfo` 로 정확히 옮겨지는지만 본다. 실제 로더(파일을 읽고 노드를
등록하는 부분)는 `packages/core/tests/test_extensions.py` 의 몫이다.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
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


# ------------------------------------------------------- web/ 서브트리 (M7.2.1)
#
# "서버가 URL 을 준다. 프론트는 조립하지 않는다." — `web_entry_url` 은 이미
# 완성된 `/api/...` 경로다. 프론트가 id 로 URL 을 다시 만들지 않는다는 계약을
# 여기서 잠근다.


def test_web_entry_url_is_null_without_index_js() -> None:
    result = ExtensionsResult(
        root=Path("/tmp/nowhere"),
        loaded=(
            ExtensionRecord(
                id="com.example.no_web",
                name="No Web",
                version="0.1.0",
                nodal_api="^0.1",
                root=Path("/tmp/nowhere/no-web"),
            ),
        ),
    )
    with TestClient(create_app(NodeRegistry(), extensions=result)) as client:
        body = client.get("/api/extensions").json()
    assert body["loaded"][0]["web_entry_url"] is None


def _write_web_extension(ext_dir: Path, *, ext_id: str) -> None:
    ext_dir.mkdir(parents=True)
    (ext_dir / "nodal.toml").write_text(
        textwrap.dedent(f"""\
            [extension]
            id = "{ext_id}"
            name = "{ext_id}"
            version = "0.1.0"
            nodal_api = "^0.1"
            """),
        encoding="utf-8",
    )
    web = ext_dir / "web"
    web.mkdir()
    (web / "index.js").write_text(
        "import { greet } from './helper.js';\nexport default greet;\n", encoding="utf-8"
    )
    (web / "helper.js").write_text("export function greet() { return 'hi'; }\n", encoding="utf-8")


def test_web_entry_url_is_server_assembled_and_frontend_imports_it_verbatim(
    tmp_path: Path,
) -> None:
    ext_root = tmp_path / "extensions"
    _write_web_extension(ext_root / "widget-pack", ext_id="com.example.widget")

    registry = NodeRegistry()
    ext_result = load_extensions(registry, ext_root)

    with TestClient(create_app(registry, extensions=ext_result)) as client:
        body = client.get("/api/extensions").json()
        entry_url = body["loaded"][0]["web_entry_url"]
        assert entry_url == "/api/extensions/com.example.widget/web/index.js"

        entry_response = client.get(entry_url)
        assert entry_response.status_code == 200
        assert entry_response.headers["content-type"].split(";")[0] == "text/javascript"
        assert "./helper.js" in entry_response.text


def test_web_subtree_serves_sibling_files_not_just_the_entry(tmp_path: Path) -> None:
    """엔트리만 내면 확장 저자가 파일을 쪼개는 순간 깨진다 — 형제 파일도 풀린다."""
    ext_root = tmp_path / "extensions"
    _write_web_extension(ext_root / "widget-pack", ext_id="com.example.widget")

    registry = NodeRegistry()
    ext_result = load_extensions(registry, ext_root)

    with TestClient(create_app(registry, extensions=ext_result)) as client:
        response = client.get("/api/extensions/com.example.widget/web/helper.js")

    assert response.status_code == 200
    assert response.headers["content-type"].split(";")[0] == "text/javascript"
    assert "greet" in response.text


def test_web_asset_rejects_dot_dot_path_escape(tmp_path: Path) -> None:
    ext_root = tmp_path / "extensions"
    ext_dir = ext_root / "widget-pack"
    _write_web_extension(ext_dir, ext_id="com.example.widget")
    # web/ 형제 자리에 있는 매니페스트 — web/ 밖으로 나가야만 닿는다.
    secret = ext_dir / "nodal.toml"
    assert secret.is_file()

    registry = NodeRegistry()
    ext_result = load_extensions(registry, ext_root)

    with TestClient(create_app(registry, extensions=ext_result)) as client:
        # `%2e%2e` 는 URL 정규화 단계에서 점-세그먼트로 접히지 않고 그대로
        # 서버까지 와서 디코드된다 — 여기서도 막히는지 본다.
        response = client.get("/api/extensions/com.example.widget/web/%2e%2e/nodal.toml")

    assert response.status_code == 404


def test_web_asset_rejects_symlink_escape(tmp_path: Path) -> None:
    ext_root = tmp_path / "extensions"
    ext_dir = ext_root / "widget-pack"
    _write_web_extension(ext_dir, ext_id="com.example.widget")

    outside_secret = tmp_path / "outside-secret.txt"
    outside_secret.write_text("shh", encoding="utf-8")
    try:
        (ext_dir / "web" / "escape.js").symlink_to(outside_secret)
    except OSError as exc:
        if getattr(exc, "winerror", None) == 1314:
            pytest.skip("Windows requires Developer Mode or symlink privileges for this test")
        raise

    registry = NodeRegistry()
    ext_result = load_extensions(registry, ext_root)

    with TestClient(create_app(registry, extensions=ext_result)) as client:
        response = client.get("/api/extensions/com.example.widget/web/escape.js")

    assert response.status_code == 404


def test_web_asset_is_not_served_for_a_failed_extension(tmp_path: Path) -> None:
    """loaded=True 인 확장만 낸다 — 실패한 확장의 파일을 내보내면 배너와 실행이 어긋난다."""
    ext_root = tmp_path / "extensions"
    ext_dir = ext_root / "widget-pack"
    _write_web_extension(ext_dir, ext_id="com.example.widget")
    # nodal_api 범위를 이 서버가 거부하도록 덮어써 로드를 실패시킨다.
    (ext_dir / "nodal.toml").write_text(
        textwrap.dedent("""\
            [extension]
            id = "com.example.widget"
            name = "com.example.widget"
            version = "0.1.0"
            nodal_api = "^99.0"
            """),
        encoding="utf-8",
    )

    registry = NodeRegistry()
    ext_result = load_extensions(registry, ext_root)
    assert ext_result.loaded == ()
    assert len(ext_result.failed) == 1

    with TestClient(create_app(registry, extensions=ext_result)) as client:
        response = client.get("/api/extensions/com.example.widget/web/index.js")

    assert response.status_code == 404


def test_web_asset_unknown_extension_id_is_404(tmp_path: Path) -> None:
    with TestClient(create_app(NodeRegistry())) as client:
        response = client.get("/api/extensions/com.example.nope/web/index.js")
    assert response.status_code == 404


def test_web_asset_content_type_for_non_js_file_is_guessed(tmp_path: Path) -> None:
    ext_root = tmp_path / "extensions"
    ext_dir = ext_root / "widget-pack"
    _write_web_extension(ext_dir, ext_id="com.example.widget")
    (ext_dir / "web" / "style.css").write_text("body { color: red; }\n", encoding="utf-8")

    registry = NodeRegistry()
    ext_result = load_extensions(registry, ext_root)

    with TestClient(create_app(registry, extensions=ext_result)) as client:
        response = client.get("/api/extensions/com.example.widget/web/style.css")

    assert response.status_code == 200
    assert response.headers["content-type"].split(";")[0] == "text/css"
