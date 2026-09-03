"""M1 실행 루프 통합 테스트 (docs/design.md §5.1, §5.4)."""

from __future__ import annotations

import hashlib
from typing import ClassVar

import pytest

import nodal.preview as preview_module
from nodal import (
    INT,
    AssetPreview,
    AssetRef,
    CancelToken,
    EncodedPreview,
    Image,
    InlinePreview,
    Int,
    NodeDone,
    NodeError,
    NodeExecutionError,
    NodePreview,
    NodeRegistry,
    NodeResult,
    NodeStarted,
    NullCache,
    PreviewEncoderNotFoundError,
    RecordingEventSink,
    RunDone,
    RunStarted,
    Type,
    clear_preview_encoders,
    execute,
    node,
    parse_graph,
    register_preview_encoder,
)


@pytest.fixture(autouse=True)
def isolate_preview_encoders(monkeypatch):
    """Clearing test encoders must not unregister already imported node packs."""
    monkeypatch.setattr(preview_module, "_ENCODERS", list(preview_module._ENCODERS))


EXECUTION_GRAPH = {
    "nodes": {
        "source": {"type": "test.Value", "inputs": {"value": 4}},
        "double": {
            "type": "test.AsyncDouble",
            "inputs": {"value": {"$link": ["source", "value"]}},
        },
        "sum": {
            "type": "test.Add",
            "inputs": {"left": {"$link": ["double", "value"]}, "right": 3},
        },
        "unrelated": {"type": "test.Value", "inputs": {"value": 999}},
    },
    "outputs": ["sum"],
}


class _MemoryAssets:
    def __init__(self) -> None:
        self._data: dict[str, bytes] = {}
        self._refs: dict[str, AssetRef] = {}

    def put(
        self,
        data: bytes,
        *,
        media_type: str = "application/octet-stream",
        filename: str | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> AssetRef:
        del filename
        digest = hashlib.blake2b(data, digest_size=16).hexdigest()
        ref = AssetRef(digest, media_type, len(data), width, height)
        self._data[digest] = data
        self._refs[digest] = ref
        return ref

    def get(self, digest: str) -> bytes | None:
        return self._data.get(digest)

    def ref(self, digest: str) -> AssetRef | None:
        return self._refs.get(digest)


def _execution_registry(calls: list[tuple[str, int]]) -> NodeRegistry:
    @node(id="test.Value", category="test")
    class Value:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append(("sync", value))
            return NodeResult(value)

    @node(id="test.AsyncDouble", category="test")
    class AsyncDouble:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        async def run(self, value: int) -> NodeResult:
            calls.append(("async", value))
            return NodeResult(value * 2)

    @node(id="test.Add", category="test")
    class Add:
        left: Int = Int()
        right: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, left: int, right: int) -> NodeResult:
            calls.append(("sync", left + right))
            return NodeResult(left + right)

    registry = NodeRegistry()
    registry.register_all((Value, AsyncDouble, Add))
    return registry


async def test_execute_runs_sync_and_async_ancestors_and_returns_named_outputs() -> None:
    """동기·비동기 run을 자동 감지하고 요청 출력의 조상만 실행한다 (§5.1, §5.4)."""
    calls: list[tuple[str, int]] = []
    registry = _execution_registry(calls)
    events = RecordingEventSink()
    graph = parse_graph(EXECUTION_GRAPH)
    before = graph.to_dict(compact=False)

    result = await execute(
        graph,
        ["sum"],
        registry=registry,
        cache=NullCache(),
        events=events,
        cancel_token=CancelToken(),
        run_id="run-sync-async",
    )

    assert result.outputs == {"sum": {"value": 11}}
    assert result.executed == ("source", "double", "sum")
    assert result.cached == ()
    assert calls == [("sync", 4), ("async", 4), ("sync", 11)]
    assert "unrelated" not in result.executed
    assert graph.to_dict(compact=False) == before


async def test_execute_emits_run_and_node_lifecycle_in_execution_order() -> None:
    """실행 루프는 run/node 시작·완료 이벤트를 실제 순서로 보고한다 (§5.1, §6)."""
    calls: list[tuple[str, int]] = []
    registry = _execution_registry(calls)
    events = RecordingEventSink()

    await execute(
        parse_graph(EXECUTION_GRAPH),
        ["sum"],
        registry=registry,
        cache=NullCache(),
        events=events,
        cancel_token=CancelToken(),
        run_id="run-events",
    )

    assert isinstance(events.events[0], RunStarted)
    assert events.events[0].run_id == "run-events"
    assert list(events.node_ids(NodeStarted)) == ["source", "double", "sum"]
    assert list(events.node_ids(NodeDone)) == ["source", "double", "sum"]
    assert isinstance(events.events[-1], RunDone)
    assert events.events[-1].run_id == "run-events"


