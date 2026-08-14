"""PNG 인코딩과 `iTXt` 워크플로 임베딩 (docs/design.md §6).

`iTXt` 를 쓰는 이유는 UTF-8 이기 때문이다. `tEXt` 는 Latin-1 이라 한글 노드 제목이
들어간 캐논 JSON 을 담을 수 없다 (`examples/arithmetic.nodal.json` 의 `"씨앗 값"` 이
바로 그 경우다).

**쓰기만 여기 있다.** 읽기는 `packages/server` 가 표준 라이브러리로 한다 — 서버는
Pillow 를 의존하지 않기 때문이다 (의존성 화살표: `server → core`).
"""

from __future__ import annotations

import io

import numpy as np
from PIL import PngImagePlugin

from .image import to_pil

__all__ = ["VERSION_KEY", "WORKFLOW_KEY", "encode_png"]

#: 캐논 그래프 JSON 이 들어가는 `iTXt` 키워드 (design.md §6).
#: `workflow` 가 아닌 이유는 다른 노드 도구가 그 이름을 흔히 쓰기 때문이다 —
#: 남의 PNG 를 삼켜 이상한 그래프를 만들거나 그 반대가 되면 안 된다.
WORKFLOW_KEY = "nodal_workflow"

#: 포맷이 바뀔 때 마이그레이션 근거가 되는 부가 키워드.
VERSION_KEY = "nodal_version"


def encode_png(
    array: np.ndarray,
    *,
    workflow: str | None = None,
    nodal_version: str | None = None,
    index: int = 0,
) -> bytes:
    """계약 형태 배열 한 장을 PNG 바이트로. 워크플로를 `iTXt` 로 심는다.

    Args:
        array: `(B, H, W, C)` float32 0..1.
        workflow: 캐논 그래프 JSON 문자열. `None` 이면 심지 않는다.
        nodal_version: 그래프 포맷 버전.
        index: 배치에서 꺼낼 장 번호.
    """
    image = to_pil(array, index)
    info = PngImagePlugin.PngInfo()
    if workflow is not None:
        # zip=False — 압축하면 읽는 쪽이 zlib 를 풀어야 하고, 워크플로 JSON 은
        # 보통 수 KB 라 압축 이득이 진단 난이도만큼의 값을 하지 않는다.
        info.add_itxt(WORKFLOW_KEY, workflow, zip=False)
        if nodal_version is not None:
            info.add_itxt(VERSION_KEY, nodal_version, zip=False)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", pnginfo=info)
    return buffer.getvalue()
