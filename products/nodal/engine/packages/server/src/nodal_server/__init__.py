"""nodal 서버 — FastAPI REST + WebSocket (docs/design.md §6).

M2 에서 채운다. 지금은 의존성 방향을 고정하기 위한 자리다:
`server` 는 `nodal`(core)을 import 하고, core 는 server 를 모른다.
"""

__all__: list[str] = []
__version__ = "0.0.0"
