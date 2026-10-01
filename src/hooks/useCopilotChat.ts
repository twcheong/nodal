// ─────────────────────────────────────────────────────────────────────────────
// useCopilotChat — Copilot(채팅-퍼스트 화면) 전용 세션 훅.
//
// useWorkflowClaw 패턴 기반이지만 개념이 다르다:
//  · 워크플로에 종속되지 않는 "그냥 채팅" — 대화(conversation) 단위로 관리.
//    새 채팅 생성 + 과거 기록 열람 가능 (localStorage 영속).
//  · 매 유저 메시지에 워크플로 카탈로그를 prelude 로 주입 — LLM(COPILOT_SOUL)이
//    기존 워크플로 실행 vs 새로 작성(workflow-spec)을 라우팅한다.
//  · 탭 UI 지원: 게이트웨이 세션을 **대화별로 동시에 유지**한다 (WS 1개,
//    sessions.create 는 대화당 1개 lazy). 백그라운드 탭에서 생각 중이던
//    응답도 frame key → conv 라우팅으로 자기 대화에 정확히 append 된다.
//  · archive: 탭 닫기 = archivedAt 스탬프 (삭제 아님 — 대시보드에서 워크플로
//    추적이 계속돼야 함). 기록에서 다시 선택하면 unarchive(탭 복귀).
//  · 앱 재시작 후에는 게이트웨이 세션이 사라지므로, 각 대화 세션의 첫 전송에
//    이전 대화 트랜스크립트를 seed 해 LLM 컨텍스트를 복원한다.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import { consumeSilentTurn, SILENT_TURN_TTL_MS } from '../lib/silentTurns'
import { buildMessageImageNote } from '../lib/messageImages'
import { getCopilotSoul, getSimpleSoul } from '../lib/copilotSoul'
import { getContentSoul } from '../lib/contentSoul'
import { stripWorkflowSpecBlock, stripSimplePlanBlock } from '../lib/parseWorkflowSpec'
import { buildPlanHistoryCatalog, removePlansLS } from '../lib/copilotPlans'
import { stripCopilotActionBlock } from '../lib/parseCopilotAction'
import {
  fileRefRegex, fileExtRegex, isBinaryDoc, isTabular, IMAGE_EXTS,
  ATTACH_PER_FILE_CAP, ATTACH_TOTAL_BUDGET,
} from '../../shared/fileTypes'
import { PRODUCT } from '../lib/product'
import { getProductCopilotMode } from '../lib/copilotModes'
import type { ControlUiTransport, GatewayEventFrame, RpcFrame } from '../lib/gateway/controlUiTransport'
import { createRendererTransport, isElectron } from '../lib/gateway/rendererTransport'
import { extractText, releaseSessions } from '../lib/gateway/sessionClient'
import { parseAgentToolFrame, ToolCallTracker, TOOL_EVENTS_CAP } from '../lib/gateway/toolEvents'
import { committed, deltaText, EMPTY_LIVE, visibleText, withDelta, withThinking, type LiveReply } from '../lib/gateway/liveReply'

// 새 채팅의 기본 모드, 그리고 모드 스탬프가 없는 옛 대화의 폴백 — 제품이 정한다.
const DEFAULT_MODE: CopilotMode = PRODUCT.features.defaultCopilotMode

// 라이브 챗 세션 상한 — 대화(탭)마다 게이트웨이 세션을 무한정 유지하는 건
// 낭비다 (대부분의 대화는 워크플로 한 번 돌리고 끝). LRU 로 이 수를 넘는
// 세션은 sessions.delete 로 반납하고, 그 대화는 다음 전송 때 새 세션 +
// 트랜스크립트 seed 로 컨텍스트를 복원한다. 활성 탭/응답 대기 중 대화는
// evict 대상에서 제외 (응답 유실 방지) — 전부 busy 면 일시 초과 허용(soft).
const MAX_LIVE_CHAT_SESSIONS = 3




// 대화 모드 — wf: 반복 작업용 워크플로 라우팅/작성(빌더 세션),
// simple: 일회성 작업을 풀 툴 'main' 에이전트가 직접 수행 (옛 plan-off chat).
// 대화 중 전환 가능하며 모드별로 게이트웨이 세션이 분리된다.
// content: 덱 같은 산출물을 스펙(```deck-spec```)으로 쓰게 하고 앱이 렌더/
//   프리뷰/내보내기를 소유 — 만들고→보고→고치는 반복이 본질인 작업용.
// 그 밖의 id 는 제품이 등록한 모드(src/lib/copilotModes.ts) — 예: Nodal 의 'video'.
export type CopilotMode = 'wf' | 'simple' | 'content' | (string & {})

export interface CopilotMessage {
  id:      string
  role:    'user' | 'assistant'
  content: string
  ts:      number
  /**
   * The app wrote this turn, not the person. Content mode speaks to the model
   * as the user (QA round, render-failure retry) and those messages are in
   * English — so language correction, which reads "the last user message" to
   * decide the target language, would see English and translate a Korean deck.
   * Anything set here is excluded from that sample.
   */
  appAuthored?: true
}

export interface CopilotConversation {
  id:        string
  title:     string
  createdAt: number
  updatedAt: number
  // 이 대화에서 마지막으로 보고 있던 워크플로 — 탭/기록에서 대화를 다시 열 때
  // 좌우 워크플로 패널을 복원하고, 탭의 run 상태 표시등에 쓴다.
  workflowId?: string | null
  // 탭 닫힘 시각. null/undefined = 탭 열림. 삭제가 아니라 보관 — 워크플로
  // 추적(대시보드)을 위해 대화·워크플로 연결은 남긴다.
  archivedAt?: number | null
  // 대화 모드 — 미지정 시 'wf'. 대화 중 전환 가능(전환해도 기록은 공유).
  mode?: CopilotMode
}

// ── localStorage 영속 ────────────────────────────────────────────────────────
const LS_INDEX = 'twixy.copilot.conversations'
const LS_ACTIVE = 'twixy.copilot.active'   // 마지막 활성 탭 id — 재시작 복원용
const msgsKey = (id: string) => `twixy.copilot.msgs.${id}`
const actKey  = (id: string) => `twixy.copilot.activity.${id}`   // 툴 활동 로그

function loadActivityLog(id: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(actKey(id)) ?? '[]')
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}
function saveActivityLog(id: string, log: string[]) {
  try { localStorage.setItem(actKey(id), JSON.stringify(log.slice(-40))) } catch { /* ignore */ }
}

// 재시작 시 복원할 활성 대화 id — 열려 있는(비 archive) 대화일 때만.

