"""WebSocket 브로드캐스트 (`/ws`).

프론트가 이 스트림 하나로 캔버스를 칠한다. 확인할 것:

1. 이벤트가 design.md §6 순서로 나오는가
2. **`node.cached` 가 실제로 나가는가** — 캐시 히트 색칠의 근거다
3. 여러 클라이언트가 같은 스트림을 받는가
4. 한 클라이언트가 끊겨도 실행이 죽지 않는가
5. 모든 메시지가 `WsEvent` 계약을 만족하는가
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from conftest import simple_graph, slow_graph, wait_for
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from nodal import NodeRegistry
from nodal_server.app import create_app
from nodal_server.schemas import WsEvent

_EVENTS: TypeAdapter[Any] = TypeAdapter(WsEvent)


def drain(socket: Any, *, until: str, timeout: float = 5.0) -> list[dict[str, Any]]:
    """`until` 이벤트가 나올 때까지 받은 것을 모은다."""
    received: list[dict[str, Any]] = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        message = socket.receive_json()
        received.append(message)
        if message["t"] == until:
            return received
    raise AssertionError(f"{until!r} 이벤트가 오지 않았다. 받은 것: {[m['t'] for m in received]}")


def test_every_message_satisfies_the_contract(client: TestClient) -> None:
    """WS 로 나가는 모든 메시지가 WsEvent 유니온으로 검증되는가.

    서버가 번역하지 않고 직렬화만 한다는 주장의 실제 증거다.
    """
    with client.websocket_connect("/ws") as socket:
        client.post("/api/runs", json={"graph": simple_graph(1, 2)})
        messages = drain(socket, until="run.done")

    for message in messages:
        _EVENTS.validate_python(message)  # 어긋나면 여기서 터진다

    assert len(messages) > 5


def test_event_order_follows_the_design_doc(client: TestClient) -> None:
    with client.websocket_connect("/ws") as socket:
        client.post("/api/runs", json={"graph": simple_graph(3, 4)})
        messages = drain(socket, until="run.done")

    kinds = [message["t"] for message in messages if message["t"] != "queue"]
    assert kinds[0] == "run.started"
    assert kinds[-1] == "run.done"
    assert kinds.count("node.started") == 3
    assert kinds.count("node.done") == 3

    # 노드마다 started 가 done 보다 앞선다.
    for node_id in ("c1", "c2", "add"):
        started = next(
            index
            for index, message in enumerate(messages)
            if message["t"] == "node.started" and message["node_id"] == node_id
        )
        done = next(
            index
            for index, message in enumerate(messages)
            if message["t"] == "node.done" and message["node_id"] == node_id
        )
        assert started < done


def test_all_events_carry_run_id(client: TestClient) -> None:
    """`queue` 를 뺀 모든 이벤트가 run_id 를 싣는다 — M2 계약."""
    created: dict[str, Any] = {}
    with client.websocket_connect("/ws") as socket:
        created = client.post("/api/runs", json={"graph": simple_graph()}).json()
        messages = drain(socket, until="run.done")

    for message in messages:
        if message["t"] == "queue":
            assert "run_id" not in message
        else:
            assert message["run_id"] == created["run_id"]


def test_node_cached_is_broadcast_on_the_second_run(client: TestClient) -> None:
    """프론트가 캐시 히트를 색칠하는 근거 (design.md §6, §7 UX 3)."""
    first = client.post("/api/runs", json={"graph": simple_graph(5, 6)}).json()["run_id"]
    wait_for(client, first)

    with client.websocket_connect("/ws") as socket:
        client.post("/api/runs", json={"graph": simple_graph(5, 6)})
        messages = drain(socket, until="run.done")

    cached = [message["node_id"] for message in messages if message["t"] == "node.cached"]
    assert set(cached) == {"c1", "c2", "add"}
    assert not [m for m in messages if m["t"] == "node.started"], "전부 캐시라 실행이 없다"


def test_partial_cache_shows_both_colours(client: TestClient) -> None:
    """입력 하나를 바꾸면 그 아래만 node.started, 나머지는 node.cached."""
    wait_for(client, client.post("/api/runs", json={"graph": simple_graph(1, 2)}).json()["run_id"])

    with client.websocket_connect("/ws") as socket:
        client.post("/api/runs", json={"graph": simple_graph(1, 42)})
        messages = drain(socket, until="run.done")

    cached = {m["node_id"] for m in messages if m["t"] == "node.cached"}
    started = {m["node_id"] for m in messages if m["t"] == "node.started"}
    assert cached == {"c1"}
    assert started == {"c2", "add"}


def test_node_done_carries_output_refs(client: TestClient) -> None:
    with client.websocket_connect("/ws") as socket:
        client.post("/api/runs", json={"graph": simple_graph(10, 20)})
        messages = drain(socket, until="run.done")

    done = next(m for m in messages if m["t"] == "node.done" and m["node_id"] == "add")
    assert done["outputs"] == [{"socket": "sum", "type": "INT", "inline": 30, "asset": None}]


def test_progress_events_reach_the_socket(client: TestClient) -> None:
    with client.websocket_connect("/ws") as socket:
        run_id = client.post("/api/runs", json={"graph": slow_graph(5)}).json()["run_id"]
        messages = drain(socket, until="run.done")

    progress = [m for m in messages if m["t"] == "node.progress"]
    assert [(m["step"], m["total"]) for m in progress] == [(i, 5) for i in range(1, 6)]
    assert all(m["run_id"] == run_id for m in progress)


def test_cancel_emits_run_cancelled_not_run_done(client: TestClient) -> None:
    with client.websocket_connect("/ws") as socket:
        run_id = client.post("/api/runs", json={"graph": slow_graph(300)}).json()["run_id"]
        # 실행이 시작될 때까지 기다린 뒤 취소한다.
        while client.get(f"/api/runs/{run_id}").json()["status"] != "running":
            time.sleep(0.01)
        client.delete(f"/api/runs/{run_id}")
        messages = drain(socket, until="run.cancelled", timeout=3.0)

    assert not [m for m in messages if m["t"] == "run.done"]
    assert messages[-1]["run_id"] == run_id


def test_node_error_names_the_node(client: TestClient) -> None:
    graph = {
        "nodal_version": "1",
        "nodes": {"boom": {"type": "test.Boom", "inputs": {}}},
        "outputs": ["boom"],
    }
    with client.websocket_connect("/ws") as socket:
        client.post("/api/runs", json={"graph": graph})
        messages = drain(socket, until="node.error", timeout=3.0)

    error = messages[-1]
    assert error["node_id"] == "boom"
    assert "의도적 실패" in error["message"]
    assert error["traceback"], "인라인 에러에 스택트레이스가 필요하다 (design.md §7 UX 4)"


# ------------------------------------------------------- 여러 클라이언트


def test_two_clients_receive_the_same_stream(client: TestClient) -> None:
    with client.websocket_connect("/ws") as first, client.websocket_connect("/ws") as second:
        client.post("/api/runs", json={"graph": simple_graph(2, 2)})
        first_messages = drain(first, until="run.done")
        second_messages = drain(second, until="run.done")

    def kinds(messages: list[dict[str, Any]]) -> list[str]:
        return [m["t"] for m in messages if m["t"] != "queue"]

    assert kinds(first_messages) == kinds(second_messages)


def test_a_disconnecting_client_does_not_kill_the_run(client: TestClient) -> None:
    """한 클라이언트가 끊겨도 실행은 계속된다."""
    with client.websocket_connect("/ws") as watcher:
        with client.websocket_connect("/ws") as leaver:
            run_id = client.post("/api/runs", json={"graph": slow_graph(10)}).json()["run_id"]
            leaver.receive_json()
        # leaver 는 여기서 끊겼다. watcher 는 끝까지 받아야 한다.
        messages = drain(watcher, until="run.done", timeout=5.0)

    assert messages[-1]["run_id"] == run_id
    assert wait_for(client, run_id)["status"] == "succeeded"


def test_queue_status_is_broadcast(client: TestClient) -> None:
    with client.websocket_connect("/ws") as socket:
        client.post("/api/runs", json={"graph": simple_graph()})
        messages = drain(socket, until="run.done")

    queue_events = [m for m in messages if m["t"] == "queue"]
    assert queue_events, "큐 상태가 나가야 한다"
    assert any(m["running"] is not None for m in queue_events)
    assert all(isinstance(m["pending"], int) for m in queue_events)


def test_a_new_client_gets_the_current_queue_state_immediately(client: TestClient) -> None:
    """새로고침한 클라이언트가 다음 이벤트까지 빈 화면을 보지 않게 한다."""
    wait_for(client, client.post("/api/runs", json={"graph": simple_graph()}).json()["run_id"])

    with client.websocket_connect("/ws") as socket:
        first = socket.receive_json()

    assert first["t"] == "queue"
    _EVENTS.validate_python(first)


# ------------------------------------------------------------------ 허브 단위


@pytest.mark.parametrize("subscribers", [0, 1, 3])
def test_hub_never_blocks_the_engine(subscribers: int) -> None:
    """느린 구독자가 실행을 막지 않는다. 버퍼가 차면 오래된 것을 버린다."""
    from nodal import QueueStatus
    from nodal_server.hub import EventHub

    hub = EventHub(buffer=4)
    contexts = [hub.subscribe() for _ in range(subscribers)]
    for context in contexts:
        context.__enter__()
    try:
        for index in range(100):
            hub.emit(QueueStatus(t="queue", pending=index, running=None))
        assert hub.subscriber_count == subscribers
        if subscribers:
            assert hub.dropped_total > 0, "버퍼를 넘겼으면 버려져야 한다"
    finally:
        for context in contexts:
            context.__exit__(None, None, None)
    assert hub.subscriber_count == 0


def test_hub_survives_an_unserialisable_event() -> None:
    """직렬화 실패가 실행을 죽이면 안 된다."""
    from nodal_server.hub import EventHub

    hub = EventHub()
    with hub.subscribe():
        hub.emit(object())  # type: ignore[arg-type]
    assert hub.subscriber_count == 0


def test_registry_is_injected_not_imported() -> None:
    """서버는 노드 팩을 import 하지 않는다 (AGENTS.md 아키텍처 절)."""
    with TestClient(create_app(NodeRegistry())) as bare:
        assert bare.get("/api/nodes").json()["nodes"] == []
