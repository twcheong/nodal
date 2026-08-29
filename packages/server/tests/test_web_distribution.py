"""M7.5 패키지 런처가 빌드된 웹 앱을 같은 서버에서 내는 경로."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nodal import NodeRegistry
from nodal_server.app import create_app


def test_built_web_is_served_without_hiding_api(tmp_path: Path) -> None:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<main>nodal packaged web</main>", encoding="utf-8")
    (tmp_path / "assets" / "app.js").write_text("export const ready = true;\n", encoding="utf-8")

    with TestClient(create_app(NodeRegistry(), web_root=tmp_path)) as client:
        assert client.get("/").text == "<main>nodal packaged web</main>"
        script = client.get("/assets/app.js")
        nodes = client.get("/api/nodes")

    assert script.status_code == 200
    assert script.headers["content-type"].startswith("text/javascript")
    assert nodes.status_code == 200
    assert nodes.json()["nodes"] == []


def test_built_web_rejects_missing_files_and_path_escape(tmp_path: Path) -> None:
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("nodal", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")

    with TestClient(create_app(NodeRegistry(), web_root=web)) as client:
        missing = client.get("/missing.js")
        escaped = client.get("/%2E%2E/secret.txt")

    assert missing.status_code == 404
    assert escaped.status_code == 404
    assert escaped.json()["error"]["code"] == "web_asset_not_found"
    assert escaped.text != "secret"


def test_built_web_requires_index(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match=r"index\.html"):
        create_app(NodeRegistry(), web_root=tmp_path)
