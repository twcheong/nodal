"""실행 큐 — 단일 워커 (docs/design.md §3, §6).

한 번에 하나만 실행한다. GPU 는 하나이고, 여러 그래프를 동시에 돌리면 VRAM 이
먼저 죽는다. 다중 워커는 M6 이후다 (design.md §11 ③).

**취소 경로가 이 파일의 핵심이다.** `CancelToken` 은 큐에 넣는 순간 만들어져
`RunRecord` 에 붙는다. 그래서 `DELETE /api/runs/{id}` 는 실행이 시작되기 전이든
노드 한가운데든 같은 토큰에 닿는다:

    POST /api/runs  →  RunRecord(cancel_token) 생성 → 큐
    DELETE          →  record.cancel_token.cancel()
    워커            →  execute(..., cancel_token=record.cancel_token)
    노드            →  ctx.raise_if_cancelled()  ← 여기서 실제로 멈춘다

토큰을 실행 직전에 만들면 큐에서 대기 중인 실행을 취소할 수 없다.
"""

from __future__ import annotations

import asyncio
import contextlib
import heapq
import itertools
import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from nodal import (
    AssetStore,
    Cache,
    Cancelled,
    CancelToken,
    Graph,
    GraphValidationError,
    LRUCache,
    NodeExecutionError,
    NodeRegistry,
    NullAssetStore,
    NullCache,
    QueueStatus,
    RunCancelled,
    RunResult,
    execute,
)

from .hub import EventHub
from .schemas import ErrorBody, RunStatus
from .wire import error_body

__all__ = ["RunQueue", "RunRecord"]

_LOGGER = logging.getLogger("nodal.server.queue")

#: 히스토리 보관 상한. 넘으면 오래된 것부터 버린다.
DEFAULT_HISTORY_LIMIT = 100


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class RunRecord:
    """실행 하나의 모든 상태. REST 응답이 이것에서 만들어진다."""

    run_id: str
    graph: Graph
    outputs: tuple[str, ...]
    use_cache: bool
    priority: int
    node_count: int

    #: 큐에 넣는 순간 만들어진다. 대기 중 취소가 가능해야 하기 때문이다.
    cancel_token: CancelToken = field(default_factory=CancelToken)

    status: RunStatus = RunStatus.QUEUED
    created_at: datetime = field(default_factory=_now)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    result: RunResult | None = None
    error: ErrorBody | None = None

    @property
    def elapsed_ms(self) -> int | None:
        if self.result is not None:
            return self.result.elapsed_ms
        if self.started_at and self.finished_at:
            return int((self.finished_at - self.started_at).total_seconds() * 1000)
        return None

    @property
    def is_terminal(self) -> bool:
        return self.status in {RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED}


