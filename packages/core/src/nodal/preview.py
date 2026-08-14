"""프리뷰 전송 형태와 인코더 등록 (docs/design.md §4.6, M3 계약).

**M2 까지 `NodeResult.preview` 는 아무 데도 가지 않았다.** `_classify` 가 값만
꺼내 쓰고 프리뷰를 버렸다. M3 계약이 그 경로를 만든다::

    NodeResult(out, preview=out)
        → executor 가 encode_preview(out) 호출
        → 등록된 인코더가 ndarray → PNG 바이트
        → ctx.assets 에 저장하거나 data URI 로
        → node.preview 이벤트

**인코딩을 왜 core 가 직접 하지 않는가.** core 는 numpy 를 모른다 (도메인 중립
그래프 엔진). server 도 `core` 만 의존하므로 마찬가지다. 그래서 노드 팩이
인코더를 등록하고 core 는 **부르기만** 한다. `register_combo_provider()` 와 같은
패턴이다 — 그쪽도 core 가 모르는 것(체크포인트 목록)을 노드 팩이 채운다.

`ctx.progress(preview=...)` 와 `NodeResult(preview=...)` 는 **같은 인코더**를 탄다.
전자는 버려질 inline, 후자는 저장될 asset 으로 core 가 전달 정책만 다르게 적용한다.
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, TypeAlias

from .assets import AssetRef, AssetStore, NullAssetStore

__all__ = [
    "AssetPreview",
    "EncodedPreview",
    "InlinePreview",
    "Preview",
    "PreviewEncoder",
    "clear_preview_encoders",
    "encode_preview",
    "register_preview_encoder",
]


@dataclass(frozen=True, slots=True)
class InlinePreview:
    """작은 프리뷰를 data URI 로 그대로 싣는다.

    샘플링 중간 프리뷰처럼 **버려질 값**이 여기 온다. 에셋 저장소에 넣으면
    스텝마다 쌓여 content-addressed 저장소가 쓰레기로 오염된다.
    """

    kind: Literal["inline"]
    data_uri: str
    width: int | None = None
    height: int | None = None


@dataclass(frozen=True, slots=True)
class AssetPreview:
    """저장소에 있는 프리뷰를 참조로 가리킨다.

    노드의 최종 출력 이미지가 여기 온다. 어차피 저장소에 있으므로 WS 로 바이트를
    다시 흘릴 이유가 없다 (§6 의 "메가바이트를 소켓으로 흘리지 않는다").
    """

    kind: Literal["asset"]
    asset: AssetRef


@dataclass(frozen=True, slots=True)
class EncodedPreview:
    """노드 팩이 만든 프리뷰 바이트. 전송·저장 정책은 아직 적용하지 않았다."""

    data: bytes
    media_type: str
    width: int
    height: int


#: 프론트가 받는 프리뷰. `kind` 로 판별한다 — 문자열 하나로 두면 받는 쪽이
#: base64 인지 해시인지 추측해야 한다 (M2 까지의 `image: str` 이 그랬다).
Preview: TypeAlias = InlinePreview | AssetPreview

#: 런타임 값 → 프리뷰. 해석할 수 없는 값이면 `None` 을 돌려주고 다음 인코더에 넘긴다.
PreviewEncoder: TypeAlias = Callable[[Any], EncodedPreview | None]

_ENCODERS: list[PreviewEncoder] = []


def register_preview_encoder(encoder: PreviewEncoder) -> PreviewEncoder:
    """프리뷰 인코더를 등록한다. 데코레이터로도 쓴다.

    나중에 등록된 것이 먼저 시도된다. 노드 팩이 기본 인코더를 덮어쓸 수 있어야
    하기 때문이다 (`nodes-diffusion` 이 latent 프리뷰를 따로 그리는 경우).

    Args:
        encoder: 런타임 값을 받아 `EncodedPreview` 또는 `None` 을 돌려주는 함수.

    Returns:
        받은 인코더 그대로. 데코레이터로 쓸 수 있게.
    """
    _ENCODERS.append(encoder)
    return encoder


def clear_preview_encoders() -> None:
    """등록된 인코더를 모두 지운다. 테스트 격리용이다."""
    _ENCODERS.clear()


def encode_preview(
    value: Any,
    *,
    assets: AssetStore | None = None,
    persistent: bool = False,
) -> Preview | None:
    """등록된 인코더로 런타임 값을 프리뷰로 바꾼다.

    등록된 인코더가 없거나 아무도 처리하지 못하면 `None` 이다. 그때는
    `node.preview` 이벤트를 **보내지 않는다** — 빈 프리뷰를 보내는 것보다 낫다.

    인코더는 바이트와 메타데이터만 만든다. core 가 `persistent` 정책을 적용해
    중간 프리뷰는 data URI 로, 영속 프리뷰는 실행별 `AssetStore` 로 보낸다.
    이미 `Preview` 인 값은 그대로 통과한다.
    """
    if isinstance(value, InlinePreview | AssetPreview):
        return value
    for encoder in reversed(_ENCODERS):
        encoded = encoder(value)
        if encoded is None:
            continue
        if persistent:
            store = assets if assets is not None else NullAssetStore()
            ref = store.put(
                encoded.data,
                media_type=encoded.media_type,
                width=encoded.width,
                height=encoded.height,
            )
            return AssetPreview(kind="asset", asset=ref)
        payload = base64.b64encode(encoded.data).decode("ascii")
        return InlinePreview(
            kind="inline",
            data_uri=f"data:{encoded.media_type};base64,{payload}",
            width=encoded.width,
            height=encoded.height,
        )
    return None