function loadIndex(): CopilotConversation[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_INDEX) ?? '[]')
    if (!Array.isArray(raw)) return []
    // 마이그레이션: archive 개념 도입 전의 대화는 "닫힌 탭" 으로 시작 —
    // 첫 로드에서 탭이 과거 대화로 도배되는 것을 막는다 (기록에는 그대로).
    return raw.map((c: CopilotConversation) =>
      c.archivedAt === undefined ? { ...c, archivedAt: c.updatedAt ?? Date.now() } : c,
    )
  } catch { return [] }
}
function saveIndex(list: CopilotConversation[]) {
  try { localStorage.setItem(LS_INDEX, JSON.stringify(list)) } catch { /* quota — 무시 */ }
}
function loadMsgs(id: string): CopilotMessage[] {
  try {
    const raw = JSON.parse(localStorage.getItem(msgsKey(id)) ?? '[]')
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}
// 대화별 메시지 인메모리 캐시 — 초기 로딩 때 열린 탭을 미리 파싱해두면 탭 전환이
// 즉시 이뤄진다(클릭 시 localStorage 파싱 대기 제거). saveMsgs 가 write-through.
const msgsCache = new Map<string, CopilotMessage[]>()
function loadMsgsCached(id: string): CopilotMessage[] {
  const c = msgsCache.get(id)
  if (c) return c
  const m = loadMsgs(id)
  msgsCache.set(id, m)
  return m
}
function saveMsgs(id: string, msgs: CopilotMessage[]) {
  // 대화당 최근 300개로 캡 — localStorage quota 보호.
  const capped = msgs.slice(-300)
  msgsCache.set(id, capped)
  try { localStorage.setItem(msgsKey(id), JSON.stringify(capped)) } catch { /* ignore */ }
}

/**
 * 대화 제목 — 첨부 경로는 빼고 사람이 쓴 말만.
 *
 * 컴포저는 전송할 때 첨부를 `@data/raw/…png` 토큰으로 **메시지 앞에** 붙인다
 * (플래너가 경로를 봐야 하므로). 그 문자열이 그대로 제목이 되는 바람에 탭
 * 이름이 '@data/raw/2026-09-16T14-23-00-지난번.png @data/raw/…' 로 시작해,
 * 정작 무슨 대화인지는 42자 안에 들어오지도 못했다.
 */
export function conversationTitle(text: string, max = 42): string {
  const clean = text
    .replace(/@[^\s]+/g, ' ')        // @첨부 토큰
    .replace(/\s+/g, ' ')
    .trim()
  const base = clean || text.trim() || 'New chat'
  return base.length > max ? base.slice(0, max) + '…' : base
}

// 재개된 대화 세션의 첫 전송에 붙는 이전 대화 트랜스크립트 — 게이트웨이 세션은
// 앱 재시작/재접속 시 새로 생겨 LLM 메모리가 없으므로, UI 에 보이는 스크롤백을
// LLM 에게도 되돌려준다. 최근 30개 · 메시지당 1,500자 · 전체 16k자 캡.
// stripBlocks: Simple 모드 세션에 seed 할 때 true — WF 모드 기록의 raw
// workflow-spec / copilot-action JSON 을 제거해, simple 플래너가 그걸 지시로
// 오해해 워크플로를 작동시키는 사고를 원천 차단한다 (프롬프트 룰과 이중 방어).
// simple-plan 블록은 모드 무관 항상 제거 — 옛 플랜 JSON 이 다음 턴을 오염 안 하게.
function buildTranscriptSeed(msgs: CopilotMessage[], opts?: { stripBlocks?: boolean }): string {
  if (msgs.length === 0) return ''
  const lines = msgs.slice(-30).map(m => {
    let content = m.content
    if (m.role === 'assistant') {
      content = stripSimplePlanBlock(content)
      if (opts?.stripBlocks) {
        content = stripCopilotActionBlock(stripWorkflowSpecBlock(content))
      }
      if (!content.trim()) content = '(plan/draft omitted)'
    }
    return `${m.role === 'user' ? 'User' : 'Assistant'}: ${content.length > 1500 ? content.slice(0, 1500) + '…' : content}`
  })
  let joined = lines.join('\n\n')
  if (joined.length > 16_000) joined = joined.slice(-16_000)
  return [
    '[Previous conversation transcript — your session was restarted; this is the earlier conversation with this user. Continue naturally from here. Do NOT re-run or re-save anything from the transcript.]',
    '"""',
    joined,
    '"""',
    '',
  ].join('\n')
}

// Simple 모드 매 메시지에 붙는 워크스페이스 데이터 파일 카탈로그 — 이전 워크플로
// 산출물(.json/.xlsx 등)의 "존재" 를 플래너에게 알린다. 내용은 안 보낸다 (매번
// 보내면 너무 길다) — 필요한 노드가 read 툴로 직접 읽도록 플랜을 짜게 한다.
// data/ 이하 2단계까지 훑고 최대 40개.
const INGEST_EXT_RE = fileExtRegex()
async function buildDataFileCatalog(): Promise<string> {
  const files: string[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 2 || files.length >= 40) return
    let entries: { name: string; isDir: boolean }[] = []
    try { entries = await window.twixy?.listDir?.(dir) ?? [] } catch { return }
    for (const e of entries) {
      if (files.length >= 40) return
      if (e.name.startsWith('.')) continue
      const p = `${dir}/${e.name}`
      if (e.isDir) await walk(p, depth + 1)
      else if (INGEST_EXT_RE.test(e.name)) files.push(p)
    }
  }
  await walk('data', 0)
  if (files.length === 0) return ''
  const hasDoc = files.some(isBinaryDoc)
  const hasTable = files.some(isTabular)
  return [
    '[Workspace data files — outputs from earlier runs. Paths only (contents not shown here to stay short).]',
    ...files.map(f => `- ${f}`),
    'To use a file, put its path in the node that needs it:',
    '- Text files (.json/.csv/.tsv/.md/.txt): the executor reads them itself with the read tool.',
    ...(hasDoc ? ['- Binary docs (.xlsx/.docx/.pptx/.pdf): mention the path in a node and its extracted text is auto-attached to that node (the executor cannot open binary files directly, so do NOT add a separate "read the file" step — just reference the path in the node that uses/transforms it).'] : []),
    // 표를 세거나 걸러야 하는 노드는 첨부가 아니라 query-data 로 가야 한다.
    // 첨부는 예산에 걸려 잘릴 수 있고, 잘린 표는 "행이 거기서 끝난다"로 읽힌다.
    ...(hasTable ? ['- Tabular files (.xlsx/.csv/.tsv): to COUNT, FILTER, JOIN or AGGREGATE rows, use the data → query tool (SQL over the whole file) rather than reading the attached text — the attachment may be truncated, the query never is.'] : []),
    '',
  ].join('\n')
}

// 유저 메시지가 참조한 파일(@경로/상대경로)을 텍스트로 뽑아 플래너에 바로
// 첨부한다. 플래너(builder)는 툴이 없어 어떤 파일도 못 읽으므로, 이게 없으면
// 약한 모델이 "내용을 알려달라" 고 되묻는다 (관측됨). 추출은 main 의 범용
// 인제스트 레지스트리(extractText.ts)가 확장자별로 처리 — 새 타입 지원해도
// 여기 코드는 그대로다. 그 메시지가 파일을 언급할 때만 붙어 길이 부담이 적다.
const MSG_FILE_RE = fileRefRegex()

