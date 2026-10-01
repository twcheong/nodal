// ─────────────────────────────────────────────────────────────────────────────
// CopilotView.tsx — 채팅-퍼스트 메인 화면 (새 "Chat" 탭).
//
// UX 흐름:
//   1) 유저가 원하는 걸 채팅으로 입력
//   2) Copilot LLM(useCopilotChat)이 워크플로 카탈로그를 보고 라우팅
//   3) 매칭됨 + 입력값 미비 → show 액션: 워크플로 패널만 슬라이드-인, 입력값을
//      채팅으로 물어봄 (입력값 완비 전에는 절대 run 하지 않음 — 클라이언트도
//      required-input 가드로 이중 방어)
//   4) 입력값 완비 → run 액션 → Test run 시작
//   5) 매칭 없음 → workflow-spec 자동 저장 후 같은 룰로 진행
//
// 패널 UI:
//   왼쪽  = NodeCanvas — Workflow 탭과 동일한 노드 시각화/입력폼/리뷰 UI 재사용
//   오른쪽 = 라이브 브라우저 프리뷰 + 활동 피드
//   양쪽 폭 + 활동 피드 높이 모두 마우스 드래그로 조절 가능
//
// 이 채팅은 워크플로 빌더 챗과 별개 개념 — 대화 단위로 새 채팅 생성/기록 열람
// (☰ 서랍). 실행 머신은 WorkflowView 와 같은 훅의 자체 인스턴스.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { marked } from 'marked'
import { safeHtml } from '../../lib/safeHtml'
import { Zap } from 'lucide-react'
import { workflowDotColor, markWorkflowOpened } from '../../lib/workflowDots'
import { conversationTitle, useCopilotChat } from '../../hooks/useCopilotChat'
import { useWorkflowTest, EMPTY_TEST_STATE, type WorkflowTestState } from '../../hooks/useWorkflowTest'
import { useWorkflowTestSession } from '../../hooks/useWorkflowTestSession'
import { useFileDropZone } from '../../hooks/useFileDropZone'
import { parseWorkflowSpecFromText, stripWorkflowSpecBlock, makeHumanReviewNode, interleaveHumanReviews, parseSimplePlanFromText, stripSimplePlanBlock } from '../../lib/parseWorkflowSpec'
import { parseCopilotAction, stripCopilotActionBlock, type CopilotAction } from '../../lib/parseCopilotAction'
import { loadPlansLS, savePlansLS, MAX_PLANS_PER_CONV, type CopilotPlan } from '../../lib/copilotPlans'
import { loadDeckLS, saveDeckLS, clearDeckLS, deckSlug, loadEditTargetLS, saveEditTargetLS, clearEditTargetLS, describeEditTarget, type PptxEditTarget } from '../../lib/copilotDecks'
import { ATTACHABLE_EXTS, fileExtRegex, fileRefRegex, isImage } from '../../../shared/fileTypes'
import { parsePptxEditBlock, stripPptxEditBlocks, pptxEditOrderWarnings, describePptxEditOp, type PptxEditOp } from '../../lib/parsePptxEdit'
import { parseDeckBlock, parseAllPatches, applyPatches, stripDeckBlocks, summarizeDeckBlocks, type DeckBlockNote } from '../../lib/parseDeckSpec'
import { collectStrings, applyStrings } from '../../../shared/deck/strings'
import { DeckPanel } from './deck/DeckPanel'
import { DeckDesigner } from './deck/DeckDesigner'
import { SlidePreview } from './deck/SlidePreview'
import { useImageAspects } from './deck/useSlideImages'
import type { SlideDisplay } from '../../../shared/deck/el'
import { warningText, type SlideWarning } from './deck/deckWarnings'
import { buildDeck } from '../../../shared/deck/layout'
import {
  submitSessionReport, composeRunDetail, buildReportEnv, describeReportError,
  ReportError, CLIP_NOTE, type SubmitResult,
} from '../../lib/sessionReports'
import { LiveBrowserPreview } from '../workflow/LiveBrowserPreview'
import { NodeCanvas } from '../workflow/NodeCanvas'
import { WorkflowNodeCard } from '../workflow/WorkflowNodeCard'
import { formatDisplayUsd } from '../../lib/useDisplayUsd'
import { cdpPortForSlot, PRODUCT } from '../../lib/product'
import { getProductCopilotMode } from '../../lib/copilotModes'

interface Props {
  workflows:        TwixyWorkflow[]
  createWorkflow:   (payload: {
    title: string; description?: string; prompt?: string
    inputs?: TwixyModuleParam[]; nodes?: TwixyWorkflowNode[]
  }) => Promise<TwixyWorkflow | null>
  // 수정 요청("json 대신 xlsx로") 시 기존 워크플로를 update — 매번 create 하면
  // 같은 제목의 워크플로가 계속 복제된다.
  updateWorkflow:   (id: string, patch: {
    title?: string; description?: string; prompt?: string
    inputs?: TwixyModuleParam[]; nodes?: TwixyWorkflowNode[]
  }) => Promise<TwixyWorkflow | null>
  fetchUsageCost:   () => Promise<{ totals: Record<string, number>; byModel: unknown[] } | null>
  // 프로젝트 폴더(workspace) — 기존 chat 탭과 동일한 지정 UX. 워크플로의 파일
  // 쓰기는 workspace 안으로 강제되므로, 지정된 폴더 내부는 Copilot 이 접근 가능.
  projectDir?:        string | null
  projectDirLoading?: boolean
  projectDirSetting?: boolean
  onPickProjectDir?:  () => void
  // 이슈 리포트(⚠)에 붙는 신원 — App.tsx 가 useAuth/useOrg 에서 내려준다.
  // WorkflowView 의 shareCtx 와 같은 모양. 없으면 ⚠ 버튼이 비활성.
  reportCtx?: {
    userId:       string
    userEmail:    string | null
    userName:     string | null
    orgIds:       string[]
    primaryOrgId: string | null
  }
}

// 인앱 확인 다이얼로그 옵션 (네이티브 window.confirm 대체).
export interface ConfirmOpts {
  title:         string
  message:       string
  confirmLabel?: string   // 기본 'OK'
  cancelLabel?:  string   // 기본 'Cancel'
  danger?:       boolean  // 확인 버튼을 위험(빨강) 톤으로
}

// ── 1회용 플랜 히스토리 — 저장/마이그레이션은 lib/copilotPlans.ts 참조 ────────

// ── 패널 폭 영속 (재시작·탭전환에도 노드 캔버스 크기 일관) ──────────────────
// deckPreview/deckDiag 는 Content 모드 전용 — wf 모드의 좌(캔버스)/우(브라우저)와
// 요구 폭이 정반대라(프리뷰가 넓어야 함) 값을 공유하면 매번 어긋난다.
type WidthKey = 'left' | 'right' | 'deckPreview' | 'deckDiag' | 'productPanel'
const widthKey = (which: WidthKey) => `twixy.copilot.width.${which}`
function loadWidthLS(which: WidthKey, fallback: number): number {
  try {
    const raw = localStorage.getItem(widthKey(which))
    const n = raw != null ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch { return fallback }
}
function saveWidthLS(which: WidthKey, px: number) {
  try { localStorage.setItem(widthKey(which), String(Math.round(px))) } catch { /* ignore */ }
}

// simple-plan 스펙 → ephemeral TwixyWorkflow. 디스크에 저장되지 않는 1회용 —
// id 접두사 plan_ 으로 저장/공유 경로들이 이를 걸러낸다. 노드 id 는 여기서 생성.
// sourceMsgId: 이 플랜을 만든 어시스턴트 메시지 — 채팅 ⚡ 칩 클릭이 자기 플랜을
// 찾는 매핑 (플랜 히스토리 항목에 함께 영속됨).
function planToWorkflow(spec: ParsedSpec, sourceMsgId?: string): CopilotPlan {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: `plan_${crypto.randomUUID().slice(0, 8)}`,
    title: spec.title,
    description: spec.description,
    author: { uid: 'copilot-simple' },
    createdAt: now,
    updatedAt: now,
    sourceMsgId,
    nodes: spec.nodes
      .filter(n => n.type !== 'review')   // 1회용 — 사람 확인 노드 없음 (방어)
      .map((n, i) => ({
        id:          n.id ?? `pn${i + 1}_${crypto.randomUUID().slice(0, 6)}`,
        type:        n.type,
        title:       n.title,
        detail:      n.detail,
        acceptance:  n.acceptance,
        skillHint:   n.skillHint,
        tool:        n.tool as TwixyWorkflowNode['tool'],
        toolSkills:  n.toolSkills,
        inputScope:  n.inputScope,
        outputScope: n.outputScope,
      })) as TwixyWorkflowNode[],
  }
}

// run 시작/재개 실패 사유 → 사용자 문구 (start/resume 공용).
function runFailureMsg(reason?: string): string {
  return reason === 'max_concurrent' ? 'Up to 3 workflows can run at once. Try again after one finishes.'
    : reason === 'already_running'   ? 'This workflow is already running — wait for it to finish or press ■ Stop first.'
    : 'This workflow has no nodes to run.'
}

// 채팅 입력 최대 길이 — 초과 방지 + 컴포저 하단 카운터로 안내.
const MAX_INPUT_LEN = 8000
/** 덱 되돌리기 깊이 — 한 대화가 들고 있는 이전 스펙 수 (플랜 캡과 같은 규칙). */
const DECK_UNDO_DEPTH = 20
/** 자동 검증 답장을 기다리는 한도. 넘으면 검증 없이 확정한다 — 홀드가 덱을
 *  영원히 붙잡는 것보다 검증 안 된 덱을 보여주는 편이 낫다. */
const DECK_QA_TIMEOUT_MS = 90_000

// 내장 모드의 칩 — 라벨·툴팁·칩 옆 한 줄 설명. 제품 등록 모드는 자기 것을 들고 온다.
const BUILTIN_MODE_CHIPS: Record<string, { icon: React.ReactNode; label: string; title: string; hint: string }> = {
  simple: {
    icon: <Zap size={11} />, label: 'Simple',
    title: 'Simple Execution — one-time task: plans a few steps from your request + existing data files and runs them immediately (nothing saved, no manual start)',
    hint: 'One-time task — plans & runs immediately, nothing saved',
  },
  wf: {
    icon: '◇', label: 'Workflow',
    title: 'Workflow mode — best for repetitive work: builds/runs reusable workflows',
    hint: 'Repetitive work → reusable workflow',
  },
  content: {
    icon: '▤', label: 'Content',
    title: 'Content mode — make a deck: the assistant writes the spec, the app renders a live preview, you fix it slide by slide',
    hint: 'Deck making — live preview, fix slide by slide',
  },
}

