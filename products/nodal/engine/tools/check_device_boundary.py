#!/usr/bin/env python
"""디바이스 경계 검사 — `torch.cuda` 류는 `devices.py` 에만 (M4 계약).

백엔드 분기는 한 번 흩어지면 되돌릴 수 없고, 빠뜨린 자리는 그 하드웨어를 가진
사람만 발견한다. 저자가 맥에서 개발하고 GPU 는 별도 리눅스 장비인 이 프로젝트
에서는 특히 그렇다. 그래서 이 검사가 있다 (`docs/design.md` §9.3).

## 왜 ruff 로 못 하나

`flake8-tidy-imports` 의 `banned-api` 는 **import 문만** 본다. 흔한 형태인
`torch.cuda.is_available()` 은 `import torch` 뒤의 속성 접근이라 지나친다.
게다가 모든 banned-api 위반이 `TID251` 하나로 보고되므로, `per-file-ignores` 로
`torch` 는 풀고 `torch.cuda` 는 막는 것이 불가능하다.

## 왜 grep 이 아니라 AST 인가

grep 은 docstring 과 주석의 산문도 잡는다. 이 저장소의 문서는 규칙 자체를
설명하느라 `torch.cuda` 를 자주 언급한다 — 실제로 첫 시도가 `models.py` 의
설명문에 걸렸다. AST 는 문자열과 주석을 애초에 보지 않는다.

torch 가 설치되어 있지 않아도 된다. import 하지 않고 파싱만 한다.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: 검사할 소스 트리.
SEARCH_ROOTS = ("packages", "apps", "tools")

#: `torch.<이것>` 이면 백엔드 질의로 본다.
BANNED_ATTRS = frozenset({"cuda", "mps"})

#: `torch.backends.<이것>` 이면 백엔드 질의로 본다. `torch.backends.cudnn` 처럼
#: 백엔드 선택과 무관한 것들이 있어서 한 겹 더 들어가 본다.
BANNED_BACKENDS = frozenset({"mps", "cuda"})

#: 유일한 예외. 이 경로가 바뀌면 여기도 바꾼다 — 그때 이 파일을 열어 보게 되는
#: 것이 의도다.
ALLOWED = ROOT / "packages/nodes-diffusion/src/nodal_nodes_diffusion/devices.py"


def _dotted(node: ast.AST) -> str | None:
    """`torch.backends.mps` 같은 속성 체인을 문자열로. 체인이 아니면 `None`."""
    parts: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if not isinstance(current, ast.Name):
        return None
    parts.append(current.id)
    return ".".join(reversed(parts))


def _is_banned(dotted: str) -> bool:
    parts = dotted.split(".")
    if parts[0] != "torch" or len(parts) < 2:
        return False
    if parts[1] in BANNED_ATTRS:
        return True
    return parts[1] == "backends" and len(parts) >= 3 and parts[2] in BANNED_BACKENDS


def violations(path: Path) -> list[tuple[int, str]]:
    """파일 하나에서 위반을 찾는다. 구문 오류는 ruff 의 몫이라 조용히 넘긴다."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError:
        return []

    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        # `torch.cuda.is_available()` — 가장 흔한 형태.
        if isinstance(node, ast.Attribute):
            dotted = _dotted(node)
            # 체인의 각 마디마다 Attribute 노드가 있으므로 가장 짧게 걸리는
            # 지점만 세면 중복이 없다. `torch.cuda` 는 잡고
            # `torch.cuda.is_available` 은 그 부모라 건너뛴다.
            if dotted and _is_banned(dotted) and not _is_banned(dotted.rsplit(".", 1)[0]):
                found.append((node.lineno, dotted))
        # `import torch.cuda`
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if _is_banned(alias.name):
                    found.append((node.lineno, f"import {alias.name}"))
        # `from torch.cuda import ...`
        elif isinstance(node, ast.ImportFrom) and node.module and _is_banned(node.module):
            found.append((node.lineno, f"from {node.module} import ..."))
    return found


def main() -> int:
    failures: list[str] = []
    for root in SEARCH_ROOTS:
        for path in sorted((ROOT / root).rglob("*.py")):
            if path == ALLOWED or "node_modules" in path.parts or ".venv" in path.parts:
                continue
            for lineno, what in violations(path):
                failures.append(f"{path.relative_to(ROOT)}:{lineno}: {what}")

    if failures:
        print("::error::백엔드 질의는 nodal_nodes_diffusion/devices.py 에서만 한다.")
        print("::error::노드는 ctx.models.plan 이 주는 DevicePlan 을 쓴다 — nodal/models.py 참조.")
        for line in failures:
            print(f"  {line}")
        return 1

    print(f"디바이스 경계 확인 — 예외는 {ALLOWED.relative_to(ROOT)} 하나뿐이다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
