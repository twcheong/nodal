// ─────────────────────────────────────────────────────────────────────────────
// WorkflowView.tsx — 사이드바 2번째 아이콘으로 진입하는 풀 워크플로 에디터/뷰어.
//
// 레이아웃 (PDF 0613 정의):
//   [260px Left]  [flex Canvas]  [320px Builder Chat]
//     ▸ Workflow Lists (top 50%)
//     ▸ Tools         (bottom 50%)
//
// v1 은 단일 워크플로우 (멀티 탭은 v1.5), 노드 읽기 전용 뷰어.
// 빌더 채팅은 별도 세션 + 전용 WORKFLOW_SOUL.md.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor } from 'lucide-react'
import { WorkflowListsPanel } from './WorkflowListsPanel'
import { harnessLabel } from '../lib/runnerHarness'
import { ToolsCatalog } from './workflow/ToolsCatalog'
import { NodeCanvas } from './workflow/NodeCanvas'
import { WorkflowBuilderChat, type WorkflowBuilderChatHandle } from './workflow/WorkflowBuilderChat'
import { LiveBrowserPreview } from './workflow/LiveBrowserPreview'
import { ShareWorkflowButton } from './workflow/ShareWorkflowButton'
import { StaleCopyBanner } from './workflow/StaleCopyBanner'
import { LiveEditButton, LiveEditBanner } from './workflow/LiveCollabControls'
import { useLiveWorkflow } from '../hooks/useLiveWorkflow'
import { pushLiveWorkflow } from '../lib/liveWorkflows'
import { reportRunStart, reportRunEnd } from '../lib/teamRuns'
import { sendRunReportEmail } from '../lib/reportEmail'
import { buildFailLog } from '../lib/runLogs'
import { useWorkflows } from '../hooks/useWorkflows'
import { useWorkflowTest } from '../hooks/useWorkflowTest'
import { useWorkflowTestSession, type TestSessionMessage, type ToolActivity } from '../hooks/useWorkflowTestSession'
import { makeHumanReviewNode, interleaveHumanReviews } from '../lib/parseWorkflowSpec'
import { marked } from 'marked'
import { safeHtml } from '../lib/safeHtml'
import { cdpPortForSlot } from '../lib/product'

interface Props {
  // activeWorkflowId 는 App 레벨에서 들고 있어, 채팅 뷰의 WorkflowTab 프리뷰와
  // 워크플로 뷰의 캔버스가 같은 선택을 공유한다.
  activeWorkflowId: string | null
  onSelectWorkflow: (id: string | null) => void
  // 사용량 / 비용은 gateway 의 사용자 전역 합산 — 세션과 무관하게 useOpenClaw 가
  // 들고 있는 함수 그대로 재사용. (Test 의 격리된 게이트웨이 세션도 같은 사용자
  // OpenRouter cap 에 잡히므로 회계 정확.)
  fetchUsageCost: () => Promise<{ totals: Record<string, number>; byModel: unknown[] } | null>
  // 팀 공유 컨텍스트 — Share to team 버튼이 필요로 하는 사용자/조직 정보.
  shareCtx: {
    userId:       string
    userEmail:    string | null
    userName:     string | null
    orgIds:       string[]
    primaryOrgId: string | null
  }
  // Runs 대시보드 브리지 — App 이 패널을 display 토글로 항상 마운트해 두므로,
  // 이 뷰의 라이브 run 상태를 위로 올리고 Stop/Resume 제어를 ref 로 노출한다.
  onRunStatesChange?: (states: Record<string, import('../hooks/useWorkflowTest').WorkflowTestState>) => void
  runControlRef?: React.MutableRefObject<{
    stop:          (workflowId: string) => void
    resume:        (workflow: TwixyWorkflow) => void
    startFromNode: (workflow: TwixyWorkflow, nodeId: string) => void
  } | null>
}