export function CopilotView({ workflows, createWorkflow, updateWorkflow, fetchUsageCost, projectDir, projectDirLoading, projectDirSetting, onPickProjectDir, reportCtx }: Props) {
  // 라이브 어시스턴트 메시지 핸들러 트램펄린 — 실제 로직(handleAssistant)은
  // 아래에서 정의되고 매 렌더 ref 로 갱신된다. 백그라운드 탭의 메시지는 큐에
  // 쌓았다가 그 탭이 활성화될 때 처리한다 (액션이 남의 탭 패널을 뺏지 않게).
  // Simple 모드 응답은 spec/action 처리 대상이 아니므로 여기서 걸러진다.
  const liveHandlerRef = useRef<((convId: string, msg: { id: string; content: string }) => void) | null>(null)
  // simple 모드 라이브 핸들러 — simple-plan 파싱→즉시 실행.
  const liveSimpleHandlerRef = useRef<((convId: string, msg: { id: string; content: string }) => void) | null>(null)
  // content 모드 라이브 핸들러 — deck-spec/deck-patch 파싱→프리뷰 갱신.
  const liveContentHandlerRef = useRef<((convId: string, msg: { id: string; content: string }) => void) | null>(null)
  const chat = useCopilotChat(workflows, (convId, msg, mode) => {
    // 제품 등록 모드는 스펙 블록을 앱이 파싱하지 않는다 — 에이전트가 툴로 직접 일하고
    // 결과는 그 모드의 SidePanel 이 보여준다.
    if (getProductCopilotMode(mode)) return
    if (mode === 'simple') { liveSimpleHandlerRef.current?.(convId, msg); return }
    if (mode === 'content') { liveContentHandlerRef.current?.(convId, msg); return }
    liveHandlerRef.current?.(convId, msg)
  })
  const activeConvRef = useRef<string | null>(null)
  useEffect(() => { activeConvRef.current = chat.activeConvId }, [chat.activeConvId])
  // wfId → 이 run 을 시작한 대화(탭) id. 러너 세션을 탭별로 잡고, run 도중
  // 유저가 탭을 바꿔도 세션 라우팅이 흔들리지 않게 "시작한 탭" 에 고정한다.
  const runConvRef = useRef<Map<string, string>>(new Map())
  // 탭별 raw scratch 폴더명 — 그 탭이 닫힐 때 삭제할 대상과 정확히 일치해야 함.
  const rawScratchFor = (convId: string) => `data/raw/tab-${convId.slice(0, 8)}`
  const scopeIdFor = (wfId: string): string => {
    const cid = runConvRef.current.get(wfId) ?? activeConvRef.current
    return cid ? `${cid}::${wfId}` : wfId
  }
  const [draft, setDraft] = useState('')
  const [wfDrawerOpen, setWfDrawerOpen]   = useState(false)   // ☰ 워크플로 리스트
  const [historyOpen,  setHistoryOpen]    = useState(false)   // ⚙ 채팅 기록
  const [runError, setRunError] = useState<string | null>(null)
  // ── 인앱 확인 다이얼로그 (네이티브 window.confirm 대체) ────────────────────
  // Promise 기반: confirm({...}) → 사용자가 OK/Cancel 하면 true/false 로 resolve.
  const [confirmState, setConfirmState] = useState<ConfirmOpts & { resolve: (ok: boolean) => void } | null>(null)
  const confirm = useCallback((opts: ConfirmOpts): Promise<boolean> => {
    return new Promise(resolve => setConfirmState({ ...opts, resolve }))
  }, [])
  // ── ⚠ 이슈 리포트 모달 ─────────────────────────────────────────────────────
  // 메모 텍스트/전송중/성공/에러는 전부 ReportIssueModal 내부 상태 — 여기 두면
  // 메모 한 글자마다 이 거대한 트리가 리렌더된다.
  const [reportOpen, setReportOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // ── Simple 모드의 1회용 플랜 히스토리 — 대화별 배열 + 활성 플랜 id ─────────
  // 저장되는 워크플로가 아니라 즉시 실행되는 ephemeral 플랜들. 새 플랜이 이전
  // 걸 덮어쓰지 않고 append 되어(캡 20) 전전/전전전 플랜으로 돌아가 보거나
  // 재실행하거나 채팅으로 수정 요청("plan 2 고쳐줘")할 수 있다. 패널 복원용
  // 으로만 영속 (run 상태는 메모리 전용 — 1회용 계약 유지).
  const [plansByConv, setPlansByConv] = useState<Map<string, CopilotPlan[]>>(new Map())
  // Content 모드의 덱 스펙 — 대화별 1개. 파일이 아니라 스펙이 진실이고, 파일은
  // Export 때만 나온다(프리뷰와 .pptx 가 같은 계산에서 나오도록).
  const [decksByConv, setDecksByConv] = useState<Map<string, TwixyWritePptxPayload>>(new Map())
  const deck = chat.activeConvId ? decksByConv.get(chat.activeConvId) ?? null : null
  // 사진의 모양은 호스트만 안다 — 읽어서 코어에 넘긴다(main 은 sharp 로 같은
  // 숫자를 구한다). 로드 전 첫 프레임은 비율 없이 그려지고, 도착하면 한 번
  // 다시 그려져 파일과 같은 기하로 수렴한다.
  const imageAspects = useImageAspects(deck)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  /** 마지막으로 내보낸 .pptx 의 워크스페이스 상대경로 — Open/Reveal 의 대상. */
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  // 깨진 deck 블록을 사용자에게 보여주기 위한 대화별 에러 + 자동 재요청 1회 제한.
  const [deckError, setDeckError] = useState<Map<string, string>>(new Map())
  const deckRetriedRef = useRef<Set<string>>(new Set())
  /** 시각 QA 를 이미 보낸 대화 — 덱당 1회 규칙의 가드 (deckRetriedRef 와 같은 패턴). */
  const deckQaRef = useRef<Set<string>>(new Set())
  const deckErr = chat.activeConvId ? deckError.get(chat.activeConvId) ?? null : null
  // 선택 슬라이드는 두 패널이 공유한다 — 좌측 디자인 타일이 "지금 보고 있는
  // 그 장"을 그려야 옵션 비교가 성립한다. 슬라이드 수가 줄면 패널이 클램프.
  const [deckSel, setDeckSel] = useState(0)
  // 되돌리기 스택 — 대화별 이전 스펙들. 세션 메모리 전용(플랜 run 상태와 같은
  // 규칙): 앱을 껐다 켜면 '지금 덱'만 남는다. 되돌릴 지점을 **커밋하는 쪽이
  // 명시**한다 — 커밋 시점에 이전 값을 읽는 자동 push 는 언어 교정처럼 한
  // 턴이 두 번 커밋하는 경로에서 undo 를 두 번 눌러야 하는 결과를 낳는다.
  const [deckPast, setDeckPast] = useState<Map<string, TwixyWritePptxPayload[]>>(new Map())
  const deckUndoDepth = chat.activeConvId ? (deckPast.get(chat.activeConvId)?.length ?? 0) : 0
  const commitDeck = useCallback((convId: string, next: TwixyWritePptxPayload, undoFrom?: TwixyWritePptxPayload | null) => {
    if (undoFrom) {
      setDeckPast(h => new Map(h).set(convId, [...(h.get(convId) ?? []), undoFrom].slice(-DECK_UNDO_DEPTH)))
    }
    setDecksByConv(prev => new Map(prev).set(convId, next))
    saveDeckLS(convId, next)
  }, [])

  // ── 원본 유지 편집 (Content 모드의 두 번째 경로) ────────────────────────────
  // 사용자의 .pptx 를 디자인 그대로 고친다. 덱 스펙과 배타적 — 여기서는 파일이
  // 진실이고 화면엔 아웃라인만 보인다(painter 는 남의 덱을 못 그린다). 모델은
  // ```pptx-edit``` 블록으로 op 목록을 내놓고, 사람이 Apply 를 눌러야 IPC 로
  // 실행된다. 자동 반영 없음 — 원본 파일을 건드리는 일이라서.
  const [editTargets, setEditTargets] = useState<Map<string, PptxEditTarget>>(new Map())
  /** 선택 대기 중인 .pptx 들 (대화별). 여러 개를 한 번에 올릴 수 있으므로 리스트다 —
   *  예전엔 첫 개만 보고 나머지를 조용히 흘렸다. */
  const [pendingPptxByConv, setPendingPptxByConv] = useState<Map<string, string[]>>(new Map())
  /** 파싱은 됐지만 아직 Apply 안 한 블록 (대화별). */
  const [pendingEditByConv, setPendingEditByConv] = useState<Map<string, { ops: PptxEditOp[]; warnings: string[]; outRelPath?: string }>>(new Map())
  /** 마지막 Apply/파싱 결과 한 줄 — 패널 하단에 표시. */
  const [editResultByConv, setEditResultByConv] = useState<Map<string, { ok: boolean; text: string }>>(new Map())
  const editRetriedRef = useRef<Set<string>>(new Set())
  /** 와이어프레임 시트(data URL) — 패널용, 메모리 전용(LS 엔 경로만). */
  const [sketchUrlByConv, setSketchUrlByConv] = useState<Map<string, string>>(new Map())
  /** 시트가 갱신됐지만 모델은 아직 못 본 대화 — 다음 전송에 한 번 붙인다. */
  const sketchUnseenRef = useRef<Set<string>>(new Set())
  /** 그림이 실물 렌더인지 근사인지 — 사용자가 무엇을 보고 있는지 알아야 한다. */
  const [sketchViaByConv, setSketchViaByConv] = useState<Map<string, 'libreoffice' | 'sketch'>>(new Map())
  /** 슬라이드별 이미지 — 페이지별 보기. 시트는 이걸 축소해 붙인 것. */
  const [pagesByConv, setPagesByConv] = useState<Map<string, string[]>>(new Map())
  /** 시트(전체 한 장) ↔ 페이지(한 장씩). 대화가 아니라 화면 상태라 대화별로 안 나눈다. */
  const [deckView, setDeckView] = useState<'sheet' | 'page'>('sheet')
  const [pageIdx, setPageIdx] = useState(0)
  const editTarget  = chat.activeConvId ? editTargets.get(chat.activeConvId) ?? null : null
  const sketchUrl   = chat.activeConvId ? sketchUrlByConv.get(chat.activeConvId) ?? null : null
  const sketchVia   = chat.activeConvId ? sketchViaByConv.get(chat.activeConvId) ?? null : null
  const pages       = chat.activeConvId ? pagesByConv.get(chat.activeConvId) ?? [] : []
  /** 대화가 아직 없으면 이 키로 보관했다가, 대화가 생기는 순간 옮긴다. */
  const PENDING_NEW = '__new__'
  const pendingPptx = pendingPptxByConv.get(chat.activeConvId ?? PENDING_NEW) ?? []
  const pendingEdit = chat.activeConvId ? pendingEditByConv.get(chat.activeConvId) ?? null : null
  const editResult  = chat.activeConvId ? editResultByConv.get(chat.activeConvId) ?? null : null

  useEffect(() => {
    const id = chat.activeConvId
    if (!id) return
    setPendingPptxByConv(prev => {
      const held = prev.get(PENDING_NEW)
      if (!held?.length) return prev
      const n = new Map(prev); n.delete(PENDING_NEW)
      n.set(id, [...new Set([...(prev.get(id) ?? []), ...held])])
      return n
    })
  }, [chat.activeConvId])

  const setEditResult = useCallback((convId: string, r: { ok: boolean; text: string } | null) => {
    setEditResultByConv(prev => { const n = new Map(prev); if (r) n.set(convId, r); else n.delete(convId); return n })
  }, [])
  const clearPendingEdit = useCallback((convId: string) => {
    setPendingEditByConv(prev => { const n = new Map(prev); n.delete(convId); return n })
  }, [])
  /** 와이어프레임 시트를 (재)생성해 target 에 경로·shapes 를 얹고 패널 이미지를 갱신한다. */
  const refreshSketch = useCallback(async (convId: string, target: PptxEditTarget, markUnseen: boolean): Promise<PptxEditTarget> => {
    const res = await window.twixy?.tools?.renderPptxSketch?.({ convId, relPath: target.relPath })
    if (!res?.ok) return target   // 스케치는 조언용 — 실패해도 편집은 계속된다
    const next: PptxEditTarget = {
      ...target,
      sketchAbsPath: res.absPath,
      layouts: res.layouts,
      outline: target.outline.map(o => ({ ...o, shapes: res.summary[o.slide - 1]?.shapes ?? o.shapes })),
    }
    setEditTargets(prev => new Map(prev).set(convId, next))
    saveEditTargetLS(convId, next)
    setSketchUrlByConv(prev => new Map(prev).set(convId, res.dataUrl))
    setSketchViaByConv(prev => new Map(prev).set(convId, res.via))
    setPagesByConv(prev => new Map(prev).set(convId, res.pages))
    // 슬라이드 수가 줄었을 수 있다 — 보고 있던 페이지를 범위 안으로.
    setPageIdx(i => Math.min(i, Math.max(0, res.pages.length - 1)))
    if (markUnseen) sketchUnseenRef.current.add(convId)
    return next
  }, [])
  /** 프렐류드 — 시트가 새것이면 이번 한 번만 이미지를 같이 보낸다. */
  const preludeFor = useCallback((convId: string, target: PptxEditTarget): string => {
    const withImage = sketchUnseenRef.current.has(convId)
    sketchUnseenRef.current.delete(convId)
    return describeEditTarget(target, { withImage })
  }, [])
  /** 편집 대상 해제 — 스펙 경로로 돌아가거나 그냥 끝낼 때. */
  const stopEditTarget = useCallback((convId: string) => {
    setEditTargets(prev => { const n = new Map(prev); n.delete(convId); return n })
    clearEditTargetLS(convId)
    clearPendingEdit(convId)
    setEditResult(convId, null)
    setSketchUrlByConv(prev => { const n = new Map(prev); n.delete(convId); return n })
    setSketchViaByConv(prev => { const n = new Map(prev); n.delete(convId); return n })
    setPagesByConv(prev => { const n = new Map(prev); n.delete(convId); return n })
    sketchUnseenRef.current.delete(convId)
  }, [clearPendingEdit, setEditResult])
  /** 원본 유지 경로 시작 — 아웃라인을 읽어 대상으로 삼고, 같은 대화의 덱 스펙은 치운다. */
  const startEditTarget = useCallback(async (convId: string, relPath: string) => {
    setPendingPptxByConv(prev => { const n = new Map(prev); n.delete(convId); return n })
    const res = await window.twixy?.tools?.readPptx?.({ relPath })
    if (!res?.ok) { setEditResult(convId, { ok: false, text: `Can't read ${relPath} — ${(res as { error?: string })?.error ?? 'unknown'}` }); return }
    const target: PptxEditTarget = {
      relPath,
      originalRelPath: relPath,
      slideCount: res.slideCount,
      outline: res.slides.map(sl => ({ slide: sl.index + 1, title: sl.title, texts: sl.body.length, textShapes: sl.textShapes })),
    }
    setEditTargets(prev => new Map(prev).set(convId, target))
    saveEditTargetLS(convId, target)
    // 덱 스펙과 배타 — 둘 다 있으면 "3번 고쳐" 가 어느 쪽인지 모호하다.
    setDecksByConv(prev => { const n = new Map(prev); n.delete(convId); return n })
    clearDeckLS(convId)
    setEditResult(convId, { ok: true, text: `${relPath} — ${res.slideCount} slides. Design stays as-is; tell me what to change.` })
    void refreshSketch(convId, target, true)
  }, [setEditResult, refreshSketch])
  const undoDeck = useCallback(() => {
    const convId = chat.activeConvId
    if (!convId) return
    const stack = deckPast.get(convId) ?? []
    const prev = stack[stack.length - 1]
    if (!prev) return
    setDeckPast(h => new Map(h).set(convId, stack.slice(0, -1)))
    setDecksByConv(p => new Map(p).set(convId, prev))
    saveDeckLS(convId, prev)
    // 내보낸 파일은 되돌린 덱이 아니다 — Open 버튼이 옛 파일을 가리키지 않게.
    setExportMsg(null)
    setExportedPath(null)
  }, [chat.activeConvId, deckPast])
  /** 디자인 패널의 로컬 편집 — 모델 왕복 없이 스펙만 갈아끼운다(프리뷰=파일). */
  const applyDeckDesign = useCallback((next: TwixyWritePptxPayload) => {
    const convId = chat.activeConvId
    if (!convId) return
    try { buildDeck(next) } catch { return }   // 안 그려지는 조합은 커밋하지 않는다
    commitDeck(convId, next, decksByConv.get(convId) ?? null)
  }, [chat.activeConvId, commitDeck, decksByConv])
  // 자동 검증 홀드 — 첫 덱은 검증이 끝난 뒤에 한 번만 화면에 올린다.
  // `base` 는 검증에 부친 덱, `prev` 는 되돌리기 지점, `timer` 는 모델이
  // 대답하지 않을 때의 안전망(홀드가 덱을 인질로 잡으면 안 된다).
  const deckHoldRef = useRef<Map<string, { base: TwixyWritePptxPayload; prev: TwixyWritePptxPayload | null; timer: number; startedAt: number }>>(new Map())
  /** 검증 홀드 중인 대화 → 지금 무슨 단계인지. 빈 화면을 오래 보여줄 거면
   *  최소한 무엇을 기다리는지는 말해야 한다. */
  const [deckVerifying, setDeckVerifying] = useState<Map<string, string>>(new Map())
  const setDeckStage = useCallback((convId: string, stage: string) => {
    setDeckVerifying(p => new Map(p).set(convId, stage))
  }, [])
  const releaseDeckHold = useCallback((convId: string, payload: TwixyWritePptxPayload, prev: TwixyWritePptxPayload | null) => {
    const held = deckHoldRef.current.get(convId)
    if (held) {
      clearTimeout(held.timer)
      // 얼마나 걸렸는지는 재서 남긴다 — "엄청 오래 걸린다" 를 다시 추측으로
      // 따라가지 않기 위해.
      uiLog(`[deck-hold] released after ${((Date.now() - held.startedAt) / 1000).toFixed(1)}s`)
    }
    deckHoldRef.current.delete(convId)
    // 더 이상 그 답장을 기다리지 않는다. 플래그를 남겨두면 뒤늦게 도착한
    // 검증 답장이 **사용자의 다음 질문에 대한 답**으로 오인돼 삼켜진다
    // (2026-09-15: 사용자가 보낸 메시지에 답이 안 온 실사고).
    chat.cancelSilentTurn(convId)
    setDeckVerifying(p => { const n = new Map(p); n.delete(convId); return n })
    commitDeck(convId, payload, prev)
  }, [commitDeck, chat])
  /** 채팅 버블의 덱 블록을 썸네일로 — 현재 덱의 테마/스타일로 그 장만 그린다. */
  const deckThumb = useCallback((slide: TwixySlideSpec): SlideDisplay | null => {
    const cur = chat.activeConvId ? decksByConv.get(chat.activeConvId) : null
    if (!cur) return null
    try { return buildDeck({ ...cur, slides: [slide] }, { imageAspects }).slides[0] ?? null } catch { return null }
  }, [chat.activeConvId, decksByConv, imageAspects])
  // buildDeck 은 순수 함수 — 스펙이 그대로면 재계산하지 않는다. 좌측 프리뷰와
  // 우측 진단이 같은 결과를 봐야 하므로 여기서 한 번만 만든다.
  const deckDisplay = useMemo(() => {
    if (!deck) return null
    try { return { ok: true as const, value: buildDeck(deck, { imageAspects }) } }
    catch (e) { return { ok: false as const, error: (e as Error).message } }
  }, [deck, imageAspects])
  // 선택은 index 가 아니라 plan id — append/캡 evict 로 배열이 밀려도 선택 유지.
  // 세션 메모리 전용: 재시작/탭 복원 시엔 아래 fallback 이 최신 플랜을 고른다.
  const [activePlanIdByConv, setActivePlanIdByConv] = useState<Map<string, string>>(new Map())
  const plans = chat.activeConvId ? plansByConv.get(chat.activeConvId) ?? [] : []
  const activePlanId = chat.activeConvId ? activePlanIdByConv.get(chat.activeConvId) ?? null : null
  // fallback: 미선택(복원 직후)·선택 플랜 evict·stale id → 최신 플랜.
  const planWorkflow = plans.find(p => p.id === activePlanId) ?? plans.at(-1) ?? null
  const selectPlan = useCallback((convId: string, planId: string) => {
    setActivePlanIdByConv(prev => new Map(prev).set(convId, planId))
  }, [])
  // 접힘 상태 — 플랜 스택에서 각 플랜 컨테이너를 접고/펼침. plan id 는 전역
  // 고유(plan_uuid)라 대화 구분 없이 한 Set 으로 충분. 새 플랜 도착/복원 시
  // 최신만 펼침(아래 seed) — 나머지는 접힌 채 쌓인다.
  const [expandedPlans, setExpandedPlans] = useState<Set<string>>(new Set())
  const togglePlanExpand = useCallback((planId: string) => {
    setExpandedPlans(prev => {
      const next = new Set(prev)
      if (next.has(planId)) next.delete(planId); else next.add(planId)
      return next
    })
  }, [])
  // 헤더 본문 클릭 = 활성화(+펼침). 우측 패널(브라우저/활동)이 이 플랜을 따라간다.
  const activatePlan = useCallback((planId: string) => {
    const cid = activeConvRef.current
    if (cid) selectPlan(cid, planId)
    setExpandedPlans(prev => (prev.has(planId) ? prev : new Set(prev).add(planId)))
  }, [selectPlan])
  // 채팅 ⚡ 칩 → 플랜 매핑 — sourceMsgId 로 찾는다 (재시작 후에도 안전).
  // 매칭 실패(피처 이전 메시지 / 캡 evict)는 null → 칩이 비활성 span 으로 렌더.
  const resolvePlanId = useCallback((msgId: string): string | null => {
    const convId = chat.activeConvId
    if (!convId) return null
    return (plansByConv.get(convId) ?? []).find(p => p.sourceMsgId === msgId)?.id ?? null
  }, [chat.activeConvId, plansByConv])

  // ── 실행 머신 — WorkflowView 와 같은 훅, 자체 인스턴스 ─────────────────────
  const [runWorkflowId, setRunWorkflowId] = useState<string | null>(null)
  // 방금 생성한 워크플로 — workflows 목록의 refresh 를 기다리지 않고 즉시 사용.
  const lastCreatedRef = useRef<TwixyWorkflow | null>(null)
  const runWorkflow =
    (runWorkflowId ? workflows.find(w => w.id === runWorkflowId) : null)
    ?? (lastCreatedRef.current?.id === runWorkflowId ? lastCreatedRef.current : null)

  // 패널이 보여줄 대상 — 모드 토글이 곧 "패널 내용 스위치":
  //   wf     → 저장된 워크플로 (runWorkflowId)
  //   simple → 이 대화의 1회용 플랜
  // 채팅은 그대로, 좌우 패널의 내용물만 바뀐다 (디자인 동일).
  const displayWorkflow = chat.activeMode === 'simple' ? planWorkflow : runWorkflow
  // 세션훅에는 "스코프된" id 를 넘긴다 — 러너 세션이 탭별 스코프(`${convId}::
  // ${wfId}`)로 생성되므로, 활성 세션 바인딩(activeKeyRef)도 같은 스코프로
  // 비교해야 live activity(toolActivity/messages)가 화면에 미러링된다. raw
  // wfId 를 넘기면 스코프와 안 맞아 미러링이 통째로 죽는다.
  const testSession = useWorkflowTestSession(displayWorkflow ? scopeIdFor(displayWorkflow.id) : null)
  const test = useWorkflowTest({
    sendAndAwaitFinal:    testSession.sendAndAwaitFinal,
    cancelTurn:           testSession.cancelTurn,
    fetchUsageCost,
    fetchSessionUsage:    testSession.fetchSessionUsage,
    assignBrowserProfile: testSession.assignBrowserProfile,
    // 러너 세션을 탭별로 (같은 WF 를 두 탭에서 열어도 기억 분리, 탭 닫으면 파괴).
    sessionScope:         scopeIdFor,
    // 중간/수집 파일은 탭별 raw 폴더로 — 탭 닫을 때 이것만 지운다.
    rawScratchDir:        (wfId) => {
      const cid = runConvRef.current.get(wfId) ?? activeConvRef.current
      return cid ? rawScratchFor(cid) : null
    },
  })
  const runState = displayWorkflow ? test.stateFor(displayWorkflow.id) : EMPTY_TEST_STATE
  // Auto-review — 항시 활성 (UI 토글 제거). WF 탭과 동일한 조건(성공 완료 시
  // 1회)으로 발사하되, 리뷰 요청/응답이 copilot 챗 세션을 통해 흐른다.
  const autoReviewedRunRef = useRef<Map<string, number>>(new Map())

  // ── ⚠ 이슈 리포트 — 활성 탭(세션)의 로그를 Twixy 지원팀 서버로 업로드 ───────
  // 모달이 "무엇이 올라가는지" 를 보내기 전에 먼저 보여준다.
  const reportSummary = useMemo(() => {
    const conv = chat.conversations.find(c => c.id === chat.activeConvId) ?? null
    const wf   = (conv?.mode ?? 'wf') === 'simple' ? planWorkflow : runWorkflow
    const wfId = wf?.id ?? conv?.workflowId ?? runWorkflowId ?? null
    return {
      convTitle:     conv?.title ?? '(untitled)',
      messageCount:  chat.messages.length,
      activityCount: chat.activityLog.length,
      wfTitle:       wf?.title ?? null,
      hasRun:        !!(wfId && test.stateFor(wfId).startedAt),
    }
  }, [chat.conversations, chat.activeConvId, chat.messages.length, chat.activityLog.length,
      planWorkflow, runWorkflow, runWorkflowId, test])

  // 실제 수집 + 업로드 — 모달에서 사용자가 [Send report] 를 눌렀을 때만 호출된다.
  const submitReport = useCallback(async (note: string): Promise<SubmitResult> => {
    const conv = chat.conversations.find(c => c.id === chat.activeConvId)
    if (!conv || !reportCtx) throw new ReportError('unknown', 'no active conversation')

    // wf 모드는 저장된 워크플로, simple 모드는 이 대화의 1회용 플랜이 대상.
    const mode   = (conv.mode ?? 'wf') as 'wf' | 'simple'
    const target = mode === 'simple' ? planWorkflow : runWorkflow
    const wfId   = target?.id ?? conv.workflowId ?? runWorkflowId ?? null
    const st     = wfId ? test.stateFor(wfId) : null

    // run 상세: 같은 워크플로를 Workflow 탭에서도 돌렸다면 디스크본이 더 풍부하다.
    // 하지만 CT 탭은 저장하지 않으므로 대개 null → 메모리 상태에서 조립한다.
    let runDetail: TwixyRunDetail | null = null
    if (wfId && st?.startedAt) {
      runDetail = await Promise.race([
        window.twixy?.workflowRunDetailLoad?.(wfId, st.startedAt).catch(() => null) ?? Promise.resolve(null),
        new Promise<null>(r => setTimeout(() => r(null), 3_000)),
      ])
      runDetail ??= composeRunDetail(target ?? null, wfId, st)
    }

    // 부가 로그 수집 실패는 무음 — 리포트 자체를 막으면 안 된다.
    const [openClawLogTail, workspace] = await Promise.all([
      window.twixy?.getOpenClawLog?.().catch(() => '') ?? Promise.resolve(''),
      window.twixy?.getWorkspace?.().catch(() => null) ?? Promise.resolve(null),
    ])

    return submitSessionReport({
      note: note.trim() || null,
      conversation: {
        id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt,
        mode, workflowId: conv.workflowId ?? null, archived: !!conv.archivedAt,
      },
      messages:    chat.messages,
      activityLog: chat.activityLog,
      workflow:    target
        ? { id: target.id, title: target.title, type: (target as TwixyWorkflow).type, nodeCount: target.nodes.length }
        : null,
      runState:    st,
      runDetail,
      openClawLogTail,
      env:         buildReportEnv({ workspace, projectDir: projectDir ?? null }),
      identity:    { ...reportCtx },
    })
  }, [chat.conversations, chat.activeConvId, chat.messages, chat.activityLog,
      planWorkflow, runWorkflow, runWorkflowId, test, projectDir, reportCtx])

  // simple 모드: 프리뷰는 "지금 실행 중인 최신(가장 나중에 시작한) 크롬 사용
  // 플랜"의 브라우저에 고정 — 히스토리에서 이전 플랜을 열람해도 브라우저는 안
  // 바뀐다. 옛 플랜의 브라우저는 의미가 없고, 유의미한 화면은 돌아가는 run 뿐.
  // 아무 플랜도 안 돌면 기존처럼 표시 중인 플랜의 마지막 브라우저로 폴백.
  const runningBrowserPlan = chat.activeMode === 'simple'
    ? plans
        .filter(p => p.nodes.some(n => n.tool === 'chrome'))
        .map(p => ({ p, st: test.stateFor(p.id) }))
        .filter(x => x.st.isRunning && x.st.browserProfile)
        .sort((a, b) => (b.st.startedAt ?? 0) - (a.st.startedAt ?? 0))[0] ?? null
    : null

  // 활성 run 의 브라우저 슬롯 → 프리뷰 CDP 포트 (wf-N → 18800+N).
  // 슬롯이 배정되기 전에는 프리뷰를 붙이지 않는다 — 기본 18800 은 채팅용
  // Chrome 이라 "실행 중인 브라우저와 다른 화면" 을 보여주게 된다.
  const previewPort = (() => {
    const profile = runningBrowserPlan?.st.browserProfile ?? runState.browserProfile
    const m = /^wf-(\d)$/.exec(profile ?? '')
    return m ? cdpPortForSlot(Number(m[1])) : null
  })()

  // 워크플로/브라우저 패널은 표시할 워크플로가 있을 때만 연다.
  const panelsOpen = !!displayWorkflow
  // Content 모드의 산출물은 워크플로가 아니라 덱이다 — 이걸 panelsOpen(= 워크플로
  // 존재 여부)에 묶어두는 바람에 스펙이 정상이고 16장이 렌더돼도 패널 폭이 0 이라
  // "아무것도 안 뜨는" 것처럼 보였다.
  //
  // 열리는 시점은 다른 모드와 같은 규칙을 따른다: 산출물이 생겼을 때. 워크플로
  // 모드가 displayWorkflow 를 기다리듯 여기서는 "첫 답변"을 기다린다 — 모드에
  // 들어가자마자 빈 패널 두 장이 펼쳐지면 채팅이 가운데로 밀려 입력 전부터
  // 화면이 산만해진다.
  const deckPanelOpen = chat.activeMode === 'content' && (chat.messages.some((m) => m.role === 'assistant') || !!editTarget)
  // 제품 등록 모드의 오른쪽 패널 — 첫 답장 뒤에 연다 (덱 패널과 같은 규칙).
  const productMode = getProductCopilotMode(chat.activeMode)
  const ProductSidePanel = productMode?.SidePanel
  const assistantTurns = chat.messages.reduce((n, m) => n + (m.role === 'assistant' ? 1 : 0), 0)
  const productPanelOpen = !!ProductSidePanel && assistantTurns > 0
  const leftOpen = panelsOpen || deckPanelOpen
  const rightOpen = panelsOpen || deckPanelOpen || productPanelOpen

  // ── run 상태 디스크 영속 (WF탭과 같은 파일 공유) ──────────────────────────
  // 앱 재시작 후에도 노드 상태/출력/입력값이 복원된다 → 패널 복원·Resume·
  // simple 모드의 "지난 run 결과 seed" 가 재시작을 넘어 동작한다.
  useEffect(() => {
    if (!runWorkflowId) return
    let cancelled = false
    ;(async () => {
      try {
        const saved = await window.twixy?.workflowTestRunLoad?.(runWorkflowId)
        if (!cancelled && saved) test.hydrate(runWorkflowId, saved)
      } catch { /* 디스크 미스 무시 */ }
    })()
    return () => { cancelled = true }
    // test.hydrate 는 stable(useCallback []) — 실행 중이면 스스로 no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runWorkflowId])

  // run 종료 시 저장 — 전체 states 감시로 백그라운드 병렬 run 도 빠짐없이.
  // 1회용 플랜(plan_*)은 저장하지 않는다 — 워크플로 디렉토리에 유령이 생긴다.
  const savedEndedAtRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    for (const [wfId, st] of Object.entries(test.states)) {
      // plan_* run 상태는 메모리 전용 — 플랜 히스토리 드롭다운의 상태점은 이번
      // 세션의 run 만 표시하고, 재시작 후엔 '—' 가 된다. 디스크 영속은 캡 evict/
      // 대화 삭제 시 유령 파일 정리가 필요해 보류 (future work).
      if (wfId.startsWith('plan_')) continue
      // 디스크에서 읽어온 그대로를 도로 쓰는 건 무의미한 왕복 — 건너뛴다.
      if (st.hydrated) continue
      if (st.isRunning || !st.endedAt) continue
      if (savedEndedAtRef.current.get(wfId) === st.endedAt) continue
      savedEndedAtRef.current.set(wfId, st.endedAt)
      void window.twixy?.workflowTestRunSave?.(wfId, st)
    }
  }, [test.states])

  // 최초 마운트 1회: 복원된 활성 대화의 워크플로 패널 복원 (세션 없이 UI 만 —
  // useWorkflowTestSession 이 peek-only 라 세션은 생기지 않는다).
  useEffect(() => {
    const id = chat.activeConvId
    if (!id) return
    const c = chat.conversations.find(x => x.id === id)
    if (c?.workflowId) setRunWorkflowId(c.workflowId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 현재 대화에 워크플로 연결 기록 — 기록에서 대화를 다시 열 때 패널 복원용.
  useEffect(() => {
    if (chat.activeConvId) chat.setConversationWorkflow(chat.activeConvId, runWorkflowId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runWorkflowId, chat.activeConvId])
  // 브라우저(chrome 툴)를 쓰는 워크플로만 프리뷰 섹션을 보여준다. web-fetch/
  // read/write 만 쓰는 워크플로는 Chrome 이 아예 안 뜨므로 "Waiting for
  // browser…" 가 영원히 남는다 — 그 공간은 Live activity 에 몰아준다.
  // 실행 중인 크롬 플랜이 있으면(프리뷰 고정 대상) 표시 플랜이 크롬을 안 써도
  // 프리뷰 섹션을 유지한다 — 히스토리 열람이 돌아가는 브라우저 화면을 숨기지 않게.
  const usesBrowser = !!displayWorkflow?.nodes.some(n => n.tool === 'chrome') || !!runningBrowserPlan

  // ── 패널 리사이즈 (마우스 드래그) ──────────────────────────────────────────
  // 노드 캔버스 패널 폭. Workflow 탭은 캔버스가 flex 로 넓게 퍼져 노드 카드가
  // 크게 보이는데, 여기(채팅-퍼스트)는 고정폭 사이드 패널이라 좁으면 노드가
  // 작아 보인다 — 기본을 넉넉히(560) 주고 최대도 900 까지 늘려 워크플로 탭과
  // 비슷한 크기로 그릴 수 있게 한다. wf/simple 모드가 이 값을 공유하므로 둘은
  // 항상 같은 크기. localStorage 로 영속해 재시작·탭전환에도 일관되게 유지.
  const [leftWidth,      setLeftWidth]      = useState(() => loadWidthLS('left', 560))   // NodeCanvas 패널
  const [rightWidth,     setRightWidth]     = useState(400)   // 브라우저+활동 패널
  // Content 모드: 우측이 덱 프리뷰(넓게), 좌측이 진단(좁게).
  const [deckPreviewWidth, setDeckPreviewWidth] = useState(() => loadWidthLS('deckPreview', 560))
  const [deckDiagWidth,    setDeckDiagWidth]    = useState(() => loadWidthLS('deckDiag', 380))
  // 제품 등록 모드의 우측 패널 (예: Nodal 의 노드 그래프 + 결과) — 그래프를 넓게 보려면 끌어서 넓힌다.
  const [productPanelWidth, setProductPanelWidth] = useState(() => loadWidthLS('productPanel', 480))
  const [activityHeight, setActivityHeight] = useState(190)   // 활동 피드 높이
  // 드래그 중에는 width 트랜지션(슬라이드-인용)을 꺼야 핸들이 즉각 따라온다.
  const [dragging, setDragging] = useState(false)

  const startDrag = (
    e: React.PointerEvent,
    apply: (deltaX: number, deltaY: number) => void,
  ) => {
    e.preventDefault()
    setDragging(true)
    const startX = e.clientX
    const startY = e.clientY
    const onMove = (ev: PointerEvent) => apply(ev.clientX - startX, ev.clientY - startY)
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ── run 시작/재개 (액션/NodeCanvas 버튼 공용) — 영어 에러 메시지 ───────────
  // run 시작 전 이 run 의 소유 탭을 고정 — 세션 스코프/raw 폴더가 "시작한 탭"
  // 을 따르게 (도중 탭 전환에도 흔들리지 않음).
  const pinRunConv = useCallback((wfId: string) => {
    const cid = activeConvRef.current
    if (cid) runConvRef.current.set(wfId, cid)
  }, [])

  // 탭(대화) 닫기 — 아카이브에 더해 그 탭의 러너 기억(세션)과 raw scratch 파일을
  // 완전히 없앤다. 같은 WF 를 다른 탭에서 열어도 안 섞이고, 중간 파일이 디스크에
  // 쌓이지 않는다. 최종 산출물(data/reports)은 건드리지 않는다.
  const closeConversation = useCallback((id: string) => {
    void testSession.destroyScope(`${id}::`)
    void window.twixy?.workflowRawScratchClear?.(rawScratchFor(id)).catch(() => {})
    for (const [wfId, cid] of runConvRef.current) if (cid === id) runConvRef.current.delete(wfId)
    const wasActive = chat.activeConvId === id
    chat.archiveConversation(id)
    if (wasActive) setRunWorkflowId(null)
  }, [testSession, chat])

  const startRun = useCallback(async (wf: TwixyWorkflow, inputs: Record<string, string>) => {
    setRunError(null)
    pinRunConv(wf.id)
    const res = await test.start(wf, inputs)
    if (!res.ok) {
      setRunError(runFailureMsg(res.reason))
    }
  }, [test, pinRunConv])

  // 실패/중단 run 재개 — 입력값은 직전 run 것을 훅이 재사용.
  const resumeRun = useCallback(async (wf: TwixyWorkflow) => {
    setRunError(null)
    pinRunConv(wf.id)
    const res = await test.resume(wf)
    if (!res.ok) setRunError(runFailureMsg(res.reason))
  }, [test, pinRunConv])

  // 마지막 run 기반 특정 노드부터 재실행 — 앞 노드 결과는 보존/recap 전달.
  const runFromNode = useCallback(async (wf: TwixyWorkflow, nodeId: string) => {
    setRunError(null)
    pinRunConv(wf.id)
    const res = await test.startFromNode(wf, nodeId)
    if (!res.ok) setRunError(runFailureMsg(res.reason))
  }, [test, pinRunConv])

  // ── 탭 내부 단일 실행 게이트 ────────────────────────────────────────────────
  // 탭(대화) 3개까지 병렬은 유지하되, 한 탭 안에서는 플랜 1개만 실행. 실행 중인
  // 다른 플랜이 있으면 먼저 경고(twixy 다이얼로그) → OK 면 그걸 중지하고 진행.
  // 없으면 액션 고유 확인(있으면)만 띄운다.
  const gatePlanRun = useCallback(async (
    plan: CopilotPlan,
    ownConfirm: ConfirmOpts | null,
    run: () => void,
  ) => {
    const cid = activeConvRef.current
    const sibling = (cid ? plansByConv.get(cid) ?? [] : [])
      .find(p => p.id !== plan.id && test.stateFor(p.id).isRunning)
    if (sibling) {
      const ok = await confirm({
        title: 'Stop the running plan?',
        message: `"${sibling.title}" is still running. Only one plan runs at a time in a chat tab — starting this will stop that one first.`,
        confirmLabel: 'Stop & run',
        danger: true,
      })
      if (!ok) return
      test.stop(sibling.id)
      await new Promise(r => setTimeout(r, 150))   // abort 전파 여유
      run()
      return
    }
    if (ownConfirm) {
      const ok = await confirm(ownConfirm)
      if (!ok) return
    }
    run()
  }, [plansByConv, test, confirm])

  // 플랜 실행 컨트롤 — 전부 게이트를 거친다.
  const planStart = useCallback((plan: CopilotPlan) => {
    void gatePlanRun(plan, null, () => { void startRun(plan, {}) })
  }, [gatePlanRun, startRun])
  const planResume = useCallback((plan: CopilotPlan) => {
    void gatePlanRun(plan, {
      title: 'Resume this plan?',
      message: 'Resume from the failed step — completed steps are kept and replayed to the runner.',
      confirmLabel: 'Resume',
    }, () => { void resumeRun(plan) })
  }, [gatePlanRun, resumeRun])
  const planRunFromNode = useCallback((plan: CopilotPlan, nodeId: string) => {
    const idx = plan.nodes.findIndex(n => n.id === nodeId)
    const node = plan.nodes[idx]
    void gatePlanRun(plan, {
      title: 'Re-run from this step?',
      message: `Re-run from step ${idx + 1}${node ? ` "${node.title}"` : ''} — earlier steps' results are kept and replayed as context.`,
      confirmLabel: 'Re-run',
    }, () => { void runFromNode(plan, nodeId) })
  }, [gatePlanRun, runFromNode])

  // ── Simple 모드: simple-plan 도착 → ephemeral 워크플로 → 즉시 실행 ─────────
  // Start 버튼/확인 카드 없이 곧바로 돈다 (1회용 컨셉). 백그라운드 탭 도착분은
  // 큐에 쌓였다가 탭 활성화 때 실행 — 남의 탭 패널/슬롯을 뺏지 않게.
  const bgSimpleQueueRef = useRef<Map<string, Array<{ id: string; content: string }>>>(new Map())
  // 실패 진단을 요청해 둔 대화 — 그 답으로 오는 플랜은 등록만 하고 자동 실행하지
  // 않는다. 진단 프롬프트가 "플랜 내지 마라" 고 시키지만 프롬프트 룰은 밀린다는
  // 걸 이미 확인했으므로(빌더 툴 차단 사례), 무인 재실행 루프는 코드로 막는다.
  // 유저는 플랜 카드의 ▶ 로 직접 돌릴 수 있다.
  const simpleDiagnosisPendingRef = useRef<Set<string>>(new Set())
  const handleSimpleAssistant = useCallback(async (convId: string, msg: { id: string; content: string }) => {
    const spec = parseSimplePlanFromText(msg.content)
    if (!spec || spec.nodes.length === 0) return
    const plan = planToWorkflow(spec, msg.id)
    const holdRun = simpleDiagnosisPendingRef.current.delete(convId)
    // append (덮어쓰기 아님) — 캡 초과 시 oldest evict. 히스토리 셀렉터/카탈로그의
    // #N 번호가 같은 배열에서 파생되므로 evict 시에도 둘이 일관되게 시프트된다.
    setPlansByConv(prev => {
      const next = new Map(prev)
      const arr = [...(next.get(convId) ?? []), plan].slice(-MAX_PLANS_PER_CONV)
      next.set(convId, arr)
      savePlansLS(convId, arr)
      return next
    })
    selectPlan(convId, plan.id)   // 새 플랜 도착 = 항상 최신 자동 선택
    setExpandedPlans(new Set([plan.id]))   // 최신만 펼치고 이전 것들은 접어 스택 정리
    setRunError(null)
    runConvRef.current.set(plan.id, convId)   // 이 플랜 run 의 소유 탭 고정
    if (holdRun) {
      setRunError('Fixed plan ready — press ▶ on the plan to run it.')
      return
    }
    const res = await test.start(plan, {})
    if (!res.ok) setRunError(runFailureMsg(res.reason))
  }, [test, selectPlan])

  liveSimpleHandlerRef.current = (convId, msg) => {
    if (activeConvRef.current === convId) {
      void handleSimpleAssistant(convId, msg)
    } else {
      const q = bgSimpleQueueRef.current.get(convId) ?? []
      q.push(msg)
      bgSimpleQueueRef.current.set(convId, q)
    }
  }

  // .pptx 를 읽어 편집 가능한 덱으로 연다. 픽셀 복사가 아니라 내용을 우리
  // 디자인 시스템으로 다시 그리는 것 — 남의 덱을 받아 리테마하는 게 목적.
  const loadDeckFromFile = useCallback(async (relPath: string, convIdOverride?: string) => {
    setExportMsg('Reading deck…')
    try {
      const res = await window.twixy?.tools?.readPptx?.({ relPath })
      if (!res?.ok) { setExportMsg(`Read failed — ${(res as { error?: string })?.error ?? 'unknown'}`); return }
      const convId = convIdOverride ?? chat.activeConvId
      if (!convId) return
      setDecksByConv(prev => new Map(prev).set(convId, res.payload))
      saveDeckLS(convId, res.payload)
      setExportMsg(`${relPath} — ${res.slideCount} slides imported. Content only; tell me the theme and structure you want.`)
    } catch (e) {
      setExportMsg(`Read failed — ${(e as Error).message}`)
    }
  }, [chat.activeConvId])

  // 슬라이드 단위 재생성 — 해당 슬라이드의 현재 스펙을 지시와 함께 보낸다.
  // 전체 덱을 다시 보내지 않는 이유: 모델이 전체를 다시 쓰면 사용자의 다른
  // 편집이 날아가고 느리다. 소울이 deck-patch 로 답하도록 되어 있다.
  const regenerateSlide = useCallback((index: number, instruction: string) => {
    const cur = chat.activeConvId ? decksByConv.get(chat.activeConvId) : null
    const slide = cur?.slides[index]
    if (!cur || !slide) return
    // 모델은 전체 컨텍스트(현재 스펙 + 프로토콜 지시)를 받고, 사람은 자기가
    // 한 말만 본다. 스펙 JSON 과 "reply with exactly one deck-patch" 는 앱↔모델
    // 배관이지 사용자가 읽을 문장이 아니다.
    void chat.sendMessage(
      `Fix ONLY slide ${index + 1} (0-based index ${index}): ${instruction}\n\n` +
      `Its current spec:\n\`\`\`json\n${JSON.stringify(slide, null, 2)}\n\`\`\`\n` +
      `Reply with exactly one \`deck-patch\` block and nothing else.`,
      { displayText: `✎ Slide ${index + 1} — ${instruction}` },
    )
  }, [chat, decksByConv])

  // Export — 프리뷰와 같은 스펙을 기존 IPC 로 .pptx 로 굽는다.
  const exportDeck = useCallback(async () => {
    const cur = chat.activeConvId ? decksByConv.get(chat.activeConvId) : null
    if (!cur) return
    setExportMsg('Exporting…')
    setExportedPath(null)
    try {
      const relPath = `data/reports/${deckSlug(cur)}.pptx`
      const res = await window.twixy?.tools?.writePptx?.({ relPath, payload: cur }) as
        | { ok: true; verified?: boolean; slides?: number; verifyReason?: string }
        | { ok: false; error?: string } | undefined
      setExportMsg(
        res?.ok
          ? res.verified
            ? `Saved — ${relPath} (${res.slides} slides verified)`
            : `Saved — ${relPath} · verification FAILED: ${res.verifyReason ?? 'unknown'}`
          : `Failed — ${res?.error ?? 'unknown'}`,
      )
      // 저장 성공 = 열 수 있는 파일이 생겼다는 뜻. 경로를 들고 있어야 패널이
      // Open/Reveal 을 걸 수 있다 — 사용자가 Finder 로 찾아 들어가지 않도록.
      if (res?.ok) setExportedPath(relPath)
    } catch (e) {
      setExportMsg(`Failed — ${(e as Error).message}`)
    }
  }, [chat.activeConvId, decksByConv])

  /** 방금 내보낸 .pptx 를 기본 앱(PowerPoint/Keynote)으로 연다. */
  const openExported = useCallback(async () => {
    if (!exportedPath) return
    const res = await window.twixy?.openFile?.(exportedPath)
    if (res && !res.ok) setExportMsg(`Can't open — ${res.error ?? 'unknown'}`)
  }, [exportedPath])
  const revealExported = useCallback(() => {
    if (exportedPath) void window.twixy?.revealInFinder?.(exportedPath)
  }, [exportedPath])

  // ── Content 모드: deck-spec / deck-patch 도착 → 프리뷰 갱신 ────────────────
  // 전체 스펙은 교체, patch 는 해당 인덱스만 교체(사용자의 다른 편집 보존).
  // 대화별로 들고 있으므로 탭을 오가도 덱이 유지된다. 백그라운드 탭도 그냥
  // 반영해도 안전하다 — 실행이 아니라 상태 갱신뿐이라 슬롯을 뺏지 않는다.
  liveContentHandlerRef.current = (convId, msg) => {
    // 원본 유지 편집 중이면 이 답장은 pptx-edit 블록이거나 그냥 대화다.
    // deck-spec/patch 는 소울이 금지하므로 여기서는 보지 않는다.
    const target = editTargets.get(convId)
    if (target) {
      const r = parsePptxEditBlock(msg.content)
      if (r.status === 'none') return
      if (r.status === 'invalid') {
        setEditResult(convId, { ok: false, text: r.error })
        if (!editRetriedRef.current.has(convId)) {
          editRetriedRef.current.add(convId)
          void chat.sendMessage(
            `The app could not read the pptx-edit block you just sent.\n\n${r.error}\n\nRe-emit the block as valid JSON with the ops listed in the soul. No explanation needed.`,
            { appAuthored: true, displayText: '⚠ Edit block unreadable — asked for a fix.', contextPrelude: preludeFor(convId, target) },
          )
        }
        return
      }
      setPendingEditByConv(prev => new Map(prev).set(convId, { ops: r.ops, warnings: pptxEditOrderWarnings(r.ops), ...(r.outRelPath ? { outRelPath: r.outRelPath } : {}) }))
      setEditResult(convId, { ok: true, text: `${r.ops.length} edit${r.ops.length === 1 ? '' : 's'} proposed — review and Apply.` })
      return
    }
    const outcome = parseDeckBlock(msg.content)

    // 검증 홀드 중이면 이 답장이 곧 검증 결과다 — 침묵 턴의 유일한 답장이라
    // 다른 후보가 없다. 여기서 확정하고 그때 처음으로 화면에 올린다.
    const held = deckHoldRef.current.get(convId)
    if (held) {
      let final = held.base
      if (outcome.status === 'ok' && outcome.block.kind === 'patch') {
        const { patches } = parseAllPatches(msg.content)
        const patched = applyPatches(held.base, patches)
        // 검증 라운드의 patch 가 깨졌으면 조언을 버리고 원본을 확정한다.
        // 여기서 모델에게 되묻지 않는 이유: 사용자가 하지 않은 질문의
        // 재시도라 화면에 나타날 곳이 없고, 덱은 이미 쓸 만하다.
        try { buildDeck(patched); final = patched } catch { /* keep base */ }
      } else if (outcome.status === 'ok' && outcome.block.kind === 'deck') {
        try { buildDeck(outcome.block.payload); final = outcome.block.payload } catch { /* keep base */ }
      }
      releaseDeckHold(convId, final, held.prev)
      return
    }

    if (outcome.status === 'none') return

    // 깨진 블록은 절대 조용히 넘기지 않는다 — 사용자에겐 패널에 띄우고,
    // 모델에겐 되돌려 스스로 고치게 한다(모델은 자기 출력이 파싱됐는지 알 수
    // 없다). 자동 재시도는 대화당 1회로 제한 — 루프 방지.
    if (outcome.status === 'invalid') {
      setDeckError(prev => new Map(prev).set(convId, outcome.error))
      if (!deckRetriedRef.current.has(convId)) {
        deckRetriedRef.current.add(convId)
        void chat.sendMessage(
          `The app could not read the block you just sent.\n\n${outcome.error}\n\n` +
          'Send the same content again as valid JSON. No explanation needed — just re-emit the block.',
        )
      }
      return
    }

    const block = outcome.block
    uiLog(`[deck] ${block.kind} arrived · ${block.kind === 'deck' ? `${block.payload.slides.length} slides` : `page ${block.index + 1}`}`)

    // 후보 덱을 만들고 커밋 **전에** buildDeck 으로 검증한다.
    //
    // 실사고: QA 라운드의 patch 가 `{ type:'kv', label, text }` (스키마엔
    // rows) 를 넣었고, 그대로 커밋되자 buildDeck 이 죽어 멀쩡하던 17장
    // 프리뷰 전체가 "Can't render" 가 됐다. 규칙: 깨진 patch/spec 은
    // 기존 덱을 절대 덮어쓰지 않고, 모델에게 슬라이드 위치가 붙은 에러로
    // 1회 재시도를 요청한다 (JSON 파싱 실패와 같은 가드 재사용).
    const cur = decksByConv.get(convId)
    let candidate: TwixyWritePptxPayload
    if (block.kind === 'deck') {
      candidate = block.payload
    } else {
      if (!cur) return   // 아직 덱이 없는데 patch 가 온 경우 — 무시
      // QA 라운드는 "고칠 슬라이드마다 patch 하나" 라 한 메시지에 여러
      // 블록이 정상 — 전부 적용한다 (첫 것만 읽으면 조용한 드롭).
      // 순차 reduce 가 아니라 원본 인덱스 기준 일괄 적용: 삭제가 섞이면
      // 순차 적용은 뒤 패치의 인덱스를 밀어버린다(applyPatches 주석 참고).
      const { patches } = parseAllPatches(msg.content)
      candidate = applyPatches(cur, patches)
    }

    try {
      buildDeck(candidate)
    } catch (err) {
      const emsg = err instanceof Error ? err.message : String(err)
      setDeckError(prev => new Map(prev).set(convId, `The last ${block.kind === 'patch' ? 'patch' : 'spec'} does not render — ${emsg}`))
      if (!deckRetriedRef.current.has(convId)) {
        deckRetriedRef.current.add(convId)
        void chat.sendMessage(
          `Your last ${block.kind === 'patch' ? '`deck-patch`' : '`deck-spec`'} produced a slide the app cannot render:\n\n${emsg}\n\n` +
          (block.kind === 'patch'
            ? 'The previous deck is untouched. Fix that slide and resend the corrected `deck-patch` block only.'
            : 'Fix that slide and resend the corrected `deck-spec`.'),
          { appAuthored: true, displayText: '⚠ A slide didn\'t render — asked for a fix.' },
        )
      }
      return   // 기존 덱 보존 — 깨진 후보는 커밋하지 않는다
    }

    deckRetriedRef.current.delete(convId)
    setDeckError(prev => { const n = new Map(prev); n.delete(convId); return n })

    // ── 언어 교정 — 덱 전용 경로 ──────────────────────────────────────────
    // 채팅의 post-turn 교정기(useCopilotChat)는 덱을 못 고친다: 그 프롬프트는
    // 코드블록을 원문 보존하도록 지시돼 있고 deck-spec 이 곧 코드블록이다.
    // 실제로 한국어 덱에 兄弟 / "stratégiques" / "제품 계정へ" 가 그대로 실려
    // 나갔다. 여기서는 스펙의 프로즈 문자열만 배열로 뽑아 같은 서브모델
    // (flash-lite)에 넘기고, 같은 길이로 돌아온 것만 반영한다 — 모델이 JSON 을
    // 보지 않으므로 스펙을 깨뜨릴 수 없다.
    //
    // 반환값은 '교정된 payload'(또는 원본) — 시각 QA 가 이걸 기다린다. 둘을
    // 각자 비동기로 띄웠더니 경합해서, 모델이 번역 이전 레이아웃을 찍은
    // 시트를 보고 QA 하고 있었다. 한국어는 길이가 달라 줄바꿈이 바뀌므로
    // 모델이 본 화면과 최종 화면이 서로 다른 덱이었다.
    //
    // `commit` — 화면에 이미 떠 있는 덱이면 교정본을 바로 반영해야 하고(프리뷰는
    // 즉시, 교정은 왕복), 아직 검증 홀드 중이면 반영하지 않는다: 홀드의 계약은
    // "확정된 것 하나만 보여준다" 다.
    const correctLanguage = async (base: TwixyWritePptxPayload, commit: boolean): Promise<TwixyWritePptxPayload> => {
      if (localStorage.getItem('twixy-lang-correction') === 'false') return base
      try {
        const items = collectStrings(base)
        if (!items.length) return base
        // 앱이 보내는 재시도 메시지는 영어이고 role 이 'user' 다 — 그걸
        // 언어 샘플로 잡으면 한국어 덱이 통째로 영어로 번역된다.
        const lastUser = [...chat.messagesFor(convId)].reverse().find(m => m.role === 'user' && !m.appAuthored)
        const res = await window.twixy?.correctLanguageBatch?.({ items, userSample: lastUser?.content ?? '' })
        if (!res?.ok || !res.items) return base
        if (res.items.every((s, i) => s === items[i])) return base        // 이미 깨끗
        const fixed = applyStrings(base, res.items)
        if (!fixed) return base                                           // 길이 불일치 → 통째로 폐기
        try { buildDeck(fixed) } catch { return base }                    // 교정본도 커밋 전 검증
        if (commit) {
          setDecksByConv(prev => {
            // 그 사이 사용자가 다음 턴을 돌렸으면 덮어쓰지 않는다.
            if (prev.get(convId) !== base) return prev
            const n = new Map(prev).set(convId, fixed)
            saveDeckLS(convId, fixed)
            return n
          })
        }
        return fixed
      } catch { return base }
    }

    // ── 시각 QA — 모델에게 눈을 준다 (대화당 1회, 전체 deck-spec 에만) ──
    // builder 는 tool-less 라 툴 결과로 이미지를 못 받는다. 대신 앱이 덱을
    // 컨택트시트 PNG 로 워크스페이스에 렌더하고, [Image: source: …] 참조를
    // 담은 후속 메시지를 보낸다 — openclaw 가 경로를 이미지 블록으로 자동
    // 인라인해 모델이 자기 덱을 실제로 본다. 구조 노트도 같은 메시지에
    // 동승시켜 왕복을 하나로 만든다. patch 에는 안 돌린다 — 한 장 수정에
    // vision 패스는 과하고, QA 는 첫 전체 스펙에서 이미 돌았다.
    if (block.kind !== 'deck' || deckQaRef.current.has(convId)) {
      // 자동 검증을 안 도는 경로(patch 등) — 즉시 커밋하고 교정만 단독으로.
      // 되돌리기 지점은 여기 하나: 언어 교정은 같은 턴의 마무리라 별도 지점을
      // 만들지 않는다(undo 한 번이 "이 턴 취소"여야 한다).
      commitDeck(convId, candidate, cur ?? null)
      void correctLanguage(candidate, true)
      return
    }

    // ── 자동 검증 홀드 — 첫 덱은 **검증이 끝난 뒤에** 처음 보여준다 ────────
    // 예전엔 초안을 먼저 띄우고, 앱이 모델에게 보낸 영문 QA 지시문과 모델의
    // 영문 답장이 대화에 그대로 쌓이고, 몇 초 뒤 슬라이드가 눈앞에서 바뀌었다.
    // 사용자 입장에서 이 왕복은 전부 내부 배관이다 — 한 번에 확정본을 준다.
    // (chat.sendMessage 의 `silent` 가 질문과 답을 전사에서 뺀다.)
    deckQaRef.current.add(convId)
    setDeckStage(convId, 'Laying out the deck')
    const startedAt = Date.now()
    void (async () => {
      uiLog(`[deck-hold] start · ${candidate.slides.length} slides`)
      // 번역이 끝난 덱으로 찍는다 — 모델이 보는 화면 = 최종 화면.
      setDeckStage(convId, 'Checking the wording')
      const shot = await correctLanguage(candidate, false)
      uiLog(`[deck-hold] language corrected in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

      // ── 홀드는 **실제로 깨진 슬라이드**가 있을 때만, 그리고 짧게 ────────
      //
      // 체감 속도의 전부가 여기 있다. 예전엔 컨택트 시트 PNG 를 구워
      // "LOOK at it and check: overflow · overlaps · contrast · …" 를 보냈다 —
      // 대화 전체 이력 + 이미지가 실린 비전 턴이라 30~90초가 첫 화면 앞에
      // 그대로 붙었다.
      //
      // 그런데 레이아웃 엔진은 **어디가 왜 깨졌는지 이미 정확히 안다**:
      // "슬라이드 9: layout (5 rows) — overflows its box by 6.75in". 이미 아는
      // 답을 그림에서 찾아보라고 시키고 있었던 셈이다. 그래서 이제는 깨진
      // 슬라이드의 스펙만 붙여 "이것만 고쳐라" 를 보낸다 — 이미지 없음,
      // 슬라이드 두세 장 분량.
      //
      // 구조 노트(순서·반복)만 있고 깨진 슬라이드가 없으면 기다리지 않는다.
      // 그건 결함이 아니라 취향이고, 취향 때문에 덱을 붙잡아 둘 수는 없다.
      let notable: SlideWarning[] = []
      let structure: string[] = []
      try {
        const built = buildDeck(shot, { imageAspects })
        notable = built.slides
          .flatMap((sl) => sl.warnings.map((w) => ({ slide: sl.index + 1, w })))
          .filter(({ w }) => w.code !== 'shrunk')   // shrunk 은 정의상 무손실
        structure = built.structure
      } catch { /* 위에서 이미 검증됨 — 방어적 */ }
      if (notable.length === 0) {
        uiLog(`[deck-hold] clean — no broken slides · total ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
        releaseDeckHold(convId, shot, cur ?? null)
        return
      }

      setDeckStage(convId, `Fixing ${notable.length} layout issue${notable.length === 1 ? '' : 's'}`)
      // 깨진 장만, 그 장의 스펙과 함께. 한 장도 못 찾으면 고칠 방법이 없으므로
      // 그냥 확정한다(홀드가 덱을 인질로 잡지 않는다).
      const broken = [...new Set(notable.map(({ slide }) => slide))]
        .filter((n) => shot.slides[n - 1])
      if (broken.length === 0) { releaseDeckHold(convId, shot, cur ?? null); return }
      const perSlide = broken.map((n) => {
        const why = notable.filter((x) => x.slide === n).map((x) => warningText(x.w)).join(' · ')
        return `Slide ${n} — ${why}\n\`\`\`json\n${JSON.stringify(shot.slides[n - 1], null, 2)}\n\`\`\``
      }).join('\n\n')

      // 답장이 오면 아래 홀드 해제 경로가, 안 오면 타이머가 확정한다.
      deckHoldRef.current.set(convId, {
        base: shot,
        prev: cur ?? null,
        startedAt,
        timer: window.setTimeout(() => releaseDeckHold(convId, shot, cur ?? null), DECK_QA_TIMEOUT_MS),
      })
      uiLog(`[deck-hold] repair asked for ${broken.length} slide(s) at ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
      void chat.sendMessage(
        `The layout engine measured the deck you just wrote and found ${notable.length} slide${notable.length === 1 ? '' : 's'} where content does not fit. ` +
        'Fix ONLY these and reply with `deck-patch` blocks — one per slide, nothing else.\n\n' +
        perSlide +
        (structure.length ? `\n\nAlso, for context (fix only if a patch above can carry it):\n${structure.map((x) => `- ${x}`).join('\n')}` : '') +
        '\n\nFix by shortening or splitting the content, never by dropping information. ' +
        'Keep every string in the language it is already written in.',
        { silent: true },
      )
    })().catch(() => {
      // 이 블록이 던지면(교정·시트·IPC 어디든) 예전엔 홀드가 영영 안 풀렸다:
      // 덱은 안 보이고 컴포저는 'Checking…' 으로 잠긴 채 남는다. 무슨 일이
      // 있어도 사용자는 덱과 입력창을 돌려받아야 한다.
      releaseDeckHold(convId, candidate, cur ?? null)
    })
  }

  // 탭 활성화 시: 밀린 simple 플랜 실행 + 영속된 플랜 히스토리를 메모리에 복원.
  // 선택(activePlanId)은 복원하지 않는다 — planWorkflow 의 최신 fallback 이
  // 오늘과 같은 "마지막 플랜이 보이는" 동작을 만든다.
  useEffect(() => {
    const id = chat.activeConvId
    if (!id) return
    if (!plansByConv.has(id)) {
      const saved = loadPlansLS(id)   // 새 배열 키 우선, 구 단수 키 자동 마이그레이션
      if (saved.length > 0) {
        setPlansByConv(prev => new Map(prev).set(id, saved))
        // 복원 직후엔 최신 플랜만 펼쳐 보인다 (나머지는 접힌 채 스택).
        setExpandedPlans(prev => (prev.size ? prev : new Set([saved[saved.length - 1].id])))
      }
    }
    // Content 모드 덱도 같이 복원 — 앱을 껐다 켜도 프리뷰가 남아 있어야 한다.
    if (!decksByConv.has(id)) {
      const savedDeck = loadDeckLS(id)
      if (savedDeck) setDecksByConv(prev => new Map(prev).set(id, savedDeck))
    }
    if (!editTargets.has(id)) {
      const t = loadEditTargetLS(id)
      if (t) { setEditTargets(prev => new Map(prev).set(id, t)); void refreshSketch(id, t, false) }
    }
    const q = bgSimpleQueueRef.current.get(id)
    if (q && q.length > 0) {
      bgSimpleQueueRef.current.delete(id)
      for (const msg of q) void handleSimpleAssistant(id, msg)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.activeConvId, handleSimpleAssistant])

  // ── 어시스턴트 응답의 spec / 액션 처리 ─────────────────────────────────────
  // 라이브 도착분만 훅 콜백으로 받는다 — 기록에서 로드된 옛 메시지에는 콜백이
  // 발화되지 않아 "과거 액션 재실행" 사고가 구조적으로 없다. 백그라운드 탭의
  // 메시지는 큐에 쌓였다가 그 탭이 활성화될 때 처리된다.
  const bgQueueRef = useRef<Map<string, Array<{ id: string; content: string }>>>(new Map())
  const workflowsRef = useRef(workflows)
  useEffect(() => { workflowsRef.current = workflows }, [workflows])

  // ── 첫 run 확인 게이트 ─────────────────────────────────────────────────────
  // 소울이 "입력값 없으면 run 금지" 라고 해도 약한 모델은 값을 지어내서 run 을
  // 발행한다 (예: "아이돌 나무위키 저장" → group_name="아이돌" 로 즉시 실행).
  // 프롬프트는 강제력이 없으므로 결정적 게이트를 둔다: 대화당 워크플로별 첫
  // run 은 자동 실행하지 않고 확인 카드(pendingRun)로 홀드 — 유저가 ▶ Run 을
  // 누르거나, 값을 채팅으로 답해 LLM 이 run 을 다시 발행하면(=armed) 자동 실행.
  // armed 키 = `${convId}:${workflowId}` — 탭 전환에도 대화별로 유지.
  const armedRunRef = useRef<Set<string>>(new Set())
  // 확인 카드도 대화별 — 탭을 오가도 각 탭의 카드가 유지된다.
  const [pendingRunByConv, setPendingRunByConv] = useState<Map<string, { workflow: TwixyWorkflow; inputs: Record<string, string> }>>(new Map())
  const pendingRun = chat.activeConvId ? pendingRunByConv.get(chat.activeConvId) ?? null : null
  const setPendingRunFor = useCallback((convId: string | null, val: { workflow: TwixyWorkflow; inputs: Record<string, string> } | null) => {
    if (!convId) return
    setPendingRunByConv(prev => {
      const next = new Map(prev)
      if (val) next.set(convId, val)
      else next.delete(convId)
      return next
    })
  }, [])
  const armKey = useCallback((wfId: string) => `${activeConvRef.current ?? 'none'}:${wfId}`, [])

  // 스펙 메시지에 딸려온 run/show 액션 — 유저가 Update/New 로 저장을 확정한
  // 뒤에 처리한다 (저장 전에는 실행 대상이 없음).
  const actionByMsgRef = useRef<Map<string, CopilotAction>>(new Map())

  // 액션 처리 공통부 — 즉시 도착한 액션과 저장 후 이연된 액션이 공유.
  const processAction = useCallback(async (action: CopilotAction, explicitTarget?: TwixyWorkflow | null) => {
    const target = explicitTarget
      ?? (action.workflowId
        ? (workflowsRef.current.find(w => w.id === action.workflowId) ?? null)
        : lastCreatedRef.current)
    if (!target) {
      setRunError('Could not find the workflow referenced by the assistant.')
      return
    }

    // 2) show → 패널만 열고 입력값 대기 (실행 안 함). "물어봤다" 는 사실을
    //    arm 으로 기록 — 유저가 값을 답한 뒤의 run 은 자동 실행된다.
    setRunWorkflowId(target.id)
    if (action.action === 'show') {
      armedRunRef.current.add(armKey(target.id))
      return
    }

    // 3) run — 클라이언트 가드 ①: 선언된 입력값이 하나라도 비면 실행하지 않는다.
    const declared = target.inputs ?? []
    const missing = declared.filter(i => !(action.inputs?.[i.id] ?? '').trim())
    if (missing.length > 0) {
      armedRunRef.current.add(armKey(target.id))
      setRunError(`Waiting for input${missing.length > 1 ? 's' : ''}: ${missing.map(i => i.label || i.id).join(', ')} — reply in chat, or press ▶ Start on the workflow panel.`)
      return
    }
    // 가드 ②(첫 run 확인 게이트): 이 대화에서 아직 묻지도 확인받지도 않은
    // 워크플로의 첫 run 은 홀드 — LLM 이 값을 지어냈을 수 있다. 제안된 입력값을
    // 확인 카드로 보여주고, 유저의 ▶ Run 클릭 또는 정정 답장 후에만 실행.
    if (!armedRunRef.current.has(armKey(target.id))) {
      armedRunRef.current.add(armKey(target.id))
      setPendingRunFor(activeConvRef.current, { workflow: target, inputs: action.inputs ?? {} })
      return
    }
    if (test.stateFor(target.id).isRunning) {
      setRunError('This workflow is already running — wait for it to finish or press ■ Stop first.')
      return
    }
    setPendingRunFor(activeConvRef.current, null)
    await startRun(target, action.inputs ?? {})
  }, [startRun, test, armKey, setPendingRunFor])

  // SpecSavePanel 의 Update/New 확정 — 저장 후 그 메시지에 딸려 있던 액션을
  // 저장된 워크플로를 대상으로 이어서 처리한다 (첫 run 게이트는 그대로 적용).
  const applySpec = useCallback(async (
    msgId: string,
    spec: NonNullable<ReturnType<typeof parseWorkflowSpecFromText>>,
    mode: 'update' | 'new',
    updateTarget: TwixyWorkflow | null,
  ): Promise<TwixyWorkflow | null> => {
    // 첫 생성(New)이면 노드 사이마다 Human Review 삽입 — 사람이 단계별 결과를
    // 확인하며 진행. 스펙에 이미 review 가 있으면 그대로. Update 는 미적용.
    const specNodes = mode === 'new' ? interleaveHumanReviews(spec.nodes) : spec.nodes
    const payload = {
      title:       spec.title,
      description: spec.description,
      prompt:      spec.prompt,
      inputs:      spec.inputs as unknown as TwixyModuleParam[],
      nodes:       specNodes as unknown as TwixyWorkflowNode[],
    }
    const saved = mode === 'update' && updateTarget
      ? await updateWorkflow(updateTarget.id, payload)
      : await createWorkflow(payload)
    if (!saved) {
      setRunError('Failed to save the workflow.')
      return null
    }
    lastCreatedRef.current = saved
    setRunWorkflowId(saved.id)
    const deferred = actionByMsgRef.current.get(msgId)
    if (deferred) {
      actionByMsgRef.current.delete(msgId)
      await processAction(deferred, saved)
    }
    return saved
  }, [createWorkflow, updateWorkflow, processAction])

  // 스펙의 Update 대상 결정: 같은 제목의 기존 워크플로 → 없으면 지금 패널에
  // 떠 있는 워크플로 (제목을 바꾸는 수정 케이스).
  const updateTargetFor = useCallback((spec: { title: string }): TwixyWorkflow | null => {
    return workflows.find(w => w.title === spec.title)
      ?? runWorkflow
      ?? null
  }, [workflows, runWorkflow])

  // 초기 채팅에서 자동 저장(⊕ New 클릭과 동일 경로)된 스펙 메시지 id — 렌더가
  // SpecSavePanel 에 전달해 버튼 대신 "✓ Saved" 를 그린다. ref 는 재처리 가드.
  const [autoSavedSpecMsgs, setAutoSavedSpecMsgs] = useState<Set<string>>(new Set())
  const autoSaveTriedRef = useRef<Set<string>>(new Set())

  // 검증 불가 주장 가드의 상태 두 개.
  //  · claimRetryPendingRef — 정정을 보낸 대화. 그 다음 응답 1건은 가드를
  //    건너뛴다(연속 재요청 = 무한루프 방지). 이후 턴은 다시 보호된다.
  //  · reviewExemptRef — 자동 run 리뷰 턴. "이번 run 은 깨끗합니다" 같은
  //    프로즈-온리 응답이 정상 계약이므로 가드 대상에서 뺀다.
  const claimRetryPendingRef = useRef<Set<string>>(new Set())
  const reviewExemptRef      = useRef<Set<string>>(new Set())

  const handleAssistant = useCallback(async (msgId: string, content: string) => {
    setRunError(null)
    const spec   = parseWorkflowSpecFromText(content)
    const action = parseCopilotAction(content)
    // 진단 로그 — "스펙을 분명히 받았는데 저장 패널이 안 뜬다" 케이스 추적용.
    // 응답이 fence 를 들고 왔는지와 파서가 뭘 돌려줬는지를 나란히 남긴다.
    logSpecDiag('handleAssistant', msgId, content, spec, action)

    // 1) workflow-spec → 기본은 자동 저장하지 않는다. 버블 아래 SpecSavePanel 이
    //    Update(기존 반영) / New(새로 생성) 선택을 유저에게 준다 — WF 탭의
    //    SaveSpecPanel 과 같은 UX. 같이 온 run/show 액션은 저장 확정 후 처리.
    //    예외(자동 New): 대화의 첫 어시스턴트 응답이 "완전히 새로운" 워크플로
    //    (Update 대상 없음)를 만든 경우 — 유저가 ⊕ New 를 누른 것과 동일하게
    //    즉시 저장하고 패널을 연다. 수정 대화나 이후 턴의 스펙은 사람이 결정.
    if (spec) {
      if (action) actionByMsgRef.current.set(msgId, action)
      const convId = activeConvRef.current
      const isFirstReply = !!convId
        && chat.messagesFor(convId).filter(m => m.role === 'assistant').length <= 1
      if (isFirstReply && !updateTargetFor(spec) && !autoSaveTriedRef.current.has(msgId)) {
        autoSaveTriedRef.current.add(msgId)
        const saved = await applySpec(msgId, spec, 'new', null)
        if (saved) setAutoSavedSpecMsgs(prev => new Set(prev).add(msgId))
      }
      return
    }

    // 2) 스펙도 액션도 없는 프로즈 응답 — 여기가 할루시네이션이 유저에게
    //    그대로 노출되던 구멍이다. 지금까지 이 경로는 조용한 no-op 이었다.
    //    builder 는 툴이 전면 차단된 에이전트라 외부 사실을 확인할 수단이 없으므로,
    //    레포 경로/URL/설치 명령 같은 식별자를 단언했다면 그건 학습기억에서 나온
    //    미검증 값이다. 프롬프트 룰로는 안 잡히므로(관측됨) 코드가 계약을 강제한다:
    //    정정과 함께 1회 되돌려보내 워크플로로 다시 만들게 한다.
    if (!action) {
      const convId = activeConvRef.current
      // spec fence 가 있는데 파싱만 실패한 경우는 다른 버그(logSpecDiag 가 남김) —
      // 스펙 JSON 안의 URL 을 주장으로 오인하지 않도록 가드를 건너뛴다.
      if (!convId || /```workflow-spec/i.test(content)) return
      if (reviewExemptRef.current.delete(convId)) return
      if (claimRetryPendingRef.current.delete(convId)) return
      const lastUser = [...chat.messagesFor(convId)].reverse()
        .find(m => m.role === 'user')?.content ?? ''
      const claims = unverifiableClaimsIn(content, lastUser)
      if (claims.length === 0) return
      claimRetryPendingRef.current.add(convId)
      void chat.sendMessage([
        '[CONTRACT VIOLATION — system check, not a user message]',
        '',
        'Your last reply answered from memory. You are a tool-less builder: every',
        'tool is denied at the gateway, so you cannot open a page, run a search, or',
        'read a file. Therefore these items you asserted are unverified guesses:',
        ...claims.map(c => `  - ${c}`),
        '',
        'This has been measured: of three GitHub paths answered this way, two were',
        '404s. Answering from memory is never acceptable here.',
        '',
        'Do NOT apologize and do NOT answer in prose again. Emit ONE',
        '```workflow-spec``` block whose nodes gather this information from live',
        'sources (the run output is the answer). If some value is genuinely',
        'unknowable from context, ask ONE short question instead.',
      ].join('\n'), {
        displayText: `⚠ That answer came from memory, not from a lookup (${claims.slice(0, 2).join(', ')}${claims.length > 2 ? ', …' : ''}) — building a workflow that checks the real sources instead.`,
      })
      return
    }
    await processAction(action)
  }, [processAction, applySpec, updateTargetFor, chat])

  // 테스트 성공 완료 감지 → copilot 챗으로 자동 리뷰 요청 (WF 탭과 동일 조건:
  // 토글 on · 완주 · 실패/중단 없음 · run 당 1회 dedup).
  useEffect(() => {
    if (!runWorkflow) return
    // simple 모드 대화에는 리뷰 요청을 보내지 않는다 — 리뷰 프롬프트가
    // workflow-spec 을 요구하므로 wf 모드 세션(빌더) 전용.
    if (chat.activeMode !== 'wf') return
    const { startedAt, endedAt, isRunning, nodeStates } = runState
    // 디스크에서 복원된 지난 run 은 리뷰하지 않는다 — 앱을 켤 때마다 hydrate 가
    // "방금 끝난 run" 처럼 보이게 만들어 같은 리뷰가 매번 재발사된다.
    if (runState.hydrated) return
    if (!startedAt || !endedAt || isRunning) return
    if (autoReviewedRunRef.current.get(runWorkflow.id) === startedAt) return
    const states = Object.values(nodeStates)
    if (states.length === 0) return
    if (states.some(s => s.status === 'failed' || s.status === 'aborted')) return
    if (!states.some(s => s.status === 'done' || s.status === 'skipped')) return

    autoReviewedRunRef.current.set(runWorkflow.id, startedAt)

    const lines = runWorkflow.nodes.map((n, i) => {
      const st = nodeStates[n.id] ?? { status: 'pending' as const }
      const cost = typeof st.costUsd === 'number' ? `$${st.costUsd.toFixed(4)}` : '—'
      const dur  = typeof st.durationMs === 'number' ? `${st.durationMs}ms` : '—'
      // 노드별 토큰 — 리뷰어가 입력 토큰 폭증(컨텍스트 누적) 노드를 집어내려면
      // 총합이 아니라 노드 단위 수치가 필요하다 (실측: 6.2M-input 노드를 총합만
      // 보고 "clean" 판정한 사례).
      const toks = (typeof st.tokensIn === 'number' || typeof st.tokensOut === 'number')
        ? ` · ${st.tokensIn ?? 0}in/${st.tokensOut ?? 0}out tok` : ''
      const out  = st.output ? `\n  output: ${st.output.length > 600 ? st.output.slice(0, 600) + '…' : st.output}` : ''
      const slice = st.autoSlice
        ? `\n  ⚠ RUNTIME-SLICED: hit the node time limit ${st.autoSlice.attempts}× and only`
          + ` completed after being cut to ${st.autoSlice.portion} of its scope.`
        : ''
      return `${i + 1}. ${n.title}${n.tool ? ` [${n.tool}]` : ''} (${n.type}) — ${st.status} · ${dur} · ${cost}${toks}${slice}${out}`
    }).join('\n')

    const llmPayload = [
      `[Workflow test SUCCEEDED — review the run log for wasted or redundant steps]`,
      '',
      `Workflow: "${runWorkflow.title}"`,
      `Totals: ${Math.round(runState.totalMs / 1000)}s · $${runState.totalCost.toFixed(4)} · ${runState.totalTokensIn}/${runState.totalTokensOut} tokens`,
      '',
      lines,
      '',
      'Human Review nodes: this run completed cleanly, so the optional "Human Review" pause steps have served their purpose. In plain, non-technical language (no jargon like "QA"), briefly tell the user they can now safely REMOVE those review steps (× on the card) so the workflow runs on its own next time — unless they still want to check each step by hand. Do NOT delete them yourself; just suggest it.',
      '',
      'If any node is marked RUNTIME-SLICED, fix that first: it only finished because the runner cut its scope mid-run, so the spec does not fit the time budget and the run is not reproducible. Prefer removing the volume (a tool that handles the whole set in one node) over adding batch nodes; size any batches from the portion that actually completed.',
      '',
      'Cost check — do NOT call the run clean without doing this: compare each node\'s input tokens. The biggest hidden waste is input-token blowup: a chrome node that visits pages one after another carries every previous page dump in its context, so input tokens (and cost) compound per page. If one node\'s input tokens dwarf the rest (hundreds of thousands or more, or most of the run\'s cost), that node is NOT clean even though it succeeded — propose the cheaper design: web_fetch against the site\'s API/JSON endpoint instead of chrome page dumps, and/or write each page\'s extract to data/raw immediately, carrying only file paths and counts forward between steps.',
      '',
      'If you find genuine improvements, return ONE updated `workflow-spec` block with the SAME title and the smallest possible change set. If the run already looks clean, reply with one short sentence saying so (plus the Human Review note above) and DO NOT return a spec block. Do NOT emit a copilot-action block.',
    ].join('\n')

    // 이 턴의 응답은 "깨끗합니다" 한 줄(프로즈-온리)이 정상 계약 — 검증 불가
    // 주장 가드에서 면제한다.
    if (activeConvRef.current) reviewExemptRef.current.add(activeConvRef.current)
    // displayText 는 사용자가 보는 문자열이라 markup 적용. 위 llmPayload 는
    // 모델이 비용을 분석하는 입력이므로 raw 원가 그대로 둔다.
    void (async () => {
      const cost = await formatDisplayUsd(runState.totalCost)
      void chat.sendMessage(llmPayload, {
        displayText: `🔍 Run succeeded (${cost} · ${Math.round(runState.totalMs / 1000)}s) — auto-reviewing the run log for wasted steps…`,
      })
    })()
  }, [runWorkflow, runState, chat])

  // ── 노드 실패 감지 → 자동 진단 요청 ────────────────────────────────────────
  // WF 탭(WorkflowView)은 예전부터 requestFixForFailedNode 로 실패를 빌더챗에
  // 흘려보내고 있었는데, Copilot 탭은 '성공 리뷰' 만 이식돼 있었다 — 정작 진단이
  // 제일 필요한 실패가 조용히 지나갔다(관측: Read 노드가 파일 1개만 찾고 죽어도
  // 아무 반응 없음). 위 성공 이펙트는 실패면 return 하므로 여기서만 처리한다.
  //
  // 모드별로 요구하는 답이 다르다:
  //  · wf     → 진단 + 고친 workflow-spec. 스펙은 SpecSavePanel 을 거치므로
  //             사람이 Update/New 를 눌러야 반영된다(자동 실행 아님).
  //  · simple → 진단만. simple-plan 은 도착 즉시 test.start 로 자동 실행되므로
  //             (handleSimpleAssistant) 여기서 플랜을 받으면 실패→수정→재실행
  //             루프가 무인으로 돌아 비용이 샌다. 고친 플랜은 사람이 요청할 때.
  const autoDiagnosedRunRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    const wf = displayWorkflow
    if (!wf) return
    const { startedAt, endedAt, isRunning, nodeStates } = runState
    // 디스크 복원본 제외 — 실패한 채 남은 run 이 앱 재시작마다 재진단된다.
    if (runState.hydrated) return
    if (!startedAt || !endedAt || isRunning) return
    if (autoDiagnosedRunRef.current.get(wf.id) === startedAt) return

    const rows = wf.nodes.map((n, i) => ({ n, i, st: nodeStates[n.id] }))
    // 'aborted' 만 있고 'failed' 가 없으면 사람이 ■ Stop 을 누른 것 — 진단 대상 아님.
    const failedRows = rows.filter(r => r.st?.status === 'failed')
    if (failedRows.length === 0) return
    autoDiagnosedRunRef.current.set(wf.id, startedAt)

    const isSimple = chat.activeMode === 'simple'
    const lines = rows.map(({ n, i, st }) => {
      const status = st?.status ?? 'pending'
      const dur  = typeof st?.durationMs === 'number' ? `${Math.round(st.durationMs / 1000)}s` : '—'
      const cost = typeof st?.costUsd === 'number' ? `$${st.costUsd.toFixed(4)}` : '—'
      const why  = st?.reason ? `\n   ↳ ${st.reason}` : ''
      const detail = n.detail ? `\n   detail: ${n.detail.length > 400 ? n.detail.slice(0, 400) + '…' : n.detail}` : ''
      const out  = st?.output && status === 'failed'
        ? `\n   output: ${st.output.length > 600 ? st.output.slice(0, 600) + '…' : st.output}` : ''
      return `${i + 1}. ${n.title}${n.tool ? ` [${n.tool}]` : ''} (${n.type}) — ${status} · ${dur} · ${cost}${detail}${why}${out}`
    }).join('\n')

    // 타임아웃은 "더 빠르게" 가 아니라 "더 잘게" 가 정답 — WF 탭과 같은 지침.
    const allErrors = failedRows.map(r => r.st?.reason ?? '').join(' ')
    const timeoutGuidance = /timeout|timed out|turn_timeout/i.test(allErrors)
      ? [
          '',
          'This is a TIMEOUT: the node ran one agent turn past the ~9-minute limit,',
          'almost always because it loops over many items in a single turn. Do NOT',
          'just ask for it to be faster — SPLIT the work into bounded slices (~10–15',
          'page visits per node) with a final node that merges them.',
        ].join('\n')
      : ''

    const llmPayload = [
      `[${isSimple ? 'One-time plan' : 'Workflow test'} FAILED — diagnose the failure]`,
      '',
      `${isSimple ? 'Plan' : 'Workflow'}: "${wf.title}"`,
      `Totals: ${Math.round(runState.totalMs / 1000)}s · $${runState.totalCost.toFixed(4)}`,
      '',
      lines,
      timeoutGuidance,
      '',
      'Find the ROOT CAUSE, not the symptom. The most common one is a node whose',
      'scope was written wrong — it looked in the wrong place, matched the wrong',
      'file pattern, or assumed data that an earlier node never produced. Read the',
      'failing node\'s detail against what it actually reported and say which of',
      'those it was.',
      '',
      isSimple
        ? 'Reply in 2–4 short sentences: what failed, why, and what the corrected step should do differently. Do NOT emit a ```simple-plan``` block in this reply — plans run the moment you emit them, and the user has not asked for a re-run yet. End by telling them they can reply "fix it and run again" if they want the corrected plan.'
        : 'Reply with 1–2 short sentences of diagnosis, then ONE updated ```workflow-spec``` block with the SAME title that fixes the root cause. Keep every unrelated node identical so the user can approve the patch with confidence.',
    ].filter(Boolean).join('\n')

    const firstErr = failedRows[0]?.st?.reason ?? 'unknown error'
    // simple: 답으로 플랜이 와도 자동 실행 금지 (프롬프트만으론 못 막음).
    if (isSimple && activeConvRef.current) simpleDiagnosisPendingRef.current.add(activeConvRef.current)
    void chat.sendMessage(llmPayload, {
      displayText: `❌ "${failedRows[0]?.n.title ?? 'A step'}" failed — diagnosing…\n\n\`\`\`\n${firstErr.length > 300 ? firstErr.slice(0, 300) + '…' : firstErr}\n\`\`\``,
    })
  }, [displayWorkflow, runState, chat])

  // 라이브 핸들러 배선 — 활성 탭 메시지는 즉시 처리, 백그라운드 탭은 큐잉.
  liveHandlerRef.current = (convId, msg) => {
    if (activeConvRef.current === convId) {
      void handleAssistant(msg.id, msg.content)
    } else {
      const q = bgQueueRef.current.get(convId) ?? []
      q.push(msg)
      bgQueueRef.current.set(convId, q)
    }
  }

  // 탭 활성화 시 그 대화의 밀린 메시지 처리 (spec 저장 패널은 렌더로 자동
  // 복원되고, 여기서는 run/show 액션과 deferred 액션 큐만 따라잡는다).
  useEffect(() => {
    if (!chat.activeConvId) return
    const q = bgQueueRef.current.get(chat.activeConvId)
    if (!q || q.length === 0) return
    bgQueueRef.current.delete(chat.activeConvId)
    for (const msg of q) void handleAssistant(msg.id, msg.content)
  }, [chat.activeConvId, handleAssistant])

  // 새 메시지 도착 시 채팅 맨 아래로.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.messages.length, chat.isThinking])
  // 쓰이는 중인 답장을 따라간다 — 단, 사용자가 위로 올려 읽고 있으면 끌어내리지 않는다.
  const liveLen = (chat.liveReply?.text.length ?? 0) + (chat.liveReply?.thinking.length ?? 0)
  useEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [liveLen])

  const submit = () => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || chat.isThinking) return
    // 보낸 시각을 남긴다 — 덱이 도착한 시각과의 차이가 '모델이 스펙을 쓰는
    // 시간' 이고, 그게 전체에서 가장 큰 조각이다. 기준점이 없으면 어디가
    // 느린지 말할 수 없다.
    uiLog(`[chat] sent · ${text.length} chars · ${attachments.length} attachment(s) · mode ${chat.activeMode}`)
    // 검증 홀드 중 전송 금지 — 아래 Send 버튼 주석 참고(답장 순서가 뒤집힌다).
    if (deckVerifying.has(chat.activeConvId ?? '')) return
    // workspace 미지정이면 전송 대신 폴더 선택 — 워크플로 파일 쓰기가 전부
    // workspace 로 강제되므로 폴더 없이는 실행이 의미가 없다 (chat 탭과 동일).
    if (!projectDir && onPickProjectDir) {
      onPickProjectDir()
      return
    }
    // 첨부 파일은 전송 시점에만 @path 토큰으로 메시지 앞에 붙인다 (LLM 이 경로를
    // 봐야 buildMessageFileAttachment 가 내용을 뽑아 첨부).
    const refs = attachments.map(p => `@${p}`).join(' ')
    const full = refs ? (text ? `${refs}\n${text}` : refs) : text
    setDraft('')
    setAttachments([])
    // 유저가 카드 대신 채팅으로 답하는 경로 — 낡은 확인 카드는 치운다.
    // (LLM 이 정정된 값으로 run 을 다시 발행하면 armed 상태라 자동 실행.)
    setPendingRunFor(chat.activeConvId, null)
    // 원본 유지 편집 중이면 대상 아웃라인을 매 메시지 앞에 붙인다 — 모델의 유일한 눈.
    void chat.sendMessage(full, editTarget && chat.activeConvId ? { contextPrelude: preludeFor(chat.activeConvId, editTarget) } : undefined)
  }

  // ── 파일 첨부: 드래그앤드랍 + @-멘션 (chat 탭과 동일 개념) ─────────────────
  // 드롭/멘션 모두 파일을 workspace(data/raw)로 들여와 "@상대경로" 토큰으로
  // 입력창에 넣는다. 그 경로가 플랜 노드로 흘러가면 러너가 읽는다 (.xlsx 는
  // useWorkflowTest 가 CSV 로 자동 첨부하므로 바이너리도 처리됨).
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const [mention, setMention] = useState<{ open: boolean; query: string; selected: number; files: TwixyRecentFile[] }>(
    { open: false, query: '', selected: 0, files: [] },
  )
  // 첨부 파일(상대경로) — @-멘션/드롭한 파일을 입력 텍스트에 @path 로 박지 않고
  // 여기 모아 "칩"으로 보여준다. 전송 시에만 @path 토큰으로 메시지 앞에 붙는다
  // (플래너가 그 경로를 보고 러너가 내용을 읽음). × 로 개별 제거.
  const [attachments, setAttachments] = useState<string[]>([])
  /**
   * 첨부된 것 중 .pptx 를 "무엇을 할지" 대기열에 넣는다.
   *
   * 모드를 여기서 보지 않는 이유: 예전엔 저장 시점에 content 모드인지 따졌고,
   * 그래서 wf 모드에서 올린 뒤 Content 로 바꾸면 기록이 없어 영영 카드가 안
   * 떴다. 대기열에는 항상 넣고, 카드를 그릴 때만 모드를 본다 — 나중에 모드를
   * 바꿔도 그때 물어볼 수 있다. 사용자가 원치 않으면 카드의 "Just attach".
   */
  const offerPptxChoice = useCallback((refs: string[]) => {
    const decks = refs.filter(r => r.toLowerCase().endsWith('.pptx'))
    if (decks.length === 0) return
    const key = chat.activeConvId ?? PENDING_NEW
    setPendingPptxByConv(prev => new Map(prev).set(key, [...new Set([...(prev.get(key) ?? []), ...decks])]))
  }, [chat.activeConvId])

  const addAttachments = useCallback((refs: string[]) => {
    setAttachments(prev => {
      const set = new Set(prev)
      for (const r of refs) if (r) set.add(r)
      return [...set]
    })
  }, [])
  const removeAttachment = useCallback((ref: string) => {
    setAttachments(prev => prev.filter(r => r !== ref))
  }, [])
  // 받아주는 파일은 shared 레지스트리에서 파생시킨다 — 여기 하드코딩된 목록이
  // 레지스트리와 갈라져 있었고, 그래서 PNG 를 떨궈도 아무 일도 안 일어났다
  // (덱에는 `image` kind 가 있는데 파일을 넣을 방법이 없었다).
  const isAcceptedFile = (f: File) => fileExtRegex(ATTACHABLE_EXTS).test(f.name)

  const loadRecent = useCallback(async () => {
    try {
      const files = (await window.twixy?.recentFiles?.(50)) ?? []
      setMention(m => ({ ...m, files }))
    } catch { /* ignore */ }
  }, [])
  const closeMention = useCallback(() => {
    setMention(m => (m.open ? { ...m, open: false, query: '', selected: 0 } : m))
  }, [])

  const filteredFiles = mention.files
    .filter(f => !mention.query || f.name.toLowerCase().includes(mention.query.toLowerCase()))
    .slice(0, 8)

  // 커서 앞의 "@query" 를 감지해 드롭다운을 연다 (textarea 기반).
  const detectMention = useCallback((el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? el.value.length
    const m = el.value.slice(0, pos).match(/(?:^|\s)@(\S*)$/)
    if (!m) { closeMention(); return }
    void loadRecent()
    setMention(s => ({ ...s, open: true, query: m[1], selected: 0 }))
  }, [closeMention, loadRecent])

  // 파일 선택 = 첨부 칩 추가. 입력창의 "@query" 조각은 지운다 (텍스트엔 @path 를
  // 남기지 않는다 — 첨부는 칩으로만 보이고 전송 시 앞에 붙는다).
  const insertMention = useCallback((file: TwixyRecentFile) => {
    const el = composerRef.current
    const val = el?.value ?? draft
    const pos = el?.selectionStart ?? val.length
    const m = val.slice(0, pos).match(/(?:^|\s)@(\S*)$/)
    if (m) {
      const start = pos - m[1].length - 1   // '@' 포함 시작
      const next = val.slice(0, start) + val.slice(pos)
      setDraft(next)
      requestAnimationFrame(() => {
        const e2 = composerRef.current
        if (!e2) return
        e2.focus()
        e2.setSelectionRange(start, start)
      })
    }
    addAttachments([file.path])
    // 멘션으로 고른 .pptx 도 드롭과 같은 갈림길을 탄다 — 예전엔 드롭에만
    // 물어봐서 @ 로 고르면 조용히 첨부만 됐다.
    offerPptxChoice([file.path])
    closeMention()
  }, [draft, closeMention, addAttachments, offerPptxChoice])

  // 드롭한 파일들을 import 하고 첨부 칩으로 추가한다.
  const importFiles = useCallback(async (files: File[]) => {
    const refs: string[] = []
    for (const f of files) {
      try {
        const bytes = await f.arrayBuffer()
        const res = await window.twixy?.importDroppedFile?.({ name: f.name, bytes })
        const ref = res?.ok ? (res.relPath || res.path) : undefined
        if (ref) refs.push(ref)
      } catch (err) { console.warn('[copilot] drop import failed:', err) }
    }
    if (refs.length === 0) return
    addAttachments(refs)
    // .pptx 는 두 갈래다: 원본 디자인을 지키며 고칠지(pptx-edit), 내용만 뽑아
    // Twixy 로 다시 만들지(deck-spec). 예전엔 무조건 후자로 갔고 그게 "내 덱을
    // 고쳐달랬더니 다른 디자인이 나왔다" 의 원인이었다.
    offerPptxChoice(refs)
    composerRef.current?.focus()
  }, [addAttachments, offerPptxChoice])
  /** 선택: Twixy 스타일로 다시 만들기 — 종전 경로. 편집 대상이 있었으면 해제. */
  /** 고르는 순간 대기열 전체를 비운다 — 덱 대상/스펙은 대화당 하나라 남겨두면
   *  "아직 뭔가 물어보는 중" 처럼 보인다. 나머지 파일은 첨부로 그대로 남는다. */
  const resolvePendingPptx = useCallback((convIdOrNull: string | null) => {
    setPendingPptxByConv(prev => { const n = new Map(prev); n.delete(convIdOrNull ?? PENDING_NEW); return n })
  }, [])
  const chooseTwixyRedesign = useCallback((convIdOrNull: string | null, relPath: string) => {
    const convId = convIdOrNull ?? chat.startConversation(relPath.split('/').pop() ?? 'Deck')
    resolvePendingPptx(convIdOrNull)
    stopEditTarget(convId)
    void loadDeckFromFile(relPath, convId)
  }, [chat, loadDeckFromFile, stopEditTarget, resolvePendingPptx])
  const chooseKeepOriginal = useCallback((convIdOrNull: string | null, relPath: string) => {
    const convId = convIdOrNull ?? chat.startConversation(relPath.split('/').pop() ?? 'Deck')
    resolvePendingPptx(convIdOrNull)
    // 편집 대상은 아웃라인 프렐류드로 매 메시지에 실린다 — 첨부로도 남겨두면
    // 같은 덱의 전체 텍스트가 한 번 더 들어가 컨텍스트만 두 배로 든다.
    removeAttachment(relPath)
    void startEditTarget(convId, relPath)
  }, [chat, startEditTarget, resolvePendingPptx, removeAttachment])

  /** pptx-edit 블록 Apply — IPC 로 원본을 고치고, 결과(applied + 새 아웃라인)를 모델에게 돌려준다. */
  const applyPendingEdit = useCallback(async () => {
    const convId = chat.activeConvId
    if (!convId) return
    const target = editTargets.get(convId)
    const pend = pendingEditByConv.get(convId)
    if (!target || !pend) return
    setEditResult(convId, { ok: true, text: 'Applying…' })
    // 규칙: 사용자가 올린 원본은 건드리지 않는다. 첫 Apply 는 산출물 폴더에
    // 복사본을 만들고, 그 뒤 편집은 그 복사본 위에서 이어진다. 목적지는 앱이
    // 정한다 — 모델이 경로를 고르면 원본을 덮어쓸 여지가 남는다.
    const onOriginal = target.relPath === target.originalRelPath
    const outRelPath = onOriginal
      ? `data/reports/${(target.originalRelPath.split('/').pop() ?? 'deck').replace(/\.pptx$/i, '')}-edited.pptx`
      : undefined
    const res = await window.twixy?.tools?.editPptx?.({ relPath: target.relPath, ...(outRelPath ? { outRelPath } : {}), ops: pend.ops })
    if (!res || !res.ok) {
      const err = (res as { error?: string } | undefined)?.error ?? 'unknown error'
      setEditResult(convId, { ok: false, text: `Edit failed — ${err}. The original file is untouched.` })
      // 모델에게 되돌려 고치게 한다 — 대화당 1회(루프 방지). 어느 op 이 왜
      // 실패했는지는 editPptx 가 메시지에 담는다(런 분할 등).
      if (!editRetriedRef.current.has(convId)) {
        editRetriedRef.current.add(convId)
        void chat.sendMessage(
          `The app tried to apply your pptx-edit block and it failed:\n\n${err}\n\nThe original file is untouched. Fix that op and resend the whole block.`,
          { appAuthored: true, displayText: '⚠ Edit failed — asked for a fix.', contextPrelude: preludeFor(convId, target) },
        )
      }
      return
    }
    const base: PptxEditTarget = { relPath: res.relPath, originalRelPath: target.originalRelPath, slideCount: res.slideCount, outline: res.outline, layouts: res.layouts }
    setEditTargets(prev => new Map(prev).set(convId, base))
    saveEditTargetLS(convId, base)
    clearPendingEdit(convId)
    setEditResult(convId, { ok: true, text: `Applied ${res.applied.length} op${res.applied.length === 1 ? '' : 's'} → ${res.relPath} (${res.slideCount} slides)${onOriginal ? ' · working on a copy; your original is untouched' : ''}` })
    // 결과 회귀 — 모델은 자기 op 이 어디에 떨어졌는지 모른다. applied 와 새
    // 아웃라인, 그리고 새 와이어프레임을 주고 확인시킨다(소울: "READ the outline").
    const next = await refreshSketch(convId, base, true)
    void chat.sendMessage(
      `Applied your pptx-edit block to ${res.relPath}.\n\n${res.applied.map(a => `- ${a}`).join('\n')}\n\nConfirm in one line that the edit landed where you meant, or send a corrected pptx-edit block.`,
      { appAuthored: true, displayText: `✓ Applied ${res.applied.length} edit${res.applied.length === 1 ? '' : 's'} to ${res.relPath}`, contextPrelude: preludeFor(convId, next) },
    )
  }, [chat, editTargets, pendingEditByConv, setEditResult, clearPendingEdit, refreshSketch, preludeFor])

  // 오버레이 상태는 useFileDropZone 이 관리한다 — dragleave 만 믿던 예전 카운터는
  // 드래그가 창 밖으로 나가거나 다른 곳에 드랍되면 오버레이가 안 꺼졌다.
  const { isDragging, dropHandlers } = useFileDropZone({ accept: isAcceptedFile, onFiles: importFiles })

  // 대화별로 '언제부터 생각 중인지'. 컴포넌트 마운트 시각으로 재면 탭을
  // 옮겼다 돌아올 때 0 초부터 다시 세서, 실제보다 빨라 보인다.
  const thinkingSinceRef = useRef<Map<string, number>>(new Map())
  for (const id of chat.thinkingConvs) {
    if (!thinkingSinceRef.current.has(id)) thinkingSinceRef.current.set(id, Date.now())
  }
  for (const id of [...thinkingSinceRef.current.keys()]) {
    if (!chat.thinkingConvs.has(id)) thinkingSinceRef.current.delete(id)
  }

  const isEmpty = chat.messages.length === 0

  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-base)', position: 'relative' }}
      {...dropHandlers}
    >
      {/* 드롭 영역은 **뷰 전체**다. 예전엔 가운데 채팅 컬럼만이었고, Content
          모드에서는 화면의 대부분이 덱 프리뷰/디자인 패널이다 — 슬라이드 위에
          사진을 떨구는 게 가장 자연스러운 동작인데 거기서는 아무 일도 안
          일어났다. 오버레이도 같이 올라온다. */}
      {isDragging && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
          background: 'color-mix(in srgb, var(--accent) 12%, var(--bg-base))',
          border: '2px dashed var(--accent)', borderRadius: 'var(--radius-md)',
          pointerEvents: 'none',
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)' }}>Drop files to attach</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {ATTACHABLE_EXTS.join(' · ')}
          </div>
        </div>
      )}

      {/* ── 헤더: 서랍 토글 + 새 채팅 + 크롬식 대화 탭 스트립 ── */}
      {/* 탭 상태 표시등 pulse 키프레임 — 컴포넌트 로컬 1회 주입 */}
      <style>{`@keyframes twixy-tab-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }
        @keyframes twixy-thinking-dot { 0%,80%,100% { opacity: .25; transform: translateY(0) } 40% { opacity: 1; transform: translateY(-2px) } }`}</style>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, zIndex: 2,
      }}>
        <button onClick={() => { setWfDrawerOpen(v => !v); setHistoryOpen(false) }} title="Workflows" style={{ ...headerBtnStyle(wfDrawerOpen), flexShrink: 0 }}>☰</button>
        <button
          onClick={() => { chat.newConversation(); setRunWorkflowId(null) }}
          title="New chat"
          style={{ ...headerBtnStyle(chat.activeConvId === null), flexShrink: 0 }}
        >＋</button>

        {/* 대화 탭들 — archive 안 된 대화 = 열린 탭. × = archive (삭제 아님:
           워크플로 추적을 위해 기록/연결은 남고, 진행 중 run 도 계속된다). */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 4, overflowX: 'auto', alignItems: 'center' }}>
          {chat.conversations
            .filter(c => !c.archivedAt)
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(c => {
              const active = chat.activeConvId === c.id
              const st = c.workflowId ? test.stateFor(c.workflowId) : EMPTY_TEST_STATE
              const failed = Object.values(st.nodeStates).some(s => s.status === 'failed' || s.status === 'aborted')
              return (
                <div
                  key={c.id}
                  onClick={() => {
                    chat.selectConversation(c.id)
                    setRunWorkflowId(c.workflowId ?? null)
                  }}
                  title={conversationTitle(c.title)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                    maxWidth: 190, padding: '4px 8px 4px 10px', cursor: 'pointer',
                    fontSize: 11, lineHeight: 1.4,
                    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                    background: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  {/* run 상태 표시등: 실행 중 = 초록 점멸 · 완료 = ✓ · 실패/중단 = ✕ */}
                  {st.isRunning ? (
                    <span style={{ color: 'var(--accent)', fontSize: 9, animation: 'twixy-tab-pulse 1.2s ease-in-out infinite', flexShrink: 0 }}>●</span>
                  ) : st.startedAt && failed ? (
                    <span style={{ color: 'var(--danger)', fontSize: 10, flexShrink: 0 }}>✕</span>
                  ) : st.startedAt && st.endedAt ? (
                    <span style={{ color: 'var(--accent)', fontSize: 10, flexShrink: 0 }}>✓</span>
                  ) : null}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                    {conversationTitle(c.title)}
                  </span>
                  {chat.thinkingConvs.has(c.id) && !st.isRunning && (
                    <span style={{ color: 'var(--accent)', fontSize: 9, animation: 'twixy-tab-pulse 1.2s ease-in-out infinite', flexShrink: 0 }}>…</span>
                  )}
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      closeConversation(c.id)
                    }}
                    title="Close tab (archived — find it again in the ⚙ history)"
                    style={{
                      background: 'transparent', border: 'none', color: 'var(--text-muted)',
                      cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '0 2px', flexShrink: 0,
                    }}
                  >×</button>
                </div>
              )
            })}
        </div>

        {/* ⚠ 이슈 리포트 — 활성 탭(세션)의 로그를 Twixy 지원팀 서버로 업로드.
           확인 모달에서 사용자가 동의해야만 전송된다. 탭 스트립(flex:1) 바로 뒤라
           탭이 많아져도 스크롤에 밀려 사라지지 않는다. */}
        <button
          onClick={() => setReportOpen(true)}
          disabled={!chat.activeConvId || !reportCtx}
          title={
            !chat.activeConvId ? 'Open a chat tab to report an issue'
            : !reportCtx       ? 'Sign in to report an issue'
            : "Report an issue — upload this chat's logs to Twixy support"
          }
          style={{
            ...headerBtnStyle(reportOpen), flexShrink: 0, whiteSpace: 'nowrap',
            opacity: (!chat.activeConvId || !reportCtx) ? 0.4 : 1,
            cursor:  (!chat.activeConvId || !reportCtx) ? 'default' : 'pointer',
          }}
        >⚠ Report</button>

        {/* 프로젝트 폴더(workspace) 배지 — chat 탭과 동일한 UX. 지정된 폴더
           내부만 Copilot(워크플로 파일 쓰기)이 접근 가능하다. */}
        {!projectDirLoading && onPickProjectDir && (
          projectDir ? (
            <button
              onClick={onPickProjectDir}
              disabled={projectDirSetting}
              title={projectDir}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
                padding: '4px 9px', border: '1px solid var(--border)',
                background: 'var(--bg-elevated)', color: 'var(--text-muted)',
                borderRadius: 'var(--radius-sm)', fontSize: 11, cursor: 'pointer',
                maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                <path d="M1 3.5A1.5 1.5 0 012.5 2H5l1 1.5H9.5A1.5 1.5 0 0111 5v4A1.5 1.5 0 019.5 10.5h-7A1.5 1.5 0 011 9V3.5z" stroke="currentColor" strokeWidth="1" fill="none"/>
              </svg>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {projectDirSetting ? 'Changing…' : projectDir.split(/[\\/]/).filter(Boolean).pop()}
              </span>
            </button>
          ) : (
            <button
              onClick={onPickProjectDir}
              disabled={projectDirSetting}
              style={{
                padding: '4px 10px', border: '1px solid var(--accent)', flexShrink: 0,
                background: 'transparent', color: 'var(--accent)',
                borderRadius: 'var(--radius-sm)', fontSize: 11, cursor: 'pointer', fontWeight: 600,
              }}
            >
              {projectDirSetting ? 'Opening…' : 'Choose Project Folder'}
            </button>
          )
        )}

        {/* ⚙ 채팅 기록 (닫힌 탭 포함 전체 대화) */}
        <button
          onClick={() => { setHistoryOpen(v => !v); setWfDrawerOpen(false) }}
          title="Chat history"
          style={{ ...headerBtnStyle(historyOpen), flexShrink: 0 }}
        >⚙</button>
      </header>

      {/* ── ☰ 워크플로 리스트 서랍 ── */}
      {/* 클릭 변경은 "+ New chat" 상태(활성 대화 없음)에서만 허용. 이미 열린
         대화 탭은 그 대화가 워크플로를 결정하므로, 리스트 클릭이 패널을
         바꿔치기하면 대화-워크플로 연결이 깨진다. 대화 중엔 조회만. */}
      {(() => {
        const canPick = chat.activeConvId === null
        return (
          <aside style={drawerStyle(wfDrawerOpen)}>
            <div style={{ ...drawerHeaderStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Workflows</span>
              {/* ＋ = 새 워크플로 만들기. 기존 wf 를 여는 게 아니라 새 채팅으로
                 새 워크플로를 만들어야 하므로 ＋ New chat 과 동일 동작 (패널
                 비우고 빈 대화로) — 사용자가 곧바로 요청을 칠 수 있게. */}
              <button
                onClick={() => { chat.newConversation(); setRunWorkflowId(null); setWfDrawerOpen(false) }}
                title="New workflow — start a new chat to build one"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
              >＋</button>
            </div>
            {!canPick && (
              <div style={{ padding: '6px 12px', fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic', borderBottom: '1px solid var(--border-subtle)' }}>
                Open ＋ New chat to switch workflow.
              </div>
            )}
            <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
              {workflows.length === 0 && (
                <div style={drawerEmptyStyle}>No workflows yet.</div>
              )}
              {workflows.map(w => {
                const st = test.stateFor(w.id)
                const active = runWorkflowId === w.id
                const isRsch = (w.type ?? 'execution') === 'research'
                return (
                  <div
                    key={w.id}
                    onClick={() => { if (!canPick) return; markWorkflowOpened(w.id); setRunWorkflowId(w.id); setWfDrawerOpen(false) }}
                    title={canPick ? w.title : 'Switch workflow only from a new chat'}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '7px 8px',
                      cursor: canPick ? 'pointer' : 'not-allowed', opacity: canPick ? 1 : 0.5,
                      borderRadius: 'var(--radius-sm)', marginBottom: 2,
                      background: active ? 'var(--accent-dim)' : 'transparent',
                    }}
                    onMouseEnter={e => { if (canPick && !active) e.currentTarget.style.background = 'var(--bg-hover)' }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
                  >
                    {/* 상태 점 — 실행 중이면 초록 펄스, 아니면 new/unseen/seen 색. 작은 5px 원. */}
                    {st.isRunning
                      ? <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', animation: 'twixy-tab-pulse 1.2s ease-in-out infinite', flexShrink: 0, display: 'inline-block' }} />
                      : <span style={{ width: 5, height: 5, borderRadius: '50%', background: workflowDotColor(w.id), flexShrink: 0, display: 'inline-block' }} />}
                    <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title}</span>
                    <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.3, flexShrink: 0, color: isRsch ? 'var(--accent)' : 'var(--warning)' }}>{isRsch ? 'RSCH' : 'EXEC'}</span>
                  </div>
                )
              })}
            </div>
          </aside>
        )
      })()}

      {/* ── ⚙ 채팅 기록 서랍 — 닫힌 탭 포함 전체 대화 ── */}
      <aside style={drawerStyle(historyOpen)}>
        <div style={drawerHeaderStyle}>Chat history</div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
          {chat.conversations.length === 0 && (
            <div style={drawerEmptyStyle}>No conversations yet.</div>
          )}
          {chat.conversations.map(c => (
            <div
              key={c.id}
              onClick={() => {
                // 선택 = archive 면 탭으로 복귀(unarchive) + 워크플로 패널 복원.
                chat.selectConversation(c.id)
                setHistoryOpen(false)
                setRunWorkflowId(c.workflowId ?? null)
              }}
              title={conversationTitle(c.title)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 8px', cursor: 'pointer',
                borderRadius: 'var(--radius-sm)', marginBottom: 2,
                background: chat.activeConvId === c.id ? 'var(--accent-dim)' : 'transparent',
              }}
              onMouseEnter={e => { if (chat.activeConvId !== c.id) e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { if (chat.activeConvId !== c.id) e.currentTarget.style.background = 'transparent' }}
            >
              {/* 열린 탭 표시 — archive 안 됐으면 채워진 점 */}
              <span style={{ color: c.archivedAt ? 'var(--text-muted)' : 'var(--accent)', fontSize: 8, flexShrink: 0 }}>{c.archivedAt ? '○' : '●'}</span>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversationTitle(c.title)}</span>
              {/* × = archive (닫기), 삭제 아님 — 워크플로 추적을 위해 대화·연결은 남는다.
                 이미 archive 된 항목은 × 를 감춘다(다시 archive 는 무의미). */}
              {!c.archivedAt && (
                <button
                  onClick={e => { e.stopPropagation(); closeConversation(c.id) }}
                  title="Close tab (archived — stays here for tracking)"
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1, flexShrink: 0 }}
                >×</button>
              )}
            </div>
          ))}
        </div>
      </aside>

      {(wfDrawerOpen || historyOpen) && (
        <div onClick={() => { setWfDrawerOpen(false); setHistoryOpen(false) }} style={{ position: 'absolute', inset: 0, top: 41, zIndex: 4 }} />
      )}

      {/* ── 본문: [NodeCanvas] [채팅] [브라우저+활동] — 좌우 패널 슬라이드-인 ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

        {/* 왼쪽 — Workflow 탭과 동일한 노드 시각화 (NodeCanvas 재사용). */}
        <aside style={{
          width: leftOpen ? (deckPanelOpen ? deckDiagWidth : leftWidth) : 0, flexShrink: 0, overflow: 'hidden',
          transition: dragging ? 'none' : 'width 0.25s ease',
          borderRight: leftOpen ? '1px solid var(--border-subtle)' : 'none',
          background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column',
          position: 'relative',
        }}>
          {/* Content 모드 — 좌측은 디자인 조작반(팔레트·형태·브랜드·페이지 얼굴).
              전부 로컬 재계산이라 모델 왕복이 없다. 프리뷰는 우측. */}
          {deckPanelOpen && (
            <div style={{ width: deckDiagWidth, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              {deckErr && (
                <div style={{ margin: '10px 12px 0', padding: '8px 10px', borderRadius: 6, fontSize: 11, lineHeight: 1.6,
                  background: 'rgba(184,80,30,.08)', color: '#b8501e', whiteSpace: 'pre-wrap' }}>
                  {deckErr}
                  <div style={{ marginTop: 4, opacity: .75 }}>Asked the assistant to fix it and resend.</div>
                </div>
              )}
              <DeckDesigner payload={deckDisplay?.ok ? deck : null} selected={deckSel} width={deckDiagWidth} onChange={applyDeckDesign} />
              {/* 오른쪽 가장자리 드래그 핸들 */}
              <div
                onPointerDown={e => {
                  const startW = deckDiagWidth
                  startDrag(e, (dx) => {
                    const w = Math.min(680, Math.max(280, startW + dx))
                    setDeckDiagWidth(w); saveWidthLS('deckDiag', w)
                  })
                }}
                title="Drag to resize"
                style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 3 }}
              />
            </div>
          )}

          {panelsOpen && chat.activeMode !== 'content' && displayWorkflow && (
            <>
              <div style={{ width: leftWidth, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                {chat.activeMode === 'simple' ? (
                  /* 플랜 스택 — 이 대화의 1회용 플랜들을 세로로 쌓는다. 각 플랜은
                     노드들을 담는 "컨테이너"(노드와 다른 디자인)로, 접으면 헤더만,
                     펼치면 노드 카드들. 새 플랜은 아래로 쌓이고 최신만 펼쳐진다. */
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 12px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {plans.map((p, i) => (
                      <PlanContainer
                        key={p.id}
                        plan={p}
                        order={i + 1}
                        runState={test.stateFor(p.id)}
                        expanded={expandedPlans.has(p.id)}
                        active={p.id === displayWorkflow.id}
                        onActivate={() => activatePlan(p.id)}
                        onToggleExpand={() => togglePlanExpand(p.id)}
                        onStart={() => planStart(p)}
                        onStop={() => test.stop(p.id)}
                        onResume={() => planResume(p)}
                        onRunFromNode={(nodeId) => planRunFromNode(p, nodeId)}
                      />
                    ))}
                  </div>
                ) : (
                  <NodeCanvas
                    workflow={displayWorkflow}
                    testState={runState}
                    onTestStart={(inputs) => { void startRun(displayWorkflow, inputs) }}
                    onTestResume={() => { void resumeRun(displayWorkflow) }}
                    onTestRunFromNode={(nodeId) => { void runFromNode(displayWorkflow, nodeId) }}
                    onTestStop={() => test.stop(displayWorkflow.id)}
                    onTestReset={() => test.reset(displayWorkflow.id)}
                    onReviewDecision={(nodeId, action, comment) => {
                      test.resumeReview(displayWorkflow.id, nodeId, { action, comment })
                    }}
                    onInsertReviewNode={(afterIndex) => {
                      const nodes = [...displayWorkflow.nodes]
                      nodes.splice(afterIndex + 1, 0, makeHumanReviewNode())
                      void updateWorkflow(displayWorkflow.id, { nodes })
                    }}
                    onDeleteNode={(nodeId) => {
                      void updateWorkflow(displayWorkflow.id, { nodes: displayWorkflow.nodes.filter(n => n.id !== nodeId) })
                    }}
                    contextUsage={testSession.contextUsage}
                    onResetContext={testSession.resetSession}
                    confirm={confirm}
                  />
                )}
              </div>
              {/* 오른쪽 가장자리 드래그 핸들 — 패널 폭 조절 */}
              <div
                onPointerDown={e => {
                  const startW = leftWidth
                  startDrag(e, (dx) => {
                    const w = Math.min(900, Math.max(340, startW + dx))
                    setLeftWidth(w)
                    saveWidthLS('left', w)
                  })
                }}
                title="Drag to resize"
                style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 3 }}
              />
            </>
          )}
        </aside>

        {/* 가운데 — 채팅. 드롭은 뷰 전체가 받는다(루트에 핸들러). */}
        <div
          style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
        >
          <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div style={{
              maxWidth: 720, margin: '0 auto', padding: isEmpty ? '0 24px' : '20px 24px',
              display: 'flex', flexDirection: 'column', gap: 12,
              minHeight: isEmpty ? '100%' : undefined,
              justifyContent: isEmpty ? 'center' : undefined,
            }}>
              {isEmpty ? (
                <div style={{ textAlign: 'center', paddingBottom: 60 }}>
                  <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
                    What do you want to automate?
                  </div>
                  <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    Describe the task — if a workflow for it already exists I'll run it,
                    otherwise I'll build one and run it for you.
                  </div>
                </div>
              ) : (
                chat.messages.map(m => (
                  <CopilotBubble
                    key={m.id}
                    msgId={m.id}
                    role={m.role}
                    content={m.content}
                    deckThumb={deckThumb}
                    updateTargetFor={updateTargetFor}
                    onApplySpec={applySpec}
                    autoSaved={autoSavedSpecMsgs.has(m.id)}
                    resolvePlanId={resolvePlanId}
                    onSelectPlan={planId => { if (chat.activeConvId) selectPlan(chat.activeConvId, planId) }}
                  />
                ))
              )}
              {chat.liveReply && <LiveReplyBubble thinking={chat.liveReply.thinking} text={chat.liveReply.text} />}
              {chat.isThinking && (
                <ThinkingLine
                  since={thinkingSinceRef.current.get(chat.activeConvId ?? '') ?? Date.now()}
                  toolActivity={chat.toolActivity}
                />
              )}
              {/* 첫 run 확인 카드 — LLM 이 제안한 입력값을 사람이 확정해야 실행 */}
              {pendingRun && (
                <div style={{
                  alignSelf: 'stretch', border: '1px solid var(--accent)',
                  borderRadius: 'var(--radius-md)', padding: '10px 12px',
                  background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: 8,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                    ▶ Ready to run: {pendingRun.workflow.title}
                  </div>
                  {(pendingRun.workflow.inputs ?? []).length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(pendingRun.workflow.inputs ?? []).map(inp => (
                        <div key={inp.id} style={{ display: 'flex', gap: 8, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{inp.label || inp.id}:</span>
                          <span style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>
                            {(pendingRun.inputs[inp.id] ?? '').trim() || '(missing)'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      onClick={() => {
                        const pr = pendingRun
                        setPendingRunFor(chat.activeConvId, null)
                        void startRun(pr.workflow, pr.inputs)
                      }}
                      style={{
                        background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)',
                        color: '#fff', fontSize: 12, fontWeight: 600, padding: '6px 14px', cursor: 'pointer',
                      }}
                    >▶ Run</button>
                    <button
                      onClick={() => setPendingRunFor(chat.activeConvId, null)}
                      style={{
                        background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                        color: 'var(--text-secondary)', fontSize: 12, padding: '6px 12px', cursor: 'pointer',
                      }}
                    >Cancel</button>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      …or reply in chat to change these values.
                    </span>
                  </div>
                </div>
              )}
              {(chat.error || runError) && (
                <div style={{
                  fontSize: 11, color: 'var(--danger)', padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)', background: 'rgba(181, 72, 47, 0.08)',
                }}>
                  {chat.error ?? runError}
                </div>
              )}
            </div>
          </div>

          {/* 컴포저 */}
          <div style={{ borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
            {/* 모드 토글 — 대화 중에도 전환 가능. wf=반복 작업(워크플로 라우팅/작성),
               simple=일회성 작업을 풀 툴 에이전트가 직접 수행 (옛 plan-off chat). */}
            {/* 어떤 모드 칩을 보일지는 제품 프로필이 정한다. 모드가 하나뿐이면 고를 게 없으니 줄을 숨긴다. */}
            {PRODUCT.features.copilotModes.length > 1 && (
            <div style={{ maxWidth: 720, margin: '0 auto', padding: '10px 24px 0', display: 'flex', gap: 6, alignItems: 'center' }}>
              {PRODUCT.features.copilotModes.map((id) => {
                const builtin = BUILTIN_MODE_CHIPS[id]
                const ext = getProductCopilotMode(id)
                const chip = builtin ?? (ext && { icon: ext.icon, label: ext.label, title: ext.title })
                if (!chip) return null
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => chat.setMode(id)}
                    title={chip.title}
                    style={modeChipStyle(chat.activeMode === id)}
                  >{chip.icon} {chip.label}</button>
                )
              })}
              <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
                {productMode?.hint ?? BUILTIN_MODE_CHIPS[chat.activeMode]?.hint}
              </span>
            </div>
            )}
            {chat.activeMode === 'content' && pendingPptx.length > 0 && (
              /* 드롭/멘션 직후 갈림길 — 입력창 바로 위에. 덱 패널은 첫 답장 뒤에야
                 열리므로 거기 두면 새 대화에서는 영영 안 보인다(실측).
                 모드는 여기서만 본다: wf 로 올려두고 나중에 Content 로 바꿔도
                 그때 물어볼 수 있게. */
              <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 24px 8px' }}>
                <div style={{ border: '1px solid var(--accent)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                      {pendingPptx.length === 1 ? 'What should happen to this deck?' : `Which deck do you want to work on? (${pendingPptx.length} attached)`}
                    </span>
                    {editTarget && (
                      <span style={{ fontSize: 11, color: '#b8501e' }}>
                        replaces the deck you are editing now ({editTarget.relPath.split('/').pop()})
                      </span>
                    )}
                  </div>
                  {pendingPptx.map(rel => (
                    <div key={rel} style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap' }}>
                      {pendingPptx.length > 1 && (
                        <span style={{ flexBasis: '100%', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rel}>
                          {rel.split('/').pop()}
                        </span>
                      )}
                      <button type="button" onClick={() => chooseKeepOriginal(chat.activeConvId, rel)}
                        style={{ flex: 1, minWidth: 220, textAlign: 'left', padding: '8px 10px', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', color: 'var(--text-primary)', cursor: 'pointer' }}>
                        <div style={{ fontWeight: 600 }}>Keep the original design</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {pendingPptx.length === 1
                            ? 'Edit text, notes, add / delete / reorder slides. Layout, theme, media stay untouched.'
                            : `Edit ${rel.split('/').pop()} in place — layout and theme untouched.`}
                        </div>
                      </button>
                      <button type="button" onClick={() => chooseTwixyRedesign(chat.activeConvId, rel)}
                        style={{ flex: 1, minWidth: 220, textAlign: 'left', padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', color: 'var(--text-primary)', cursor: 'pointer' }}>
                        <div style={{ fontWeight: 600 }}>Redesign in Twixy</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Content only; you pick a theme and structure and the deck is rebuilt.</div>
                      </button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button type="button" onClick={() => resolvePendingPptx(chat.activeConvId)}
                      title="Leave the file as a plain attachment"
                      style={{ padding: '4px 8px', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>
                      Just attach {pendingPptx.length > 1 ? 'all' : ''}
                    </button>
                    {attachments.length > pendingPptx.length && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {attachments.length - pendingPptx.length} other file{attachments.length - pendingPptx.length === 1 ? '' : 's'} stay attached either way
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
            <form
              onSubmit={e => { e.preventDefault(); submit() }}
              style={{ maxWidth: 720, margin: '0 auto', padding: '8px 24px 16px', display: 'flex', gap: 8, alignItems: 'flex-end' }}
            >
              <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                {/* @-멘션 드롭다운 — 커서 앞 @query 에 매칭되는 최근 파일 */}
                {mention.open && filteredFiles.length > 0 && (
                  <div style={{
                    position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0,
                    maxHeight: 240, overflowY: 'auto', zIndex: 25,
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
                    padding: 4,
                  }}>
                    <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', padding: '4px 8px 6px' }}>
                      Attach a file (recent)
                    </div>
                    {filteredFiles.map((f, i) => (
                      <button
                        key={f.path}
                        type="button"
                        onMouseDown={e => { e.preventDefault(); insertMention(f) }}
                        onMouseEnter={() => setMention(m => ({ ...m, selected: i }))}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                          padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                          background: i === mention.selected ? 'var(--bg-active)' : 'transparent',
                        }}
                      >
                        <span style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{f.name}</span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{f.dir}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/* 첨부 파일 칩 — @-멘션/드롭한 파일이 "붙은 것처럼" 보인다.
                   × 로 제거, 전송 시 @path 로 메시지 앞에 붙는다. */}
                {attachments.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                    {attachments.map(ref => {
                      const name = ref.split('/').pop() ?? ref
                      return (
                        <span
                          key={ref}
                          title={ref}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            padding: '3px 5px 3px 8px', fontSize: 11, fontFamily: 'var(--font-mono)',
                            background: 'var(--bg-elevated)', border: '1px solid var(--accent)',
                            borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', maxWidth: 220,
                          }}
                        >
                          {/* 사진은 이름 대신 그림이 신원이다 — 스크린샷 세 장을
                              붙이면 파일명은 전부 pasted-17…png 로 똑같다. */}
                          {isImage(ref)
                            ? <AttachmentThumb relPath={ref} />
                            : <span style={{ color: 'var(--accent)', flexShrink: 0 }}>📎</span>}
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                          <button
                            type="button"
                            onClick={() => removeAttachment(ref)}
                            title="Remove attachment"
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              width: 16, height: 16, padding: 0, lineHeight: 1, fontSize: 12, flexShrink: 0,
                              background: 'transparent', border: 'none', borderRadius: 3,
                              color: 'var(--text-muted)', cursor: 'pointer',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger)' }}
                            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)' }}
                          >×</button>
                        </span>
                      )
                    })}
                  </div>
                )}
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={e => { setDraft(e.target.value); detectMention(e.target) }}
                  onClick={e => detectMention(e.currentTarget)}
                  onPaste={e => {
                    // 스크린샷은 거의 항상 붙여넣기로 온다 — 드래그할 파일이
                    // 애초에 없다(⌘⇧4 는 클립보드로 간다). 드롭과 같은 통로로
                    // 보내되, 클립보드 이미지는 이름이 없으므로 여기서 짓는다.
                    const shots = [...e.clipboardData.items]
                      .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
                      .map(it => it.getAsFile())
                      .filter((f): f is File => !!f)
                    if (shots.length === 0) return
                    e.preventDefault()
                    void importFiles(shots.map(f => (
                      f.name && f.name !== 'image.png'
                        ? f
                        : new File([f], `pasted-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })
                    )))
                  }}
                  onBlur={() => { setTimeout(closeMention, 120) }}
                  onKeyDown={e => {
                    // 멘션 드롭다운이 열려 있으면 방향키/Enter 로 파일 선택.
                    if (mention.open && filteredFiles.length > 0) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setMention(m => ({ ...m, selected: (m.selected + 1) % filteredFiles.length })); return }
                      if (e.key === 'ArrowUp')   { e.preventDefault(); setMention(m => ({ ...m, selected: (m.selected - 1 + filteredFiles.length) % filteredFiles.length })); return }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        if (!e.nativeEvent.isComposing) { e.preventDefault(); insertMention(filteredFiles[mention.selected]); return }
                      }
                      if (e.key === 'Escape') { e.preventDefault(); closeMention(); return }
                    }
                    // Korean/CJK IME: 조합 중 Enter 는 조합 종료지 전송이 아님.
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      submit()
                    }
                  }}
                  placeholder={productMode ? productMode.placeholder : chat.activeMode === 'wf'
                    ? 'Describe the task you want to automate…  (drop a file or type @ to attach)'
                    : 'Describe the one-time task (e.g. fix the broken links in @data/raw/…​.xlsx)…'}
                  rows={3}
                  maxLength={MAX_INPUT_LEN}
                  style={{
                    width: '100%', boxSizing: 'border-box', background: 'var(--bg-surface)', color: 'var(--text-primary)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                    padding: '10px 12px', fontFamily: 'var(--font-sans)', fontSize: 13,
                    resize: 'none', outline: 'none', lineHeight: 1.5,
                  }}
                />
                {/* 글자수 카운터 — 최대 길이 안내 (한도 근처면 강조). */}
                <div style={{
                  position: 'absolute', right: 10, bottom: 6, fontSize: 10, pointerEvents: 'none',
                  color: draft.length >= MAX_INPUT_LEN ? 'var(--red, #b5482f)'
                    : draft.length > MAX_INPUT_LEN * 0.9 ? 'var(--warning)'
                    : 'var(--text-muted)',
                  opacity: draft.length > 0 ? 0.9 : 0.45,
                }}>
                  {draft.length.toLocaleString()} / {MAX_INPUT_LEN.toLocaleString()}
                </div>
              </div>
              {(chat.isThinking || runState.isRunning) ? (
                <button
                  type="button"
                  onClick={() => {
                    // 실행 중인 플랜/워크플로가 있으면 그 run 을 멈추고, 챗 turn 이
                    // 돌고 있으면 그것도 멈춘다. simple 모드는 플래너가 끝난 뒤
                    // 플랜이 백그라운드로 도는데(=isThinking=false) 컴포저가 Send
                    // 로 돌아가 멈출 방법이 안 보였다 — 활동 중엔 항상 Stop 노출.
                    if (runState.isRunning && displayWorkflow) test.stop(displayWorkflow.id)
                    if (chat.isThinking) void chat.abortActive()
                  }}
                  title={runState.isRunning
                    ? 'Stop the running task (this stops the steps executing on the left)'
                    : 'Stop the current turn (session stays — you can continue chatting)'}
                  style={{
                    background: 'var(--red, #b5482f)', border: 'none', borderRadius: 'var(--radius-md)',
                    color: '#fff', fontSize: 13, fontWeight: 600, padding: '10px 18px',
                    cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  ■ Stop
                </button>
              ) : (() => {
                // 검증 홀드 중에는 보낼 수 없다. 이 몇 초 사이에 사용자가
                // 메시지를 보내면 그 답장이 검증 답장보다 **먼저** 도착해
                // 침묵 처리에 먹힌다 — 사용자의 답이 사라지는 사고다.
                const holding = deckVerifying.has(chat.activeConvId ?? '')
                const ready = !holding && (draft.trim().length > 0 || attachments.length > 0)
                return (
                  <button
                    type="submit"
                    disabled={!ready}
                    title={holding ? 'Checking the deck — one moment' : undefined}
                    style={{
                      background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-md)',
                      color: '#fff', fontSize: 13, fontWeight: 600, padding: '10px 18px',
                      cursor: ready ? 'pointer' : 'not-allowed',
                      opacity: ready ? 1 : 0.5, flexShrink: 0,
                    }}
                  >
                    {holding ? 'Checking…' : 'Send'}
                  </button>
                )
              })()}
            </form>
          </div>
        </div>

        {/* 오른쪽 — 브라우저 프리뷰 + 활동 피드 (폭/높이 드래그 조절).
           wf/simple 모드 공통 — displayWorkflow(저장 워크플로 또는 1회용 플랜)의
           run 세션을 그대로 미러링한다. 모드 토글 = 내용물 스위치. */}
        <aside style={{
          width: rightOpen ? (deckPanelOpen ? deckPreviewWidth : productPanelOpen && !panelsOpen ? productPanelWidth : rightWidth) : 0, flexShrink: 0, overflow: 'hidden',
          transition: dragging ? 'none' : 'width 0.25s ease',
          borderLeft: rightOpen ? '1px solid var(--border-subtle)' : 'none',
          background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column',
          position: 'relative',
        }}>
          {deckPanelOpen && (
            <>
              {/* 왼쪽 가장자리 드래그 핸들 — wf 모드 우측 패널과 동일 */}
              <div
                onPointerDown={e => {
                  const startW = deckPreviewWidth
                  startDrag(e, (dx) => {
                    const w = Math.min(900, Math.max(360, startW - dx))
                    setDeckPreviewWidth(w); saveWidthLS('deckPreview', w)
                  })
                }}
                title="Drag to resize"
                style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 3 }}
              />
              <div style={{ width: deckPreviewWidth, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                {deck && deckDisplay?.ok ? (
                  <DeckPanel
                    payload={deck}
                    deck={deckDisplay.value}
                    panelWidth={deckPreviewWidth}
                    selected={deckSel}
                    onSelect={setDeckSel}
                    busy={chat.isThinking}
                    exportMsg={exportMsg}
                    onRegenerateSlide={regenerateSlide}
                    onExport={exportDeck}
                    undoDepth={deckUndoDepth}
                    onUndo={undoDeck}
                    exportedPath={exportedPath}
                    onOpenExported={() => void openExported()}
                    onRevealExported={revealExported}
                  />
                ) : deckDisplay && !deckDisplay.ok ? (
                  <div style={{ padding: 16, fontSize: 12, color: '#b8501e', lineHeight: 1.6 }}>
                    Can't render the deck — {deckDisplay.error}
                  </div>
                ) : editTarget ? (
                  /* 원본 유지 편집 패널 — 아웃라인이 프리뷰 대신이다. */
                  <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
                    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                        <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'inherit' }}>
                          {editTarget.relPath === editTarget.originalRelPath
                            ? `Original design · ${editTarget.slideCount} slides`
                            : `Working copy · ${editTarget.slideCount} slides`}
                        </div>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={editTarget.relPath}>{editTarget.relPath}</div>
                        {editTarget.relPath !== editTarget.originalRelPath && (
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: .75 }} title={editTarget.originalRelPath}>
                            from {editTarget.originalRelPath} — untouched
                          </div>
                        )}
                      </div>
                      {/* 산출물은 복사본이므로 "끝냈다"(Done)가 아니라 "가져간다"(Export)가 맞다. */}
                      <button type="button"
                        disabled={editTarget.relPath === editTarget.originalRelPath}
                        onClick={() => void window.twixy?.revealInFinder?.(editTarget.relPath)}
                        title={editTarget.relPath === editTarget.originalRelPath
                          ? 'Apply an edit first — the copy is created on the first change'
                          : `Reveal ${editTarget.relPath}`}
                        style={{
                          fontSize: 11, padding: '4px 10px', borderRadius: 'var(--radius-sm)', cursor: editTarget.relPath === editTarget.originalRelPath ? 'default' : 'pointer',
                          border: `1px solid ${editTarget.relPath === editTarget.originalRelPath ? 'var(--border-subtle)' : 'var(--accent)'}`,
                          background: editTarget.relPath === editTarget.originalRelPath ? 'transparent' : 'var(--accent)',
                          color: editTarget.relPath === editTarget.originalRelPath ? 'var(--text-muted)' : '#fff', fontWeight: 600,
                        }}>
                        Export
                      </button>
                      <button type="button" onClick={() => chat.activeConvId && chooseTwixyRedesign(chat.activeConvId, editTarget.originalRelPath)}
                        title="Switch to a Twixy redesign (content only)"
                        style={{ fontSize: 11, padding: '4px 8px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                        Redesign
                      </button>
                      <button type="button" onClick={() => chat.activeConvId && stopEditTarget(chat.activeConvId)}
                        title="Close this deck (the file stays on disk)"
                        style={{ fontSize: 11, padding: '4px 8px', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                        Close
                      </button>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 12px', fontSize: 12, lineHeight: 1.6 }}>
                      {sketchUrl && (
                        <div style={{ marginBottom: 8 }}>
                          {/* 전체 보기가 기본. 한 장을 클릭하면 그 장만 크게,
                              ← 로 돌아온다. 토글 버튼을 따로 두는 것보다 클릭이
                              곧 확대라는 게 설명이 필요 없다. */}
                          {deckView === 'page' && pages.length > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                              <button type="button" onClick={() => setDeckView('sheet')}
                                title="Back to all slides"
                                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 10, fontFamily: 'inherit' }}>
                                ← All slides
                              </button>
                              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                                <button type="button" onClick={() => setPageIdx(i => Math.max(0, i - 1))} disabled={pageIdx === 0}
                                  style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: pageIdx === 0 ? 'default' : 'pointer', padding: '0 4px', opacity: pageIdx === 0 ? .4 : 1 }}>←</button>
                                Slide {pageIdx + 1} / {pages.length}
                                <button type="button" onClick={() => setPageIdx(i => Math.min(pages.length - 1, i + 1))} disabled={pageIdx >= pages.length - 1}
                                  style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: pageIdx >= pages.length - 1 ? 'default' : 'pointer', padding: '0 4px', opacity: pageIdx >= pages.length - 1 ? .4 : 1 }}>→</button>
                              </span>
                            </div>
                          )}
                          <img
                            src={deckView === 'page' && pages[pageIdx] ? pages[pageIdx] : sketchUrl}
                            alt={deckView === 'page' ? `Slide ${pageIdx + 1}` : sketchVia === 'libreoffice' ? 'Every slide, rendered' : 'Wireframe of every slide'}
                            onClick={() => {
                              if (deckView === 'page') { setDeckView('sheet'); return }
                              if (pages.length === 0) return
                              // 시트에서 클릭한 지점이 몇 번째 칸인지 — 그 장을 연다.
                              setDeckView('page')
                            }}
                            onMouseDown={e => {
                              if (deckView !== 'sheet' || pages.length === 0) return
                              const r = (e.target as HTMLImageElement).getBoundingClientRect()
                              // composeSheet 와 같은 격자: 4열, 셀 위에 번호 라벨.
                              const cols = Math.min(4, Math.max(1, pages.length))
                              const rows = Math.ceil(pages.length / cols)
                              const col = Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * cols)))
                              const row = Math.min(rows - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * rows)))
                              setPageIdx(Math.min(pages.length - 1, row * cols + col))
                            }}
                            title={deckView === 'sheet' && pages.length > 0 ? 'Click a slide to enlarge' : 'Click to go back'}
                            style={{ width: '100%', display: 'block', borderRadius: 4, border: '1px solid var(--border-subtle)', cursor: pages.length > 0 ? (deckView === 'sheet' ? 'zoom-in' : 'zoom-out') : 'default' }} />
                          {/* 무엇을 보고 있는지 밝힌다 — 근사본을 실물로 착각하면
                              "왜 원본과 다르냐" 가 반복된다. */}
                          <div style={{ marginTop: 3, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            {sketchVia === 'libreoffice'
                              ? 'exact render · LibreOffice'
                              : 'approximate wireframe — install LibreOffice for an exact render'}
                          </div>
                        </div>
                      )}
                      {editTarget.outline.map(sl => (
                        <div key={sl.slide}
                          onClick={() => { if (pages.length) { setDeckView('page'); setPageIdx(sl.slide - 1) } }}
                          title={pages.length ? `Show slide ${sl.slide}` : undefined}
                          style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--border-subtle)', cursor: pages.length ? 'pointer' : 'default',
                            background: deckView === 'page' && pageIdx === sl.slide - 1 ? 'var(--accent-dim)' : undefined }}>
                          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', width: 24, flexShrink: 0, textAlign: 'right' }}>{sl.slide}</span>
                          <span style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sl.title ?? <em style={{ color: 'var(--text-muted)' }}>(no title)</em>}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 10, whiteSpace: 'nowrap' }}>{sl.shapes ?? sl.texts}</span>
                        </div>
                      ))}
                    </div>
                    {pendingEdit && (
                      /* Apply 게이트 — 원본을 건드리는 유일한 지점. */
                      <div style={{ flexShrink: 0, borderTop: '1px solid var(--accent)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Proposed edits · {pendingEdit.ops.length}{pendingEdit.outRelPath ? ` → ${pendingEdit.outRelPath}` : ' (in place)'}</div>
                        <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.7 }}>
                          {pendingEdit.ops.map((op, i) => <li key={i}>{describePptxEditOp(op)}</li>)}
                        </ol>
                        {pendingEdit.warnings.map((w, i) => (
                          <div key={i} style={{ fontSize: 11, color: '#b8501e' }}>⚠ {w}</div>
                        ))}
                        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                          <button type="button" disabled={chat.isThinking} onClick={() => void applyPendingEdit()}
                            style={{ padding: '6px 14px', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--accent)', color: '#fff', cursor: chat.isThinking ? 'default' : 'pointer', fontWeight: 600, fontSize: 12 }}>
                            Apply to file
                          </button>
                          <button type="button" onClick={() => chat.activeConvId && clearPendingEdit(chat.activeConvId)}
                            style={{ padding: '6px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>
                            Discard
                          </button>
                        </div>
                      </div>
                    )}
                    {editResult && (
                      <div style={{ flexShrink: 0, padding: '6px 12px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: editResult.ok ? 'var(--text-muted)' : '#b8501e', lineHeight: 1.5 }}>
                        {editResult.text}
                      </div>
                    )}
                  </div>
                ) : deckVerifying.has(chat.activeConvId ?? '') ? (
                  /* 검증 홀드 — 초안은 이미 있지만 확정 전이라 일부러 안 보여준다.
                     무엇을 기다리는지는 말해준다(빈 화면 + 침묵은 고장으로 읽힌다). */
                  <div style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                    {deckVerifying.get(chat.activeConvId ?? '') ?? 'Checking the deck'}… <HoldClock />
                    <br />
                    The deck appears here once it passes.
                  </div>
                ) : (
                  <div style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                    Ask for a deck and the slides are drawn here as they arrive.<br />
                    Then you can pick a slide and fix it one at a time.
                  </div>
                )}
              </div>
            </>
          )}
          {productPanelOpen && ProductSidePanel && (
            <>
              {/* 왼쪽 가장자리 드래그 핸들 — 덱 패널과 같은 규칙 (왼쪽으로 끌면 넓어짐, 폭 기억) */}
              <div
                onPointerDown={e => {
                  const startW = productPanelWidth
                  startDrag(e, (dx) => {
                    const w = Math.min(1400, Math.max(320, startW - dx))
                    setProductPanelWidth(w); saveWidthLS('productPanel', w)
                  })
                }}
                title="Drag to resize"
                style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 3 }}
              />
              <div style={{ width: productPanelWidth, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <ProductSidePanel convId={chat.activeConvId} turnCount={assistantTurns} isThinking={chat.isThinking} />
              </div>
            </>
          )}
          {panelsOpen && !deckPanelOpen && (
            <>
              {/* 왼쪽 가장자리 드래그 핸들 — 패널 폭 조절 (왼쪽으로 끌면 넓어짐) */}
              <div
                onPointerDown={e => {
                  const startW = rightWidth
                  startDrag(e, (dx) => setRightWidth(Math.min(760, Math.max(300, startW - dx))))
                }}
                title="Drag to resize"
                style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 3 }}
              />
              <div style={{ width: rightWidth, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                {/* 브라우저 섹션 — chrome 툴을 쓰는 워크플로에서만 */}
                {usesBrowser && (
                  <>
                    <div style={{
                      padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
                      fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
                    }}>
                      Browser (headless)
                    </div>
                    <div style={{ flex: 1, minHeight: 120, padding: 8 }}>
                      {previewPort !== null ? (
                        <LiveBrowserPreview key={previewPort} cdpPort={previewPort} />
                      ) : (
                        <div style={{
                          height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic',
                        }}>
                          Browser appears when the run starts.
                        </div>
                      )}
                    </div>
                    {/* 프리뷰/활동 세로 분할 드래그 핸들 */}
                    <div
                      onPointerDown={e => {
                        const startH = activityHeight
                        startDrag(e, (_dx, dy) => setActivityHeight(Math.min(480, Math.max(100, startH - dy))))
                      }}
                      title="Drag to resize"
                      style={{ height: 7, marginTop: -3, cursor: 'row-resize', flexShrink: 0, zIndex: 3 }}
                    />
                  </>
                )}
                {/* 활동 피드 — run 세션의 라이브 LLM 메시지/툴 활동.
                   브라우저 없는 워크플로에선 패널 전체를 차지한다. */}
                <div style={usesBrowser
                  ? {
                      height: activityHeight, flexShrink: 0, borderTop: '1px solid var(--border-subtle)',
                      display: 'flex', flexDirection: 'column' as const,
                    }
                  : { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' as const }}>
                  <div style={{ padding: '6px 12px', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 0 }}>
                    Live activity{usesBrowser ? '' : ' — this workflow does not use the browser'}
                  </div>
                  <ActivityFeed
                    messages={testSession.messages}
                    toolActivity={testSession.toolActivity}
                    isThinking={testSession.isThinking}
                  />
                </div>
              </div>
            </>
          )}
        </aside>
      </div>

      {/* 인앱 확인 다이얼로그 — 네이티브 confirm 대체 (플랜 중지 경고 / 재실행 등) */}
      {confirmState && (
        <ConfirmDialog
          opts={confirmState}
          onResolve={ok => { confirmState.resolve(ok); setConfirmState(null) }}
        />
      )}

      {/* ⚠ 이슈 리포트 모달 — 확인 + 선택 메모 + 전송 상태 */}
      {reportOpen && (
        <ReportIssueModal
          summary={reportSummary}
          submit={submitReport}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  )
}

// ── 인앱 확인 다이얼로그 — 네이티브 window.confirm 대체 ──────────────────────
function ConfirmDialog({ opts, onResolve }: { opts: ConfirmOpts; onResolve: (ok: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onResolve(false) }
      if (e.key === 'Enter')  { e.preventDefault(); onResolve(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResolve])

  return (
    <div
      onClick={() => onResolve(false)}
      style={{
        position: 'absolute', inset: 0, zIndex: 50,
        background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(400px, 92%)', background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '16px 18px 14px' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            {opts.title}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            {opts.message}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0 18px 16px' }}>
          <button
            type="button"
            onClick={() => onResolve(false)}
            style={{
              background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)',
              borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontSize: 12.5, cursor: 'pointer',
            }}
          >{opts.cancelLabel ?? 'Cancel'}</button>
          <button
            type="button"
            autoFocus
            onClick={() => onResolve(true)}
            style={{
              background: opts.danger ? 'var(--danger)' : 'var(--accent)', border: 'none', color: '#fff',
              borderRadius: 'var(--radius-sm)', padding: '7px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}
          >{opts.confirmLabel ?? 'OK'}</button>
        </div>
      </div>
    </div>
  )
}

// ── ⚠ 이슈 리포트 모달 — 확인 + 선택 메모 + 전송 상태 ────────────────────────
// 로컬 ConfirmDialog(absolute/z50)와 달리 position:'fixed' 를 쓴다. 저건 "패널
// 내용에 대한 질문"이고 이건 계정 단위 트랜잭션(데이터가 기기 밖으로 나감 +
// 입력 필드 + confirm→sending→receipt 다단계)이라, 같은 부류인 TwixyConfirm
// (z1000) / ShareWorkflowButton(z990) 과 같은 규약을 따른다. CT 패널은 비활성일
// 때 display:'none' 이므로 다른 탭으로 새지 않는다.
type ReportPhase = 'confirm' | 'sending' | 'done' | 'error'

function ReportIssueModal({ summary, submit, onClose }: {
  summary: { convTitle: string; messageCount: number; activityCount: number; wfTitle: string | null; hasRun: boolean }
  submit:  (note: string) => Promise<SubmitResult>
  onClose: () => void
}) {
  const [note,   setNote]   = useState('')
  const [phase,  setPhase]  = useState<ReportPhase>('confirm')
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [result, setResult] = useState<SubmitResult | null>(null)

  // Escape 로만 닫는다. 전역 Enter→확인 바인딩은 넣지 않는다 — 메모 입력이
  // Enter 를 소유하며, 둘 다 걸면 이중 전송이 난다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'sending') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, onClose])

  const send = async () => {
    setPhase('sending'); setErrMsg(null)
    try {
      setResult(await submit(note))
      setPhase('done')
    } catch (e) {
      setErrMsg(e instanceof ReportError ? describeReportError(e.kind, e.detail)
              : e instanceof Error       ? e.message
              : String(e))
      setPhase('error')   // 입력한 메모는 state 에 그대로 남아 재시도 시 재입력 불필요.
    }
  }

  const btn: React.CSSProperties = {
    background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontSize: 12.5, cursor: 'pointer',
  }
  const primaryBtn: React.CSSProperties = {
    ...btn, background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 600, padding: '7px 16px',
  }

  return (
    <div
      onClick={() => { if (phase !== 'sending') onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 995,
        background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(460px, 92%)', background: 'var(--bg-surface)', textAlign: 'left',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '16px 18px 10px' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Report an issue</div>
          <button
            onClick={onClose}
            disabled={phase === 'sending'}
            title="Close"
            style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 16, lineHeight: 1, padding: 0, cursor: 'pointer' }}
          >×</button>
        </div>

        {phase === 'sending' ? (
          <div style={{ padding: '4px 18px 18px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Uploading…
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>This can take a few seconds.</div>
          </div>
        ) : phase === 'done' ? (
          <>
            <div style={{ padding: '4px 18px 16px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <div style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: 6 }}>✓ Report sent.</div>
              <div>
                Reference:{' '}
                <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--text-primary)' }}>
                  {result?.id.slice(0, 8)}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                Share this code with Twixy support.
              </div>
              {!!result?.truncated.length && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
                  Some logs were trimmed to fit ({result.truncated.join(', ')}).
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 18px 16px' }}>
              <button type="button" autoFocus onClick={onClose} style={primaryBtn}>Close</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '4px 18px 14px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              This uploads this chat session's logs to <strong style={{ color: 'var(--text-primary)' }}>Twixy's servers</strong> so
              our support team can reproduce and fix the problem.
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                <li>This tab's chat transcript and activity log</li>
                <li>The linked workflow's run details (steps, errors, outputs)</li>
                <li>A tail of the app's process log</li>
                <li>Your account email, org, app version and OS</li>
              </ul>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
                API keys and access tokens are removed automatically. File paths and your project folder
                path are included — they're needed to debug file errors.
              </div>
              <div style={{
                marginTop: 10, padding: '6px 9px', fontSize: 11,
                color: 'var(--text-muted)', background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                Chat "{summary.convTitle}" · {summary.messageCount} messages · {summary.activityCount} activity lines
                {summary.wfTitle ? ` · ${summary.hasRun ? 'run' : 'workflow'}: ${summary.wfTitle}` : ''}
              </div>
              <input
                value={note}
                autoFocus
                maxLength={CLIP_NOTE}
                placeholder="What went wrong? (optional)"
                onChange={e => setNote(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void send() } }}
                style={{
                  width: '100%', marginTop: 10, padding: '7px 9px', fontSize: 12,
                  background: 'var(--bg-base)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', outline: 'none',
                }}
              />
              {errMsg && (
                <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--danger)', lineHeight: 1.5 }}>{errMsg}</div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0 18px 16px' }}>
              <button type="button" onClick={onClose} style={btn}>Cancel</button>
              <button type="button" onClick={() => void send()} style={primaryBtn}>
                {phase === 'error' ? 'Try again' : 'Send report'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── 채팅 버블 — spec 은 SaveSpecPanel 류의 Update/New 선택 패널로 ────────────
// ── 진단 로그: workflow-spec 도착 → 저장 패널 렌더까지 ──────────────────────
// "어시스턴트가 스펙을 줬는데 ⊕ New 버튼이 안 뜬다" 를 재현 없이 잡기 위한 계측.
// 콘솔에서 `copilot-spec` 으로 필터하면 도착/렌더 두 지점이 나란히 보인다.
// fence 는 왔는데 파서가 null 이면 error 레벨 + 블록 앞부분을 함께 남긴다.
function logSpecDiag(
  where: string,
  msgId: string,
  content: string,
  spec: ParsedSpec | null,
  action: ReturnType<typeof parseCopilotAction>,
  plan?: ParsedSpec | null,
) {
  const hasFence = /```workflow-spec/i.test(content)
  const info = {
    where,
    msgId:      msgId.slice(0, 8),
    len:        content.length,
    hasFence,
    spec:       spec ? `${spec.title} (${spec.nodes.length} nodes)` : null,
    tools:      spec ? spec.nodes.map(n => n.tool ?? n.type).join(',') : null,
    plan:       plan === undefined ? undefined : (plan ? `${plan.title}` : null),
    action:     action ? action.action : null,
    willRender: spec ? 'SpecSavePanel' : (plan ? 'PlanChip' : (action ? 'ActionChip' : 'prose only')),
  }
  if (hasFence && !spec) {
    const at = content.search(/```workflow-spec/i)
    console.error('[copilot-spec] FENCE PRESENT BUT PARSE FAILED', info,
      '\n--- block head ---\n' + content.slice(at, at + 400))
  } else {
    console.info('[copilot-spec]', info)
  }
}

// ── 검증 불가 주장 탐지 — 툴 정책 deny 의 "출력 측" 대응물 ────────────────────
// builder 에이전트는 게이트웨이에서 tools.deny:["*"] 로 모든 툴이 막혀 있다.
// 즉 어떤 페이지도 열 수 없고 어떤 검색도 못 한다. 그런데 그 제약은 "행동"만
// 막을 뿐 "주장"은 막지 못한다 — 오히려 사실 질문에 친절히 답하려는 순간
// 지어내기가 유일한 선택지가 된다. 실측: 앱이 프로즈로 답한 GitHub 경로 3개 중
// 2개가 404 (python-openxml/python-pptx, OfficeDev/OfficeGen).
//
// 그래서 "툴 없는 에이전트가 외부 식별자를 단언했다" 를 코드에서 계약 위반으로
// 판정한다. 유저가 먼저 준 식별자를 되받는 것은 정상이므로 제외한다.
const CLAIM_PATTERNS: RegExp[] = [
  /\bhttps?:\/\/[^\s`'")\]]+/gi,                                                  // URL
  /\bgithub\.com\/[\w.-]+\/[\w.-]+/gi,                                            // 레포 경로
  /`([\w.-]+\/[\w.-]+)`/g,                                                        // 백틱 owner/repo
  /\b(?:pip3?|npm|yarn|pnpm|brew|gem|cargo|go)\s+(?:install|i|add|get)\s+[\w.@/-]+/gi, // 설치 명령
  /⭐\s*[\d,.]+\s*k?/gi,                                                           // 스타 수
  /\b[\d,.]+\s*k?\s*(?:stars|스타)\b/gi,
]

function unverifiableClaimsIn(prose: string, userText: string): string[] {
  const hay = userText.toLowerCase()
  const found = new Set<string>()
  for (const re of CLAIM_PATTERNS) {
    for (const m of prose.matchAll(re)) {
      const tok = (m[1] ?? m[0]).trim().replace(/[.,;:!?)]+$/, '')
      if (tok.length < 4) continue
      if (hay.includes(tok.toLowerCase())) continue   // 유저가 준 값 — 되받기는 정상
      found.add(tok)
    }
  }
  return [...found].slice(0, 8)
}

type ParsedSpec = NonNullable<ReturnType<typeof parseWorkflowSpecFromText>>

/** 진단 한 줄 — 콘솔과 **로그 파일** 양쪽에. 렌더러 콘솔에만 남기면 아무도
 *  꺼내 볼 수 없어서, 정작 "왜 오래 걸리나" 를 물었을 때 답할 수가 없다. */
function uiLog(line: string) {
  console.log(line)
  void window.twixy?.logUi?.(line)
}

/** 메시지에 실린 첨부 경로들 (@토큰). 등장 순서, 중복 제거. */
function attachmentRefs(text: string): string[] {
  const re = fileRefRegex(ATTACHABLE_EXTS)
  re.lastIndex = 0
  const out: string[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const p = m[0]
    // @ 가 앞에 붙은 것만 = 컴포저가 실어 보낸 첨부. 사용자가 본문에 그냥 쓴
    // 파일명까지 칩으로 만들면 문장이 조각난다.
    if (text[m.index - 1] === '@' && !out.includes(p)) out.push(p)
  }
  return out
}

/** 확장자별 칩 색 — 엑셀은 초록, 프레젠테이션은 주황 같은 통념을 따른다. */
const FILE_TINT: Record<string, string> = {
  xlsx: '#1D6F42', xlsm: '#1D6F42', xls: '#1D6F42', csv: '#1D6F42', tsv: '#1D6F42',
  pptx: '#C43E1C', pdf: '#B3261E', docx: '#2B579A',
  json: '#6B7280', md: '#6B7280', txt: '#6B7280', log: '#6B7280',
  yaml: '#6B7280', yml: '#6B7280', html: '#6B7280', xml: '#6B7280',
}

/**
 * 첨부 한 개 — 사진이면 그림, 그 외엔 확장자 배지 + 이름.
 *
 * 로고 이미지를 쓰지 않는 이유: 남의 상표를 앱에 심는 것이고, 확장자 배지가
 * 같은 일을 한다(무엇으로 열리는 파일인지). 이름은 타임스탬프 접두사를 떼고
 * 사람이 붙인 이름만 보여준다.
 */
function FileChip({ relPath }: { relPath: string }) {
  const base = relPath.split('/').pop() ?? relPath
  const name = base.replace(/^\d{4}-\d{2}-\d{2}T[\d-]{8}-/, '')
  const ext = (base.split('.').pop() ?? '').toLowerCase()
  const chip: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 220,
    padding: '3px 8px 3px 4px', borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
    fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
  }
  return (
    <span style={chip} title={relPath}>
      {isImage(relPath)
        ? <AttachmentThumb relPath={relPath} />
        : (
          <span style={{
            flexShrink: 0, fontSize: 8, fontWeight: 700, letterSpacing: .3,
            padding: '2px 4px', borderRadius: 3, color: '#fff',
            background: FILE_TINT[ext] ?? '#6B7280',
          }}>{ext.toUpperCase().slice(0, 4)}</span>
        )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </span>
  )
}

/**
 * 답이 올 때까지의 '생각 중' 표시 — 점 애니메이션 + 경과 초.
 *
 * 정지한 'Thinking…' 은 멈춘 화면과 구분되지 않는다. 8장짜리 덱은 모델이
 * 스펙을 쓰는 데만 2분 가까이 걸리는데(실측), 그동안 화면에 변하는 것이 하나도
 * 없으면 고장으로 읽힌다. 움직이는 점은 "살아 있다", 초는 "얼마나 됐다" 를
 * 말한다 — 둘 다 없으면 사용자가 할 수 있는 판단이 없다.
 */
function ThinkingLine({ since, toolActivity }: { since: number; toolActivity: string | null }) {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000))
  const mmss = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`
  return (
    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', display: 'flex', gap: 8, alignItems: 'center' }}>
      <span>Thinking</span>
      <span aria-hidden style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{
            width: 4, height: 4, borderRadius: '50%', background: 'currentColor',
            animation: 'twixy-thinking-dot 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.16}s`,
          }} />
        ))}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontStyle: 'normal', fontVariantNumeric: 'tabular-nums' }}>{mmss}</span>
      {toolActivity && (
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontStyle: 'normal', fontSize: 10 }}>
          ⚙ {toolActivity}
        </span>
      )}
    </div>
  )
}

/**
 * 턴 진행 중에 쓰이고 있는 답장 — 끝나면 정식 버블(CopilotBubble)로 바뀐다.
 *
 * CopilotBubble 을 쓰지 않는 이유: 그쪽은 워크플로 스펙·액션·덱 블록을 파싱해 카드와 버튼을
 * 그린다. 반쯤 쓰인 블록으로 그걸 돌리면 깨진 카드가 깜빡이고, 버튼이 미완성 스펙을 저장할 수 있다.
 * 여기는 글자만 보여준다. 추론은 접힌 채 마지막 몇 줄만 — 펼치면 전부.
 */
function LiveReplyBubble({ text, thinking }: { text: string; thinking: string }) {
  const [open, setOpen] = useState(false)
  const tail = thinking.split('\n').filter(Boolean).slice(-3).join('\n')
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {thinking && (
        <button type="button" onClick={() => setOpen(v => !v)} style={{
          textAlign: 'left', border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-md)',
          background: 'transparent', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-muted)',
          fontSize: 11, lineHeight: 1.5, fontStyle: 'italic', fontFamily: 'var(--font-sans)', whiteSpace: 'pre-wrap',
          maxHeight: open ? 320 : undefined, overflowY: open ? 'auto' : undefined,
        }}>
          <div style={{ fontStyle: 'normal', fontWeight: 600, marginBottom: 2 }}>{open ? '▾' : '▸'} 생각하는 중</div>
          {open ? thinking : tail}
        </button>
      )}
      {text && (
        <div style={{
          background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)', padding: '8px 12px', fontSize: 13, lineHeight: 1.55,
          wordBreak: 'break-word', whiteSpace: 'pre-wrap', userSelect: 'text',
        }}>
          {text}
          <span aria-hidden style={{ display: 'inline-block', width: 7, height: 14, marginLeft: 2, verticalAlign: 'text-bottom', background: 'var(--accent)', animation: 'twixy-thinking-dot 1s ease-in-out infinite' }} />
        </div>
      )}
    </div>
  )
}

/** 홀드가 도는 동안의 경과 초. 멈춘 화면과 일하는 화면을 구분해 준다. */
function HoldClock() {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setSecs((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  return <span style={{ fontFamily: 'var(--font-mono)', opacity: .7 }}>{secs}s</span>
}

/** 첨부 칩 안의 16px 미리보기 — 붙인 사진이 "그 사진" 인지 눈으로 확인시킨다. */
function AttachmentThumb({ relPath }: { relPath: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const u = await window.twixy?.readImage?.(relPath); if (alive) setSrc(u ?? null) }
      catch { /* 못 읽으면 클립으로 남는다 */ }
    })()
    return () => { alive = false }
  }, [relPath])
  if (!src) return <span style={{ color: 'var(--accent)', flexShrink: 0 }}>🖼</span>
  return <img src={src} alt="" style={{ width: 16, height: 16, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />
}

/**
 * 덱 블록 하나를 사람이 보는 형태로. 교체는 **그 슬라이드를 그려서** 보여준다
 * — 모델이 "3번을 이렇게 고쳤다"고 말할 때 사용자가 확인하고 싶은 건 JSON 이
 * 아니라 그림이다.
 */
function DeckBlockCard({ note, thumb }: { note: DeckBlockNote; thumb: (slide: TwixySlideSpec) => SlideDisplay | null }) {
  const slide = useMemo(() => (note.kind === 'patch' && note.slide ? thumb(note.slide) : null), [note, thumb])
  const chip: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px',
    fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
    background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-sm)', alignSelf: 'flex-start',
  }
  if (note.kind === 'deck') return <span style={chip}>◧ Deck · {note.slides} slides</span>
  if (!note.slide) return <span style={chip}>✕ Slide {note.page} removed</span>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignSelf: 'flex-start' }}>
      {slide
        ? <SlidePreview slide={slide} width={210} />
        : <span style={chip}>✎ Slide {note.page}</span>}
      {slide && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          Slide {note.page} · {note.slide.kind}
        </span>
      )}
    </div>
  )
}

function CopilotBubble({ msgId, role, content, deckThumb, updateTargetFor, onApplySpec, autoSaved, resolvePlanId, onSelectPlan }: {
  msgId: string
  role: 'user' | 'assistant'
  content: string
  /** 덱 블록을 썸네일로 그리기 위한 렌더러 — 현재 덱의 테마/스타일을 쓴다. */
  deckThumb: (slide: TwixySlideSpec) => SlideDisplay | null
  updateTargetFor: (spec: { title: string }) => TwixyWorkflow | null
  onApplySpec: (msgId: string, spec: ParsedSpec, mode: 'update' | 'new', updateTarget: TwixyWorkflow | null) => Promise<TwixyWorkflow | null>
  // 초기 채팅 자동 New 저장 완료 — SpecSavePanel 이 버튼 대신 ✓ Saved 를 그린다.
  autoSaved: boolean
  // 플랜 히스토리 — 이 메시지가 만든 플랜의 id (sourceMsgId 매칭). null 이면
  // 매칭 실패(피처 이전 기록 / 캡 evict) → 칩을 클릭 불가 span 으로 유지.
  resolvePlanId: (msgId: string) => string | null
  onSelectPlan: (planId: string) => void
}) {
  const isUser = role === 'user'
  // 훅은 user/assistant 분기보다 먼저 — 그리고 content 로 메모해야 note 객체
  // 신원이 유지된다. 스트리밍 중엔 전 버블이 매 틱 재렌더되므로, 여기서 매번
  // 새 객체를 만들면 아래 썸네일이 매 틱 buildDeck 을 다시 돈다.
  const deckNotes = useMemo(() => (role === 'assistant' ? summarizeDeckBlocks(content) : []), [role, content])
  const editOps = useMemo(() => {
    if (role !== 'assistant') return null
    const r = parsePptxEditBlock(content)
    return r.status === 'ok' ? r.ops : null
  }, [role, content])
  const baseStyle: React.CSSProperties = {
    alignSelf: isUser ? 'flex-end' : 'flex-start',
    maxWidth: '85%',
    background: isUser ? 'var(--accent-dim)' : 'var(--bg-elevated)',
    color: isUser ? 'var(--text-primary)' : 'var(--text-secondary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    padding: '8px 12px',
    fontSize: 13,
    lineHeight: 1.55,
    wordBreak: 'break-word',
    userSelect: 'text' as const,
  }

  if (isUser) {
    // 첨부는 경로가 아니라 **파일**로 보여준다. 전송할 때 붙는 @토큰은 모델이
    // 경로를 봐야 해서 있는 것이지 사람이 읽을 것이 아니다 — 사진 일곱 장을
    // 올리면 버블 절반이 `@data/raw/2026-09-16T14-35-01-…png` 로 찬다.
    const refs = attachmentRefs(content)
    const prose = refs.reduce((t, r) => t.split(`@${r}`).join(' '), content).replace(/[ \t]+/g, ' ').trim()
    return (
      <div style={{ ...baseStyle, whiteSpace: 'pre-wrap' }}>
        {refs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: prose ? 6 : 0 }}>
            {refs.map(r => <FileChip key={r} relPath={r} />)}
          </div>
        )}
        {prose}
      </div>
    )
  }

  // simple-plan(1회용 플랜)이 있으면 그것만 처리 — 저장 패널 없이 실행 칩만.
  const plan = parseSimplePlanFromText(content)
  const spec   = plan ? null : parseWorkflowSpecFromText(content)
  const action = parseCopilotAction(content)
  // 렌더 지점 계측 — 도착(handleAssistant)과 렌더 판단이 갈리는지 확인한다.
  // 스트리밍 중에도 재렌더되므로, 최종 상태만 보려면 마지막 줄을 읽으면 된다.
  logSpecDiag('render', msgId, content, spec, action, plan)
  let prose = content
  if (plan)   prose = stripSimplePlanBlock(prose)
  if (spec)   prose = stripWorkflowSpecBlock(prose)
  if (action) prose = stripCopilotActionBlock(prose)
  // 덱 블록은 항상 걷어낸다 — Content 모드에서만 나오는 펜스라 모드 분기가
  // 필요 없고, 사용자가 볼 것은 아래 카드(썸네일/칩)다.
  prose = stripDeckBlocks(prose)
  prose = stripPptxEditBlocks(prose)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignSelf: 'flex-start', maxWidth: '85%' }}>
      {prose.trim() && (
        <div
          className="md-render"
          style={{ ...baseStyle, alignSelf: 'stretch', maxWidth: '100%' }}
          dangerouslySetInnerHTML={{ __html: safeHtml(marked(prose, { breaks: true, gfm: true })) }}
        />
      )}
      {plan && (() => {
        // sourceMsgId 매칭되면 클릭 → 그 플랜을 패널에 표시. 매칭 실패는 기존 span.
        const linkedPlanId = resolvePlanId(msgId)
        const chipStyle: React.CSSProperties = {
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
          fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent)',
          background: 'var(--bg-surface)', border: '1px solid var(--accent)',
          borderRadius: 'var(--radius-sm)', alignSelf: 'flex-start',
        }
        const label = `⚡ One-time plan: ${plan.title} (${plan.nodes.length} step${plan.nodes.length === 1 ? '' : 's'})`
        return linkedPlanId ? (
          <button
            type="button"
            onClick={() => onSelectPlan(linkedPlanId)}
            title="Show this plan in the panel"
            style={{ ...chipStyle, cursor: 'pointer' }}
          >
            {label} · click to view
          </button>
        ) : (
          <span style={chipStyle}>{label} — runs automatically</span>
        )
      })()}
      {deckNotes.map((n, i) => <DeckBlockCard key={i} note={n} thumb={deckThumb} />)}
      {editOps && (
        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, padding: '6px 10px', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', alignSelf: 'flex-start' }}>
          <span style={{ color: 'var(--accent)' }}>✎ Edit original deck · {editOps.length} op{editOps.length === 1 ? '' : 's'} — review in the panel</span>
          {editOps.slice(0, 6).map((op, i) => <span key={i}>{describePptxEditOp(op)}</span>)}
          {editOps.length > 6 && <span>… +{editOps.length - 6} more</span>}
        </div>
      )}
      {spec && (
        <SpecSavePanel
          msgId={msgId}
          spec={spec}
          updateTarget={updateTargetFor(spec)}
          onApply={onApplySpec}
          autoSaved={autoSaved}
        />
      )}
      {!spec && !plan && action && <ActionChip action={action} />}
    </div>
  )
}

