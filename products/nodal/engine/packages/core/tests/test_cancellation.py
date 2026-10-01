"""협조적 실행 취소 테스트 (docs/design.md §5.4)."""

from __future__ import annotations

import asyncio
from typing import ClassVar

import pytest

from nodal import (
    INT,
    Cancelled,
    CancelToken,
    NodeContext,
    NodeDone,
    NodeError,
    NodeRegistry,
    NodeResult,
    NodeStarted,
    NullCache,
    RecordingEventSink,
    RunCancelled,
    RunDone,
    Type,
    execute,
    node,
    parse_graph,
)

CANCELLABLE_GRAPH = {
    "nodes": {"work": {"type": "test.Cancellable"}},
    "outputs": ["work"],
}


def test_cancel_token_raises_only_after_cancellation() -> None:
    """취소 토큰은 요청 전에는 통과하고 요청 후에는 Cancelled를 던진다 (§5.4)."""
    token = CancelToken()
    token.raise_if_cancelled()

    token.cancel("사용자 요청")
    token.cancel("중복 요청")

    assert token.cancelled
    assert token.reason is not None
    with pytest.raises(Cancelled):
        token.raise_if_cancelled()


async def test_running_node_observes_cancellation_through_context() -> None:
    """실행 중 노드가 ctx를 확인하면 실패가 아닌 run.cancelled로 끝난다 (§5.4, §6)."""
    started = asyncio.Event()
    resume = asyncio.Event()

    @node(id="test.Cancellable", category="test")
    class Cancellable:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        async def run(self, ctx: NodeContext) -> NodeResult:
            started.set()
            await resume.wait()
            ctx.raise_if_cancelled()
            return NodeResult(1)

    registry = NodeRegistry()
    registry.register(Cancellable)
    token = CancelToken()
    events = RecordingEventSink()
    task = asyncio.create_task(
        execute(
            parse_graph(CANCELLABLE_GRAPH),
            ["work"],
            registry=registry,
            cache=NullCache(),
            events=events,
            cancel_token=token,
            run_id="cancel-me",
        )
    )
    started_wait = asyncio.create_task(started.wait())
    done, _ = await asyncio.wait(
        {task, started_wait},
        timeout=1,
        return_when=asyncio.FIRST_COMPLETED,
    )
    if task in done:
        await task
    assert started_wait in done, "노드 실행이 시작되지 않았다"

    token.cancel("사용자 요청")
    resume.set()

    with pytest.raises(Cancelled):
        await task

    assert list(events.node_ids(NodeStarted)) == ["work"]
    assert not events.node_ids(NodeDone)
    assert not events.of_type(NodeError)
    assert not events.of_type(RunDone)
    cancelled = events.of_type(RunCancelled)
    assert len(cancelled) == 1
    assert cancelled[0].run_id == "cancel-me"
