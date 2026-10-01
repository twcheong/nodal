import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { User } from '@supabase/supabase-js'
import { Sidebar } from './components/Sidebar'
import { UpdateBanner } from './components/UpdateBanner'
import { ChatPanel } from './components/ChatPanel'
import { FilesPanel } from './components/FilesPanel'
import { WorkflowTab } from './components/WorkflowTab'
import { WorkflowListsPanel } from './components/WorkflowListsPanel'
import { WorkflowView } from './components/WorkflowView'
import { CopilotView } from './components/copilot/CopilotView'
import { OrchestrationView } from './components/OrchestrationView'
import { LiveBrowserPreview } from './components/workflow/LiveBrowserPreview'
import { useWorkflows } from './hooks/useWorkflows'
import type { WorkflowTestState } from './hooks/useWorkflowTest'
import { TeamDashboardPanel } from './components/TeamDashboardPanel'
import { lazyPanel } from './components/LazyPanel'
import { StatusBar } from './components/StatusBar'
import { LoginScreen } from './components/LoginScreen'
import { ConnectingSplash } from './components/ConnectingSplash'
import { SetupScreen } from './components/SetupScreen'
import { UpgradeModal } from './components/UpgradeModal'
import { NoCreditsModal } from './components/NoCreditsModal'
import { useGuardrail } from './hooks/useGuardrail'
import { useOpenClaw } from './hooks/useOpenClaw'
import type { ChatMessageAction } from './hooks/useOpenClaw'
import { usePlans } from './hooks/usePlans'
import { useAuth } from './hooks/useAuth'
import { useEntitlements } from './hooks/useEntitlements'
import { useOrg } from './hooks/useOrg'
import { useMemberCredits } from './hooks/useMemberCredits'
import { useProjectDir } from './hooks/useProjectDir'
import { FREE_PLAN } from './lib/entitlements'
import './styles/globals.css'
import { PRODUCT, type View } from './lib/product'
import { getProductView, setShellNavigator } from './lib/productShell'
import { BACKEND_CONFIGURED } from './lib/supabase'

// ─────────────────────────────────────────────────────────────────────────────
// App.tsx — 렌더러(React)의 최상위 컴포넌트.
//
// 역할:
//  1) Supabase 인증 게이트 (비로그인 사용자는 LoginScreen)
//  2) OpenClaw 게이트웨이 상태에 따른 화면 분기 (Setup / Splash / 메인)
//  3) 주요 패널(Chat, Data, Dashboard, Skills, MR, Admin, Settings)을
//     CSS display 토글로 "항상 마운트" — 탭 이동 시 스크롤/세션이 유지된다.
//  4) Entitlements(무료/유료 쿼터) 선검증 래퍼로 sendMessage 감싸기
//  5) 대시보드 세션을 App 수준에 유지해 Data → Dashboard 워크플로우 연결
// ─────────────────────────────────────────────────────────────────────────────

// 사이드바에서 선택 가능한 뷰 종류.
// data/strategies/reports 셋은 실제로는 같은 DataPanel 을 공유한다(하단 dataActive 참고).
// View 유니온의 단일 출처는 shared/product/types.ts (Sidebar 와 공유).

// 첫 방문 때 코드를 받는 패널 — 실행·구독·게이트웨이 세션을 소유하지 않는 순수 UI 만
// (분류: docs/refactor/d0-panel-classification.md 의 B). Copilot/Workflow/Orchestration/
// TeamDashboard/chat 은 숨겨진 채로도 돌아야 해서 정적 import 로 남긴다 (단 features.panels 에
// 없는 제품에서는 아예 마운트하지 않는다 — 아래 has()).
const DataPanel         = lazyPanel(() => import('./components/DataPanel').then(m => m.DataPanel))
const SkillsPanel       = lazyPanel(() => import('./components/SkillsPanel').then(m => m.SkillsPanel))
const MergeRequestPanel = lazyPanel(() => import('./components/MergeRequestPanel').then(m => m.MergeRequestPanel))
const SettingsPanel     = lazyPanel(() => import('./components/SettingsPanel').then(m => m.SettingsPanel))
// admin 슬롯은 제품 플래그로 둘 중 하나만 쓴다 — 안 쓰는 쪽은 아예 받지 않는다.
const AdminSlot = lazyPanel(() => PRODUCT.features.enterpriseAdmin
  ? import('./admin/TwixyEnterpriseDashboard').then(m => m.TwixyEnterpriseDashboard)
  : import('./components/AdminPanel').then(m => m.AdminPanel))

// 이 제품이 마운트하는 패널 (profile 의 features.panels). 없는 패널은 숨긴 채로도 돌지 않는다.
const PANELS: ReadonlySet<View> = new Set(PRODUCT.features.panels)
const has = (v: View) => PANELS.has(v)
// 제품이 등록한 탭 중 이 제품이 쓰는 것. ⚠ 모듈 최상위에서 계산하면 안 된다 — products/<id>/renderer/
// main.tsx 는 App 을 import 한 **뒤에** registerProductView 를 부르므로, 이 파일이 평가되는 시점엔
// 레지스트리가 비어 있다 (사이드바만 보이고 본문이 비던 버그). 렌더 때 읽는다.
function productViews() {
  return PRODUCT.features.panels
    .map(id => getProductView(id))
    .filter((v): v is NonNullable<typeof v> => !!v)
}