// ── SpecSavePanel — WF 탭 SaveSpecPanel 의 copilot 판 ────────────────────────
// Update = 기존 워크플로에 덮어쓰기 / New = 새 워크플로 생성. 자동 저장 없음 —
// 수정 대화가 복제본을 조용히 쌓는 사고를 사람이 최종 결정으로 막는다.
function SpecSavePanel({ msgId, spec, updateTarget, onApply, autoSaved }: {
  msgId: string
  spec: ParsedSpec
  updateTarget: TwixyWorkflow | null
  onApply: (msgId: string, spec: ParsedSpec, mode: 'update' | 'new', updateTarget: TwixyWorkflow | null) => Promise<TwixyWorkflow | null>
  // true = 초기 채팅에서 앱이 이미 ⊕ New 경로로 저장·오픈함 — 버튼 없이 ✓ 만.
  autoSaved?: boolean
}) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved-update' | 'saved-new' | 'error'>('idle')

  const run = async (mode: 'update' | 'new') => {
    setStatus('saving')
    const saved = await onApply(msgId, spec, mode, updateTarget)
    setStatus(saved ? (mode === 'update' ? 'saved-update' : 'saved-new') : 'error')
  }

  const done = !!autoSaved || status === 'saved-update' || status === 'saved-new'

  return (
    <div style={{
      alignSelf: 'stretch', border: '1px solid var(--accent)',
      borderRadius: 'var(--radius-md)', padding: '9px 12px',
      background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
        ◇ Workflow draft: {spec.title} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({spec.nodes.length} nodes)</span>
      </div>
      {done ? (
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
          {status === 'saved-update' ? `✓ Updated "${updateTarget?.title ?? spec.title}"` : '✓ Saved as new workflow'}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {updateTarget && (
            <button
              onClick={() => void run('update')}
              disabled={status === 'saving'}
              title={`Overwrite "${updateTarget.title}" with this draft`}
              style={{
                background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)',
                color: '#fff', fontSize: 12, fontWeight: 600, padding: '5px 12px',
                cursor: status === 'saving' ? 'default' : 'pointer', opacity: status === 'saving' ? 0.6 : 1,
              }}
            >✎ Update "{updateTarget.title.length > 22 ? updateTarget.title.slice(0, 22) + '…' : updateTarget.title}"</button>
          )}
          <button
            onClick={() => void run('new')}
            disabled={status === 'saving'}
            title="Save as a new workflow"
            style={{
              background: updateTarget ? 'transparent' : 'var(--accent)',
              border: updateTarget ? '1px solid var(--border)' : 'none',
              borderRadius: 'var(--radius-sm)',
              color: updateTarget ? 'var(--text-secondary)' : '#fff',
              fontSize: 12, fontWeight: 600, padding: '5px 12px',
              cursor: status === 'saving' ? 'default' : 'pointer', opacity: status === 'saving' ? 0.6 : 1,
            }}
          >⊕ New</button>
          {status === 'saving' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Saving…</span>}
          {status === 'error' && <span style={{ fontSize: 11, color: 'var(--danger)' }}>Save failed — try again.</span>}
        </div>
      )}
    </div>
  )
}

