"""프리뷰 인코더 등록을 테스트마다 복구하는 autouse 픽스처.

**`conftest.py` 가 아닌 이유**: pytest 는 `__init__.py` 없는 테스트 디렉토리를
각각 `sys.path` 에 넣는다. 그래서 `conftest` 라는 이름이 두 개 생기면
`packages/server/tests` 의 `from conftest import ...` 가 이 패키지의 것을 집는다.
이름을 고유하게 두면 그 충돌이 없다.

**왜 필요한가**: 인코더 레지스트리는 프로세스 전역이고 `nodal_nodes_image` 는
import 시점에 한 번 등록한다. 그런데 core 의 테스트가 격리를 위해
`clear_preview_encoders()` 를 부르므로, 한 프로세스에서 전체 스위트를 돌리면
등록이 사라진 채 이 패키지의 테스트가 시작될 수 있다.

실제로 그랬다 — 이 패키지만 돌리면 통과하는데 `uv run pytest` 로 전부 돌리면
`PreviewEncoderNotFoundError` 로 실패했다. 순서에 의존하는 통과는 통과가 아니다.
"""

from __future__ import annotations

import pytest

import nodal_nodes_image
from nodal import register_preview_encoder
from nodal.preview import _ENCODERS

__all__ = ["ensure_preview_encoder_registered"]


@pytest.fixture(autouse=True)
def ensure_preview_encoder_registered() -> None:
    """이 패키지의 ndarray 인코더가 등록된 상태를 보장한다."""
    if nodal_nodes_image.encode_ndarray_preview not in _ENCODERS:
        register_preview_encoder(nodal_nodes_image.encode_ndarray_preview)
