"""이벤트 허브 — core 의 `EventSink` 를 접속된 WS 클라이언트로 중계한다.

**느린 구독자가 실행을 막지 않는다.** core 의 `EventSink.emit` 은 동기 함수이고
실행 루프 한가운데서 불린다. 여기서 네트워크를 기다리면 노드 실행이 멈춘다.
그래서 구독자마다 유한 큐를 두고 `put_nowait` 만 한다 — 큐가 차면 가장 오래된
것을 버린다.

버리는 쪽을 택한 이유: 프리뷰와 진행률은 최신이 중요하고, 놓친 클라이언트는
`GET /api/runs/{id}` 로 최종 상태를 다시 얻을 수 있다 (그래서 `RunDetail` 에
`executed`·`cached` 가 있다). 실행이 느려지는 것보다 낫다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Iterator
from typing import Any

from nodal import Event

from .wire import event_to_wire

__all__ = ["EventHub", "Subscription"]

_LOGGER = logging.getLogger("nodal.server.hub")

#: 구독자 한 명이 밀리는 것을 허용하는 이벤트 수. 넘으면 오래된 것부터 버린다.
DEFAULT_BUFFER = 256


class Subscription:
    """WS 클라이언트 하나가 받을 이벤트 줄."""

    def __init__(self, buffer: int = DEFAULT_BUFFER) -> None:
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=buffer)
        self.dropped = 0

    def offer(self, message: dict[str, Any]) -> None:
        """이벤트를 넣는다. **절대 블록하지 않고 절대 예외를 던지지 않는다.**"""
        while True:
            try:
                self._queue.put_nowait(message)
                return
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    self._queue.get_nowait()
                    self.dropped += 1

    async def next(self) -> dict[str, Any]:
        return await self._queue.get()


class EventHub:
    """core 이벤트를 모든 구독자에게 밀어 넣는 `EventSink`.

    `emit` 은 동기이고 즉시 반환한다. 구독자가 없어도, 구독자가 죽어 있어도
    실행에는 영향이 없다.
    """

    def __init__(self, buffer: int = DEFAULT_BUFFER) -> None:
        self._subscribers: set[Subscription] = set()
        self._buffer = buffer
        #: 마지막 큐 상태. 새 구독자가 붙자마자 현재 상황을 알 수 있게 한다.
        self._last_queue_status: dict[str, Any] | None = None

    # ------------------------------------------------------------ EventSink

    def emit(self, event: Event) -> None:
        """core 실행 루프가 부른다. 여기서 기다리면 노드 실행이 멈춘다."""
        try:
            message = event_to_wire(event)
        except Exception:
            _LOGGER.exception("이벤트를 직렬화할 수 없다: %r", event)
            return

        if message.get("t") == "queue":
            self._last_queue_status = message

        for subscriber in tuple(self._subscribers):
            subscriber.offer(message)

    # ------------------------------------------------------------ 구독 관리

    @contextlib.contextmanager
    def subscribe(self) -> Iterator[Subscription]:
        """구독을 열고 닫는다. 예외가 나도 반드시 정리된다."""
        subscription = Subscription(self._buffer)
        self._subscribers.add(subscription)
        try:
            yield subscription
        finally:
            self._subscribers.discard(subscription)

    async def stream(self) -> AsyncIterator[dict[str, Any]]:
        """구독을 열고 이벤트를 순서대로 내준다. WS 핸들러가 그대로 쓴다."""
        with self.subscribe() as subscription:
            if self._last_queue_status is not None:
                # 붙자마자 지금 큐가 어떤지 알려준다. 새로고침한 클라이언트가
                # 다음 이벤트까지 빈 화면을 보지 않게 하는 것이 목적이다.
                yield self._last_queue_status
            while True:
                yield await subscription.next()

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    @property
    def dropped_total(self) -> int:
        """버려진 이벤트 총합. 버퍼가 부족한지 판단하는 지표다."""
        return sum(subscriber.dropped for subscriber in self._subscribers)