function ActionChip({ action }: { action: CopilotAction }) {
  const isRun = action.action === 'run'
  const color = isRun ? 'var(--accent)' : 'var(--accent)'
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
      fontSize: 11, fontFamily: 'var(--font-mono)', color,
      background: 'var(--bg-surface)', border: `1px solid ${color}`,
      borderRadius: 'var(--radius-sm)',
    }}>
      {isRun ? '▶ Run requested' : '◇ Workflow ready — waiting for inputs'}
    </span>
  )
}

// ── 플랜 컨테이너 — 1회용 플랜 하나(노드들을 담는 껍데기). 노드 카드와는 다른
// 디자인의 접이식 컨테이너: 접으면 헤더만, 펼치면 안에 노드 카드들이 뜬다.
// 헤더가 그 플랜의 실행 컨트롤(▶/■/⟲)·상태·시각을 갖고, 본문은 기존
// WorkflowNodeCard 를 재사용해 노드를 그린다 (노드 디자인은 WF 탭과 동일).
function relTime(iso: string | undefined): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function PlanContainer({ plan, order, runState, expanded, active, onActivate, onToggleExpand, onStart, onStop, onResume, onRunFromNode }: {
  plan:           CopilotPlan
  order:          number
  runState:       WorkflowTestState
  expanded:       boolean
  active:         boolean          // 우측 패널(브라우저/활동)이 이 플랜을 미러 중
  onActivate:     () => void
  onToggleExpand: () => void
  onStart:        () => void
  onStop:         () => void
  onResume:       () => void
  onRunFromNode:  (nodeId: string) => void
}) {
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null)
  const st = runState
  const running = st.isRunning
  const hasRun  = !!st.startedAt
  const failed  = !running && Object.values(st.nodeStates).some(s => s.status === 'failed' || s.status === 'aborted')
  const done    = !running && !failed && !!st.endedAt

  // 상태 배지 — 실행중/완료/실패/미실행.
  const status = running
    ? { label: 'Running…', bg: '#0d5c5022', fg: 'var(--accent)' }
    : failed ? { label: 'Failed', bg: 'rgba(181, 72, 47,0.2)', fg: 'var(--red)' }
    : done   ? { label: 'Done',   bg: '#0d5c5022', fg: '#34d399' }
    : { label: '', bg: '', fg: '' }

  // 실행 컨트롤 — 톤다운(솔리드 채움 대신 은은한 tint + 컬러 텍스트). hex 만 받는다
  // (opacity 접미사 조합용). green=Start / amber=Resume / red=Stop.
  // 선택되지 않은 플랜의 버튼은 무채색(회색)으로 — 활성 플랜만 컬러로 눈에 띄게.
  const ctrlBtn = (color: string): React.CSSProperties => {
    const c = active ? color : '#8a8f98'   // 비활성 = 중립 회색
    return {
      display: 'inline-flex', alignItems: 'center',
      background: `${c}1a`, border: `1px solid ${c}59`, color: c,
      borderRadius: 'var(--radius-sm)', padding: '3px 9px', fontSize: 11, fontWeight: 600,
      cursor: 'pointer', flexShrink: 0,
    }
  }

  return (
    <div style={{
      // 선택 표시: 제목 밝기 + 은은한 회색 테두리(accent 아님 — 눈에 덜 띄게).
      border: `1px solid ${active ? 'var(--border)' : 'var(--border-subtle)'}`,
      borderRadius: 'var(--radius-md)',
      background: 'var(--bg-base)', overflow: 'hidden', flexShrink: 0,
    }}>
      {/* 헤더 — 플랜 컨테이너 고유 디자인 (노드 카드와 다름) */}
      <div
        onClick={onActivate}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
          cursor: 'pointer', background: 'var(--bg-elevated)',
          borderBottom: expanded ? '1px solid var(--border-subtle)' : 'none',
        }}
      >
        {/* 접기/펼치기 */}
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onToggleExpand() }}
          title={expanded ? 'Collapse' : 'Expand'}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: 0, width: 14, flexShrink: 0 }}
        >{expanded ? '▾' : '▸'}</button>
        <Zap size={12} strokeWidth={2} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', flexShrink: 0 }}>#{order}</span>
        {/* 선택된 플랜만 제목을 밝게 — 나머지는 #번호/아이콘과 같은 muted. */}
        <span style={{ fontSize: 12.5, fontWeight: 600, color: active ? 'var(--text-primary)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
          {plan.title}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{plan.nodes.length} step{plan.nodes.length === 1 ? '' : 's'}</span>
        {status.label && (
          <span style={{ fontSize: 9.5, padding: '1px 6px', borderRadius: 'var(--radius-sm)', background: status.bg, color: status.fg, fontWeight: 600, flexShrink: 0 }}>
            {status.label}
          </span>
        )}
        {/* 실행 컨트롤 — stopPropagation 으로 헤더 활성화와 분리 */}
        {running ? (
          <button type="button" onClick={e => { e.stopPropagation(); onStop() }} title="Stop this plan" style={ctrlBtn('var(--danger)')}>■ Stop</button>
        ) : (
          <>
            {failed && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onResume() }}
                title="Resume from the failed step"
                style={ctrlBtn('var(--warning)')}
              >⟲ Resume</button>
            )}
            <button type="button" onClick={e => { e.stopPropagation(); onStart() }}
              title={hasRun ? 'Re-run this plan from the start' : 'Run this plan'} style={ctrlBtn('var(--accent)')}>
              <span style={{ fontSize: 9, marginRight: 3 }}>▶</span>{hasRun ? 'Re-run' : 'Start'}
            </button>
          </>
        )}
        <span style={{ fontSize: 9.5, color: 'var(--text-muted)', flexShrink: 0 }}>{relTime(plan.createdAt)}</span>
      </div>

      {/* 본문 — 노드 카드들 (기존 WorkflowNodeCard 재사용) */}
      {expanded && (
        <div style={{ padding: '12px 12px', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 14 }}>
          {plan.description && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>{plan.description}</div>
          )}
          {plan.nodes.map((node, idx) => {
            const prevNode = idx > 0 ? plan.nodes[idx - 1] : null
            const prevMetrics = prevNode ? st.nodeStates[prevNode.id] : undefined
            return (
              <WorkflowNodeCard
                key={node.id}
                node={node}
                order={idx + 1}
                isLast={idx === plan.nodes.length - 1}
                expanded={expandedNodeId === node.id}
                onToggle={() => setExpandedNodeId(expandedNodeId === node.id ? null : node.id)}
                runMetrics={st.nodeStates[node.id]}
                previousOutput={prevMetrics?.output}
                previousNodeTitle={prevNode?.title}
                // "이 노드부터 재실행" — 마지막 run 이 있고 실행 중이 아닐 때만.
                // 확인 다이얼로그는 CopilotView(planRunFromNode)가 담당.
                onRunFromHere={!running && hasRun ? () => onRunFromNode(node.id) : undefined}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── 라이브 활동 피드 — run 세션의 최근 메시지 + 툴 칩 ─────────────────────────
function ActivityFeed({ messages, toolActivity, isThinking }: {
  messages:     Array<{ id: string; role: string; content: string }>
  toolActivity: { name: string; detail?: string; subagentLabel?: string } | null
  isThinking:   boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, toolActivity, isThinking])

  return (
    <div ref={ref} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {messages.length === 0 && !isThinking && !toolActivity && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Idle — no messages yet.</div>
      )}
      {messages.slice(-30).map(m => (
        <div
          key={m.id}
          className="md-render"
          style={{
            fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)',
            background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)', padding: '5px 8px', wordBreak: 'break-word',
          }}
          dangerouslySetInnerHTML={{ __html: safeHtml(marked(m.content, { breaks: true, gfm: true })) }}
        />
      ))}
      {toolActivity && (
        <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
          ⚙ {toolActivity.subagentLabel ?? toolActivity.name}{toolActivity.detail ? ` — ${toolActivity.detail.slice(0, 80)}` : ''}
        </div>
      )}
      {isThinking && !toolActivity && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>Thinking…</div>
      )}
    </div>
  )
}

