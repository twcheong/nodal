"""Adapter for the reviewed, external Apache-2.0 diffusers H3 Pruned model.

The model implementation stays beside the user's weights, outside nodal. Only
the reviewed bytes are executed; no general trust_remote_code switch is exposed.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

REPOSITORY = "multimodalart/MiniMax-H3-Pruned"
REVISION = "1a0ef5e65b639e84af81d883817968532180e9c7"
SOURCE_NAME = "modeling_minimax_h3_pruned.py"
SOURCE_SHA256 = "fe56b6b6b43d18ef4c46d98f5aa5b5bcac99be5412bbfa25a6bbfed1348ada47"
CLASS_NAME = "MiniMaxH3PrunedTransformer3DModel"
CONVROT_PROFILE = "pruned_convrot_int8_offload"


def is_pruned(root: Path) -> bool:
    config = root / "transformer" / "config.json"
    if not config.is_file():
        return False
    value = json.loads(config.read_text(encoding="utf-8"))
    return isinstance(value, dict) and value.get("_class_name") == CLASS_NAME


def reviewed_source(root: Path) -> bytes:
    """Read and validate before importing torch or executing any model code."""
    source = (root / "transformer" / SOURCE_NAME).read_bytes()
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError(
            f"H3 Pruned 로더가 검토한 버전과 다르다. {REPOSITORY}@{REVISION}의 "
            f"transformer/{SOURCE_NAME}이 필요하다. docs/minimax-h3.md 참고."
        )
    return source


def model_class(root: Path) -> Any:
    source = reviewed_source(root)
    name = f"_nodal_h3_pruned_{SOURCE_SHA256}"
    if name not in sys.modules:
        module = ModuleType(name)
        module.__file__ = str(root / "transformer" / SOURCE_NAME)
        sys.modules[name] = module
        try:
            exec(compile(source, module.__file__, "exec"), module.__dict__)
        except BaseException:
            sys.modules.pop(name, None)
            raise
    return getattr(sys.modules[name], CLASS_NAME)
