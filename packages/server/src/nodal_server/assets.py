"""에셋 저장소 — content-addressed (docs/design.md §6).

같은 내용이면 같은 해시다. 그래서 같은 이미지를 두 번 올려도 하나만 남는다.

> **M2 범위**: 메모리에만 둔다. 디스크 스필과 `AssetStore` 의 제대로 된 설계는
> M3 다 (roadmap M3). 여기서 파일 레이아웃을 먼저 정하면 M3 가 그것을 물려받게
> 되므로, 지금은 **엔드포인트가 실제로 동작하는 것**까지만 한다.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

__all__ = ["AssetStore", "StoredAsset"]

#: 메모리에 둘 수 있는 총량. M2 는 테스트용 작은 파일만 다룬다.
DEFAULT_CAPACITY_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class StoredAsset:
    hash: str
    data: bytes
    media_type: str
    filename: str | None

    @property
    def size_bytes(self) -> int:
        return len(self.data)


class AssetStore:
    """content-addressed 인메모리 저장소."""

    def __init__(self, capacity_bytes: int = DEFAULT_CAPACITY_BYTES) -> None:
        self._assets: dict[str, StoredAsset] = {}
        self._capacity = capacity_bytes
        self._used = 0

    def put(
        self,
        data: bytes,
        *,
        media_type: str = "application/octet-stream",
        filename: str | None = None,
    ) -> StoredAsset:
        """저장하고 해시를 돌려준다. 이미 있으면 그대로 돌려준다.

        Raises:
            ValueError: 용량을 넘길 때.
        """
        digest = hashlib.blake2b(data, digest_size=16).hexdigest()
        existing = self._assets.get(digest)
        if existing is not None:
            return existing

        if self._used + len(data) > self._capacity:
            raise ValueError(
                f"에셋 저장소 용량을 넘었다 ({self._capacity} 바이트). M3 에서 디스크로 스필한다"
            )

        asset = StoredAsset(hash=digest, data=data, media_type=media_type, filename=filename)
        self._assets[digest] = asset
        self._used += len(data)
        return asset

    def get(self, digest: str) -> StoredAsset | None:
        return self._assets.get(digest)

    def __len__(self) -> int:
        return len(self._assets)
