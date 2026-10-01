#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv 를 찾을 수 없습니다: https://docs.astral.sh/uv/" >&2
  exit 1
fi

exec uv run --no-project python tools/launch.py "$@"
