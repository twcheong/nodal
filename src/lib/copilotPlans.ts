// ─────────────────────────────────────────────────────────────────────────────
// copilotPlans.ts — Simple 모드 1회용 플랜 히스토리 저장 모듈.
//
// 대화별 plan_* 워크플로 스냅샷 "배열" 을 localStorage 에 영속한다. 예전엔
// 대화당 플랜 1개(단수 키)만 저장해 새 플랜이 이전 걸 덮어썼는데, 실사용에서
// 유저가 플랜을 여러 번 반복 생성한 뒤 전전/전전전 플랜으로 돌아가 보거나
// 재실행하거나 수정 요청하는 흐름이 필요해 히스토리로 확장했다.
//
// CopilotView(패널 셀렉터/칩)와 useCopilotChat(플랜 카탈로그 주입, 대화 삭제
// 정리)이 공유한다 — prop-drilling 대신 이 모듈이 단일 진실 공급원.
// ─────────────────────────────────────────────────────────────────────────────

// TwixyWorkflow + 이 플랜을 만든 어시스턴트 메시지 id — 채팅의 ⚡ 칩 클릭이
// 이 매핑으로 자기 플랜을 찾는다 (재시작 후에도 안전 — content 재매칭 아님).
export type CopilotPlan = TwixyWorkflow & { sourceMsgId?: string }

// 대화당 플랜 상한 — append 시 oldest evict. 1~4노드 플랜 20개는 몇 KB 수준.
export const MAX_PLANS_PER_CONV = 20

const plansKey   = (convId: string) => `twixy.copilot.plans.${convId}`   // 새 키 (배열)
const oldPlanKey = (convId: string) => `twixy.copilot.plan.${convId}`    // 구 키 (단수) — 마이그레이션용

export function loadPlansLS(convId: string): CopilotPlan[] {
  try {
    const raw = localStorage.getItem(plansKey(convId))
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr as CopilotPlan[]
    }
    // 새 키 미스 → 구 단수 키 lazy 마이그레이션 (배열로 감싸 새 키에 쓰고 구 키 삭제).
    const old = localStorage.getItem(oldPlanKey(convId))
    if (old) {
      const plan = JSON.parse(old) as CopilotPlan
      const arr = plan && typeof plan === 'object' ? [plan] : []
      localStorage.setItem(plansKey(convId), JSON.stringify(arr))
      localStorage.removeItem(oldPlanKey(convId))
      return arr
    }
  } catch { /* corrupt/quota — 빈 히스토리로 */ }
  return []
}

export function savePlansLS(convId: string, plans: CopilotPlan[]) {
  try { localStorage.setItem(plansKey(convId), JSON.stringify(plans.slice(-MAX_PLANS_PER_CONV))) } catch { /* ignore */ }
}

// 대화 삭제 시 호출 — 새 키 + 구 키 모두 제거 (구 키는 예전부터 미정리 누수였음).
export function removePlansLS(convId: string) {
  try {
    localStorage.removeItem(plansKey(convId))
    localStorage.removeItem(oldPlanKey(convId))
  } catch { /* ignore */ }
}

// ── LLM 페이로드용 플랜 히스토리 카탈로그 ────────────────────────────────────
// simple 플래너에게 "이 대화에서 이미 만든 플랜들" 을 알려줘 "plan 2 고쳐줘"
// 같은 지칭을 가능하게 한다. 번호(#N)는 저장 배열의 절대 위치(1-base)라 패널
// 드롭다운의 #N 과 항상 일치. 토큰 절약: 마지막 8개, 노드 타이틀만(40자 클립).
// 플랜이 0~1개면 빈 문자열 (지칭할 "이전" 이 없음).
export function buildPlanHistoryCatalog(convId: string): string {
  const plans = loadPlansLS(convId)
  if (plans.length <= 1) return ''
  const start = Math.max(0, plans.length - 8)
  const lines = plans.slice(start).map((p, i) => {
    const n = start + i + 1
    const steps = (p.nodes ?? []).map(nd => {
      const t = nd.title ?? ''
      return t.length > 40 ? t.slice(0, 40) + '…' : t
    }).join('; ')
    return `#${n} "${p.title}" — ${p.nodes?.length ?? 0} step${(p.nodes?.length ?? 0) === 1 ? '' : 's'}: ${steps}`
  })
  return [
    '[Plan history — one-time plans already created in this conversation, oldest first. The numbers match the plan selector the user sees.]',
    ...lines,
    'When the user refers to a previous plan ("plan 2", "the first plan", "run it again but…"), emit a NEW ```simple-plan``` based on that plan with the requested changes applied. Plans are immutable snapshots — a modification is always a NEW plan, never an edit. If this list only shows step titles and you no longer have that plan\'s full node details in context, reconstruct equivalent steps from the titles and the conversation.',
    '',
  ].join('\n')
}