export default function App() {
  // 전체 앱을 Supabase 인증 뒤로 게이팅한다.
  // useOpenClaw / useDashboardClaw 등 무거운 훅은 로그인 이후에만 마운트되도록
  // AuthedApp 을 분리했다 — 익명 사용자에 대해 WS 연결/에이전트 세션을 시작하지 않기 위함.
  const { user, loading: authLoading, signIn } = useAuth()

  // 백엔드(Supabase·웹 API)가 아직 없는 제품 — 로그인 버튼을 눌러도 갈 곳이 없으므로
  // 그 사실을 그대로 보여준다.
  if (!BACKEND_CONFIGURED) {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
        background: 'var(--bg-base, #fafaf6)', color: 'var(--text-primary, #14201b)',
        fontFamily: 'system-ui, sans-serif', padding: 40, textAlign: 'center',
      }}>
        <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.02em' }}>{PRODUCT.displayName}</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted, #4a594f)', maxWidth: 420, lineHeight: 1.6 }}>
          Sign-in is not available yet — this build has no account backend configured
          (<code>products/{PRODUCT.id}/profile.ts</code> → <code>supabase</code>, <code>webUrl</code>).
        </div>
      </div>
    )
  }

  if (authLoading) {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-base, #fafaf6)',
        color: 'var(--text-muted, #4a594f)', fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
      }}>Loading…</div>
    )
  }

  if (!user) {
    return <LoginScreen onSignIn={signIn} />
  }

  return <AuthedApp user={user} />
}

