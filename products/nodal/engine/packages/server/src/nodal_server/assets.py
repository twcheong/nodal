"""에셋 저장소 — content-addressed (docs/design.md §6).

같은 내용이면 같은 해시다. 그래서 같은 이미지를 두 번 올려도 하나만 남는다.

둘 다 `nodal.AssetStore` 프로토콜을 만족한다 (core 인터페이스 / server 구현 —
design.md §4.5).

- `FileAssetStore` — M3 의 기본. 디스크에 남아 서버를 재시작해도 살아 있다.
- `AssetStore` — 인메모리. 테스트와 임시 실행용으로 남겨 둔다.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from nodal import AssetRef

__all__ = ["AssetStore", "FileAssetStore", "StoredAsset"]

#: 메모리에 둘 수 있는 총량. M2 는 테스트용 작은 파일만 다룬다.
DEFAULT_CAPACITY_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class StoredAsset:
    ref: AssetRef
    data: bytes
    filename: str | None

    @property
    def hash(self) -> str:
        return self.ref.hash


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
        width: int | None = None,
        height: int | None = None,
    ) -> AssetRef:
        """저장하고 해시를 돌려준다. 이미 있으면 그대로 돌려준다.

        Raises:
            ValueError: 용량을 넘길 때.
        """
        digest = hashlib.blake2b(data, digest_size=16).hexdigest()
        existing = self._assets.get(digest)
        if existing is not None:
            return existing.ref

        if self._used + len(data) > self._capacity:
            raise ValueError(
                f"에셋 저장소 용량을 넘었다 ({self._capacity} 바이트). M3 에서 디스크로 스필한다"
            )

        ref = AssetRef(
            hash=digest,
            media_type=media_type,
            size_bytes=len(data),
            width=width,
            height=height,
        )
        asset = StoredAsset(ref=ref, data=data, filename=filename)
        self._assets[digest] = asset
        self._used += len(data)
        return ref

    def get(self, digest: str) -> bytes | None:
        stored = self._assets.get(digest)
        return stored.data if stored is not None else None

    def ref(self, digest: str) -> AssetRef | None:
        stored = self._assets.get(digest)
        return stored.ref if stored is not None else None

    def __len__(self) -> int:
        return len(self._assets)


class FileAssetStore:
    """content-addressed 파일시스템 저장소 (M3).

    파일명이 곧 해시다. 같은 내용이면 같은 경로이므로 중복 저장이 구조적으로
    불가능하다 — 존재 여부만 확인하면 dedup 이 끝난다.

    ```
    <root>/ab/abcdef0123…            바이트 그대로
    <root>/ab/abcdef0123….json       메타데이터 (media_type · 크기 · 원본 파일명)
    ```

    앞 두 글자로 디렉토리를 나누는 이유는 한 디렉토리에 파일이 수만 개 쌓이면
    파일시스템과 `ls` 가 모두 느려지기 때문이다.

    메타데이터를 사이드카 JSON 으로 두는 이유: 바이트만으로는 `media_type` 과
    픽셀 크기를 복원할 수 없고, 저장소가 이미지를 **해석하기 시작하면 더 이상
    범용 바이트 저장소가 아니다** (design.md §4.5 — 크기는 넣는 쪽이 알려준다).

    쓰기는 같은 디렉토리에 임시 파일을 만든 뒤 `os.replace` 로 원자적으로 옮긴다.
    중간에 죽어도 반쯤 쓰인 파일이 해시 이름으로 남지 않는다.
    """

    def __init__(self, root: Path) -> None:
        self._root = Path(root)
        self._root.mkdir(parents=True, exist_ok=True)

    def _paths(self, digest: str) -> tuple[Path, Path]:
        shard = self._root / digest[:2]
        return shard / digest, shard / f"{digest}.json"

    def put(
        self,
        data: bytes,
        *,
        media_type: str = "application/octet-stream",
        filename: str | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> AssetRef:
        digest = hashlib.blake2b(data, digest_size=16).hexdigest()
        blob, meta = self._paths(digest)
        ref = AssetRef(
            hash=digest,
            media_type=media_type,
            size_bytes=len(data),
            width=width,
            height=height,
        )
        if blob.exists():
            # 이미 있다. 내용이 같음이 해시로 보장되므로 다시 쓰지 않는다.
            existing = self.ref(digest)
            return existing if existing is not None else ref

        blob.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(blob, data)
        _atomic_write(
            meta,
            json.dumps(
                {
                    "media_type": media_type,
                    "size_bytes": len(data),
                    "width": width,
                    "height": height,
                    "filename": filename,
                },
                ensure_ascii=False,
            ).encode("utf-8"),
        )
        return ref

    def get(self, digest: str) -> bytes | None:
        blob, _ = self._paths(digest)
        try:
            return blob.read_bytes()
        except OSError:
            return None

    def ref(self, digest: str) -> AssetRef | None:
        blob, meta = self._paths(digest)
        if not blob.exists():
            return None
        try:
            info = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # 사이드카가 없거나 깨졌다. 바이트는 살아 있으므로 최소 정보로 돌려준다.
            return AssetRef(
                hash=digest,
                media_type="application/octet-stream",
                size_bytes=blob.stat().st_size,
            )
        return AssetRef(
            hash=digest,
            media_type=str(info.get("media_type", "application/octet-stream")),
            size_bytes=int(info.get("size_bytes", blob.stat().st_size)),
            width=info.get("width"),
            height=info.get("height"),
        )

    def filename(self, digest: str) -> str | None:
        """원본 업로드 파일명. 다운로드 시 `Content-Disposition` 에 쓴다."""
        _, meta = self._paths(digest)
        try:
            name = json.loads(meta.read_text(encoding="utf-8")).get("filename")
        except (OSError, ValueError):
            return None
        return str(name) if name is not None else None

    def __len__(self) -> int:
        return sum(1 for _ in self._root.glob("*/*") if not _.name.endswith(".json"))


def _atomic_write(path: Path, data: bytes) -> None:
    """같은 디렉토리에 임시 파일로 쓴 뒤 원자적으로 옮긴다."""
    handle, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