// 사진은 추출 대상이 아니라 **배치 대상**이다. INGEST 목록에 섞지 않는 이유가
// 이것: 추출기에 PNG 를 물리면 '읽을 수 없음' 안내가 프롬프트에 흘러들고,
// 모델은 그걸 "이 파일은 못 쓴다"로 읽는다 — 정확히 반대 결론이다. 대신 경로를
// 있는 그대로 주고, 볼 수 없다는 사실을 함께 말한다(빌더는 vision 이 없다).
async function buildMessageFileAttachment(text: string): Promise<string> {
  const twixy = typeof window !== 'undefined' ? window.twixy : undefined
  if (!twixy?.extractFileText) return ''
  MSG_FILE_RE.lastIndex = 0        // /g 정규식은 상태를 갖는다 — 재사용 전 리셋
  const paths = Array.from(new Set(
    (text.match(MSG_FILE_RE) ?? [])
      .map(p => p.replace(/^[`'"@]+|[`'"]+$/g, '').replace(/^\.?\//, '').replace(/^~\//, '')),
  ))
  if (paths.length === 0) return ''
  const blocks: string[] = []
  let budget = ATTACH_TOTAL_BUDGET
  for (const rel of paths) {
    if (budget <= 0) break
    try {
      const res = await twixy.extractFileText({ relPath: rel, maxChars: Math.min(budget, ATTACH_PER_FILE_CAP) })
      if (!res) continue
      if (res.ok && res.text) {
        budget -= res.text.length
        blocks.push(`--- ${rel} (${res.kind ?? 'file'}${res.truncated ? '; truncated' : ''}) ---\n${res.text}`)
      } else if (res.note) {
        // 미지원/에러 — 데이터 대신 안내를 넣어 플래너가 되묻지 않고 유저에게
        // 고치는 법을 알려주게 한다.
        blocks.push(`--- ${rel} — cannot read: ${res.note} ---`)
      }
    } catch { /* skip */ }
  }
  if (blocks.length === 0) return ''
  return [
    '',
    '[Referenced file(s) — extracted for you below. Use this DIRECTLY; never ask the user to paste it. If a file could not be read, tell the user how to fix it instead of asking for its contents.]',
    ...blocks,
    '',
  ].join('\n')
}

// 매 유저 메시지에 붙는 워크플로 카탈로그 — LLM 라우팅의 근거.
// nodes 전체는 토큰 낭비라 개수만; 매칭에 필요한 건 title/description/inputs.
function buildCatalogPrelude(workflows: TwixyWorkflow[]): string {
  const catalog = workflows.map(w => ({
    id:          w.id,
    title:       w.title,
    description: w.description ?? '',
    inputs:      (w.inputs ?? []).map(i => ({ id: i.id, label: i.label, valueType: i.valueType, kind: i.kind })),
    nodeCount:   w.nodes?.length ?? 0,
  }))
  return [
    '[Available workflows — match the user\'s request against these before authoring anything new]',
    '```json',
    JSON.stringify(catalog, null, 2),
    '```',
    '',
  ].join('\n')
}

// 세션 장부 키 — 같은 대화라도 모드별로 게이트웨이 세션이 분리된다
// (wf=builder 에이전트 / simple=main 에이전트).
const sessKeyOf = (convId: string, mode: CopilotMode) => `${convId}::${mode}`

export function useCopilotChat(
  workflows: TwixyWorkflow[],
  // 라이브로 도착한 어시스턴트 메시지 알림 (활성/백그라운드 대화 모두).
  // CopilotView 가 spec/action 처리를 위해 구독 — 기록에서 로드된 옛 메시지에는
  // 발화되지 않으므로 "과거 액션 재실행" 사고가 구조적으로 없다. mode 를 함께
  // 넘겨 simple 모드 응답에서는 spec/action 을 처리하지 않게 한다.
  onAssistantMessage?: (convId: string, msg: CopilotMessage, mode: CopilotMode) => void,
) {
  const [conversations, setConversations] = useState<CopilotConversation[]>(loadIndex)
  // 새로 열면 항상 "새 탭"(활성 대화 없음)으로 시작한다 — 이전 작업 탭을 복원하지
  // 않는다. 과거 대화는 탭 스트립/⚙ 히스토리에서 다시 열 수 있다.
  const [activeConvId,  setActiveConvId]  = useState<string | null>(null)
  const [messages,      setMessages]      = useState<CopilotMessage[]>([])
  const [isThinking,    setIsThinking]    = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  // 대화별 thinking 상태 — 탭 표시등/전환 시 복원용. state 로도 노출.
  const [thinkingConvs, setThinkingConvs] = useState<Set<string>>(new Set())
  // 활성 대화의 현재 툴 활동 + 최근 활동 로그 — "작동 중인지 안 보인다" 해결.
  // simple 모드(풀 툴 main 에이전트)에서 특히 중요: 턴이 길어 중간 신호가 없으면
  // 멈춘 것처럼 보인다. 로그는 대화별로 최근 40개 유지 + localStorage 영속
  // (앱 재시작 후에도 Live activity 기록이 남는다).
  const [toolActivity, setToolActivity] = useState<string | null>(null)
  // 새 탭으로 시작하므로 활동 로그도 비어서 시작 (대화 선택 시 복원됨).
  const [activityLog,  setActivityLog]  = useState<string[]>([])
  const toolActivityByConv = useRef<Map<string, string | null>>(new Map())
  const activityLogByConv  = useRef<Map<string, string[]>>(new Map())
  // 턴 진행 중에 쓰이고 있는 답장·추론 (liveReply.ts). 대화별 장부 + 활성 대화의 화면용 값.
  // 전에는 메시지가 다 끝나야 보여서, 긴 턴 동안 "Thinking" 만 떠 있었다.
  const liveByConv = useRef<Map<string, LiveReply>>(new Map())
  const [liveReply, setLiveReply] = useState<{ text: string; thinking: string } | null>(null)

  // 침묵 턴이 대기 중인 대화들 — sendMessage({ silent }) 가 등록하고, 그
  // 대화의 **다음 어시스턴트 메시지 하나**가 소비한다(대화당 하나). 앱이
  // 모델과 주고받는 내부 왕복(덱 자동 검증)을 전사에서 통째로 빼기 위한 것.
  //
  // 값이 **마감 시각**인 이유(2026-09-15 실사고): 침묵 턴이 답장도 에러도 없이
  // 사라질 수 있다 — 세션이 LRU 로 evict 되어 프레임이 라우팅 안 되거나,
  // 이미지 인라인이 실패하거나. 그러면 Set 이던 시절엔 플래그가 세션 내내
  // 남아 **그 다음에 오는 진짜 답장**을 삼켰다. 사용자는 질문을 보냈는데
  // 아무 답도 못 받았다. 만료되면 플래그는 없는 것과 같다.
  const silentTurns  = useRef<Map<string, number>>(new Map())
  /** 대화별 턴 시작 시각 — 모델 응답 시간 계측용. */
  const turnStartedAt = useRef<Map<string, number>>(new Map())
  // 핸드셰이크·RPC 는 transport 가 맡는다 (훅 인스턴스당 하나, 첫 send 때 lazy 생성 — WS 1개는 그대로).
  const transportRef = useRef<ControlUiTransport | null>(null)
  const activeConvIdRef = useRef<string | null>(activeConvId)

  // 활성 탭 id 영속 — 앱 재시작 시 마지막 탭 복원. 세션은 만들지 않는다.
  useEffect(() => {
    try {
      if (activeConvId) localStorage.setItem(LS_ACTIVE, activeConvId)
      else localStorage.removeItem(LS_ACTIVE)
    } catch { /* quota */ }
  }, [activeConvId])
  // ── 대화×모드별 세션 장부 (탭 병렬의 심장) — 키는 sessKeyOf(convId, mode) ──
  const sessionKeyByConv = useRef<Map<string, string>>(new Map())
  const convByKey        = useRef<Map<string, { convId: string; mode: CopilotMode }>>(new Map())
  const soulSentConvs    = useRef<Set<string>>(new Set())
  // sessions.create 동시 호출 직렬화 (useWorkflowTestSession 에서 배운 교훈).
  const createLocks      = useRef<Map<string, Promise<string>>>(new Map())
  // LRU 순서 (오래된 것 앞, sessKey) + thinking 의 ref 미러 (evict 판정은 동기라 state 불가).
  const lruRef           = useRef<string[]>([])
  const thinkingRef      = useRef<Set<string>>(new Set())
  // 진행 중인 툴 호출 — toolCallId 로 세어 병렬 호출이 서로를 지우지 않게 (세션 key 기준).
  const toolTracker      = useRef(new ToolCallTracker())
  // 초기 로딩 시 "열린 탭"(archive 안 된 대화) 메시지를 미리 캐시에 파싱해둔다 →
  // 나중에 탭 클릭 시 localStorage 파싱 대기 없이 즉시 전환된다.
  useEffect(() => {
    for (const c of loadIndex()) if (!c.archivedAt) loadMsgsCached(c.id)
  }, [])
  // 콜백 stale closure 회피.
  const onAssistantRef = useRef(onAssistantMessage)
  useEffect(() => { onAssistantRef.current = onAssistantMessage }, [onAssistantMessage])
  const workflowsRef = useRef(workflows)
  useEffect(() => { workflowsRef.current = workflows }, [workflows])
  // 대화 인덱스 ref 미러 — sendMessage 가 활성 대화의 mode 를 동기적으로 읽는다.
  const conversationsRef = useRef(conversations)
  useEffect(() => { conversationsRef.current = conversations }, [conversations])
  // "＋ New chat" 상태에서 고른 모드 — 첫 전송 시 새 대화에 스탬프된다.
  const [newChatMode, setNewChatMode] = useState<CopilotMode>(DEFAULT_MODE)
  const newChatModeRef = useRef<CopilotMode>(DEFAULT_MODE)
  useEffect(() => { newChatModeRef.current = newChatMode }, [newChatMode])

  const setConvThinking = useCallback((convId: string, thinking: boolean) => {
    if (thinking) thinkingRef.current.add(convId)
    else thinkingRef.current.delete(convId)
    setThinkingConvs(prev => {
      const next = new Set(prev)
      if (thinking) next.add(convId)
      else next.delete(convId)
      return next
    })
    if (activeConvIdRef.current === convId) setIsThinking(thinking)
  }, [])

  const setConvToolActivity = useCallback((convId: string, name: string | null) => {
    toolActivityByConv.current.set(convId, name)
    if (name) {
      // 메모리 미스(재시작 직후)면 디스크 로그에 이어붙인다.
      const log = activityLogByConv.current.get(convId) ?? loadActivityLog(convId)
      const next = [...log, `▸ ${name}`].slice(-40)
      activityLogByConv.current.set(convId, next)
      saveActivityLog(convId, next)
      if (activeConvIdRef.current === convId) setActivityLog(next)
    }
    if (activeConvIdRef.current === convId) setToolActivity(name)
  }, [])

  /** 라이브 장부 갱신 — null 이면 비운다(턴 끝). 활성 대화면 화면 값도. */
  const updateLive = useCallback((convId: string, fn: ((l: LiveReply) => LiveReply) | null) => {
    const next = fn ? fn(liveByConv.current.get(convId) ?? EMPTY_LIVE) : null
    if (next) liveByConv.current.set(convId, next)
    else liveByConv.current.delete(convId)
    if (activeConvIdRef.current !== convId) return
    const text = next ? visibleText(next) : ''
    setLiveReply(next && (text || next.thinking) ? { text, thinking: next.thinking } : null)
  }, [])

  const touchLru = useCallback((convId: string) => {
    lruRef.current = [...lruRef.current.filter(id => id !== convId), convId]
  }, [])

  // RPC 는 send 포함 15s 고정 (transport 기본값). transport 가 아직 없으면(=연결 전)
  // 예전과 똑같이 'WS not open' 으로 거절한다.
  const rpc = useCallback((method: string, params: Record<string, unknown>): Promise<RpcFrame> => {
    const t = transportRef.current
    return t ? t.rpc(method, params) : Promise.reject(new Error('WS not open'))
  }, [])

  // 메시지 내용 교체(언어 교정) — 활성 대화면 state, 디스크 둘 다 패치.
  const patchMessage = useCallback((convId: string, msgId: string, content: string) => {
    if (activeConvIdRef.current === convId) {
      setMessages(prev => {
        const next = prev.map(m => (m.id === msgId ? { ...m, content } : m))
        saveMsgs(convId, next)
        return next
      })
    } else {
      const next = loadMsgs(convId).map(m => (m.id === msgId ? { ...m, content } : m))
      saveMsgs(convId, next)
    }
  }, [])

  // 메시지를 대화에 append — 활성 대화면 state 도 갱신, 아니면 디스크만.
  const appendToConv = useCallback((convId: string, line: CopilotMessage) => {
    if (activeConvIdRef.current === convId) {
      setMessages(prev => {
        const next = [...prev, line]
        saveMsgs(convId, next)
        return next
      })
    } else {
      saveMsgs(convId, [...loadMsgs(convId), line])
    }
    // 인덱스의 updatedAt 갱신 + 최신 대화를 맨 위로.
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === convId)
      if (idx < 0) return prev
      const next = [...prev]
      const [conv] = next.splice(idx, 1)
      next.unshift({ ...conv, updatedAt: line.ts })
      saveIndex(next)
      return next
    })
  }, [])

  // 연결이 사라졌을 때의 정리.
  const handleClose = useCallback(() => {
    // 게이트웨이 세션들은 이 연결에 묶여 있으므로 전부 리셋 — 다음 전송이
    // 대화별로 새 세션을 만들고 트랜스크립트 seed 로 컨텍스트를 복원한다.
    sessionKeyByConv.current.clear()
    convByKey.current.clear()
    soulSentConvs.current.clear()
    createLocks.current.clear()
    lruRef.current = []
    thinkingRef.current.clear()
    toolTracker.current.clearAll()
    liveByConv.current.clear()
    setLiveReply(null)
    setThinkingConvs(new Set())
    setIsThinking(false)
  }, [])

  // 완료 판정·대화 라우팅은 전부 여기서 — transport 는 raw 프레임만 넘긴다.
  const handleEvent = useCallback((frame: GatewayEventFrame) => {
    // chat 상태 이벤트 — final/error 에서 thinking 을 확실히 내린다.
    // (전에는 assistant 메시지 도착만 신호였는데, 턴이 에러로 죽으면
    // (예: 이미지 입력 404) 메시지 없이 끝나 "Thinking…" 이 영원히 남았다.)
    if (frame.event === 'chat') {
      const state = frame.payload?.state as string | undefined
      const evtKey = (frame.payload?.sessionKey ?? frame.payload?.key) as string | undefined
      const routed = evtKey ? convByKey.current.get(evtKey) : undefined
      if (!routed) return
      if (state === 'delta') {
        // 쓰이는 중인 답장. 침묵 턴(앱 내부 왕복)은 보이지 않는다.
        const text = deltaText(frame.payload)
        if (text && !silentTurns.current.has(routed.convId)) updateLive(routed.convId, (l) => withDelta(l, text))
        return
      }
      updateLive(routed.convId, null)   // final · error · aborted — 턴이 끝났다
      if (state === 'final') {
        // 모델 한 턴이 얼마나 걸렸나 — 이 숫자가 없어서 "11분" 을
        // 게이트웨이 세션 생성 시각에서 역산해야 했다. usage 가 실려
        // 오면 같이 남긴다(프롬프트가 큰 건지 생성이 느린 건지 구분).
        const began = turnStartedAt.current.get(routed.convId)
        if (began) {
          turnStartedAt.current.delete(routed.convId)
          const usage = frame.payload?.usage as Record<string, unknown> | undefined
          const tail = usage ? ` · usage ${JSON.stringify(usage).slice(0, 160)}` : ''
          void window.twixy?.logUi?.(`[chat] reply in ${((Date.now() - began) / 1000).toFixed(1)}s${tail}`)
        }
        setConvThinking(routed.convId, false)
        if (evtKey) toolTracker.current.clear(evtKey)
        setConvToolActivity(routed.convId, null)
      } else if (state === 'error') {
        setConvThinking(routed.convId, false)
        if (evtKey) toolTracker.current.clear(evtKey)
        setConvToolActivity(routed.convId, null)
        // 침묵 턴이 죽었으면 대화에 아무것도 남기지 않는다 — 사용자가
        // 하지 않은 질문에 대한 에러다. 플래그는 반드시 걷어야 다음
        // 정상 답장이 삼켜지지 않는다. (호출자는 자체 타임아웃으로
        // 결과를 확정한다 — 덱 홀드가 그 예다.)
        if (consumeSilentTurn(silentTurns.current, routed.convId)) return
        const msg = (frame.payload?.error as { message?: string })?.message ?? 'turn failed'
        appendToConv(routed.convId, {
          id: crypto.randomUUID(), role: 'assistant',
          content: `⚠️ The turn failed: ${msg}. You can send a follow-up message to continue.`,
          ts: Date.now(),
        })
      }
      return
    }

    // 추론 스트림 — 세션 reasoningLevel 이 'stream' 일 때만 온다 (세션 생성 때 켠다).
    if (frame.event === 'agent' && frame.payload?.stream === 'thinking') {
      const key = frame.payload.sessionKey as string | undefined
      const routed = key ? convByKey.current.get(key) : undefined
      const raw = (frame.payload.data as { text?: unknown } | undefined)?.text
      if (routed && typeof raw === 'string' && !silentTurns.current.has(routed.convId)) updateLive(routed.convId, (l) => withThinking(l, raw))
      return
    }

    // session.tool — 대화별 툴 활동 표시 (simple 모드 가시화의 핵심).
    // 툴 활동 — `agent` 의 tool 스트림에서 온다 (session.tool 이 아니다, toolEvents.ts 참고).
    const tool = parseAgentToolFrame(frame)
    if (tool) {
      const routed = convByKey.current.get(tool.sessionKey)
      if (!routed) return
      const { current } = toolTracker.current.apply(tool)
      if (current) {
        setConvToolActivity(routed.convId, current)
      } else {
        // 진행 중인 호출이 없다 — 칩을 내린다. (setConvToolActivity 는 이름이 있을 때만
        // activityLog 에 쌓으므로 여기서 직접 비운다.)
        toolActivityByConv.current.set(routed.convId, null)
        if (activeConvIdRef.current === routed.convId) setToolActivity(null)
      }
      return
    }

    if (frame.event === 'session.message') {
      const msg = frame.payload?.message as Record<string, unknown> | undefined
      if (msg?.role !== 'assistant') return
      const text = extractText(msg.content)
      if (!text) return
      // frame key → 대화×모드 라우팅. 라우팅되지 않는 프레임은 **버린다**.
      // 예전엔 활성 대화로 폴백했지만 그 폴백은 틀리는 쪽으로만 작동한다: 게이트웨이는
      // session.message 에 항상 sessionKey 를 싣고(번들 확인), 키가 장부에 없다는 건 그 세션이
      // evict/삭제됐다는 뜻이다 — 그 답의 주인은 지금 화면에 떠 있는 대화가 아니다.
      const frameKey = (frame.payload?.key ?? frame.payload?.sessionKey) as string | undefined
      const routed = frameKey ? convByKey.current.get(frameKey) : undefined
      if (!routed) return
      const { convId, mode } = routed
      const line: CopilotMessage = { id: crypto.randomUUID(), role: 'assistant', content: text, ts: Date.now() }
      // 이 메시지가 대화에 붙는다 — 라이브 버블에서 그만큼 뺀다. 턴은 아직 이어질 수 있다(툴 뒤 다음 말).
      updateLive(convId, committed)
      // thinking 은 여기서 내리지 않는다 — 턴 종료(chat final/error)가 내린다. 여기서 내리면
      // "먼저 확인할게요" 한 마디 뒤 같은 턴에서 도는 툴·실행 동안 화면이 쉬는 것처럼 보이고,
      // 제품 패널(Nodal)이 그 사이에 생긴 실행을 이 대화 것으로 못 알아본다 (isThinking 으로 귀속).
      const lruKey = sessKeyOf(convId, mode)
      lruRef.current = [...lruRef.current.filter(k => k !== lruKey), lruKey]
      // 침묵 턴의 답장 — 대화에 남기지 않는다. 앱이 모델에게 물어본
      // 것(레이아웃 자동 검증)이라 사람에게는 '질문'도 '답'도 아니고,
      // 결과(고쳐진 덱)만 보이면 된다. 구독자(CopilotView)에게는 그대로
      // 전달해야 그 결과가 적용된다.
      const silent = consumeSilentTurn(silentTurns.current, convId)
      if (!silent) appendToConv(convId, line)
      // spec/action 처리는 라이브 도착분만 — CopilotView 가 구독.
      // simple 모드 응답은 mode 로 구분돼 spec/action 처리에서 제외된다.
      onAssistantRef.current?.(convId, line, mode)
      // 언어 교정 — chat 모드와 동일한 post-turn 파이프라인. 약한 모델이
      // 한국어 응답에 중국어/일본어를 흘리는 것을 flash-lite 1회 호출로
      // 재작성. 코드블록(workflow-spec/copilot-action)은 교정 프롬프트가
      // 원문 보존. spec/액션 처리는 원문 기준으로 이미 발화됐음.
      if (!silent && localStorage.getItem('twixy-lang-correction') !== 'false') {
        const lastUser = [...loadMsgs(convId)].reverse().find(m => m.role === 'user' && !m.appAuthored)
        void window.twixy?.correctLanguage?.({ text, userSample: lastUser?.content ?? '' })
          .then(res => {
            if (res?.ok && res.text && res.text !== text) {
              patchMessage(convId, line.id, res.text)
            }
          })
          .catch(() => { /* non-critical */ })
      }
    }
  }, [appendToConv, patchMessage, setConvThinking, setConvToolActivity, updateLive])

  const getTransport = useCallback((): ControlUiTransport => {
    if (transportRef.current) return transportRef.current
    // tool-events: Live activity 에 실행 중인 툴을 그린다 → tool 스트림 agent 프레임이 필요하다.
    // 연결 이름은 모델이 보는 **보낸 사람 이름**이 된다 — 제품 이름으로 (Nodal 에이전트가 사용자를
    // "Twixy Copilot님" 이라 부르고 자기를 Twixy 라 했다). Twixy 에서는 예전과 같은 'Twixy Copilot'.
    const t = createRendererTransport(`${PRODUCT.displayName} Copilot`, 'Copilot WS error', { caps: [TOOL_EVENTS_CAP] })
    t.onClose(handleClose)
    t.onEvent(handleEvent)
    transportRef.current = t
    return t
  }, [handleClose, handleEvent])

  const ensureConnected = useCallback(async () => {
    await getTransport().ensureConnected()
  }, [getTransport])

  // 언마운트 정리 — 예전엔 없어서 소켓과 RPC 타이머가 남았다. dispose 는 구독자를 먼저 비우므로
  // 언마운트 뒤 도착한 프레임이 대화에 append 되거나 setState 를 부르지 않는다. 살아 있던 연결이면
  // 세션 장부도 close 때와 똑같이 비운다. transport 는 다음 send 가 새로 만든다 — StrictMode 의
  // mount→unmount→mount 에서도 dispose 된 인스턴스를 재사용하지 않는다.
  useEffect(() => () => {
    const t = transportRef.current
    transportRef.current = null
    if (!t) return
    const wasConnected = t.isConnected()
    // 대화×모드 세션을 반납 — 소켓을 닫기 전에, handleClose 가 장부를 비우기 전에.
    releaseSessions(t, sessionKeyByConv.current.values())
    t.dispose()
    if (wasConnected) handleClose()
  }, [handleClose])

  // LRU evict — 캡을 넘는 유휴 세션을 게이트웨이에서 반납. 활성 대화의 세션과
  // thinking 중인 대화는 건너뛴다; 전부 busy 면 그대로 둔다 (soft cap).
  const evictOverCap = useCallback(() => {
    while (sessionKeyByConv.current.size > MAX_LIVE_CHAT_SESSIONS) {
      const victim = lruRef.current.find(k => {
        const convId = k.split('::')[0]
        return convId !== activeConvIdRef.current
          && !thinkingRef.current.has(convId)
          && sessionKeyByConv.current.has(k)
      })
      if (!victim) break
      const key = sessionKeyByConv.current.get(victim)!
      sessionKeyByConv.current.delete(victim)
      convByKey.current.delete(key)
      soulSentConvs.current.delete(victim)
      lruRef.current = lruRef.current.filter(k => k !== victim)
      // 게이트웨이 메모리 반납 — 실패해도 로컬 매핑은 이미 끊겨 무해.
      void rpc('sessions.delete', { key }).catch(() => { /* best-effort */ })
    }
  }, [rpc])

  // 대화×모드당 게이트웨이 세션 1개 — 없으면 생성 (동시 호출 직렬화).
  //  · wf     → 'builder' (tool-less): 라우팅 + workflow-spec 작성.
  //  · simple → 'builder' (tool-less): 1회용 simple-plan 작성. 실행은 앱이
  //             workflow-runner 세션(useWorkflowTestSession)으로 별도 수행.
  const ensureSessionForConv = useCallback(async (convId: string, mode: CopilotMode): Promise<string> => {
    await ensureConnected()
    const sk = sessKeyOf(convId, mode)
    const existing = sessionKeyByConv.current.get(sk)
    if (existing) { touchLru(sk); return existing }
    let lock = createLocks.current.get(sk)
    if (!lock) {
      lock = (async () => {
        //  · 제품 등록 모드 → 그 모드가 지정한 에이전트 (툴을 가진 에이전트일 수 있다).
        const sess = await rpc('sessions.create', { agentId: getProductCopilotMode(mode)?.agentId ?? 'builder' })
        if (!sess.ok || !sess.payload?.key) throw new Error('Session create failed')
        const key = sess.payload.key as string
        sessionKeyByConv.current.set(sk, key)
        convByKey.current.set(key, { convId, mode })
        await rpc('sessions.messages.subscribe', { key })
        // 추론을 스트림으로 — 모델의 추론이 답장에 섞이지 않고 `agent` stream:'thinking' 으로만 온다
        // (liveReply.ts). 추론을 안 내는 모델이면 아무 일도 없다. 실패해도 채팅은 그대로 된다.
        void rpc('sessions.patch', { key, reasoningLevel: 'stream' }).catch(() => { /* best-effort */ })
        touchLru(sk)
        evictOverCap()
        return key
      })()
      // lock 은 읽을 때와 같은 key(sk = 대화×모드)로 걸고 푼다. 예전엔 convId 로 써서 위의
      // get(sk) 가 항상 빗나갔다 — 직렬화가 작동하지 않아 같은 틱의 두 전송이 세션을 2개 만들었다.
      createLocks.current.set(sk, lock)
      void lock.catch(() => { /* propagate below */ }).finally(() => {
        createLocks.current.delete(sk)
      })
    }
    return lock
  }, [ensureConnected, rpc, touchLru, evictOverCap])

  /**
   * 대화를 지금 만든다 — 전송 없이. 보통은 첫 메시지가 lazy 하게 만들지만,
   * 메시지 전에 대화에 묶인 상태가 생기는 경로가 있다: Content 모드에서 .pptx
   * 를 떨어뜨리고 "원본 유지" 를 고르는 순간 편집 대상은 대화별로 저장돼야
   * 하는데, 아직 대화가 없으면 저장할 곳이 없다(실측: 새 대화에 바로 드롭하면
   * 아무것도 안 떴다). 동기적으로 id 를 돌려준다 — 호출부가 바로 쓴다.
   */
  const startConversation = useCallback((title: string): string => {
    const conv: CopilotConversation = {
      id:         crypto.randomUUID(),
      title:      conversationTitle(title),
      createdAt:  Date.now(),
      updatedAt:  Date.now(),
      workflowId: null,
      archivedAt: null,
      mode:       newChatModeRef.current,
    }
    activeConvIdRef.current = conv.id
    setActiveConvId(conv.id)
    setConversations(prev => {
      const next = [conv, ...prev]
      saveIndex(next)
      return next
    })
    return conv.id
  }, [])

  // `text` 는 LLM 이 받는 페이로드(숨은 컨텍스트 포함 가능), `displayText` 가
  // 있으면 채팅 버블에는 그것만 보인다 (auto-review 등 내부 스캐폴딩 은닉).
  const sendMessage = useCallback(async (text: string, opts?: { displayText?: string; appAuthored?: true; silent?: true; contextPrelude?: string }): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!isElectron) { setError('Not running inside Twixy'); return }

    const visible = (opts?.displayText ?? trimmed).trim() || trimmed

    // 첫 메시지면 대화를 이 시점에 생성 (ChatGPT 식 lazy 생성). 탭 열림 상태.
    let convId = activeConvIdRef.current
    if (!convId) convId = startConversation(visible)
    // 이 전송이 갈 모드 — 대화에 스탬프된 모드 (새 대화면 방금 스탬프된 것).
    const mode: CopilotMode =
      conversationsRef.current.find(c => c.id === convId)?.mode
      ?? newChatModeRef.current

    // 트랜스크립트 seed 용 — 이번에 보내는 메시지가 append 되기 전의 기록.
    const priorMsgs = loadMsgs(convId)
    // silent — 이 왕복은 전사에 남지 않는다(보낸 것도, 받은 것도). 대화가
    // 아직 없을 때는 침묵 턴이 있을 수 없으므로(덱이 이미 있어야 한다) 위의
    // lazy 생성과 순서가 꼬이지 않는다.
    if (opts?.silent) silentTurns.current.set(convId, Date.now() + SILENT_TURN_TTL_MS)
    else appendToConv(convId, { id: crypto.randomUUID(), role: 'user', content: visible, ts: Date.now(), ...(opts?.appAuthored ? { appAuthored: true as const } : {}) })
    turnStartedAt.current.set(convId, Date.now())
    updateLive(convId, null)
    setConvThinking(convId, true)
    setError(null)

    try {
      const sid = await ensureSessionForConv(convId, mode)
      const sk  = sessKeyOf(convId, mode)
      // LLM 페이로드 (모드별):
      //  · wf     — (첫 메시지엔 COPILOT_SOUL + 트랜스크립트) + 워크플로 카탈로그 + 텍스트
      //  · simple — (첫 메시지엔 SIMPLE_SOUL + run recap + 정화된 트랜스크립트) +
      //             데이터 파일 카탈로그(매 메시지) + 텍스트. 워크플로 카탈로그는
      //             안 준다 — 플래너가 워크플로를 매칭/작동할 이유 자체를 제거.
      // 이 메시지가 참조한 파일은 즉시 텍스트로 첨부 — 플래너가 툴 없이도 데이터를
      // 손에 쥐게 해 "내용 달라" 되묻기를 원천 차단 (wf/simple 공통, 모든 지원 타입).
      const fileAttach = (await buildMessageFileAttachment(trimmed)) + buildMessageImageNote(trimmed, priorMsgs)
      let body: string
      const productMode = getProductCopilotMode(mode)
      if (productMode) {
        const first = !soulSentConvs.current.has(sk)
        body = await productMode.buildBody({
          text: trimmed,
          first,
          transcriptSeed: first ? buildTranscriptSeed(priorMsgs, { stripBlocks: true }) : '',
          fileAttach,
        })
      } else if (mode === 'simple') {
        // 유저 요청을 명시 마커로 감싼다 — 페이로드 앞쪽의 recap/트랜스크립트/
        // 카탈로그(전부 배경)가 새 지시를 덮는 사고 방지. 소울의 PRIORITY 규칙과
        // 짝을 이루는 결정적 표식: 이전 워크플로와 다른 요구(언어/포맷/범위)가
        // 와도 최신 메시지가 이긴다.
        const userReq = `[Current user request — THIS is the task and it OVERRIDES all background context above]\n${trimmed}`
        // 데이터 파일 카탈로그는 매 메시지 갱신 — run 이 새 파일을 만들면 다음
        // 턴에 바로 보인다. 경로만이라 가볍다.
        const dataCatalog = await buildDataFileCatalog()
        // 플랜 히스토리 카탈로그 — "plan 2 고쳐줘" 같은 지칭을 가능하게. #N 은
        // 패널 셀렉터와 같은 번호. 0~1개면 빈 문자열 (토큰 절약).
        const planCatalog = buildPlanHistoryCatalog(convId)
        if (soulSentConvs.current.has(sk)) {
          body = `${planCatalog}${dataCatalog}${fileAttach}${userReq}`
        } else {
          // 연결된 워크플로의 마지막 run 결과(디스크)를 seed — "수집된 데이터를
          // 기반으로 수정" 이 앱 재시작 후에도 가능하게. 노드별 output 을 클립.
          let runRecap = ''
          const wfId = conversationsRef.current.find(c => c.id === convId)?.workflowId
          if (wfId) {
            try {
              const saved = await window.twixy?.workflowTestRunLoad?.(wfId) as
                { nodeStates?: Record<string, { output?: string; status?: string }> } | null
              const wf = workflowsRef.current.find(w => w.id === wfId)
              if (saved?.nodeStates && wf) {
                const parts: string[] = []
                wf.nodes.forEach((n, i) => {
                  const out = saved.nodeStates?.[n.id]?.output
                  if (out) {
                    parts.push(`### Node ${i + 1}: ${n.title}`)
                    parts.push(out.length > 1500 ? out.slice(0, 1500) + '…' : out)
                  }
                })
                if (parts.length > 0) {
                  runRecap = [
                    `[Linked workflow "${wf.title}" — last run results, loaded from disk as BACKGROUND context. Use as source data instead of redoing the collection — but the user's current request below OVERRIDES anything here (language, format, scope).]`,
                    ...parts,
                    '',
                  ].join('\n')
                  if (runRecap.length > 14_000) runRecap = runRecap.slice(0, 14_000) + '…\n\n'
                }
              }
            } catch { /* 저장된 run 없음 — seed 생략 */ }
          }
          body = `${getSimpleSoul()}\n\n---\n\n${runRecap}${buildTranscriptSeed(priorMsgs, { stripBlocks: true })}${planCatalog}${dataCatalog}${fileAttach}${userReq}`
        }
      } else if (mode === 'content') {
        // 워크플로 카탈로그를 주지 않는다 — 이 모드의 산출물은 워크플로가 아니라
        // 덱 스펙이고, 카탈로그가 있으면 모델이 자꾸 실행 쪽으로 샌다.
        // 데이터 파일 카탈로그는 매 메시지 갱신(덱의 소스가 워크스페이스 파일).
        const dataCatalog = await buildDataFileCatalog()
        // contextPrelude — 호출부가 매 메시지 앞에 붙이는 상태(원본 편집 대상의
        // 아웃라인 등). 화면에는 안 보이고 LLM 페이로드에만 들어간다.
        const prelude = opts?.contextPrelude ? `${opts.contextPrelude}\n` : ''
        body = soulSentConvs.current.has(sk)
          ? `${prelude}${dataCatalog}${fileAttach}${trimmed}`
          : `${getContentSoul()}\n\n---\n\n${buildTranscriptSeed(priorMsgs, { stripBlocks: true })}${prelude}${dataCatalog}${fileAttach}${trimmed}`
      } else {
        const withCatalog = `${buildCatalogPrelude(workflowsRef.current)}${fileAttach}${trimmed}`
        body = soulSentConvs.current.has(sk)
          ? withCatalog
          : `${getCopilotSoul()}\n\n---\n\n${buildTranscriptSeed(priorMsgs)}${withCatalog}`
      }
      soulSentConvs.current.add(sk)
      await rpc('sessions.send', { key: sid, message: body })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setConvThinking(convId, false)
    }
  }, [appendToConv, ensureSessionForConv, rpc, setConvThinking, startConversation, updateLive])

  const newConversation = useCallback(() => {
    activeConvIdRef.current = null
    setActiveConvId(null)
    setMessages([])
    setIsThinking(false)
    setLiveReply(null)
    setToolActivity(null)
    setActivityLog([])
    setError(null)
    // 세션들은 대화별로 계속 살아 있다 — 백그라운드 탭의 응답 수신 유지.
  }, [])

  // 활성 대화의 진행 중인 턴 중단 — 현재 모드 세션에 sessions.abort.
  // (게이트웨이 측 모델/툴 스트림까지 취소된다. 세션 자체는 유지 — 이어서 대화 가능.)
  /**
   * 대기 중인 침묵 턴을 취소한다 — 호출자가 "이제 그 답장은 안 기다린다" 고
   * 결정했을 때. 만료(TTL)와 이중 방어: 덱 홀드가 타임아웃으로 확정했는데
   * 플래그가 남아 있으면, 뒤늦게 오는 그 답장이 사용자의 다음 질문에 대한
   * 답으로 오인돼 삼켜질 수 있다.
   */
  const cancelSilentTurn = useCallback((convId: string) => {
    silentTurns.current.delete(convId)
  }, [])

  const abortActive = useCallback(async () => {
    const convId = activeConvIdRef.current
    if (!convId) return
    const mode: CopilotMode =
      conversationsRef.current.find(c => c.id === convId)?.mode ?? DEFAULT_MODE
    const key = sessionKeyByConv.current.get(sessKeyOf(convId, mode))
    if (key) {
      try { await rpc('sessions.abort', { key }) } catch { /* best-effort */ }
    }
    setConvThinking(convId, false)
    setConvToolActivity(convId, null)
    updateLive(convId, null)
  }, [rpc, setConvThinking, setConvToolActivity, updateLive])

  // 대화 선택(탭/기록 클릭) — archive 상태면 탭으로 복귀(unarchive).
  const selectConversation = useCallback((id: string) => {
    if (activeConvIdRef.current === id) return
    activeConvIdRef.current = id
    setActiveConvId(id)
    setMessages(loadMsgsCached(id))
    setError(null)
    setToolActivity(toolActivityByConv.current.get(id) ?? null)
    setActivityLog(activityLogByConv.current.get(id) ?? loadActivityLog(id))
    const live = liveByConv.current.get(id)
    setLiveReply(live && (visibleText(live) || live.thinking) ? { text: visibleText(live), thinking: live.thinking } : null)
    setThinkingConvs(prev => { setIsThinking(prev.has(id)); return prev })
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === id)
      if (idx < 0 || !prev[idx].archivedAt) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], archivedAt: null }
      saveIndex(next)
      return next
    })
  }, [])

  // 탭 닫기 = archive. 삭제가 아니다 — 대화·워크플로 연결은 대시보드 추적을
  // 위해 남는다. 진행 중인 run 도 세션도 건드리지 않는다 (백그라운드 계속).
  const archiveConversation = useCallback((id: string) => {
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === id)
      if (idx < 0) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], archivedAt: Date.now() }
      saveIndex(next)
      return next
    })
    if (activeConvIdRef.current === id) newConversation()
  }, [newConversation])

  const deleteConversation = useCallback((id: string) => {
    setConversations(prev => {
      const next = prev.filter(c => c.id !== id)
      saveIndex(next)
      return next
    })
    try { localStorage.removeItem(msgsKey(id)) } catch { /* ignore */ }
    try { localStorage.removeItem(actKey(id)) } catch { /* ignore */ }
    removePlansLS(id)   // 플랜 히스토리 (새 배열 키 + 구 단수 키 — 예전 누수도 정리)
    // 이 대화의 세션을 전부 반납 — 모드 목록이 아니라 **장부**를 훑는다. 목록을 하드코딩하면
    // 모드가 늘 때마다 빠진다 (content 가 그랬고, 제품 등록 모드는 프로필 목록과 출처가 달라 또 빠졌다).
    const prefix = `${id}::`
    for (const [sk, key] of [...sessionKeyByConv.current]) {
      if (!sk.startsWith(prefix)) continue
      sessionKeyByConv.current.delete(sk)
      convByKey.current.delete(key)
      void rpc('sessions.delete', { key }).catch(() => { /* best-effort */ })
    }
    for (const sk of [...soulSentConvs.current]) if (sk.startsWith(prefix)) soulSentConvs.current.delete(sk)
    lruRef.current = lruRef.current.filter(k => !k.startsWith(prefix))
    thinkingRef.current.delete(id)
    if (activeConvIdRef.current === id) newConversation()
  }, [newConversation, rpc])

  // 대화 ↔ 워크플로 연결 기록 — CopilotView 가 runWorkflowId 변경 시 호출.
  const setConversationWorkflow = useCallback((convId: string, workflowId: string | null) => {
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === convId)
      if (idx < 0 || prev[idx].workflowId === workflowId) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], workflowId }
      saveIndex(next)
      return next
    })
  }, [])

  // 모드 전환 — 활성 대화가 있으면 그 대화에 스탬프(대화 중 전환 가능, 기록은
  // 공유), 없으면 다음 새 대화에 적용될 모드로 보관. 세션은 모드별로 분리돼
  // 있어 전환해도 기존 모드 세션은 그대로 남는다 (다시 돌아오면 이어짐).
  const setMode = useCallback((mode: CopilotMode) => {
    const id = activeConvIdRef.current
    if (!id) { setNewChatMode(mode); return }
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === id)
      if (idx < 0 || prev[idx].mode === mode) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], mode }
      saveIndex(next)
      return next
    })
  }, [])

  // 현재 UI 가 보여줄 모드 — 활성 대화의 모드, 새 채팅이면 선택해 둔 모드.
  const activeMode: CopilotMode = activeConvId
    ? (conversations.find(c => c.id === activeConvId)?.mode ?? DEFAULT_MODE)
    : newChatMode

  // 대화별 메시지 스냅샷 — appendToConv 가 write-through 캐시(saveMsgs)를 먼저
  // 갱신한 뒤 onAssistantMessage 를 발화하므로, 콜백 시점에 방금 도착한
  // 메시지까지 포함된 목록이 돌아온다.
  const messagesFor = useCallback((convId: string): CopilotMessage[] => loadMsgsCached(convId), [])

  return {
    conversations, activeConvId, messages, isThinking, thinkingConvs, error,
    toolActivity, activityLog,
    // 턴 진행 중에 쓰이고 있는 답장·추론 (활성 대화). 없으면 null.
    liveReply,
    activeMode, setMode,
    sendMessage, cancelSilentTurn, abortActive, newConversation, startConversation, selectConversation, archiveConversation,
    deleteConversation, setConversationWorkflow,
    // 대화별 메시지 동기 조회 — 활성 대화가 아니어도 읽을 수 있다.
    // (CopilotView 가 "이 응답이 대화의 첫 어시스턴트 메시지인가" 판정에 사용.)
    messagesFor,
  }
}