// 로그인 완료 이후 실제 UI 본체.
// 여기서부터 비로소 OpenClaw WebSocket 세션과 대시보드 세션을 시작한다.
function AuthedApp({ user }: { user: User }) {
  // twixy-enterprise 모드에서는 admin 탭이 기본 뷰.
  // twixy 기본 랜딩은 채팅-퍼스트 Copilot 뷰 — 입력하면 워크플로 빌더가 팝업.
  // (기존 chat 패널도 계속 마운트되어 Smart Export 등 내부 라우팅에 쓰인다.)
  const [activeView, setActiveView] = useState<View>(PRODUCT.features.initialView)
  // 한 번이라도 연 뷰. lazy 패널은 여기 들어오기 전에는 렌더하지 않는다 — 숨긴 채로라도 렌더하면
  // import() 가 즉시 시작돼 분리한 의미가 없다. 한번 들어오면 빠지지 않으므로 그 뒤로는 기존과 똑같이
  // 계속 마운트 + display 토글이다. effect 가 아니라 렌더 중에 맞추는 이유: effect 로 하면
  // 탭을 누른 첫 프레임에 패널 자리가 비어 보인다.
  const [visited, setVisited] = useState<ReadonlySet<View>>(() => new Set([activeView]))
  if (!visited.has(activeView)) setVisited(new Set(visited).add(activeView))
  // 제품 코드가 탭을 바꿀 수 있게 (src/lib/productShell.ts navigateToView).
  useEffect(() => {
    setShellNavigator(setActiveView)
    return () => setShellNavigator(null)
  }, [])
  const [fileToOpen, setFileToOpen] = useState<string | null>(null)   // ChatPanel 에서 특정 파일을 DataPanel 로 열 때 사용
  const [setupError, setSetupError] = useState<string | null>(null)   // 기동 오류(Node 22 누락 등)

  // Marketing IDE 셸 상태 — chat 뷰에서만 의미가 있다. activeView 가 다른 곳으로
  // 옮겨가도 메모리에 남아 다시 돌아왔을 때 사용자 선택이 보존된다.
  const workflowsApi = useWorkflows()
  // 조직/크레딧 상태 — 팀 공유 대시보드, 크레딧 표시, 전송 선검증 게이트에 사용.
  // team 이 꺼진 제품은 org 테이블이 없는 백엔드를 쓴다 — userId 를 안 넘기면 조회 자체를 안 한다.
  const { orgIds, adminOrgIds, primaryOrgId, loading: orgLoading, refresh: refreshOrg } = useOrg(PRODUCT.features.team ? user.id : undefined)
  const memberCredits = useMemberCredits(user.id, primaryOrgId)
  // 신원 컨텍스트 — 워크플로 공유(shareCtx)와 CT 탭 이슈 리포트(reportCtx)가 함께
  // 쓴다. useMemo 로 참조를 고정 — CopilotView 가 이 값을 useCallback 의존성에
  // 넣기 때문 (useOrg 의 orgIds 는 이미 참조 안정화돼 있다).
  const identityCtx = useMemo(() => ({
    userId:       user.id,
    userEmail:    user.email ?? null,
    userName:     (user.user_metadata?.full_name as string) ?? (user.user_metadata?.name as string) ?? null,
    orgIds,
    primaryOrgId,
  }), [user.id, user.email, user.user_metadata, orgIds, primaryOrgId])
  const [activeWorkflowId,     setActiveWorkflowId]     = useState<string | null>(null)
  const [activeOrchestrationId, setActiveOrchestrationId] = useState<string | null>(null)
  // Runs 대시보드 브리지 — WorkflowView(항상 마운트)가 라이브 run 상태를 올리고
  // Stop/Resume 제어를 ref 로 노출. 대시보드 탭이 소비한다.
  const [liveRunStates, setLiveRunStates] = useState<Record<string, WorkflowTestState>>({})
  const runControlRef = useRef<{
    stop:          (workflowId: string) => void
    resume:        (workflow: TwixyWorkflow) => void
    startFromNode: (workflow: TwixyWorkflow, nodeId: string) => void
  } | null>(null)
  const [workflowTabCollapsed, setWorkflowTabCollapsed] = useState(false)
  const [leftPanelCollapsed,   setLeftPanelCollapsed]   = useState(false)
  const [rightPanelCollapsed,  setRightPanelCollapsed]  = useState(false)
  // Live browser preview in chat — Chrome is always headless, so this panel is
  // how the user watches / drives the browser during chat automations.
  const [chatPreviewOpen,      setChatPreviewOpen]      = useState(false)
  const activeWorkflow = activeWorkflowId
    ? (workflowsApi.workflows.find(w => w.id === activeWorkflowId) ?? null)
    : null

  // Main window fullscreen state. In fullscreen the native traffic-light
  // buttons (macOS) disappear, so the custom titlebar's 80px left padding
  // becomes wasted space and the title text shifts off-center. We also
  // collapse the titlebar height entirely in fullscreen — there's nothing
  // to drag and giving back 38px of vertical real estate looks cleaner
  // with the new 3-column Marketing IDE layout.
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    if (!window.twixy?.onMainFullscreenChanged) return
    const off = window.twixy.onMainFullscreenChanged(setIsFullscreen)
    return () => off()
  }, [])

  // 메인 OpenClaw 세션(챗 UX의 심장). 상태/메시지/전송/중단/재연결 등을 제공한다.
  const openclaw = useOpenClaw()
  const guardrail = useGuardrail(openclaw.resolveGuardrail)
  const { messages, status, errorMsg, isThinking, toolActivity, toolStats, sendMessage: rawSendMessage, abortMessage, reconnect, fetchUsageCost, resetUsageBaseline, liveUsage, clearChat } = openclaw

  // ── Planning Mode wiring ────────────────────────────────────────
  // 토글 상태는 localStorage 에 사용자별로 영속. 기본값 ON — 모든 프롬프트가
  // 플래너로 라우팅되며, composer 칩에서 명시적으로 끌 수 있다.
  const [planMode, setPlanMode] = useState<boolean>(() => {
    try { return localStorage.getItem('twixy.planModeEnabled') !== 'false' } catch { return true }
  })
  const togglePlanMode = useCallback(() => {
    setPlanMode(v => {
      const next = !v
      try { localStorage.setItem('twixy.planModeEnabled', String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  const [planGenerating, setPlanGenerating] = useState(false)
  // 이번 세션에서 가장 최근 생성된 plan id. draft/paused 상태일 때
  // 후속 채팅 메시지를 새 플랜이 아닌 기존 플랜의 수정으로 라우팅하기 위함.
  const activePlanIdRef = useRef<string | null>(null)

  const plans = usePlans({
    addUserMessage:    openclaw.addUserMessage,
    insertPlanMessage: openclaw.insertPlanMessage,
    patchMessage:      openclaw.patchMessage,
    removeMessage:     openclaw.removeMessage,
    sendAndAwaitFinal: openclaw.sendAndAwaitFinal,
    abortMessage:      openclaw.abortMessage,
    addSystemMessage:  openclaw.addSystemMessage,
    getSessionKey:     openclaw.getSessionKey,
    setRejectNewRuns:  openclaw.setRejectNewRuns,
    killActiveSubagents: openclaw.killActiveSubagents,
    setRequesterAnnounceFrozen: openclaw.setRequesterAnnounceFrozen,
    resetSession:       openclaw.resetSession,
    getSessionMessages: openclaw.getSessionMessages,
  })

  // 렌더러 (재)마운트 시 워크플로 슬롯 전역 lease 정리 — 리로드/재로그인으로
  // 훅 인스턴스가 사라지면 run 도 죽으므로 main 장부에 남은 lease 는 유령이다.
  useEffect(() => {
    void window.twixy?.wfSlotClearAll?.()
  }, [])

  // 경합 상태 방어 ①: openclaw-error 이벤트가 이 컴포넌트 마운트 전에 발사되었다면
  // IPC 이벤트는 유실되어 status 가 영원히 'connecting' 에 갇힌다.
  // 메인 프로세스가 버퍼링해둔 마지막 에러를 첫 렌더에 강제 조회한다.
  useEffect(() => {
    if (!window.twixy?.getStartupError) return
    window.twixy.getStartupError().then(err => {
      if (err) setSetupError(err)
    })
  }, [])

  // 경합 상태 방어 ②: 마운트 이후 발생하는 에러(예: 재시도 실패)도 실시간 수신.
  useEffect(() => {
    if (!window.twixy?.onOpenClawError) return
    return window.twixy.onOpenClawError(err => setSetupError(err))
  }, [])

  // NOTE: setupError 분기는 hook 호출이 모두 끝난 뒤(아래쪽, `status === 'connecting'`
  // 직전)에서 평가한다. 이 위치에서 early return 을 하면 setupError 가 null → 값으로
  // 바뀔 때 두 번째 렌더의 hook 개수가 첫 렌더보다 적어져 React error #300
  // (Rendered fewer hooks than expected) 으로 폭발 → 화면이 검정으로 굳는다.
  // 본인 머신에서는 startup error 가 발생하지 않아 분기 자체를 안 타서 안 드러나고,
  // 다른 머신(예: M4 Max, 첫 실행에서 Node22 누락 등)에서만 재현되던 원인이다.

  // 구독 플랜/쿼터. Free 는 일일 메시지 50건, Pro 2000건 등의 상한을 관리한다.
  const ent = useEntitlements()
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [upgradeReason, setUpgradeReason] = useState<'messages' | 'schedules'>('messages')
  const [noCreditsOpen, setNoCreditsOpen] = useState(false)

  const { projectDir, loading: projDirLoading, setting: projDirSetting, pickAndSet: pickProjectDir } = useProjectDir()

  // 모델 이용 모드. Twixy 호스팅(=서버 모델 사용) vs BYOK(사용자 API 키 사용).
  // 상태바에 표시되는 지표(메시지 수 vs 토큰/USD)가 이 값에 따라 달라진다.
  const [isTwixyHosting, setIsTwixyHosting] = useState(true)
  useEffect(() => {
    window.twixy?.getTwixyMode?.().then((m: string) => setIsTwixyHosting(m !== 'byok'))
  }, [])

  // sendMessage 를 래핑하여 매 전송마다 일일 메시지 한도를 선검증한다.
  // Free 50/day, Pro 2000/day. 한도 초과 또는 네트워크 실패 시 UpgradeModal 을 띄운다.
  // Planning Mode ON 이면 프롬프트가 플래너로 라우팅되고, 이미 draft/paused 플랜이
  // 있으면 새 플랜이 아닌 기존 플랜의 수정으로 처리된다.
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return
    try {
      const result = await ent.recordUsage('message', 1)
      if (!result.allowed) {
        setUpgradeReason('messages')
        setUpgradeOpen(true)
        return
      }
    } catch (err) {
      // 실패 시 CLOSED 정책: entitlements API 가 닿지 않으면 로컬 카운터를 신뢰할 수 없으므로
      // 전송을 거부하고 연결성 힌트와 함께 업그레이드 모달을 띄운다.
      // 이렇게 안 하면 무료 사용자가 일부러 Wi-Fi 를 끊어 한도를 우회할 수 있다.
      console.warn('[twixy/entitlements] preflight failed, blocking send:', err)
      setUpgradeReason('messages')
      setUpgradeOpen(true)
      return
    }
    // 회사 크레딧 게이트: 팀 소속 멤버가 개인 잔액을 소진하면 전송 차단.
    // balance === null 이면 조직 미소속(솔로) → 크레딧 미터링 대상 아님(통과).
    if (memberCredits.balance !== null && memberCredits.balance <= 0) {
      setNoCreditsOpen(true)
      return
    }
    if (!planMode) {
      await rawSendMessage(text)
      return
    }
    // Route to updatePlanViaChat if we have an active draft/paused plan.
    const activeId = activePlanIdRef.current
    if (activeId) {
      try {
        const p = await window.twixy.planGet(activeId)
        if (p && (p.status === 'draft' || p.status === 'paused')) {
          await plans.updatePlanViaChat(activeId, text)
          return
        }
      } catch { /* fall through to creating a new plan */ }
    }
    setPlanGenerating(true)
    try {
      await plans.enterPlanMode(text)
    } finally {
      setPlanGenerating(false)
    }
  }, [ent, rawSendMessage, planMode, plans, memberCredits.balance])

  // Whenever a new PlanCard bubble lands in the transcript, remember its
  // id so subsequent chat messages can edit the same plan.
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const p = messages[i].planId
      if (p) { activePlanIdRef.current = p; return }
    }
    activePlanIdRef.current = null
  }, [messages])

  // ── Sidetab overlay: mirror our chat/plan state to the floating window ──
  // The overlay is a separate BrowserWindow that renders a compact read-only
  // view + Stop + (when paused) composer. mainWindow is the single source of
  // truth — we push a thin snapshot on every state change and forward
  // overlay-triggered actions back to our own handlers.
  const [activePlanStatus, setActivePlanStatus] = useState<TwixyPlanStatus | null>(null)
  useEffect(() => {
    const id = activePlanIdRef.current
    if (!id) { setActivePlanStatus(null); return }
    let cancelled = false
    const load = async () => {
      try {
        const p = await window.twixy.planGet(id)
        if (!cancelled) setActivePlanStatus(p?.status ?? null)
      } catch { /* ignore */ }
    }
    void load()
    const off = window.twixy.onPlanChanged(e => { if (e.id === id) void load() })
    return () => { cancelled = true; off() }
  }, [messages])

  useEffect(() => {
    const activePlanId = activePlanIdRef.current
    const snapshot: OverlaySnapshot = {
      // Keep only the last 20 messages — the overlay only renders ~6
      // but we include a small buffer so the overlay's own filtering
      // has room to work without another round-trip.
      messages: messages.slice(-20).map(m => ({
        id:      m.id,
        role:    m.role,
        content: m.content,
        planId:  m.planId,
      })),
      isThinking,
      toolActivity: toolActivity
        ? {
            name:           toolActivity.name,
            isSubagent:     toolActivity.isSubagent,
            detail:         toolActivity.detail,
            subagentLabel:  toolActivity.subagentLabel,
            callId:         toolActivity.callId,
          }
        : null,
      toolStats: toolStats
        ? { count: toolStats.count, startedAt: toolStats.startedAt }
        : null,
      activePlanId,
      planStatus:  activePlanStatus,
      planMode,
      connected:   status === 'ready',
    }
    void window.twixy.overlaySyncPush(snapshot)
  }, [messages, isThinking, toolActivity, toolStats, activePlanStatus, planMode, status])

  // Guardrail popup window lifecycle. We spawn the popup the moment a
  // pending request appears (so users in another app see the prompt
  // immediately) and tear it down when the queue clears. Re-pushing on
  // every change keeps the popup in sync if a second request arrives
  // before the first is decided.
  useEffect(() => {
    if (guardrail.current) {
      void window.twixy.guardrailPopupShow({
        request: guardrail.current,
        mode:    guardrail.config.mode,
      })
    } else {
      void window.twixy.guardrailPopupClose()
    }
  }, [guardrail.current, guardrail.config.mode])

  // Overlay -> mainWindow: Stop button forwards here. Prefer pausing the
  // active plan (clean lifecycle); otherwise just abort the current turn.
  useEffect(() => {
    return window.twixy.onOverlayStop(() => {
      const id = activePlanIdRef.current
      if (id) void plans.pausePlan(id)
      else void abortMessage()
    })
  }, [plans, abortMessage])

  // Overlay -> mainWindow: composer send forwards here and routes through
  // the same sendMessage path — picks up entitlement checks + plan editing.
  useEffect(() => {
    return window.twixy.onOverlaySend(text => { void sendMessage(text) })
  }, [sendMessage])

  // Guardrail popup -> main renderer: button clicks in the popup window
  // route here. We look up the request by id in the current pending
  // queue (the popup may be slightly stale if the queue advances) and
  // dispatch through useGuardrail.decide so the same allowlist / session
  // cache semantics apply as the in-window modal. `params` is forwarded
  // so the popup's "directory scope" choice can rewrite the path before
  // the fingerprint is computed.
  useEffect(() => {
    return window.twixy.onGuardrailPopupDecide(({ id, action, params, saveAsName }) => {
      const req = guardrail.current
      if (!req || req.id !== id) return
      const effective = params ? { ...req, params } : req
      guardrail.decide(effective, action, saveAsName ? { saveAsName } : undefined)
    })
  }, [guardrail])

  // Overlay -> mainWindow: Start button forwards here. Only meaningful
  // while a draft plan is active; delegates to the same buildPlan path
  // the inline PlanCard uses.
  useEffect(() => {
    return window.twixy.onOverlayStart(() => {
      const id = activePlanIdRef.current
      if (id) void plans.buildPlan(id)
    })
  }, [plans])

  // Execution Plan (API path) auto-run. main creates the draft plan from an
  // inbound Execution Plan and emits 'execution-plan-run'; we start it with no
  // human interaction. The UI-import path does NOT emit this event (a human
  // reviews the draft PlanCard and presses Start), so automation is API-only.
  //
  // Busy guard: starting a run calls setRejectNewRuns(false) + resetSession(),
  // which would abort/wipe a plan run or chat response already in flight. The
  // event handler closure can be a render stale, so the chat-busy bit is
  // mirrored into a ref each render; plan-run state is read via the stable
  // plans.hasActiveRun(). When busy, the ingested plan stays a DRAFT and is
  // surfaced as a PlanCard + system notice so the user can start it manually.
  const chatBusyRef = useRef(false)
  chatBusyRef.current = isThinking
  useEffect(() => {
    return window.twixy.onExecutionPlanRun(({ planId }) => {
      if (plans.hasActiveRun() || chatBusyRef.current) {
        openclaw.insertPlanMessage(planId)
        openclaw.addSystemMessage(
          '⏸️ **Execution Plan received** — another run/response is in progress, so auto-run was held. The plan is saved as a draft; press Start on its card when ready.',
        )
        return
      }
      openclaw.setRejectNewRuns(false)
      void plans.buildPlan(planId)
    })
  }, [plans, openclaw])

  // Single resume entry point — clears the rejectNewRuns guard synchronously
  // before delegating to plans.resumePlan, matching the original "Try again"
  // system-message action behavior. Used by:
  //   - PlanCard's Resume button (planHandlers.onResume)
  //   - "Try again" button on the failure system message (handleMessageAction)
  //   - Overlay's onOverlayResume bridge
  // Without the synchronous setRejectNewRuns(false), there's a microtask gap
  // between click and runFromCurrent's own setRejectNewRuns(false) where
  // stale subagent announces can be intercepted, manifesting as a stuck
  // resume that "Try again" — which already cleared the flag — avoided.
  const handleResume = useCallback((planId: string) => {
    openclaw.setRejectNewRuns(false)
    void plans.resumePlan(planId)
  }, [plans, openclaw])

  // Overlay -> mainWindow: Resume after a pause, delegating to the same
  // path the inline PlanCard uses (handleResume — cleared rejectNewRuns
  // synchronously before resumePlan).
  useEffect(() => {
    return window.twixy.onOverlayResume(() => {
      const id = activePlanIdRef.current
      if (id) handleResume(id)
    })
  }, [handleResume])

  // Overlay -> mainWindow: plan-mode toggle. Mirrors the header chip so
  // users can flip plan-first routing on/off without switching windows.
  useEffect(() => {
    return window.twixy.onOverlayTogglePlanMode(() => {
      togglePlanMode()
    })
  }, [togglePlanMode])

  // When the user starts a fresh chat, drop the plan pointer so the next
  // message isn't interpreted as an edit of the previous plan.
  const handleNewChat = useCallback(() => {
    activePlanIdRef.current = null
    clearChat()
  }, [clearChat])

  const planHandlers = {
    onBuild:     plans.buildPlan,
    onPause:     plans.pausePlan,
    onResume:    handleResume,
    onDelete:    plans.deletePlan,
    onRevealRun: plans.revealRun,
  }

  const handleMessageAction = useCallback((action: ChatMessageAction, _msgId: string) => {
    if (action.actionId === 'plan-resume' && action.planId) {
      handleResume(action.planId)
    }
    // 'plan-dismiss' is handled locally in MessageBubble (sets dismissed=true)
  }, [handleResume])

  const [usageRefreshKey, setUsageRefreshKey] = useState(0)

  // AI 응답 종료 2초 후 사용량 자동 갱신.
  // usageRefreshKey 증가로 SettingsPanel 의 비용 재조회를 트리거하고,
  // ent.refresh() 호출로 상태바/모달의 토큰 수치를 Supabase 최신값에 맞춘다.
  // (페이지 새로고침 없이 즉시 UI 반영하기 위함)
  const prevThinking = useRef(false)
  useEffect(() => {
    if (prevThinking.current && !isThinking) {
      const t = setTimeout(() => {
        setUsageRefreshKey(k => k + 1)
        void ent.refresh()
        void memberCredits.refresh()
      }, 2000)
      return () => clearTimeout(t)
    }
    prevThinking.current = isThinking
  }, [isThinking, ent.refresh, memberCredits.refresh])

  const [pendingChip, setPendingChip] = useState<{ path: string; name: string } | null>(null)

  // DataPanel 의 "Ask about this document" 칩 핸들러: 채팅 뷰로 전환하면서
  // ChatPanel 이 그 파일을 컨텍스트 칩으로 띄우도록 한다.
  const handleAskAbout = useCallback((filePath: string, fileName: string) => {
    setPendingChip({ path: filePath, name: fileName })
    setActiveView('chat')
  }, [])

  // DataPanel 의 "Smart Export" 버튼 핸들러: Exporter 스킬을 자연어 채팅으로 호출.
  // 스킬이 내부적으로 중첩 JSON, 지저분한 markdown, 복수 테이블 문서 등을 해석해
  // exports/ 아래에 정제된 CSV 를 떨어뜨린다.
  const handleSmartExport = useCallback((filePath: string, fileName: string) => {
    const prompt = `Use the Exporter skill to convert this file to CSV: ${filePath}\nFile name: ${fileName}\nDetect the structure intelligently (handle nested JSON, multiple markdown tables, irregular columns, etc.) and save the result under exports/.`
    setActiveView('chat')
    void sendMessage(prompt)
  }, [sendMessage])

  // 패널은 마운트된 채로 두고 CSS display 로만 숨긴다.
  // 탭 이동 시 세션/스크롤 상태가 유지되어 체감 성능이 훨씬 좋다.
  // (순수 UI 패널은 첫 방문 때 마운트 — 위 visited. 한번 마운트되면 똑같이 유지된다.)
  const dataActive = activeView === 'data' || activeView === 'strategies' || activeView === 'reports'

  function panel(id: string, active: boolean) {
    return {
      display:       active ? 'flex' : 'none',
      flex:           1,
      flexDirection: 'column' as const,
      overflow:      'hidden',
    }
  }

  // 기동 오류가 있으면 메인 UI 대신 복구 화면(SetupScreen) 표시.
  // 모든 hook 호출 뒤로 미뤄 둔 분기 — Rules of Hooks 준수.
  if (setupError) {
    return (
      <SetupScreen
        errorMsg={setupError}
        onSuccess={() => setSetupError(null)}
      />
    )
  }

  // 게이트웨이가 실제로 쓸 수 있게 될 때까지 브랜드 스플래시를 띄운다.
  // 'ready' / 'error' / 'disconnected' 세 상태에서만 스플래시를 내린다 —
  // error/disconnected 는 메인 UI 가 있어야 사용자가 Reconnect 를 누르거나 Settings 를 열 수 있어서.
  if (status === 'connecting') {
    return <ConnectingSplash />
  }

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* 타이틀바 드래그 영역 (프레임리스 윈도우용 수동 드래그 핸들).
         In fullscreen mode the native traffic-light buttons disappear and
         the window can't be dragged anyway, so we collapse the bar entirely
         — this both avoids the off-center title (due to paddingLeft: 80
         being wasted space) and gives back vertical real estate to the
         3-column workspace below. */}
      {!isFullscreen && (
        <div style={{
          height: 38,
          WebkitAppRegion: 'drag',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 80,
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-muted)',
          letterSpacing: '0.05em',
        } as React.CSSProperties}>
          {PRODUCT.wordmark}
        </div>
      )}

      {/* 새 버전 알림 배너 (있을 때만 렌더) */}
      <UpdateBanner />

      {/* 본문: 좌측 사이드바 + 우측 메인 패널 영역 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar activeView={activeView} onViewChange={setActiveView} isFullscreen={isFullscreen} />
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>

          {has('chat') && <div style={{ ...panel('chat', activeView === 'chat'), flexDirection: 'row' }}>
            <FilesPanel
              onOpenFile={relPath => { setFileToOpen(relPath); setActiveView('data') }}
              collapsed={leftPanelCollapsed}
              onToggleCollapse={() => setLeftPanelCollapsed(v => !v)}
            />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
              <button
                onClick={() => setChatPreviewOpen(v => !v)}
                title={chatPreviewOpen ? 'Close browser preview' : 'Open browser preview'}
                style={{
                  position: 'absolute', top: 8, right: 8, zIndex: 3,
                  padding: '4px 8px', fontSize: 10, fontFamily: 'var(--font-mono)',
                  color: chatPreviewOpen ? 'var(--text-primary)' : 'var(--text-muted)',
                  background: chatPreviewOpen ? 'var(--bg-active)' : 'var(--bg-elevated)',
                  border: `1px solid ${chatPreviewOpen ? 'var(--accent)' : 'var(--border-subtle)'}`,
                  borderRadius: 'var(--radius-sm)', cursor: 'pointer', lineHeight: 1,
                }}
              >
                {chatPreviewOpen ? '▣ browser' : '▢ browser'}
              </button>
              <WorkflowTab
                workflow={activeWorkflow}
                collapsed={workflowTabCollapsed}
                onToggleCollapse={() => setWorkflowTabCollapsed(v => !v)}
                onOpenEditor={() => setActiveView('workflow')}
                onExecute={(wf) => {
                  // Run-workflow trigger. We assemble a single user-facing
                  // message that primes the LLM with (a) the workflow prompt
                  // template and (b) the list of inputs it must collect from
                  // the user before substituting placeholders. The LLM then
                  // naturally asks for each input in chat — no separate
                  // "form" UI needed in v1.
                  const inputs = wf.inputs ?? []
                  const inputLines = inputs.length
                    ? inputs.map(i => `  - {{${i.id}}} — ${i.label} (${i.valueType}${i.kind === 'list' ? '[]' : ''})`).join('\n')
                    : '  (none)'
                  const body = wf.prompt ?? wf.description ?? ''
                  const message = [
                    `Run workflow: **${wf.title}**`,
                    '',
                    `Before you begin, ask me for each required input below, one at a time. Once I have provided every input, substitute them into the prompt and execute it.`,
                    '',
                    `Required inputs:`,
                    inputLines,
                    '',
                    `--- Workflow prompt ---`,
                    body,
                  ].join('\n')
                  void sendMessage(message)
                }}
              />
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <ChatPanel messages={messages} isThinking={isThinking} toolActivity={toolActivity} toolStats={toolStats} onSend={sendMessage} onStop={abortMessage} onNewChat={handleNewChat} onOpenFile={relPath => { setFileToOpen(relPath); setActiveView('data') }} pendingChip={pendingChip} onChipConsumed={() => setPendingChip(null)} projectDir={projectDir} projectDirLoading={projDirLoading} projectDirSetting={projDirSetting} onPickProjectDir={pickProjectDir} planMode={planMode} onTogglePlanMode={togglePlanMode} planHandlers={planHandlers} planGenerating={planGenerating} onMessageAction={handleMessageAction} onImportExecutionPlan={(json) => { void plans.importExecutionPlan(json) }} />
              </div>
            </div>
            {chatPreviewOpen && (
              <aside style={{
                width: 420, background: 'var(--bg-surface)',
                borderLeft: '1px solid var(--border-subtle)',
                display: 'flex', flexDirection: 'column', flexShrink: 0,
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)',
                  fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
                }}>
                  <span>Browser (headless)</span>
                  <button onClick={() => setChatPreviewOpen(false)} title="Close preview"
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                </div>
                <div style={{ flex: 1, minHeight: 0, padding: 8 }}>
                  <LiveBrowserPreview />
                </div>
              </aside>
            )}
            <WorkflowListsPanel
              workflows={workflowsApi.workflows}
              activeId={activeWorkflowId}
              isLoading={workflowsApi.isLoading}
              collapsed={rightPanelCollapsed}
              onSelect={setActiveWorkflowId}
              onCreate={async (title) => workflowsApi.create({ title })}
              onDelete={async (id) => {
                const ok = await workflowsApi.remove(id)
                if (ok && activeWorkflowId === id) setActiveWorkflowId(null)
                return ok
              }}
              onUpdateTags={async (id, tags) => { await workflowsApi.update(id, { tags }) }}
              onToggleCollapse={() => setRightPanelCollapsed(v => !v)}
            />
          </div>}

          <div style={panel('copilot', activeView === 'copilot')}>
            <CopilotView
              workflows={workflowsApi.workflows}
              createWorkflow={workflowsApi.create}
              updateWorkflow={workflowsApi.update}
              fetchUsageCost={fetchUsageCost}
              projectDir={projectDir}
              projectDirLoading={projDirLoading}
              projectDirSetting={projDirSetting}
              onPickProjectDir={pickProjectDir}
              reportCtx={identityCtx}
            />
          </div>

          {has('orchestration') && <div style={panel('orchestration', activeView === 'orchestration')}>
            <OrchestrationView
              activeOrchestrationId={activeOrchestrationId}
              onSelectOrchestration={setActiveOrchestrationId}
              fetchUsageCost={fetchUsageCost}
              onOpenWorkflow={(id) => { setActiveWorkflowId(id); setActiveView('workflow') }}
            />
          </div>}

          {has('workflow') && <div style={panel('workflow', activeView === 'workflow')}>
            <WorkflowView
              activeWorkflowId={activeWorkflowId}
              onSelectWorkflow={setActiveWorkflowId}
              fetchUsageCost={fetchUsageCost}
              shareCtx={identityCtx}
              onRunStatesChange={setLiveRunStates}
              runControlRef={runControlRef}
            />
          </div>}

          {has('dashboard') && <div style={panel('dashboard', activeView === 'dashboard')}>
            <TeamDashboardPanel
              userId={user.id}
              userName={(user.user_metadata?.full_name as string) ?? (user.user_metadata?.name as string) ?? user.email ?? null}
              orgIds={orgIds}
              adminOrgIds={adminOrgIds}
              orgLoading={orgLoading}
              onCopied={() => { void workflowsApi.refresh() }}
              onOpenWorkflow={(id) => { setActiveWorkflowId(id); setActiveView('workflow') }}
              liveRuns={liveRunStates}
              workflows={workflowsApi.workflows}
              onStopRun={(wfId) => runControlRef.current?.stop(wfId)}
              onResumeRun={(wf) => runControlRef.current?.resume(wf)}
              onRetryFromNode={(wf, nodeId) => {
                runControlRef.current?.startFromNode(wf, nodeId)
                setActiveWorkflowId(wf.id)
                setActiveView('workflow')
              }}
              onOrgChanged={() => { void refreshOrg() }}
              usage={{
                usdToday:      ent.openRouterUsage.usdToday,
                tokensToday:   ent.openRouterUsage.tokensIn + ent.openRouterUsage.tokensOut,
                messagesToday: ent.usage.messages,
              }}
            />
          </div>}

          {/* 제품이 등록한 탭 — 첫 방문 때 마운트, 그 뒤로는 유지 (아래 lazy 패널과 같은 규칙) */}
          {productViews().map(({ id, Component }) => (
            <div key={id} style={panel(id, activeView === id)}>
              {visited.has(id) && <Component active={activeView === id} navigate={setActiveView} />}
            </div>
          ))}

          {/* 여기부터는 첫 방문 때 로드되는 패널 (visited 가드). 방문 후에는 위 패널들과 똑같이 유지된다. */}
          <div style={panel('data', dataActive)}>
            {(visited.has('data') || visited.has('strategies') || visited.has('reports')) && (
              <DataPanel onSmartExport={handleSmartExport} onAskAbout={handleAskAbout} fileToOpen={fileToOpen} isTwixyHosting={isTwixyHosting} />
            )}
          </div>

          <div style={panel('skills', activeView === 'skills')}>
            {visited.has('skills') && <SkillsPanel />}
          </div>

          <div style={panel('mr', activeView === 'mr')}>
            {visited.has('mr') && <MergeRequestPanel />}
          </div>

          <div style={panel('admin', activeView === 'admin')}>
            {visited.has('admin') && <AdminSlot />}
          </div>

          <div style={panel('settings', activeView === 'settings')}>
            {visited.has('settings') && <SettingsPanel
              fetchUsageCost={fetchUsageCost}
              resetUsageBaseline={resetUsageBaseline}
              usageRefreshKey={usageRefreshKey}
              cron={{
                cronList:        openclaw.cronList,
                cronAddFromForm: openclaw.cronAddFromForm,
                cronRemove:      openclaw.cronRemove,
                cronRun:         openclaw.cronRun,
                cronEnable:      openclaw.cronEnable,
                cronDisable:     openclaw.cronDisable,
              }}
              visible={activeView === 'settings'}
            />}
          </div>

        </main>
      </div>

      {/* 하단 상태바: 연결 상태 · 플랜 · 사용량 · 재연결/업그레이드 버튼 */}
      <StatusBar
        status={status}
        errorMsg={errorMsg}
        onReconnect={reconnect}
        tier={ent.tier}
        isTwixyHosting={isTwixyHosting}
        usageMessages={ent.usage.messages}
        limitMessages={ent.limits.messagesPerDay}
        usageTokens={ent.openRouterUsage.tokensIn + ent.openRouterUsage.tokensOut}
        limitTokens={FREE_PLAN.tokensPerMonth}
        usdToday={ent.openRouterUsage.usdToday}
        creditBalance={memberCredits.balance}
        creditLimit={memberCredits.limit}
        creditSpent={memberCredits.spent}
        onUpgradeClick={() => { setUpgradeReason('messages'); setUpgradeOpen(true) }}
      />

      {/* 쿼터 초과 또는 사용자가 직접 눌렀을 때 뜨는 업그레이드 모달 */}
      <UpgradeModal
        open={upgradeOpen}
        reason={upgradeReason}
        tier={ent.tier}
        isTwixyHosting={isTwixyHosting}
        usageMessages={ent.usage.messages}
        limitMessages={ent.limits.messagesPerDay}
        usageTokens={ent.openRouterUsage.tokensIn + ent.openRouterUsage.tokensOut}
        limitTokens={FREE_PLAN.tokensPerMonth}
        usdToday={ent.openRouterUsage.usdToday}
        onClose={() => setUpgradeOpen(false)}
      />

      {/* 회사 크레딧 소진 시 안내 모달 */}
      <NoCreditsModal
        open={noCreditsOpen}
        balance={memberCredits.balance}
        onClose={() => setNoCreditsOpen(false)}
      />
    </div>
  )
}
