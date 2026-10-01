"""서버 테스트 공용 픽스처.

서버는 노드 팩을 import 하지 않으므로 (의존성은 `server → core` 한 방향),
테스트가 레지스트리를 만들어 주입한다. 실제 실행에서도 같은 경로다.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from nodal import Combo, Int, NodeRegistry, NodeResult, node
from nodal_server.app import create_app


@node(id="test.Const", title="Const", category="test")
class Const:
    """리터럴 하나."""

    value: Int = Int(0)

    returns = {"value": Int}

    def run(self, value: int) -> NodeResult:
        return NodeResult(value)


@node(id="test.Add", title="Add", category="test", aliases=["더하기"])
class Add:
    """a + b."""

    a: Int = Int(0)
    b: Int = Int(0)

    returns = {"sum": Int}

    def run(self, a: int, b: int) -> NodeResult:
        return NodeResult(a + b)


@node(id="test.Boom", title="Boom", category="test")
class Boom:
    """항상 실패한다. 실패 경로를 시험한다."""

    returns = {"never": Int}

    def run(self) -> NodeResult:
        raise RuntimeError("의도적 실패")


@node(id="test.BoomAfter", title="Boom After", category="test")
class BoomAfter:
    """상류가 끝난 뒤 실패한다. 실패 run의 실행 이력을 시험한다."""

    value: Int

    returns = {"never": Int}

    def run(self, value: int) -> NodeResult:
        raise RuntimeError(f"{value} 뒤 의도적 실패")


@node(id="test.Slow", title="Slow", category="test")
class Slow:
    """오래 걸리고 매 스텝 취소를 확인하는 노드.

    취소가 **실행 중인 노드까지** 닿는지 보려면 실제로 시간이 걸려야 한다.
    """

    steps: Int = Int(50)

    returns = {"value": Int}

    def run(self, steps: int, ctx: Any) -> NodeResult:
        for index in range(steps):
            # 협조적 취소는 노드가 확인해 줄 때만 성립한다.
            ctx.raise_if_cancelled()
            ctx.progress(index + 1, steps)
            time.sleep(0.01)
        return NodeResult(steps)


@node(id="test.Choice", title="Choice", category="test")
class Choice:
    """Combo 옵션이 JSON 배열로 전송되는지 확인하는 노드."""

    mode: Combo = Combo("first", options=["first", "second"])

    returns = {"value": Int}

    def run(self, mode: str) -> NodeResult:
        return NodeResult(len(mode))


TEST_NODES: tuple[type, ...] = (Const, Add, Boom, BoomAfter, Slow, Choice)


@pytest.fixture
def registry() -> NodeRegistry:
    reg = NodeRegistry()
    reg.register_all(list(TEST_NODES))
    return reg


@pytest.fixture
def client(registry: NodeRegistry) -> Iterator[TestClient]:
    """lifespan 을 켠 테스트 클라이언트. 워커가 실제로 돈다."""
    with TestClient(create_app(registry)) as test_client:
        yield test_client


def simple_graph(a: int = 1, b: int = 2) -> dict[str, Any]:
    """`c1 + c2 → add` 3노드 그래프."""
    return {
        "nodal_version": "1",
        "nodes": {
            "c1": {"type": "test.Const", "inputs": {"value": a}},
            "c2": {"type": "test.Const", "inputs": {"value": b}},
            "add": {
                "type": "test.Add",
                "inputs": {
                    "a": {"$link": ["c1", "value"]},
                    "b": {"$link": ["c2", "value"]},
                },
            },
        },
        "outputs": ["add"],
    }


def slow_graph(steps: int = 200) -> dict[str, Any]:
    return {
        "nodal_version": "1",
        "nodes": {"s": {"type": "test.Slow", "inputs": {"steps": steps}}},
        "outputs": ["s"],
    }


def wait_for(client: TestClient, run_id: str, *, timeout: float = 5.0) -> dict[str, Any]:
    """실행이 끝날 때까지 폴링한다."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        payload = client.get(f"/api/runs/{run_id}").json()
        if payload["status"] in {"succeeded", "failed", "cancelled"}:
            return payload
        time.sleep(0.01)
    raise AssertionError(f"실행 {run_id} 가 {timeout}초 안에 끝나지 않았다")
