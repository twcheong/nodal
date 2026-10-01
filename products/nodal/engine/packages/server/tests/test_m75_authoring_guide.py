"""M7.5 완료 증거: 가이드 예제를 설치 경로에서 읽어 API에 노출한다."""

import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from nodal import NodeRegistry, load_extensions
from nodal_server.app import create_app


def test_guide_node_pack_appears_in_api_nodes(tmp_path: Path) -> None:
    repository = Path(__file__).parents[3]
    source = repository / "examples" / "extensions" / "guide-pack"
    extension_root = tmp_path / ".nodal" / "extensions"
    shutil.copytree(source, extension_root / "guide-pack")

    registry = NodeRegistry()
    extensions = load_extensions(registry, extension_root)
    with TestClient(create_app(registry, extensions=extensions)) as client:
        extension_body = client.get("/api/extensions").json()
        node_body = client.get("/api/nodes").json()

    assert [item["id"] for item in extension_body["loaded"]] == ["com.example.guide-pack"]
    assert extension_body["loaded"][0]["node_count"] == 1
    assert "guide.InvertBoolean" in {item["id"] for item in node_body["nodes"]}


def test_guide_preserves_transport_but_rejects_an_invented_widget_api() -> None:
    repository = Path(__file__).parents[3]
    guide = (repository / "docs" / "node-authoring.md").read_text(encoding="utf-8")

    assert "서버가 완성된 URL을 주고" in guide
    assert "ESM으로 평가" in guide
    assert "같은 UI 배너" in guide
    assert "커스텀 위젯은 아직 저작할 수 없다" in guide
    assert "`globalThis`" in guide
    assert "지원되는 방법도 호환성 계약도 아니다" in guide
