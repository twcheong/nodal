"""실행 큐와 REST 라우트.

브라우저 없이 M2 를 검증한다. 세 가지가 핵심이다:

1. 그래프를 큐에 넣으면 실제로 실행되고 결과가 REST 로 나온다
2. 같은 그래프를 다시 넣으면 캐시가 산다 (`cached` 가 채워진다)
3. 실행 중 `DELETE` 가 **실행 중인 노드까지** 멈춘다
"""

from __future__ import annotations

import time
from typing import Any

from conftest import simple_graph, slow_graph, wait_for
from fastapi.testclient import TestClient

# ------------------------------------------------------------------ 노드 · 검증


def test_nodes_endpoint_feeds_the_palette(client: TestClient) -> None:
    payload = client.get("/api/nodes").json()
    ids = [node["id"] for node in payload["nodes"]]
    assert ids == sorted(ids), "팔레트는 안정적인 순서로 나가야 한다"
    assert "test.Add" in ids
    assert payload["types_version"] == "1"

    add = next(node for node in payload["nodes"] if node["id"] == "test.Add")
    assert [socket["name"] for socket in add["inputs"]] == ["a", "b"], "선언 순서를 유지한다"
    assert [socket["name"] for socket in add["outputs"]] == ["sum"]
    assert add["inputs"][0]["type"] == "INT"
    assert add["aliases"] == ["더하기"]


def test_validate_accepts_a_good_graph(client: TestClient) -> None:
    response = client.post("/api/graph/validate", json={"graph": simple_graph()})
    assert response.status_code == 200
    assert response.json() == {"valid": True, "issues": []}


def test_validate_reports_issues_with_200(client: TestClient) -> None:
    """무효한 그래프도 200 이다 — 검증은 질의이지 명령이 아니다."""
    graph = simple_graph()
    graph["nodes"]["add"]["inputs"]["a"] = {"$link": ["c1", "nonexistent"]}

    response = client.post("/api/graph/validate", json={"graph": graph})
    assert response.status_code == 200

    payload = response.json()
    assert payload["valid"] is False
    (issue,) = payload["issues"]
    assert issue["code"] == "unknown_output_socket"
    assert issue["location"] == "nodes.add.inputs.a", "프론트가 이걸로 소켓을 지목한다"


# ------------------------------------------------------------------ 실행


def test_run_executes_and_returns_named_outputs(client: TestClient) -> None:
    created = client.post("/api/runs", json={"graph": simple_graph(2, 3)})
    assert created.status_code == 202
    run_id = created.json()["run_id"]
    assert created.json()["status"] == "queued"

    detail = wait_for(client, run_id)
    assert detail["status"] == "succeeded"
    assert detail["outputs"] == {
        "add": [{"socket": "sum", "type": "INT", "inline": 5, "asset": None}]
    }
    assert set(detail["executed"]) == {"c1", "c2", "add"}
    assert detail["cached"] == []
    assert detail["error"] is None
    assert detail["started_at"] and detail["finished_at"]


def test_second_run_hits_the_cache(client: TestClient) -> None:
    """캐시가 실행 경계를 넘어 산다. design.md §6 의 node.cached 근거."""
    first = client.post("/api/runs", json={"graph": simple_graph(4, 5)}).json()["run_id"]
    wait_for(client, first)

    second = client.post("/api/runs", json={"graph": simple_graph(4, 5)}).json()["run_id"]
    detail = wait_for(client, second)

    assert detail["status"] == "succeeded"
    assert detail["executed"] == [], "전부 캐시여야 한다"
    assert set(detail["cached"]) == {"c1", "c2", "add"}


def test_changed_input_reruns_only_descendants(client: TestClient) -> None:
    first = client.post("/api/runs", json={"graph": simple_graph(1, 2)}).json()["run_id"]
    wait_for(client, first)

    # c2 만 바꾼다. c1 은 그대로여야 한다.
    second = client.post("/api/runs", json={"graph": simple_graph(1, 99)}).json()["run_id"]
    detail = wait_for(client, second)

    assert detail["cached"] == ["c1"]
    assert set(detail["executed"]) == {"c2", "add"}


def test_use_cache_false_reruns_everything(client: TestClient) -> None:
    graph = simple_graph(7, 7)
    wait_for(client, client.post("/api/runs", json={"graph": graph}).json()["run_id"])

    payload = {"graph": graph, "use_cache": False}
    detail = wait_for(client, client.post("/api/runs", json=payload).json()["run_id"])

    assert detail["cached"] == []
    assert set(detail["executed"]) == {"c1", "c2", "add"}


def test_invalid_graph_is_rejected_before_queueing(client: TestClient) -> None:
    """큐 진입 전에 검증한다. 첫 노드를 돌리기 전에 실패시킨다."""
    graph = simple_graph()
    graph["nodes"]["ghost"] = {"type": "test.Nonexistent", "inputs": {}}
    graph["outputs"] = ["ghost"]

    response = client.post("/api/runs", json={"graph": graph})
    assert response.status_code == 422

    error = response.json()["detail"]["error"]
    assert error["code"] == "graph_invalid"
    assert any(issue["code"] == "unknown_node_type" for issue in error["issues"])