export function WorkflowView({
  activeWorkflowId,
  onSelectWorkflow,
  fetchUsageCost,
  shareCtx,
  onRunStatesChange,
  runControlRef,
}: Props) {
  const wfApi = useWorkflows()
  // Test 는 메인 chat 세션과 완전 격리된 자체 게이트웨이 세션에서 실행 —
  // useWorkflowTestSession 이 workflowId 별로 sessionKey 관리 + tool activity /
  // isThinking / context usage 모두 자체 추적. 메인 chat 의 New Chat / 메시지
  // 입력이 Test 에 영향 못 줌.
  const testSession = useWorkflowTestSession(activeWorkflowId)
  const test  = useWorkflowTest({
    sendAndAwaitFinal: testSession.sendAndAwaitFinal,
    cancelTurn:        testSession.cancelTurn,
    fetchUsageCost,
    // 병렬 run 의 노드별 비용 오염 방지 — 자기 세션만의 usage 를 우선 사용.
    fetchSessionUsage: testSession.fetchSessionUsage,
    // run 시작 시 sessionKey→wf-N 슬롯 매핑 등록 → openclaw 훅이 browser 툴
    // 호출에 이 프로필을 강제 (병렬 run 이 서로 다른 Chrome 을 쓰게). 이게 빠지면
    // 슬롯 리스는 되지만 툴레이어 강제가 안 걸려 기본 Chrome 을 공유하게 됨.
    assignBrowserProfile: testSession.assignBrowserProfile,
  })
  // 화면(캔버스/오버레이)이 보는 것은 활성 워크플로의 run 상태. 다른 워크플로의
  // run 은 test.states 안에서 백그라운드로 계속 돈다 (병렬 실행).
  const activeTestState = test.stateFor(activeWorkflowId)
  // 브라우저 패널이 볼 Chrome 의 CDP 포트 — 활성 run 의 슬롯 프로필 wf-N 이
  // 18800+N 에 맵핑됨 (openclaw.json browser.profiles). 슬롯 없으면 18800.
  const activePreviewPort = (() => {
    const m = /^wf-(\d)$/.exec(activeTestState.browserProfile ?? '')
    return cdpPortForSlot(m ? Number(m[1]) : null)
  })()
  // Overlay snapshot 등에서 쓰는 라이브 미러 — 이제 main 이 아닌 test session 출처.
  const messages     = testSession.messages
  const toolActivity = testSession.toolActivity
  const isThinking   = testSession.isThinking
  const activeWorkflow = activeWorkflowId
    ? (wfApi.workflows.find(w => w.id === activeWorkflowId) ?? null)
    : null
  // 배지 계산이 "지금 보고 있는 워크플로"를 건너뛰게 하려고 최신값을 ref 로.
  const activeWorkflowIdRef = useRef(activeWorkflowId)
  activeWorkflowIdRef.current = activeWorkflowId

  // ── 팀 실시간 공동편집 (US-R1-04, 가벼운 버전) ──────────────────────────────
  // 원격 저장 수신 → 로컬에 그대로 반영(LWW). raw wfApi.update 라 되push 안 함(에코 방지).
  const onRemoteLive = useCallback((wf: TwixyWorkflow) => {
    const id = activeWorkflowIdRef.current
    if (!id) return
    void wfApi.update(id, {
      title: wf.title, description: wf.description, prompt: wf.prompt,
      inputs: wf.inputs, nodes: wf.nodes,
    })
  }, [wfApi])
  const { editors: liveEditors } = useLiveWorkflow(
    activeWorkflow?.liveId ?? null,
    shareCtx.userId, shareCtx.userName, null, onRemoteLive,
  )
  // 로컬 UI 편집 → 라이브면 전체 json 을 서버에 push. 편집 콜백은 이 래퍼를 쓴다.
  const updateWf = useCallback(async (id: string, patch: Parameters<typeof wfApi.update>[1]) => {
    const wf = await wfApi.update(id, patch)
    if (wf?.liveId) void pushLiveWorkflow(wf.liveId, wf, shareCtx.userId).catch(() => {})
    return wf
  }, [wfApi, shareCtx.userId])

  // Builder-chat imperative handle — test failures bubble through here as a
  // "fix this" request that the LLM answers with a workflow-spec patch.
  const builderChatRef = useRef<WorkflowBuilderChatHandle | null>(null)
  // workflowId → run 별 실패 보고 dedup. 빌더챗은 활성 워크플로에 바인딩되므로
  // 백그라운드 run 의 실패는 그 워크플로로 화면 전환한 시점에 발사된다.
  const reportedFailureRunRef = useRef<Map<string, { startedAt: number; nodeIds: Set<string> }>>(new Map())

  // 테스트 끝났을 때 자동 리뷰 발사 여부. 세션 단위로만 유지.
  // Auto-review 항시 활성 (UI 토글 제거됨) — 성공 run 은 항상 빌더가 검토.
  const autoReviewEnabled = true
  // workflowId → 마지막으로 리뷰 보낸 run 의 startedAt (dedup).
  const autoReviewedRunRef = useRef<Map<string, number>>(new Map())

  // Live browser preview — auto-open the panel when a Test run starts so the
  // user can watch (and drive) the always-headless Chrome. Chrome never opens
  // an OS window, so nothing ever steals focus. The user can also toggle the
  // panel manually via the button in the top-right of the canvas.
  const [previewOpen, setPreviewOpen] = useState(false)
  // Panel width — user-resizable via the left-edge drag handle (300–760px).
  const [previewWidth, setPreviewWidth] = useState(420)
  // Activity 피드 높이 — 프리뷰와의 세로 분할을 드래그로 조절.
  const [activityHeight, setActivityHeight] = useState(180)
  // 백그라운드 run 이 끝난 워크플로 → 완료/실패 배지 (리스트에 표시).
  // 그 워크플로를 클릭(select)하면 제거 → 배지 사라짐. 새 run 이 끝나면 다시 뜬다.
  const [doneBadges, setDoneBadges] = useState<Record<string, 'done' | 'failed'>>({})

  // 처음 워크플로 리스트가 로드되면 첫 항목을 자동 선택 — 빈 캔버스 회피.
  useEffect(() => {
    if (activeWorkflowId === null && wfApi.workflows.length > 0) {
      onSelectWorkflow(wfApi.workflows[0].id)
    }
  }, [activeWorkflowId, wfApi.workflows, onSelectWorkflow])

  // 활성 워크플로가 바뀌면 디스크에서 이전 run 결과를 hydrate (앱 재시작 후에도
  // 캔버스 노드들이 직전 색/시간/비용 그대로 보이게). hydrate 는 그 워크플로가
  // 실행 중이면 스스로 no-op — 병렬 run 진행 상태를 덮지 않는다.
  // race 가드: 빠르게 두 번 갈아타면 늦은 load 가 이른 reset 을 덮지 않게.
  useEffect(() => {
    if (!activeWorkflowId) return
    const wfId = activeWorkflowId
    let cancelled = false
    ;(async () => {
      try {
        const saved = await window.twixy?.workflowTestRunLoad?.(wfId)
        if (cancelled) return
        test.hydrate(wfId, saved ?? null)
      } catch {
        if (!cancelled) test.hydrate(wfId, null)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkflowId])

  // Run 시작/종료 감시 — 전체 states 맵을 감시해, 시작한 run 은 팀 대시보드에
  // 리포트하고(org_workflow_runs), 끝난 run 은 디스크 save + 로컬 히스토리
  // append + 팀 리포트 update + 실패 시 OS 알림. 백그라운드 병렬 run 도 빠짐없이.
  const savedEndedAtRef = useRef<Map<string, number>>(new Map())
  // 시작 리포트 dedup (wfId → startedAt) + org run 행 id 매핑 (`wfId:startedAt` → uuid).
  const reportedStartRef = useRef<Map<string, number>>(new Map())
  const orgRunIdRef = useRef<Map<string, string>>(new Map())
  // 이펙트 deps 를 test.states 하나로 유지하기 위한 최신값 ref 들.
  const workflowsRef = useRef(wfApi.workflows)
  workflowsRef.current = wfApi.workflows
  const shareCtxRef = useRef(shareCtx)
  shareCtxRef.current = shareCtx
  const onSelectWorkflowRef = useRef(onSelectWorkflow)
  onSelectWorkflowRef.current = onSelectWorkflow
  useEffect(() => {
    for (const [wfId, st] of Object.entries(test.states)) {
      // ── 시작 감지 — resume/startFromNode 도 startedAt 이 갱신되므로 함께 포착.
      if (st.isRunning && st.startedAt && reportedStartRef.current.get(wfId) !== st.startedAt) {
        reportedStartRef.current.set(wfId, st.startedAt)
        const ctx = shareCtxRef.current
        const wf = workflowsRef.current.find(w => w.id === wfId)
        if (ctx.primaryOrgId && wf) {
          const key = `${wfId}:${st.startedAt}`
          void reportRunStart(
            ctx.primaryOrgId,
            { id: ctx.userId, name: ctx.userName ?? ctx.userEmail },
            { wfId, wfTitle: wf.title, startedAt: st.startedAt, nodeTotal: wf.nodes.length },
          ).then(id => { orgRunIdRef.current.set(key, id) }).catch(() => {})
        }
      }

      // ── 종료 감지 (기존 save 지점).
      // 디스크 복원본(hydrate)은 이미 저장/기록이 끝난 run 이다 — 여기서 다시
      // 처리하면 앱을 켤 때마다 runs.jsonl 에 같은 run 이 append 되고 실패
      // 알림도 재발사된다.
      if (st.hydrated) continue
      if (st.isRunning || !st.endedAt) continue
      if (savedEndedAtRef.current.get(wfId) === st.endedAt) continue
      savedEndedAtRef.current.set(wfId, st.endedAt)
      void window.twixy?.workflowTestRunSave?.(wfId, st)

      const nodeVals = Object.values(st.nodeStates)
      const hasFailed  = nodeVals.some(n => n.status === 'failed')
      const hasAborted = nodeVals.some(n => n.status === 'aborted')
      const status: 'done' | 'failed' | 'aborted' = hasFailed ? 'failed' : hasAborted ? 'aborted' : 'done'
      const failReason = nodeVals.find(n => n.status === 'failed')?.reason
      const wf = workflowsRef.current.find(w => w.id === wfId)

      if (st.startedAt) {
        const runKey = `${wfId}:${st.startedAt}`
        // 로컬 히스토리 (runs.jsonl) — Runs 대시보드 필터/통계의 데이터 기반.
        void window.twixy?.workflowRunHistoryAppend?.(wfId, {
          runId:      runKey,
          wfId,
          wfTitle:    wf?.title ?? wfId,
          status,
          startedAt:  st.startedAt,
          endedAt:    st.endedAt,
          durationMs: st.totalMs,
          costUsd:    st.totalCost,
          failReason,
          nodeTotal:  wf?.nodes.length ?? nodeVals.length,
          nodeDone:   nodeVals.filter(n => n.status === 'done').length,
          harness:    harnessLabel(),   // 실행 기록: v3(기본 하네스 ON) | off
        })?.catch?.(() => {})
        // run 상세 로그 (runs/<startedAt>.json) — 로그 뷰어의 데이터 소스.
        // 노드 메타(제목/툴)는 워크플로 정의에서, 실행 기록은 nodeStates 에서 조합.
        const detail: TwixyRunDetail = {
          runId:     runKey,
          wfId,
          wfTitle:   wf?.title ?? wfId,
          status,
          startedAt: st.startedAt,
          endedAt:   st.endedAt,
          totals:    { ms: st.totalMs, usd: st.totalCost, tokensIn: st.totalTokensIn, tokensOut: st.totalTokensOut },
          nodes: (wf?.nodes ?? []).map(n => {
            const ns = st.nodeStates[n.id]
            return {
              nodeId: n.id, title: n.title, type: n.type, tool: n.tool,
              status: ns?.status ?? 'pending',
              startedAt: ns?.startedAt, endedAt: ns?.endedAt, durationMs: ns?.durationMs,
              costUsd: ns?.costUsd, tokensIn: ns?.tokensIn, tokensOut: ns?.tokensOut,
              reason: ns?.reason, prompt: ns?.prompt, output: ns?.output, toolCalls: ns?.toolCalls,
            }
          }),
        }
        void window.twixy?.workflowRunDetailSave?.(wfId, detail)?.catch?.(() => {})
        // 팀 리포트 마감 (시작 리포트가 성공했을 때만 id 가 있다).
        // 실패 run 은 클립된 상세(fail_log)를 첨부 — 팀리더 원격 진단용.
        const orgRunId = orgRunIdRef.current.get(runKey)
        if (orgRunId) {
          orgRunIdRef.current.delete(runKey)
          void reportRunEnd(orgRunId, {
            status,
            endedAt:    st.endedAt,
            durationMs: st.totalMs,
            costUsd:    st.totalCost,
            failReason: failReason ?? null,
            failLog:    status === 'failed' ? buildFailLog(detail) : null,
            nodeDone:   nodeVals.filter(n => n.status === 'done').length,
          }).catch(() => {})
        }
        // 이메일 리포트 — 실행자 본인에게 결과/오류 송부. 토글(localStorage) 'twixy.runsDash.emailReport':
        //   'off'  = 발송 안 함 / 'all' = 성공·실패 모두 / 그 외(기본) = 실패·중단만.
        // 부가 기능이라 실패해도 무시(오프라인/미배포여도 run 정상).
        {
          const emailMode = localStorage.getItem('twixy.runsDash.emailReport')
          const email = shareCtxRef.current.userEmail
          const shouldEmail = emailMode !== 'off' && email &&
            (emailMode === 'all' || status !== 'done')
          if (shouldEmail) {
            void sendRunReportEmail(email, {
              wfTitle:    wf?.title ?? wfId,
              status,
              durationMs: st.totalMs,
              costUsd:    st.totalCost,
              failReason: failReason ?? null,
              startedAt:  st.startedAt,
            }).catch(() => {})
          }
        }
        // 실패 OS 알림 — Electron renderer 는 HTML5 Notification 이 권한 없이 동작.
        // 토글(localStorage) off 가 아니면 발사, 클릭 시 해당 워크플로로 이동.
        if (status === 'failed' && localStorage.getItem('twixy.runsDash.notify') !== 'off') {
          try {
            const n = new Notification('Workflow failed', {
              body: `${wf?.title ?? wfId} — ${failReason ?? 'unknown error'}`,
            })
            n.onclick = () => onSelectWorkflowRef.current(wfId)
          } catch { /* Notification 미지원 환경 — 무시 */ }
        }
      }

      // 방금 끝난 run 에 완료/실패 배지. 지금 보고 있는 워크플로는 건너뜀
      // (이미 화면에 결과가 보이므로). run 당 1회만 (endedAt 가드).
      if (wfId !== activeWorkflowIdRef.current) {
        const failed = hasFailed || hasAborted
        setDoneBadges(prev => ({ ...prev, [wfId]: failed ? 'failed' : 'done' }))
      }
    }
  }, [test.states])

  // ── Runs 대시보드 브리지 ─────────────────────────────────────────────
  // App 이 패널을 display 토글로 항상 마운트해 두므로, 이 뷰가 대시보드 탭
  // 뒤에서도 라이브 run 상태를 위로 push 하고 Stop/Resume 제어를 ref 로 노출.
  useEffect(() => {
    onRunStatesChange?.(test.states)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test.states])
  if (runControlRef) {
    runControlRef.current = {
      stop:          (wfId: string) => test.stop(wfId),
      resume:        (wf: TwixyWorkflow) => { void test.resume(wf) },
      startFromNode: (wf: TwixyWorkflow, nodeId: string) => { void test.startFromNode(wf, nodeId) },
    }
  }

  // ── Test Progress Overlay 미러링 ───────────────────────────────────────
  // 테스트가 시작되면 (그리고 아직 overlay 가 안 떠 있으면) 자동으로 띄우고,
  // testState 가 바뀔 때마다 스냅샷을 push 한다. overlay 는 활성 워크플로의
  // run 을 보여주므로 Stop / review 결정도 활성 워크플로로 라우팅한다.
  // (핸들러 재구독을 피하려고 최신 activeWorkflowId/함수를 ref 로 참조.)
  const overlayTargetRef = useRef<{ stop: () => void; review: (nodeId: string, action: 'approve' | 'note' | 'skip', comment?: string) => void }>({
    stop: () => {}, review: () => {},
  })
  overlayTargetRef.current = {
    stop:   () => { if (activeWorkflowId) test.stop(activeWorkflowId) },
    review: (nodeId, action, comment) => {
      if (activeWorkflowId) test.resumeReview(activeWorkflowId, nodeId, { action, comment })
    },
  }
  useEffect(() => {
    if (!window.twixy?.onTestOverlayStop) return
    return window.twixy.onTestOverlayStop(() => { overlayTargetRef.current.stop() })
  }, [])

  // overlay 에서 review 결정을 내리면 메인이 받아 resumeReview 로 전달.
  useEffect(() => {
    if (!window.twixy?.onTestOverlayReviewDecision) return
    return window.twixy.onTestOverlayReviewDecision((payload) => {
      overlayTargetRef.current.review(payload.nodeId, payload.action, payload.comment)
    })
  }, [])

  useEffect(() => {
    if (!activeWorkflow || !window.twixy?.pushTestOverlaySnapshot) return

    // 라이브 메시지 슬라이스: 테스트 시작 시각 이후의 메시지만 보낸다.
    // 시작 전이면 가장 최근 6개. 각 콘텐츠는 1200자로 클립해 페이로드 비대화 방지.
    const sinceTs = activeTestState.startedAt
      ? activeTestState.startedAt - 250  // 시작 직후 push 된 첫 메시지까지 잡으려는 약간의 여유
      : 0
    const sliced = (sinceTs > 0
      ? messages.filter(m => m.timestamp.getTime() >= sinceTs)
      : messages.slice(-6)
    ).slice(-12)  // 최대 12개 — overlay 가 한 화면에 보여줄 만큼만
    const liveMessages = sliced.map(m => ({
      id:      m.id,
      role:    (m.role === 'user' || m.role === 'assistant' || m.role === 'system') ? m.role : 'assistant' as const,
      content: clip(m.content, 1200),
      ts:      m.timestamp.getTime(),
    }))

    const snapshot = {
      workflowTitle:  activeWorkflow.title,
      nodes:          activeWorkflow.nodes.map(n => ({ id: n.id, title: n.title, type: n.type })),
      isRunning:      activeTestState.isRunning,
      startedAt:      activeTestState.startedAt,
      endedAt:        activeTestState.endedAt,
      totalCost:      activeTestState.totalCost,
      totalMs:        activeTestState.totalMs,
      totalTokensIn:  activeTestState.totalTokensIn,
      totalTokensOut: activeTestState.totalTokensOut,
      nodeStates:     activeTestState.nodeStates,
      toolActivity,
      isThinking,
      liveMessages,
    }
    void window.twixy.pushTestOverlaySnapshot(snapshot)
  }, [activeWorkflow, activeTestState, messages, toolActivity, isThinking])

  // 노드 실패 감지 → 빌더 챗으로 자동 라우팅. 빌더챗은 활성 워크플로에 바인딩
  // 되므로 **활성 워크플로의 실패만** 발사한다 — 백그라운드 병렬 run 의 실패는
  // 그 워크플로로 화면 전환한 시점에 이 이펙트가 다시 돌면서 발사됨 (per-wf
  // 트래커가 run(startedAt) 단위로 dedup).
  useEffect(() => {
    if (!activeWorkflow) return
    const st = test.stateFor(activeWorkflow.id)
    // 디스크 복원본은 제외 — 실패한 채로 남은 run 이 앱 재시작마다 빌더 챗에
    // 같은 "노드 실패, 고쳐줘" 요청을 다시 밀어넣는다.
    if (st.hydrated) return
    const startedAt = st.startedAt
    if (!startedAt) return
    let tracker = reportedFailureRunRef.current.get(activeWorkflow.id)
    if (!tracker || tracker.startedAt !== startedAt) {
      tracker = { startedAt, nodeIds: new Set() }
      reportedFailureRunRef.current.set(activeWorkflow.id, tracker)
    }
    for (const node of activeWorkflow.nodes) {
      const ns = st.nodeStates[node.id]
      if (ns?.status === 'failed' && !tracker.nodeIds.has(node.id)) {
        tracker.nodeIds.add(node.id)
        builderChatRef.current?.requestFixForFailedNode({
          workflow:   activeWorkflow,
          nodeId:     node.id,
          nodeTitle:  node.title,
          nodeDetail: node.detail,
          error:      ns.reason ?? 'unknown error',
        })
      }
    }
  }, [test, activeWorkflow])

  // 테스트 성공 완료 감지 → 빌더 챗에 자동 리뷰 요청.
  // 조건: (a) 토글 on, (b) 한 번이라도 돌았고 (startedAt), (c) 끝났고 (endedAt
  // 있고 isRunning=false), (d) 실패/중단된 노드 없음, (e) 이 run 에 대해 아직
  // 리뷰 보내지 않음.
  useEffect(() => {
    if (!autoReviewEnabled) return
    if (!activeWorkflow) return
    // 활성 워크플로의 run 만 리뷰 — 백그라운드 run 은 그 워크플로로 전환 시
    // 이 이펙트가 다시 돌면서 발사 (per-wf dedup 이 중복 방지).
    const runState = test.stateFor(activeWorkflow.id)
    const { startedAt, endedAt, isRunning, nodeStates } = runState
    // 디스크 복원본(hydrate)은 제외 — 앱 재시작마다 지난 run 이 "방금 끝난 run"
    // 으로 보여 같은 리뷰 요청이 계속 재발사된다.
    if (runState.hydrated) return
    if (!startedAt || !endedAt || isRunning) return
    if (autoReviewedRunRef.current.get(activeWorkflow.id) === startedAt) return
    const states = Object.values(nodeStates)
    if (states.length === 0) return
    const hasFailure = states.some(s => s.status === 'failed' || s.status === 'aborted')
    if (hasFailure) return  // 실패는 이미 requestFixForFailedNode 가 처리
    // 실제 실행된 노드가 하나라도 있어야 의미 있음 (전부 pending 이면 skip)
    const hasExecuted = states.some(s => s.status === 'done' || s.status === 'skipped')
    if (!hasExecuted) return

    autoReviewedRunRef.current.set(activeWorkflow.id, startedAt)

    // 노드 순서대로 run summary 만들기
    const summary = activeWorkflow.nodes.map((n, i) => {
      const st = nodeStates[n.id] ?? { status: 'pending' as const }
      return {
        order:       i + 1,
        nodeId:      n.id,
        title:       n.title,
        type:        n.type,
        tool:        n.tool,
        toolSkills:  n.toolSkills,
        status:      st.status,
        durationMs:  st.durationMs,
        costUsd:     st.costUsd,
        tokensIn:    st.tokensIn,
        tokensOut:   st.tokensOut,
        output:      st.output,
        autoSlice:   st.autoSlice,
      }
    })

    builderChatRef.current?.requestAutoReview({
      workflow:   activeWorkflow,
      runSummary: summary,
      totals: {
        ms:         runState.totalMs,
        usd:        runState.totalCost,
        tokensIn:   runState.totalTokensIn,
        tokensOut:  runState.totalTokensOut,
      },
    })
  }, [autoReviewEnabled, activeWorkflow, test])

  useEffect(() => {
    if (activeTestState.isRunning) setPreviewOpen(true)
  }, [activeTestState.isRunning])

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'row',
      overflow: 'hidden',
      background: 'var(--bg-base)',
    }}>
      {/* Left column: Workflow list (top) + Tools catalog (bottom) */}
      <aside style={{
        width: 260,
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <WorkflowListsPanel
            workflows={wfApi.workflows}
            activeId={activeWorkflowId}
            isLoading={wfApi.isLoading}
            collapsed={false}
            runningIds={Object.entries(test.states).filter(([, s]) => s.isRunning).map(([id]) => id)}
            finishedStatus={doneBadges}
            onSelect={(id) => {
              // 워크플로를 클릭하면 그 완료/실패 배지를 지운다 (읽음 처리).
              setDoneBadges(prev => {
                if (!prev[id]) return prev
                const next = { ...prev }
                delete next[id]
                return next
              })
              onSelectWorkflow(id)
            }}
            onCreate={async (title) => wfApi.create({ title })}
            onDelete={async (id) => {
              const ok = await wfApi.remove(id)
              if (ok && activeWorkflowId === id) onSelectWorkflow(null)
              return ok
            }}
            onUpdateTags={async (id, tags) => { await wfApi.update(id, { tags }) }}
            onToggleCollapse={() => { /* 이 뷰에서는 항상 펼침 */ }}
            variant="embedded"
          />
        </div>
        <div style={{ height: 1, background: 'var(--border-subtle)' }} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <ToolsCatalog />
        </div>
      </aside>

      {/* Center column: Canvas — with a live-preview toggle in the top-right */}
      <main style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}>
        <NodeCanvas
          workflow={activeWorkflow}
          // WF 탭에선 타입 배지 숨김 (Copilot 탭에선 기본값 true 로 계속 표시).
          showTypeBadge={false}
          // 상단 툴바에 in-flow 로 편입 (absolute 오버레이 제거 → 겹침 없음).
          headerLeft={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ShareWorkflowButton
                workflow={activeWorkflow}
                userId={shareCtx.userId}
                userEmail={shareCtx.userEmail}
                userName={shareCtx.userName}
                orgIds={shareCtx.orgIds}
                primaryOrgId={shareCtx.primaryOrgId}
              />
              <LiveEditButton
                workflow={activeWorkflow}
                orgId={shareCtx.primaryOrgId}
                userId={shareCtx.userId}
                onLiveChange={(liveId) => { if (activeWorkflow) void wfApi.update(activeWorkflow.id, { liveId }) }}
              />
            </span>
          }
          headerRight={
            <PreviewToggleButton
              open={previewOpen}
              onToggle={() => setPreviewOpen(v => !v)}
            />
          }
          banner={
            <>
              <LiveEditBanner workflow={activeWorkflow} editors={liveEditors} meUserId={shareCtx.userId} />
              <StaleCopyBanner
                workflow={activeWorkflow}
                orgIds={shareCtx.orgIds}
                onCopied={(newId) => {
                  void wfApi.refresh().then(() => onSelectWorkflow(newId))
                }}
              />
            </>
          }
          testState={activeTestState}
          onTestStart={(inputs) => {
            if (!activeWorkflow) return
            // Chrome is always headless — just open the preview so the user can
            // watch, and start the run. No mode swap, no gateway restart.
            // 다른 워크플로가 돌고 있어도 시작 가능 (병렬 실행) — 같은 워크플로의
            // 이중 실행만 useWorkflowTest 가 막는다.
            setPreviewOpen(true)
            void test.start(activeWorkflow, inputs).then(res => {
              if (!res.ok && res.reason === 'max_concurrent') {
                alert('동시 실행은 최대 3개입니다.\n실행 중인 테스트를 멈추거나 끝난 뒤 다시 시도하세요.')
              }
            })
          }}
          onTestResume={() => {
            if (!activeWorkflow) return
            setPreviewOpen(true)
            void test.resume(activeWorkflow).then(res => {
              if (!res.ok && res.reason === 'max_concurrent') {
                alert('동시 실행은 최대 3개입니다.\n실행 중인 테스트를 멈추거나 끝난 뒤 다시 시도하세요.')
              }
            })
          }}
          onTestRunFromNode={(nodeId) => {
            if (!activeWorkflow) return
            setPreviewOpen(true)
            void test.startFromNode(activeWorkflow, nodeId).then(res => {
              if (!res.ok && res.reason === 'max_concurrent') {
                alert('동시 실행은 최대 3개입니다.\n실행 중인 테스트를 멈추거나 끝난 뒤 다시 시도하세요.')
              }
            })
          }}
          onTestStop={() => { if (activeWorkflowId) test.stop(activeWorkflowId) }}
          onTestReset={() => {
            if (!activeWorkflowId) return
            // test.reset 이 디스크 스냅샷 삭제 + 다른 탭 인스턴스 전파까지 처리.
            test.reset(activeWorkflowId)
            savedEndedAtRef.current.delete(activeWorkflowId)
          }}
          onReviewDecision={(nodeId, action, comment) => {
            if (activeWorkflowId) test.resumeReview(activeWorkflowId, nodeId, { action, comment })
          }}
          onInsertReviewNode={(afterIndex) => {
            if (!activeWorkflow) return
            const nodes = [...activeWorkflow.nodes]
            nodes.splice(afterIndex + 1, 0, makeHumanReviewNode())
            void updateWf(activeWorkflow.id, { nodes })
          }}
          onDeleteNode={(nodeId) => {
            if (!activeWorkflow) return
            void updateWf(activeWorkflow.id, { nodes: activeWorkflow.nodes.filter(n => n.id !== nodeId) })
          }}
          contextUsage={testSession.contextUsage}
          onResetContext={testSession.resetSession}
          onPatchWorkflow={async (patch) => { if (activeWorkflow) await updateWf(activeWorkflow.id, patch) }}
        />
      </main>

      {/* Live browser panel — mounted only when open so the CDP stream is
          paused while the panel is hidden. Left edge is a drag handle for
          width resize; below the frame is a live LLM-activity feed so the
          user can track what the runner is doing without the popup. */}
      {previewOpen && (
        <aside style={{
          width: previewWidth,
          background: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          position: 'relative',
        }}>
          {/* Drag handle — full-height strip on the left edge. */}
          <div
            onPointerDown={(e) => {
              e.preventDefault()
              const startX = e.clientX
              const startW = previewWidth
              const onMove = (ev: PointerEvent) => {
                // 왼쪽으로 끌면 넓어짐 (오른쪽 고정 패널이므로).
                const w = Math.min(760, Math.max(300, startW + (startX - ev.clientX)))
                setPreviewWidth(w)
              }
              const onUp = () => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            }}
            title="Drag to resize"
            style={{
              position: 'absolute', left: -3, top: 0, bottom: 0, width: 7,
              cursor: 'col-resize', zIndex: 3,
            }}
          />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 10px',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
          }}>
            <span>Browser (headless)</span>
            <button
              onClick={() => setPreviewOpen(false)}
              title="Close browser panel"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: 0,
              }}
            >×</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: 8 }}>
            {/* 활성 워크플로가 lease 한 슬롯(wf-N → 18800+N)의 Chrome 을 본다.
                슬롯이 없으면(한 번도 안 돌림) 기본 18800. key 로 remount —
                포트 전환 시 이전 스트림 stop → 새 스트림 start. */}
            <LiveBrowserPreview key={activePreviewPort} cdpPort={activePreviewPort} />
          </div>
          {/* Vertical drag handle — resizes the browser preview vs the activity feed. */}
          <div
            onPointerDown={(e) => {
              e.preventDefault()
              const startY = e.clientY
              const startH = activityHeight
              const onMove = (ev: PointerEvent) => {
                // 위로 끌면 Activity↑ / 프리뷰↓ (Activity 는 하단 고정 패널).
                const h = Math.min(520, Math.max(80, startH + (startY - ev.clientY)))
                setActivityHeight(h)
              }
              const onUp = () => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            }}
            title="Drag to resize"
            style={{
              height: 7,
              flexShrink: 0,
              cursor: 'row-resize',
              borderTop: '1px solid var(--border-subtle)',
              background: 'var(--bg-elevated)',
            }}
          />
          {/* LLM activity feed — what the runner session is doing right now. */}
          <TestActivityFeed
            messages={messages}
            toolActivity={toolActivity}
            isThinking={isThinking}
            height={activityHeight}
          />
        </aside>
      )}

      {/* Right column: Builder Chat */}
      <aside style={{
        width: 320,
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        <WorkflowBuilderChat
          ref={builderChatRef}
          activeWorkflow={activeWorkflow}
          onSaveSpec={async (spec) => {
            // 새 워크플로 생성 — 모든 필드 보존하고 자동 선택까지.
            // 첫 생성이므로 노드 사이마다 Human Review 삽입 (스펙에 이미 있으면 그대로).
            const wf = await wfApi.create({
              title:       spec.title,
              description: spec.description,
              prompt:      spec.prompt,
              inputs:      spec.inputs,
              nodes:       interleaveHumanReviews(spec.nodes),
            })
            if (wf) onSelectWorkflow(wf.id)
            return wf
          }}
          onUpdateActive={async (spec) => {
            // 활성 워크플로에 spec 을 덮어쓰기. 직전 상태를 스냅샷으로 반환해
            // SaveSpecPanel 이 Undo 가능하도록.
            if (!activeWorkflow) return null
            const snapshot: TwixyWorkflow = JSON.parse(JSON.stringify(activeWorkflow))
            const wf = await updateWf(activeWorkflow.id, {
              title:       spec.title,
              description: spec.description,
              prompt:      spec.prompt,
              inputs:      spec.inputs,
              nodes:       spec.nodes,
            })
            if (!wf) return null
            return { workflow: wf, snapshot }
          }}
          onUndo={async (snapshot) => {
            // 보관된 스냅샷으로 풀 overwrite 복원. 라이브면 서버에도 반영.
            const wf = await wfApi.restore(snapshot)
            if (wf?.liveId) void pushLiveWorkflow(wf.liveId, wf, shareCtx.userId).catch(() => {})
            return wf
          }}
        />
      </aside>
    </div>
  )
}

