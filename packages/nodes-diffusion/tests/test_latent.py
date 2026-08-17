"""잠재 크기 계산과 `EmptyLatent` 실행.

`latent_size` 는 torch 없이 돌고, `EmptyLatent.run` 은 `importorskip` 으로
런타임이 있을 때만 돈다. CI 의 diffusion 잡이 그쪽을 담당한다.
"""

from __future__ import annotations

import pytest

from nodal_nodes_diffusion import EmptyLatent, KSampler
from nodal_nodes_diffusion.latent import LATENT_CHANNELS, VAE_SCALE_FACTOR, latent_size

# ------------------------------------------------------------------ 크기 계산


def test_latent_size_divides_by_the_vae_factor():
    assert latent_size(1024, 1024) == (128, 128)
    assert latent_size(1216, 832) == (104, 152)  # (rows, cols) — 높이가 앞이다


def test_latent_size_refuses_to_round_silently():
    # 1000 을 넣고 1024 결과를 받으면 사용자가 놀란다. 어느 쪽이든 놀랄 거라면
    # **왜** 다른 크기가 되는지 말하는 편이 낫다.
    with pytest.raises(ValueError) as caught:
        latent_size(999, 1024)
    message = str(caught.value)
    assert "width=999" in message
    assert str(VAE_SCALE_FACTOR) in message
    assert "992" in message  # 가까운 값을 알려준다


def test_latent_size_names_the_offending_axis():
    with pytest.raises(ValueError, match="height=513"):
        latent_size(1024, 513)


def test_latent_size_rejects_nonpositive():
    with pytest.raises(ValueError, match="양수"):
        latent_size(0, 512)


# -------------------------------------------------------------------- 실행


def test_empty_latent_shape():
    torch = pytest.importorskip("torch")

    out = EmptyLatent().run(width=512, height=256, batch_size=2)
    latent = out.values[0] if hasattr(out, "values") else out

    assert latent.shape == (2, LATENT_CHANNELS, 32, 64)  # (B, C, H/8, W/8)
    assert latent.dtype == torch.float32
    assert bool(latent.abs().sum() == 0)


def test_ksampler_run_is_not_implemented_yet():
    # 이 커밋은 스키마만 노출한다. 조용히 0 을 돌려주는 것보다 명시적으로
    # 실패하는 편이 낫다 — 아니면 프론트가 "돌았는데 결과가 이상하다" 를 본다.
    pytest.importorskip("torch")

    with pytest.raises(NotImplementedError, match="ModelManager"):
        KSampler().run(
            model=object(),
            positive=object(),
            negative=object(),
            latent=object(),
            seed=0,
            steps=20,
            cfg=7.0,
            sampler_name="euler",
            scheduler="normal",
            denoise=1.0,
            ctx=None,  # type: ignore[arg-type]
        )
