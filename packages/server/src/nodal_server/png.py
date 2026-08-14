"""PNG `iTXt` 워크플로 추출 (docs/design.md §6).

**표준 라이브러리만 쓴다.** 서버는 `core` 에만 의존하므로 Pillow 가 없다
(AGENTS.md 아키텍처 절). 다행히 PNG 청크 구조는 단순해서 워크플로를 꺼내는 데
이미지 디코더가 필요 없다 — 픽셀은 건드리지 않고 텍스트 청크만 읽는다.

쓰기는 `packages/nodes-image` 가 Pillow 로 한다. 읽기와 쓰기가 다른 곳에 있는 것은
중복이 아니다 — 같은 규칙을 두 번 구현하는 것이 아니라 표준 포맷의 반대 방향
연산이다.

`iTXt` 청크 구조 (PNG 명세 11.3.4.5):

    keyword \\0 compression_flag compression_method language_tag \\0 translated_keyword \\0 text
"""

from __future__ import annotations

import struct
import zlib

__all__ = ["PNG_MAGIC", "PngFormatError", "read_text_chunks"]

#: PNG 파일 시그니처. 이것으로 시작하지 않으면 PNG 가 아니다.
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

#: 텍스트를 담는 청크 셋. `iTXt` 가 UTF-8 이고 나머지는 Latin-1 이다.
_TEXT_CHUNKS = (b"iTXt", b"tEXt", b"zTXt")

#: 압축 해제 결과의 상한. zip 폭탄으로 서버 메모리를 터뜨리지 못하게 한다.
_MAX_TEXT_BYTES = 16 * 1024 * 1024


class PngFormatError(ValueError):
    """PNG 로 읽을 수 없는 바이트."""


def read_text_chunks(data: bytes) -> dict[str, str]:
    """PNG 의 텍스트 청크를 `{키워드: 값}` 으로 읽는다.

    `iTXt` 는 UTF-8, `tEXt`·`zTXt` 는 Latin-1 로 디코드한다. 같은 키워드가 여러 번
    나오면 **처음 것**을 쓴다 — 뒤에 덧붙인 청크로 앞의 워크플로를 덮어쓰는 길을
    열지 않는다.

    픽셀 데이터(`IDAT`)는 읽지 않고 건너뛴다. 워크플로만 필요하기 때문이다.

    Raises:
        PngFormatError: 시그니처가 없거나 청크 구조가 깨졌을 때.
    """
    if not data.startswith(PNG_MAGIC):
        raise PngFormatError("PNG 시그니처가 없다")

    chunks: dict[str, str] = {}
    offset = len(PNG_MAGIC)
    total = len(data)

    while offset + 8 <= total:
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        kind = data[offset + 4 : offset + 8]
        body_start = offset + 8
        body_end = body_start + length
        if body_end + 4 > total:
            raise PngFormatError(f"{kind!r} 청크가 파일 끝을 넘어간다")

        if kind in _TEXT_CHUNKS:
            parsed = _parse_text_chunk(kind, data[body_start:body_end])
            if parsed is not None:
                keyword, value = parsed
                chunks.setdefault(keyword, value)
        elif kind == b"IEND":
            break

        offset = body_end + 4  # +4 = CRC

    return chunks


def _parse_text_chunk(kind: bytes, body: bytes) -> tuple[str, str] | None:
    """텍스트 청크 하나를 (키워드, 값) 으로. 해석할 수 없으면 `None`."""
    keyword_raw, separator, rest = body.partition(b"\x00")
    if not separator:
        return None
    keyword = keyword_raw.decode("latin-1", errors="replace")

    if kind == b"tEXt":
        return keyword, rest.decode("latin-1", errors="replace")

    if kind == b"zTXt":
        if not rest:
            return None
        # rest[0] 이 압축 방법. 0(deflate)만 정의돼 있다.
        return keyword, _inflate(rest[1:])

    # iTXt: compression_flag(1) compression_method(1) lang \0 translated \0 text
    if len(rest) < 2:
        return None
    compressed = rest[0] == 1
    after_flags = rest[2:]
    _lang, separator, after_lang = after_flags.partition(b"\x00")
    if not separator:
        return None
    _translated, separator, text = after_lang.partition(b"\x00")
    if not separator:
        return None
    if compressed:
        return keyword, _inflate(text)
    return keyword, text.decode("utf-8", errors="replace")


def _inflate(payload: bytes) -> str:
    """zlib 로 압축된 텍스트를 푼다. 상한을 넘으면 자른다."""
    try:
        raw = zlib.decompressobj().decompress(payload, _MAX_TEXT_BYTES)
    except zlib.error as exc:
        raise PngFormatError(f"압축된 텍스트 청크를 풀 수 없다: {exc}") from exc
    return raw.decode("utf-8", errors="replace")