def test_node_failure_marks_the_run_failed(client: TestClient) -> None:
    graph = {
        "nodal_version": "1",
        "nodes": {"boom": {"type": "test.Boom", "inputs": {}}},
        "outputs": ["boom"],
    }
    run_id = client.post("/api/runs", json={"graph": graph}).json()["run_id"]
    detail = wait_for(client, run_id)
    assert detail["status"] == "failed"
    assert detail["error"]["code"] == "node_failed"
    assert "boom" in detail["error"]["message"], "어느 노드인지 지목해야 한다"


def test_unknown_run_is_404_with_the_shared_error_shape(client: TestClient) -> None:
    response = client.get("/api/runs/nope")
    assert response.status_code == 404
    assert response.json()["detail"]["error"]["code"] == "run_not_found"


# ------------------------------------------------------------------ 취소


def test_cancel_stops_a_running_node(client: TestClient) -> None:
    """이번 단계의 핵심 — CancelToken 이 큐를 거쳐 실행 중인 노드까지 닿는가."""
    run_id = client.post("/api/runs", json={"graph": slow_graph(300)}).json()["run_id"]

    # 실제로 실행이 시작될 때까지 기다린다.
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if client.get(f"/api/runs/{run_id}").json()["status"] == "running":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("실행이 시작되지 않았다")

    started = time.monotonic()
    response = client.delete(f"/api/runs/{run_id}")
    assert response.status_code == 200

    detail = wait_for(client, run_id, timeout=3.0)
    assert detail["status"] == "cancelled"
    # 300 스텝, 스텝당 10ms = 3초. 그 훨씬 전에 멈춰야 협조적 취소가 동작한 것이다.
    assert time.monotonic() - started < 1.0


def test_cancel_a_queued_run_never_executes_it(client: TestClient) -> None:
    """대기 중 취소. 토큰이 큐 진입 시점에 만들어지지 않으면 여기서 실패한다."""
    blocking = client.post("/api/runs", json={"graph": slow_graph(80)}).json()["run_id"]
    queued = client.post("/api/runs", json={"graph": simple_graph(8, 9)}).json()["run_id"]

    assert client.delete(f"/api/runs/{queued}").json()["status"] == "cancelled"

    client.delete(f"/api/runs/{blocking}")
    wait_for(client, blocking, timeout=3.0)

    detail = client.get(f"/api/runs/{queued}").json()
    assert detail["status"] == "cancelled"
    assert detail["executed"] == [], "실행된 적이 없어야 한다"


def test_cancelling_a_finished_run_keeps_its_status(client: TestClient) -> None:
    run_id = client.post("/api/runs", json={"graph": simple_graph()}).json()["run_id"]
    wait_for(client, run_id)
    assert client.delete(f"/api/runs/{run_id}").json()["status"] == "succeeded"


def test_cancel_unknown_run_is_404(client: TestClient) -> None:
    assert client.delete("/api/runs/nope").status_code == 404


# ------------------------------------------------------------------ 큐 목록


def test_run_list_separates_running_queued_and_history(client: TestClient) -> None:
    slow = client.post("/api/runs", json={"graph": slow_graph(60)}).json()["run_id"]
    later = client.post("/api/runs", json={"graph": simple_graph(3, 4)}).json()["run_id"]

    listing = client.get("/api/runs").json()
    assert listing["limit"] == 100
    ids = {entry["run_id"] for entry in listing["queued"]}
    assert later in ids or listing["running"]["run_id"] == later

    client.delete(f"/api/runs/{slow}")
    wait_for(client, slow, timeout=3.0)
    wait_for(client, later, timeout=3.0)

    history = {entry["run_id"] for entry in client.get("/api/runs").json()["history"]}
    assert {slow, later} <= history


def test_priority_runs_first(client: TestClient) -> None:
    blocking = client.post("/api/runs", json={"graph": slow_graph(40)}).json()["run_id"]
    low = client.post("/api/runs", json={"graph": simple_graph(1, 1), "priority": 0}).json()
    high = client.post("/api/runs", json={"graph": simple_graph(2, 2), "priority": 10}).json()

    order = [entry["run_id"] for entry in client.get("/api/runs").json()["queued"]]
    assert order.index(high["run_id"]) < order.index(low["run_id"])

    client.delete(f"/api/runs/{blocking}")
    for run_id in (blocking, high["run_id"], low["run_id"]):
        wait_for(client, run_id, timeout=3.0)


# ------------------------------------------------------- 모델 · 에셋 · 확장


def test_models_and_extensions_are_empty_but_present(client: TestClient) -> None:
    """M4·M6 까지는 비어 있다. '아직 없음'과 '엔드포인트 없음'은 다르다."""
    assert client.get("/api/models").json() == {"models": [], "kinds": []}
    assert client.get("/api/extensions").json() == {"loaded": [], "failed": []}


def test_asset_round_trip_is_content_addressed(client: TestClient) -> None:
    files: dict[str, Any] = {"file": ("cat.png", b"\x89PNG fake bytes", "image/png")}
    first = client.post("/api/assets", files=files).json()
    assert first["size_bytes"] == 15
    assert first["media_type"] == "image/png"

    again = client.post("/api/assets", files=files).json()
    assert again["hash"] == first["hash"], "같은 내용이면 같은 해시다"

    fetched = client.get(f"/api/assets/{first['hash']}")
    assert fetched.content == b"\x89PNG fake bytes"
    assert fetched.headers["content-type"] == "image/png"


def test_unknown_asset_is_404(client: TestClient) -> None:
    response = client.get("/api/assets/deadbeef")
    assert response.status_code == 404
    assert response.json()["detail"]["error"]["code"] == "asset_not_found"
