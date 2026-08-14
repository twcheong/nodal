"""에셋 참조와 저장소 인터페이스 (docs/design.md §4.5, M3 계약).

**여기 있는 것은 인터페이스뿐이고 구현은 없다.** 디스크 레이아웃·스필·GC 는
`packages/server` 가 정한다. core 에 두는 이유는 하나다 — 이미지를 저장하는
노드가 저장소에 닿아야 하는데, 노드 팩은 `core` 만 의존하기 때문이다
(AGENTS.md 아키텍처 절). 구현까지 core 에 넣으면 도메인 중립 그래프 엔진에
파일시스템 정책이 들어온다.

노드는 `ctx.assets` 로 접근한다. `ctx` 를 선언하지 않은 노드는 저장소를 모르며,
그것이 정상이다 — 순수 함수로 남아 엔진 없이 단위 테스트가 된다.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

__all__ = ["AssetRef", "AssetStore", "NullAssetStore"]


class AssetRef:
    """저장된 에셋 하나에 대한 **참조**. 바이트가 아니다 (design.md §6).

    `OutputRef.asset` 과 `node.preview` 가 이 모양을 그대로 싣는다. 프론트가
    이미지를 **받기 전에** 자리를 잡을 수 있어야 하므로 크기가 참조에 들어 있다 —
    해시만 주면 GET 이 끝날 때까지 레이아웃이 튄다.

    `width` · `height` 는 이미지가 아닌 에셋에서는 `None` 이다. 저장소는 바이트와
    미디어 타입만 알고 픽셀 크기는 **넣는 쪽이 알려준다** — 저장소가 이미지를
    해석하기 시작하면 그것은 더 이상 범용 바이트 저장소가 아니다.

    `hash` 라는 인자 이름은 내장 함수를 가리지만 **전송 필드 이름**이라 바꾸지
    않는다 — 바꾸면 계약이 바뀐다.

    Attributes:
        hash: 내용 해시. `GET /api/assets/{hash}` 의 키.
        media_type: `image/png` 처럼.
        size_bytes: 바이트 수.
        width: 픽셀 너비. 이미지가 아니면 `None`.
        height: 픽셀 높이. 이미지가 아니면 `None`.
    """

    __slots__ = ("hash", "height", "media_type", "size_bytes", "width")

    def __init__(
        self,
        hash: str,
        media_type: str,
        size_bytes: int,
        width: int | None = None,
        height: int | None = None,
    ) -> None:
        self.hash = hash
        self.media_type = media_type
        self.size_bytes = size_bytes
        self.width = width
        self.height = height

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, AssetRef):
            return NotImplemented
        return self.hash == other.hash and self.media_type == other.media_type

    def __hash__(self) -> int:
        return hash((self.hash, self.media_type))

    def __repr__(self) -> str:
        size = f"{self.width}x{self.height}" if self.width else f"{self.size_bytes}B"
        return f"AssetRef({self.hash[:12]}…, {self.media_type}, {size})"


@runtime_checkable
class AssetStore(Protocol):
    """content-addressed 바이트 저장소.

    같은 내용이면 같은 해시다. 그래서 같은 이미지를 두 번 저장해도 하나만 남는다.
    해시 알고리즘은 구현이 정하지만 **캐시 키와 같은 계열(blake2b-128)** 을 쓴다
    (`cache.py` 의 결정과 같은 이유 — 암호학적 보증이 필요 없고 결정성과 충돌
    회피만 필요하다).

    구현은 `packages/server` 에 있다. M3 구현 단계에서 채운다.
    """

    def put(
        self,
        data: bytes,
        *,
        media_type: str = ...,
        filename: str | None = ...,
        width: int | None = ...,
        height: int | None = ...,
    ) -> AssetRef:
        """저장하고 참조를 돌려준다. 이미 있으면 저장하지 않고 그대로 돌려준다."""
        ...

    def get(self, digest: str) -> bytes | None:
        """해시로 바이트를 꺼낸다. 없으면 `None`."""
        ...

    def ref(self, digest: str) -> AssetRef | None:
        """해시로 참조(메타데이터)만 꺼낸다. 바이트를 읽지 않는다."""
        ...


class NullAssetStore:
    """아무것도 저장하지 않는 저장소.

    저장소 없이 실행할 때의 기본값이다 (CLI, 단위 테스트). `put` 이 조용히
    성공하는 대신 **명시적으로 실패한다** — 이미지를 저장했다고 믿었는데
    사라지는 것보다 그 자리에서 터지는 편이 낫다.
    """

    def put(
        self,
        data: bytes,
        *,
        media_type: str = "application/octet-stream",
        filename: str | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> AssetRef:
        raise RuntimeError(
            "이 실행에는 에셋 저장소가 없다. 서버로 실행하거나 ctx.assets 를 주입하라"
        )

    def get(self, digest: str) -> bytes | None:
        return None

    def ref(self, digest: str) -> AssetRef | None:
        return None