class RunQueue:
    """단일 워커 실행 큐.

    워커는 `start()` 로 뜨고 `aclose()` 로 내려간다. FastAPI 의 lifespan 이 붙인다.
    """

    def __init__(
        self,
        registry: NodeRegistry,
        hub: EventHub,
        *,
        cache: Cache | None = None,
        assets: AssetStore | None = None,
        history_limit: int = DEFAULT_HISTORY_LIMIT,
    ) -> None:
        self._registry = registry
        self._hub = hub
        #: 실행 사이에 **공유되는** 캐시. 캐시가 실행 경계를 넘어 사는 것이 요점이다
        #: — 같은 그래프를 다시 큐에 넣으면 전부 node.cached 로 나가야 한다.
        self._cache: Cache = cache if cache is not None else LRUCache(512)
        self._assets: AssetStore = assets if assets is not None else NullAssetStore()
        self._history_limit = history_limit

        self._records: dict[str, RunRecord] = {}
        self._heap: list[tuple[int, int, str]] = []
        self._counter = itertools.count()
        self._wakeup = asyncio.Event()
        self._running_id: str | None = None
        self._worker: asyncio.Task[None] | None = None
        self._closing = False

    # ------------------------------------------------------------ 수명주기

    def start(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run_forever(), name="nodal-run-worker")

    async def aclose(self) -> None:
        """워커를 멈춘다. 실행 중이면 취소를 요청하고 기다린다."""
        self._closing = True
        running = self._records.get(self._running_id or "")
        if running is not None:
            running.cancel_token.cancel("서버 종료")
        self._wakeup.set()
        if self._worker is not None:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None

    # ---------------------------------------------------------------- 등록

    def enqueue(
        self,
        graph: Graph,
        outputs: Sequence[str],
        *,
        use_cache: bool = True,
        priority: int = 0,
        run_id: str | None = None,
    ) -> RunRecord:
        """큐에 넣고 즉시 돌아온다. 검증은 호출자(라우트)가 이미 마쳤다."""
        record = RunRecord(
            run_id=run_id or uuid.uuid4().hex,
            graph=graph,
            outputs=tuple(outputs),
            use_cache=use_cache,
            priority=priority,
            node_count=len(graph.nodes),
        )
        self._records[record.run_id] = record
        # 우선순위가 크면 먼저. 같으면 등록 순서 (heapq 는 최소 힙이다).
        heapq.heappush(self._heap, (-priority, next(self._counter), record.run_id))
        self._trim_history()
        self._wakeup.set()
        self._emit_queue_status()
        return record

    def cancel(self, run_id: str) -> RunRecord | None:
        """취소를 요청한다. 없는 실행이면 `None`.

        대기 중이면 즉시 취소 상태가 되고, 실행 중이면 토큰만 올린다 — 실제로
        멈추는 것은 노드가 `raise_if_cancelled()` 를 부를 때다 (협조적 취소).
        """
        record = self._records.get(run_id)
        if record is None:
            return None
        if record.is_terminal:
            return record

        record.cancel_token.cancel("사용자 요청")

        if record.status is RunStatus.QUEUED:
            # 아직 워커가 집지 않았다. 여기서 끝내고 이벤트를 직접 낸다 —
            # execute() 를 거치지 않으므로 core 가 run.cancelled 를 낼 기회가 없다.
            record.status = RunStatus.CANCELLED
            record.finished_at = _now()
            self._hub.emit(RunCancelled(t="run.cancelled", run_id=record.run_id, elapsed_ms=0))
            self._emit_queue_status()
        return record

    # ---------------------------------------------------------------- 조회

    def get(self, run_id: str) -> RunRecord | None:
        return self._records.get(run_id)

    @property
    def running(self) -> RunRecord | None:
        return self._records.get(self._running_id) if self._running_id else None

    def queued(self) -> list[RunRecord]:
        """대기 중인 실행. 실행될 순서대로."""
        return [
            record
            for _, _, run_id in sorted(self._heap)
            if (record := self._records.get(run_id)) is not None
            and record.status is RunStatus.QUEUED
        ]

    def history(self, limit: int) -> list[RunRecord]:
        """끝난 실행. 최신이 먼저."""
        finished = [record for record in self._records.values() if record.is_terminal]
        finished.sort(key=lambda record: record.finished_at or record.created_at, reverse=True)
        return finished[:limit]

    @property
    def history_limit(self) -> int:
        return self._history_limit

    @property
    def pending_count(self) -> int:
        return sum(1 for record in self._records.values() if record.status is RunStatus.QUEUED)

    # ---------------------------------------------------------------- 워커

    async def _run_forever(self) -> None:
        while not self._closing:
            record = self._take_next()
            if record is None:
                self._wakeup.clear()
                await self._wakeup.wait()
                continue
            await self._execute(record)

    def _take_next(self) -> RunRecord | None:
        while self._heap:
            _, _, run_id = heapq.heappop(self._heap)
            record = self._records.get(run_id)
            if record is not None and record.status is RunStatus.QUEUED:
                return record
        return None

    async def _execute(self, record: RunRecord) -> None:
        record.status = RunStatus.RUNNING
        record.started_at = _now()
        self._running_id = record.run_id
        self._emit_queue_status()

        cache: Cache = self._cache if record.use_cache else NullCache()

        try:
            record.result = await execute(
                record.graph,
                record.outputs,
                registry=self._registry,
                cache=cache,
                events=self._hub,
                cancel_token=record.cancel_token,
                run_id=record.run_id,
                assets=self._assets,
            )
            record.status = RunStatus.SUCCEEDED

        except Cancelled:
            # execute() 가 이미 run.cancelled 를 냈다.
            record.status = RunStatus.CANCELLED

        except GraphValidationError as exc:
            record.status = RunStatus.FAILED
            record.error = error_body("graph_invalid", str(exc), exc.issues)

        except NodeExecutionError as exc:
            record.status = RunStatus.FAILED
            record.error = error_body("node_failed", str(exc))

        except Exception as exc:
            _LOGGER.exception("실행 %s 가 예상치 못하게 실패했다", record.run_id)
            record.status = RunStatus.FAILED
            record.error = error_body("internal_error", f"{type(exc).__name__}: {exc}")

        finally:
            record.finished_at = _now()
            self._running_id = None
            self._emit_queue_status()

    # ---------------------------------------------------------------- 내부

    def _emit_queue_status(self) -> None:
        self._hub.emit(QueueStatus(t="queue", pending=self.pending_count, running=self._running_id))

    def _trim_history(self) -> None:
        """끝난 실행이 상한을 넘으면 오래된 것부터 버린다."""
        finished = [record for record in self._records.values() if record.is_terminal]
        if len(finished) <= self._history_limit:
            return
        finished.sort(key=lambda record: record.finished_at or record.created_at)
        for record in finished[: len(finished) - self._history_limit]:
            self._records.pop(record.run_id, None)


def result_outputs(record: RunRecord) -> dict[str, Any]:
    """`RunResult.outputs` 를 REST 응답 형태로. 없으면 빈 딕셔너리."""
    return dict(record.result.outputs) if record.result is not None else {}