function clip(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + '…'
}

// ── TestActivityFeed — 브라우저 패널 하단. Test 팝업(TestOverlay 의 LiveActivity)
// 과 동일한 채팅+툴 미러: "Live activity" 헤더 + 툴 chip + You/Twixy/System 버블.
// 팝업 없이도 러너가 지금 뭘 하는지 같은 UI로 본다. 새 메시지 오면 자동 스크롤.
function TestActivityFeed({
  messages, toolActivity, isThinking, height,
}: {
  messages:     TestSessionMessage[]
  toolActivity: ToolActivity | null
  isThinking:   boolean
  height:       number
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const recent = messages.slice(-30)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [recent.length, toolActivity?.name, isThinking])

  return (
    <div style={{
      height,
      flexShrink: 0,
      borderTop: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-base)',
    }}>
      <header style={{
        padding: '8px 12px 4px',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        color: 'var(--text-muted)',
        flexShrink: 0,
      }}>
        Live activity
      </header>

      {/* Tool / thinking chip */}
      <div style={{ padding: '0 12px 6px', display: 'flex', flexWrap: 'wrap', gap: 6, flexShrink: 0 }}>
        {toolActivity ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            padding: '2px 8px',
            borderRadius: 'var(--radius-sm)',
            background: '#0d5c5022',
            color: 'var(--accent)',
            border: '1px solid #0d5c5044',
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%',
              background: 'var(--accent)', boxShadow: '0 0 4px var(--accent)',
            }} />
            {toolActivity.isSubagent ? '↳ ' : ''}{toolActivity.name}
            {toolActivity.subagentLabel && (
              <span style={{ color: 'var(--text-muted)' }}>· {toolActivity.subagentLabel}</span>
            )}
            {toolActivity.detail && (
              <span style={{
                color: 'var(--text-muted)',
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>· {toolActivity.detail}</span>
            )}
          </span>
        ) : isThinking ? (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Thinking…</span>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Idle</span>
        )}
      </div>

      {/* Recent messages — 팝업과 동일한 버블, 내용만 마크다운 렌더 */}
      <div ref={scrollRef} style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '4px 12px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}>
        {recent.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            No messages yet.
          </div>
        ) : (
          recent.map(m => <TestActivityBubble key={m.id} m={m} />)
        )}
      </div>
    </div>
  )
}

