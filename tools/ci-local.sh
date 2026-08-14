#!/usr/bin/env bash
#
# CI 를 로컬에서 재현한다.
#
# ⚠️ 이 스크립트는 .github/workflows/ci.yml 의 복사본이 아니다.
#    실행할 명령을 여기 적어두지 않고, ci.yml 을 파싱해서 거기 있는 `run:` 블록을
#    그대로 꺼내 실행한다. ci.yml 이 유일한 출처다.
#
#    복사본을 만들면 반드시 어긋난다 — AGENTS.md 가 CLAUDE.md/AGENTS.md 에 대해
#    말하는 것과 같은 이유다. 검사를 하나 추가했는데 로컬 스크립트에 옮기는 걸
#    잊으면, 로컬은 초록인데 CI 는 빨간 상태가 다시 생긴다.
#
# 쓰는 법:
#   tools/ci-local.sh              # 재현 가능한 잡 전부
#   tools/ci-local.sh python web   # 지정한 잡만
#
# 커밋 전에 돌린다. 일부만 돌리고 "통과"라고 하지 않기 위한 도구다.

set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root" || exit 1

workflow=".github/workflows/ci.yml"
[ -f "$workflow" ] || { echo "❌ $workflow 이 없다."; exit 1; }

# ci.yml 을 읽어 (job, step, 실행가능여부, 사유, 스크립트) 레코드를 뱉는다.
# 필드 구분 US(\x1f), 레코드 구분 RS(\x1e) — run 블록이 여러 줄이라 개행은 못 쓴다.
plan=$(uv run python - "$workflow" "$@" <<'PY'
import sys, yaml

path, *want = sys.argv[1:]
spec = yaml.safe_load(open(path, encoding="utf-8"))
jobs = spec.get("jobs") or {}
if not jobs:
    sys.exit(f"{path} 에서 job 을 찾지 못했다. 워크플로 구조가 바뀌었나?")

if want:
    unknown = [w for w in want if w not in jobs]
    if unknown:
        sys.exit(f"그런 job 이 없다: {', '.join(unknown)}. 있는 것: {', '.join(jobs)}")
    jobs = {k: v for k, v in jobs.items() if k in want}

US, RS = "\x1f", "\x1e"
out = []
for job_id, job in jobs.items():
    # 잡 수준 if 는 GitHub 이벤트 컨텍스트라 로컬에 대응물이 없다 (예: dco 는 PR 전용).
    job_gate = job.get("if")
    for step in job.get("steps") or []:
        script = step.get("run")
        # ci.yml 에는 이름 없는 `- run:` 단계가 있다. 그럴 땐 명령 첫 줄을 이름으로 쓴다.
        name = step.get("name") or step.get("uses")
        if not name:
            first = (script or "").strip().splitlines()[0] if script else ""
            name = first if len(first) <= 60 else first[:57] + "..."
        if script is None:
            # actions/checkout, setup-node 같은 액션. 로컬에 해당하는 것이 없다.
            ok, why = "skip", "액션 단계 (로컬 대응물 없음)"
        elif job_gate:
            ok, why = "skip", f"잡 조건: if {job_gate}"
        elif "${{" in script:
            # GitHub 표현식이 들어간 명령은 컨텍스트 없이 그대로 돌릴 수 없다.
            ok, why = "skip", "GitHub 표현식(${{ }}) 사용 — 이벤트 컨텍스트 필요"
        elif step.get("if"):
            ok, why = "skip", f"단계 조건: if {step['if']}"
        else:
            ok, why = "run", ""
        out.append(US.join([job_id, name, ok, why, script or ""]))
print(RS.join(out), end="")
PY
) || exit 1

US=$'\x1f'
RS=$'\x1e'

passed=0; failed=0; skipped=0
failed_names=()
skipped_names=()
current_job=""

while IFS= read -r -d "$RS" record || [ -n "$record" ]; do
  [ -n "$record" ] || continue

  # `read` 로 필드를 나누지 말 것. run 블록은 여러 줄인데 read 는 첫 개행에서
  # 잘라버려서, 실제로는 첫 줄만 실행하고 통과했다고 보고한다 (실제로 겪었다).
  # 파라미터 확장으로 자르면 개행이 보존된다.
  rest="$record"
  job="${rest%%"$US"*}";  rest="${rest#*"$US"}"
  name="${rest%%"$US"*}"; rest="${rest#*"$US"}"
  ok="${rest%%"$US"*}";   rest="${rest#*"$US"}"
  why="${rest%%"$US"*}";  script="${rest#*"$US"}"

  if [ "$job" != "$current_job" ]; then
    printf '\n== job: %s ==\n' "$job"
    current_job="$job"
  fi

  if [ "$ok" = "skip" ]; then
    printf '  --  %s  (%s)\n' "$name" "$why"
    skipped=$((skipped + 1))
    skipped_names+=("$job / $name — $why")
    continue
  fi

  # GitHub 의 리눅스 러너 기본 셸과 같은 조건으로 돌린다.
  if output=$(bash --noprofile --norc -eo pipefail -c "$script" 2>&1); then
    printf '  ✅  %s\n' "$name"
    passed=$((passed + 1))
  else
    printf '  ❌  %s\n' "$name"
    printf '%s\n' "$output" | tail -30 | sed 's/^/        /'
    failed=$((failed + 1))
    failed_names+=("$job / $name")
  fi
done <<<"$plan"

printf '\n----\n통과 %d · 실패 %d · 건너뜀 %d\n' "$passed" "$failed" "$skipped"

if [ "$skipped" -gt 0 ]; then
  printf '\n건너뛴 단계 (CI 에서만 검증된다):\n'
  printf '  · %s\n' "${skipped_names[@]}"
fi

if [ "$failed" -gt 0 ]; then
  printf '\n실패:\n'
  printf '  · %s\n' "${failed_names[@]}"
  exit 1
fi

printf '\n로컬에서 재현 가능한 검사는 전부 통과했다.\n'
