"""모델 디렉토리 스캐너 → `register_combo_provider` (roadmap M4).

`Combo.from_provider("checkpoints")` 가 부를 공급자를 등록한다. core 는 공급자가
무엇을 세는지 모른다 — 체크포인트 디렉토리를 훑는 것은 이 팩의 일이다
(`nodal.schema.register_combo_provider`).

## 디렉토리 배치

    models/
      checkpoints/   *.safetensors · *.ckpt · diffusers 폴더
      loras/         *.safetensors
      vae/           *.safetensors · diffusers 폴더
      controlnet/    *.safetensors · diffusers 폴더

루트는 `NODAL_MODELS_DIR` 또는 `nodal serve --models DIR` 로 정한다. 없으면
스캔 결과가 빈 목록이고, 그것이 정상이다 — 모델 없이도 서버는 뜬다.

## 매번 새로 훑는다

`Combo.options()` 는 부를 때마다 공급자를 다시 호출한다. 그래서 사용자가 파일을
넣고 브라우저를 새로고침하면 바로 보인다. 캐시하지 않는 이유는 캐시 무효화
시점을 정할 방법이 없어서다 — 파일시스템 감시는 M6 확장 시스템과 함께 온다.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Sequence
from pathlib import Path

from nodal.schema import register_combo_provider

__all__ = [
    "MODELS_ENV_VAR",
    "PROVIDERS",
    "models_root",
    "register_providers",
    "resolve",
    "scan",
    "set_models_root",
]

_log = logging.getLogger("nodal.diffusion.scanner")

#: 모델 루트를 환경변수로 주는 이름.
MODELS_ENV_VAR = "NODAL_MODELS_DIR"

#: 공급자 이름 → (하위 디렉토리, 허용 확장자).
#:
#: 공급자 이름은 `Combo.from_provider(...)` 가 쓰는 문자열이고 노드 스키마에
#: 그대로 실려 프론트로 간다. 바꾸면 그래프 문서가 아니라 **UI 가** 깨진다.
PROVIDERS: dict[str, tuple[str, tuple[str, ...]]] = {
    "checkpoints": ("checkpoints", (".safetensors", ".ckpt")),
    "loras": ("loras", (".safetensors",)),
    "vae": ("vae", (".safetensors", ".ckpt")),
    "controlnet": ("controlnet", (".safetensors",)),
}

_root: Path | None = None


def set_models_root(root: Path | str | None) -> None:
    """모델 루트를 지정한다. CLI 의 `--models` 가 부른다.

    `None` 이면 환경변수로 되돌아간다.
    """
    global _root
    _root = Path(root).expanduser() if root is not None else None
    if _root is not None:
        _log.info("모델 루트: %s", _root)


def models_root() -> Path | None:
    """현재 모델 루트. `set_models_root` → 환경변수 순으로 본다.

    존재하지 않는 경로여도 그대로 돌려준다 — 스캔이 빈 목록을 주고, 왜 비었는지
    는 `scan()` 의 로그가 말한다. 여기서 조용히 `None` 으로 바꾸면 오타 난 경로와
    설정하지 않은 경우를 구분할 수 없다.
    """
    if _root is not None:
        return _root
    from_env = os.environ.get(MODELS_ENV_VAR)
    return Path(from_env).expanduser() if from_env else None


def scan(provider: str) -> list[str]:
    """공급자 하나가 볼 항목 이름들. 정렬되어 있고 중복이 없다.

    단일 파일은 파일명 그대로, diffusers 폴더는 폴더명이다. 둘을 구분해서
    보여주지 않는 이유는 사용자가 고르는 것이 **모델**이지 파일 형식이
    아니기 때문이다 — 어느 로더를 쓸지는 `LoadCheckpoint` 가 판단한다.

    Raises:
        KeyError: 알 수 없는 공급자 이름일 때. 조용히 빈 목록을 주면 오타 난
            공급자와 모델이 없는 경우를 구분할 수 없다.
    """
    subdir, suffixes = PROVIDERS[provider]
    root = models_root()
    if root is None:
        return []

    directory = root / subdir
    if not directory.is_dir():
        _log.debug("%s 디렉토리가 없다: %s", provider, directory)
        return []

    found = {e.name for e in directory.iterdir() if _is_model(e, suffixes)}
    return sorted(found)


#: 폴더가 모델임을 알려주는 파일. `model_index.json` 은 파이프라인,
#: `config.json` 은 VAE · ControlNet 처럼 컴포넌트 하나짜리다.
_FOLDER_MARKERS = ("model_index.json", "config.json")


def _is_model(entry: Path, suffixes: tuple[str, ...]) -> bool:
    """이 항목이 고를 수 있는 모델인가. 숨김 파일은 아니다."""
    if entry.name.startswith("."):
        return False
    if entry.is_file():
        return entry.suffix in suffixes
    return entry.is_dir() and any((entry / m).is_file() for m in _FOLDER_MARKERS)


def resolve(provider: str, name: str) -> Path | None:
    """공급자 항목 이름을 실제 경로로 푼다. 없으면 `None`."""
    subdir, _ = PROVIDERS[provider]
    root = models_root()
    if root is None:
        return None
    candidate = root / subdir / name
    return candidate if candidate.exists() else None


def register_providers() -> None:
    """모든 공급자를 core 에 등록한다. 이 팩을 import 하면 자동으로 불린다.

    등록은 **호출 시점에 스캔하지 않는다.** 람다가 스캔을 미루므로, 서버가 뜨는
    시점에 모델 디렉토리가 없어도 문제가 없고 나중에 생기면 바로 보인다.
    """
    for provider in PROVIDERS:
        register_combo_provider(provider, _provider_fn(provider))


def _provider_fn(provider: str) -> Callable[[], Sequence[str]]:
    """공급자 하나를 닫는다.

    루프 변수를 그대로 캡처하면 전부 마지막 값을 본다 — 파이썬의 늦은 바인딩.
    함수를 하나 거쳐 값을 고정한다.
    """

    def options() -> Sequence[str]:
        return scan(provider)

    return options