function TestActivityBubble({ m }: { m: TestSessionMessage }) {
  const isUser = m.role === 'user'
  return (
    <div style={{
      alignSelf: isUser ? 'flex-end' : 'flex-start',
      maxWidth: '94%',
      background: isUser ? 'var(--accent-dim)' : 'var(--bg-elevated)',
      color: isUser ? 'var(--text-primary)' : 'var(--text-secondary)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-sm)',
      padding: '5px 8px',
      fontSize: 11,
      lineHeight: 1.45,
      wordBreak: 'break-word',
    }}>
      <div style={{
        fontSize: 9,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        marginBottom: 2,
      }}>
        {isUser ? 'You' : (m.role === 'assistant' ? 'Twixy' : 'System')}
      </div>
      <div
        className="md-render"
        dangerouslySetInnerHTML={{ __html: safeHtml(marked(m.content, { breaks: true, gfm: true })) }}
      />
    </div>
  )
}

// browser 프리뷰 토글 — ⤢(popout)·↺(refresh) 형제와 같은 아이콘 버튼 스타일.
// 텍스트 없이 아이콘만. 열려 있으면 accent 로 강조.
function PreviewToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={open ? 'Close browser preview' : 'Open browser preview (watch headless Chrome)'}
      style={{
        padding: '4px 8px',
        margin: '6px 0',
        fontSize: 13,
        lineHeight: 1,
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        color: open ? 'var(--accent)' : 'var(--text-muted)',
        background: open ? 'var(--bg-active)' : 'transparent',
        cursor: 'pointer',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <Monitor size={15} strokeWidth={1.5} />
    </button>
  )
}
