// ─────────────────────────────────────────────────────────────────────────────
// runnerHarness — 실행 러너(workflow-runner) 추론 하네스 주입.
//
// modest 모델(MiniMax)은 얇게 두면 입력을 skim 하고 쉬운 부분만 답하고 멈춘다.
// v3 "추론·철저"(WORKFLOW_RUNNER_V3_SOUL.md) 하네스를 첫 노드에 prepend 하면 모든
// 항목을 커버하고 명시적으로 추론해 결과 품질이 오른다.
//   A/B(SEO Action Plan, n=5): v3 품질 8.3 vs baseline 6.95 (+19%), 비용도 저렴.
// 그래서 기본 ON — 릴리즈 기본 동작이다.
//
// 끄기(디버깅 / baseline 비교용): localStorage.setItem('twixy.runnerHarness','off')
//   되켜기: localStorage.removeItem('twixy.runnerHarness')
//
// 과거 v2 "툴 절약" 하네스는 오히려 조기 종료를 유도해 품질을 해쳤다(A/B 1~3점) →
// 폐기. WORKFLOW_RUNNER_V2_SOUL.md 는 A/B 기록으로만 남긴다.
// ─────────────────────────────────────────────────────────────────────────────

import { harnessPreambleFor, type HarnessVariant } from './agents/harness'

// 값이 정확히 'off' 일 때만 하네스를 끈다. 그 외(미설정 포함) = ON.
const DISABLE_KEY = 'twixy.runnerHarness'

function harnessEnabled(): boolean {
  try { return localStorage.getItem(DISABLE_KEY) !== 'off' } catch { return true }
}

/** 렌더러의 플래그를 읽어 변종을 고른다. 순수 코드는 이걸 부르지 말고 변종을 직접 넘길 것. */
export function currentHarnessVariant(): HarnessVariant {
  return harnessEnabled() ? 'v3' : 'off'
}

/** 하네스가 켜져 있으면(기본) 첫 노드에 prepend 할 블록을, 꺼져 있으면 '' 를 반환. */
export function runnerHarnessPreamble(): string {
  return harnessPreambleFor(currentHarnessVariant())
}

/** 실행 기록(RunHistoryEntry.harness)용 라벨. ON=현재 하네스 버전, OFF=baseline. */
export function harnessLabel(): HarnessVariant {
  return currentHarnessVariant()
}

// ── self-check ───────────────────────────────────────────────────────────────
// 기본 ON, 'off' 만 비활성인지 assert 하나로.
export function __selfCheck(): void {
  const gate = (flag: string | null) => harnessPreambleFor(flag === 'off' ? 'off' : 'v3')
  console.assert(gate(null).startsWith('[Runner Harness'), 'default(미설정) → ON')
  console.assert(gate('off') === '', "'off' → empty")
  console.assert(gate(null).includes('Reasoning'), 'ON → v3 SOUL 본문 포함')
}