// 좌측 슬라이드-인 서랍 (워크플로 리스트 · 채팅 기록 공용).
function drawerStyle(open: boolean): React.CSSProperties {
  return {
    position: 'absolute', top: 41, bottom: 0, left: 0, width: 250, zIndex: 5,
    background: 'var(--bg-surface)', borderRight: '1px solid var(--border-subtle)',
    transform: open ? 'translateX(0)' : 'translateX(-100%)',
    transition: 'transform 0.22s ease', display: 'flex', flexDirection: 'column',
    boxShadow: open ? '8px 0 24px rgba(0,0,0,0.25)' : 'none',
    pointerEvents: open ? 'auto' : 'none',
  }
}
const drawerHeaderStyle: React.CSSProperties = {
  padding: '8px 12px', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border-subtle)', textTransform: 'uppercase', letterSpacing: 0.4,
}
const drawerEmptyStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: '8px 6px',
}

// 컴포저 위 모드 칩 (Workflow / Simple).
function modeChipStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '3px 10px', fontSize: 11, fontFamily: 'var(--font-mono)',
    color: active ? '#fff' : 'var(--text-muted)',
    background: active ? 'var(--accent)' : 'var(--bg-elevated)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
    borderRadius: 999, cursor: 'pointer', lineHeight: 1.5, fontWeight: active ? 600 : 400,
  }
}

function headerBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 9px', fontSize: 11, fontFamily: 'var(--font-mono)',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    background: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
    borderRadius: 'var(--radius-sm)', cursor: 'pointer', lineHeight: 1.4,
  }
}
