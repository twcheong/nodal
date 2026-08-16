"""`examples/sample.png` 를 만든다.

예제 그래프(`examples/image.nodal.json`)의 `image.Load` 가 가리킬 파일이 필요하다.
**외부에서 가져온 이미지를 커밋하지 않으려고** 생성 스크립트를 함께 둔다 — 산출물의
출처가 이 파일 하나로 설명되고, 라이선스가 얽힐 여지가 없다 (`docs/license.md`).

    uv run python tools/make_example_image.py

의도적으로 단순한 도형만 쓴다. 평면 색이 많아 PNG 가 몇 KB 로 압축되고,
`Resize`·`Crop` 의 효과가 눈에 바로 보인다.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

SIZE = 512
OUT = Path(__file__).resolve().parent.parent / "examples" / "sample.png"

# 색상 밴드 — 리사이즈해도 구분이 남을 만큼 크게 잡는다.
BANDS = (
    (0x1F, 0x77, 0xB4),
    (0x2C, 0xA0, 0x2C),
    (0xFF, 0x7F, 0x0E),
    (0xD6, 0x27, 0x28),
)


def build() -> np.ndarray:
    canvas = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)

    # 1) 왼쪽에서 오른쪽으로 세로 색 밴드
    band_width = SIZE // len(BANDS)
    for index, colour in enumerate(BANDS):
        canvas[:, index * band_width : (index + 1) * band_width] = colour

    # 2) 위쪽 1/4 은 밝기 그라디언트 — 보간 방식의 차이가 드러나는 부분
    ramp = np.linspace(0, 255, SIZE, dtype=np.uint8)
    canvas[: SIZE // 4] = ramp[None, :, None]

    # 3) 가운데 원 — 리사이즈 품질(계단 현상)을 눈으로 확인하는 용도
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    centre = SIZE / 2
    inside = (yy - centre) ** 2 + (xx - centre) ** 2 <= (SIZE / 5) ** 2
    canvas[inside] = (0xF7, 0xF7, 0xF7)

    # 4) 우하단 체커보드 — 축소하면 모아레가 보인다
    cell = 16
    checker = ((yy // cell) + (xx // cell)) % 2 == 0
    corner = (yy > SIZE * 3 // 4) & (xx > SIZE * 3 // 4)
    canvas[corner & checker] = (0x20, 0x20, 0x20)
    canvas[corner & ~checker] = (0xE0, 0xE0, 0xE0)

    return canvas


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(build()).save(OUT, optimize=True)
    print(f"{OUT.relative_to(Path.cwd())} — {OUT.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