async def test_output_node_is_selected_before_an_independent_ready_node() -> None:
    """준비 노드 중 output_node를 일반 노드보다 먼저 고른다 (§1.1 ②, §5.1)."""
    calls: list[str] = []

    @node(id="test.PlainSource", category="test")
    class PlainSource:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> NodeResult:
            calls.append("plain")
            return NodeResult(1)

    @node(id="test.PreviewSource", category="test", output_node=True)
    class PreviewSource:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> NodeResult:
            calls.append("preview")
            return NodeResult(2)

    @node(id="test.Join", category="test")
    class Join:
        left: Int = Int()
        right: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, left: int, right: int) -> NodeResult:
            calls.append("join")
            return NodeResult(left + right)

    registry = NodeRegistry()
    registry.register_all((PlainSource, PreviewSource, Join))
    graph = parse_graph(
        {
            "nodes": {
                "plain": {"type": "test.PlainSource"},
                "preview": {"type": "test.PreviewSource"},
                "join": {
                    "type": "test.Join",
                    "inputs": {
                        "left": {"$link": ["plain", "value"]},
                        "right": {"$link": ["preview", "value"]},
                    },
                },
            },
            "outputs": ["join"],
        }
    )

    await execute(
        graph,
        ["join"],
        registry=registry,
        cache=NullCache(),
        events=RecordingEventSink(),
        cancel_token=CancelToken(),
    )

    assert calls == ["preview", "plain", "join"]


async def test_preview_encoder_uses_inline_for_progress_and_asset_for_final_output() -> None:
    """인코더는 바이트만 만들고 core가 실행별 저장·전송 정책을 적용한다."""
    token = object()

    @node(id="test.ImagePreview", category="test")
    class ImagePreview:
        returns = {"image": Image}

        def run(self, ctx: object) -> NodeResult:
            ctx.progress(1, 2, preview=token)  # type: ignore[attr-defined]
            return NodeResult(token, preview=token)

    def encoder(value: object) -> EncodedPreview | None:
        if value is not token:
            return None
        return EncodedPreview(b"png-bytes", "image/png", 2, 3)

    registry = NodeRegistry()
    registry.register(ImagePreview)
    events = RecordingEventSink()
    assets = _MemoryAssets()
    clear_preview_encoders()
    register_preview_encoder(encoder)
    try:
        result = await execute(
            parse_graph({"nodes": {"image": {"type": "test.ImagePreview"}}, "outputs": ["image"]}),
            ["image"],
            registry=registry,
            cache=NullCache(),
            events=events,
            cancel_token=CancelToken(),
            assets=assets,
        )
    finally:
        clear_preview_encoders()

    previews = [event.preview for event in events.of_type(NodePreview)]
    assert isinstance(previews[0], InlinePreview)
    assert previews[0].data_uri == "data:image/png;base64,cG5nLWJ5dGVz"
    assert isinstance(previews[1], AssetPreview)
    assert assets.get(previews[1].asset.hash) == b"png-bytes"

    (ref,) = result.references["image"]
    assert ref.asset == previews[1].asset
    done = events.of_type(NodeDone)[0]
    assert done.outputs[0].asset == previews[1].asset  # type: ignore[attr-defined]


async def test_preview_encoding_failure_is_attributed_to_the_node() -> None:
    """프리뷰 인코더 실패도 익명 run 실패가 아니라 node.error가 된다."""

    @node(id="test.BrokenPreview", category="test")
    class BrokenPreview:
        returns = {"value": INT}

        def run(self) -> NodeResult:
            return NodeResult(1, preview=object())

    def broken_encoder(_: object) -> EncodedPreview:
        raise ValueError("preview failed")

    registry = NodeRegistry()
    registry.register(BrokenPreview)
    events = RecordingEventSink()
    clear_preview_encoders()
    register_preview_encoder(broken_encoder)
    try:
        with pytest.raises(NodeExecutionError, match="preview failed"):
            await execute(
                parse_graph(
                    {"nodes": {"broken": {"type": "test.BrokenPreview"}}, "outputs": ["broken"]}
                ),
                ["broken"],
                registry=registry,
                cache=NullCache(),
                events=events,
                cancel_token=CancelToken(),
            )
    finally:
        clear_preview_encoders()

    errors = events.of_type(NodeError)
    assert len(errors) == 1
    assert errors[0].node_id == "broken"  # type: ignore[attr-defined]


@pytest.mark.parametrize("explicit_preview", [True, False])
async def test_missing_encoder_fails_explicit_preview_and_tensor_output(
    explicit_preview: bool,
) -> None:
    """인코더 등록 누락은 프리뷰와 Tensor 출력을 조용히 버리지 않는다."""
    token = object()

    @node(id="test.MissingEncoder", category="test")
    class MissingEncoder:
        returns = {"image": Image}

        def run(self) -> NodeResult:
            return NodeResult(token, preview=token if explicit_preview else None)

    registry = NodeRegistry()
    registry.register(MissingEncoder)
    events = RecordingEventSink()
    clear_preview_encoders()

    with pytest.raises(NodeExecutionError) as caught:
        await execute(
            parse_graph(
                {"nodes": {"image": {"type": "test.MissingEncoder"}}, "outputs": ["image"]}
            ),
            ["image"],
            registry=registry,
            cache=NullCache(),
            events=events,
            cancel_token=CancelToken(),
        )

    assert isinstance(caught.value.cause, PreviewEncoderNotFoundError)
    errors = events.of_type(NodeError)
    assert len(errors) == 1
    assert errors[0].node_id == "image"  # type: ignore[attr-defined]
