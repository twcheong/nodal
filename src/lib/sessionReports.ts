// ─────────────────────────────────────────────────────────────────────────────
// sessionReports.ts — CT(Copilot) 탭 "이슈 리포트" 수집/업로드 레이어.
//
// 고객사가 앱을 쓰다 문제를 겪으면 ⚠ 버튼 → 확인 → 이 모듈이 해당 세션의 로그
// 번들을 만들어 Supabase `session_reports` 에 insert 한다. 스태프는 대시보드
// (service_role)로만 읽는다 — docs/supabase/session_reports.sql 참조.
//
// 설계 메모 3가지:
//   1) run 상세는 디스크가 아니라 메모리에서 조립한다. CopilotView 는
//      workflowRunDetailSave 를 부르지 않으므로(WorkflowView 만 부른다)
//      CT 탭에서 시작한 run 은 runs/<startedAt>.json 이 없다 → composeRunDetail.
//   2) id 는 클라이언트가 생성하고 .select() 없이 insert 한다. 테이블에 SELECT
//      정책이 없어(수신함) PostgREST 가 representation 을 못 만든다.
//   3) teamRuns 의 report* 와 달리 fire-and-forget 이 아니다 — 사용자가 모달
//      앞에서 기다리므로 실패를 삼키지 않고 분류해서 문구로 돌려준다.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase'
import { buildFailLog } from './runLogs'
import type { CopilotMessage } from '../hooks/useCopilotChat'
import type { WorkflowTestState } from '../hooks/useWorkflowTest'

// payload 스키마 버전 — 스태프 쪽 파서가 옛 리포트를 구분할 수 있게.
export const SESSION_REPORT_SCHEMA = 1

// ── 타입 ────────────────────────────────────────────────────────────────────

export interface ReportIdentity {
  userId:       string
  userEmail:    string | null
  userName:     string | null
  orgIds:       string[]
  primaryOrgId: string | null
}

export interface ReportEnv {
  appVersion: string | null
  platform:   string | null
  userAgent:  string
  locale:     string
  timezone:   string | null
  online:     boolean
  screen:     { w: number; h: number }
  workspace:  string | null
  projectDir: string | null
  capturedAt: string           // ISO
}

export interface ReportConversation {
  id:         string
  title:      string
  createdAt:  number
  updatedAt:  number
  mode:       'wf' | 'simple'
  workflowId: string | null
  archived:   boolean
}

export interface ReportRunSummary {
  isRunning:    boolean
  startedAt?:   number
  endedAt?:     number
  totalMs:      number
  totalCostUsd: number
  nodeTotal:    number
  nodeDone:     number
  nodeFailed:   number
}

/** CopilotView 가 모아서 넘기는 원재료 (클립/레닥션 전). */
export interface SessionReportInput {
  note:            string | null
  conversation:    ReportConversation
  messages:        CopilotMessage[]
  activityLog:     string[]
  workflow:        { id: string; title: string; type?: string; nodeCount: number } | null
  runState:        WorkflowTestState | null
  runDetail:       TwixyRunDetail | null
  openClawLogTail: string
  env:             ReportEnv
  identity:        ReportIdentity
}

/** 실제로 jsonb 컬럼에 들어가는 모양. */
export interface SessionReportPayload {
  schema:          number
  note:            string | null
  conversation:    ReportConversation
  messages:        Array<{ id: string; role: 'user' | 'assistant'; content: string; ts: number }>
  activityLog:     string[]
  workflow:        SessionReportInput['workflow']
  runSummary:      ReportRunSummary | null
  runDetail:       unknown | null
  openClawLogTail: string | null
  env:             ReportEnv
  identity:        ReportIdentity
  // 상한 때문에 무엇을 버렸는지 — 스태프가 "왜 로그가 없지?" 로 헤매지 않게.
  truncated:       string[]
}

// ── 시크릿 레닥션 ────────────────────────────────────────────────────────────
// 리포트에 들어가는 모든 자유 텍스트(메시지·활동로그·프로세스 로그·prompt/output·
// 메모)에 적용한다. 특히 OpenClaw 로그에는 Supabase access token(JWT)이 실제로
// 찍히므로 jwt 패턴은 필수.
//
// 파일 경로는 일부러 지우지 않는다: 이 앱의 가장 흔한 실패 유형이 input(파일 못
// 찾음)이고 절대경로 자체가 진단 정보다(runLogs.categorizeError 참조). 대신
// env.workspace / env.projectDir 를 함께 실어 workspace 내부/외부를 구분 가능하게
// 하고, 모달 문구로 "경로가 포함된다"를 미리 알린다.
const SECRET_PATTERNS: Array<[kind: string, re: RegExp]> = [
  // 구체적인(접두사 있는) 패턴 먼저 — 마지막 일반 kv 패턴이 잡아먹지 않도록.
  ['jwt',        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['anthropic',  /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ['openrouter', /\bsk-or-v1-[A-Za-z0-9]{16,}/g],
  ['openai',     /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['google',     /\bAIza[0-9A-Za-z_-]{20,}/g],
  ['aws',        /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github',     /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ['slack',      /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['bearer',     /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi],
  ['kv',         /\b(api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["']?[^\s"',;]{8,}/gi],
]

export function redactSecrets(s: string): string {
  let out = s
  for (const [kind, re] of SECRET_PATTERNS) {
    // kv 패턴은 키 이름(api_key= 등)을 남겨야 무엇이 지워졌는지 읽을 수 있다.
    out = kind === 'kv'
      ? out.replace(re, (_m: string, key: string) => `${key}=[redacted:kv]`)
      : out.replace(re, `[redacted:${kind}]`)
  }
  return out
}

const clip = (s: string | undefined, n: number) =>
  s == null ? s : s.length > n ? s.slice(0, n) + '…' : s

const redactClip = (s: string | undefined, n: number) =>
  s == null ? s : redactSecrets(clip(s, n) as string)

// ── run 상세 조립 ───────────────────────────────────────────────────────────
// CopilotView 는 runs/<startedAt>.json 을 저장하지 않으므로(WorkflowView 만
// 저장) 메모리 상태에서 직접 만든다. 로직은 WorkflowView.tsx 의 종료 처리와 동일.
export function composeRunDetail(
  wf: { id: string; title: string; nodes: TwixyWorkflowNode[] } | null,
  wfId: string,
  st: WorkflowTestState,
): TwixyRunDetail | null {
  if (!st.startedAt) return null
  const nodeVals = Object.values(st.nodeStates)
  const hasFailed  = nodeVals.some(n => n.status === 'failed')
  const hasAborted = nodeVals.some(n => n.status === 'aborted')
  const status: TwixyRunDetail['status'] = hasFailed ? 'failed' : hasAborted ? 'aborted' : 'done'
  // 노드 메타는 워크플로 정의에서, 실행 기록은 nodeStates 에서. 정의가 없으면
  // (플랜이 evict 된 경우 등) nodeStates 키만으로 최소 형태를 만든다.
  const nodes: TwixyRunDetailNode[] = wf
    ? wf.nodes.map(n => {
        const ns = st.nodeStates[n.id]
        return {
          nodeId: n.id, title: n.title, type: n.type, tool: n.tool,
          status: ns?.status ?? 'pending',
          startedAt: ns?.startedAt, endedAt: ns?.endedAt, durationMs: ns?.durationMs,
          costUsd: ns?.costUsd, tokensIn: ns?.tokensIn, tokensOut: ns?.tokensOut,
          reason: ns?.reason, prompt: ns?.prompt, output: ns?.output, toolCalls: ns?.toolCalls,
        }
      })
    : Object.entries(st.nodeStates).map(([nodeId, ns]) => ({
        nodeId, title: nodeId, status: ns.status,
        startedAt: ns.startedAt, endedAt: ns.endedAt, durationMs: ns.durationMs,
        costUsd: ns.costUsd, tokensIn: ns.tokensIn, tokensOut: ns.tokensOut,
        reason: ns.reason, prompt: ns.prompt, output: ns.output, toolCalls: ns.toolCalls,
      }))

  return {
    runId:     `${wfId}:${st.startedAt}`,
    wfId,
    wfTitle:   wf?.title ?? wfId,
    status,
    startedAt: st.startedAt,
    endedAt:   st.endedAt ?? Date.now(),
    totals:    { ms: st.totalMs, usd: st.totalCost, tokensIn: st.totalTokensIn, tokensOut: st.totalTokensOut },
    nodes,
  }
}

export function summarizeRun(st: WorkflowTestState | null, nodeTotal: number): ReportRunSummary | null {
  if (!st || !st.startedAt) return null
  const nodeVals = Object.values(st.nodeStates)
  return {
    isRunning:    st.isRunning,
    startedAt:    st.startedAt,
    endedAt:      st.endedAt,
    totalMs:      st.totalMs,
    totalCostUsd: st.totalCost,
    nodeTotal:    nodeTotal || nodeVals.length,
    nodeDone:     nodeVals.filter(n => n.status === 'done').length,
    nodeFailed:   nodeVals.filter(n => n.status === 'failed' || n.status === 'aborted').length,
  }
}

// ── 환경 메타 ───────────────────────────────────────────────────────────────
export function buildReportEnv(extra: { workspace: string | null; projectDir: string | null }): ReportEnv {
  let timezone: string | null = null
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null } catch { /* ignore */ }
  return {
    // define 이 빠진 번들 경로에서도 throw 하지 않도록 typeof 가드.
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null,
    platform:   window.twixy?.platform ?? null,
    userAgent:  navigator.userAgent,
    locale:     navigator.language,
    timezone,
    online:     navigator.onLine,
    screen:     { w: window.screen?.width ?? 0, h: window.screen?.height ?? 0 },
    workspace:  extra.workspace,
    projectDir: extra.projectDir,
    capturedAt: new Date().toISOString(),
  }
}

// ── 페이로드 빌드 (크기 사다리) ──────────────────────────────────────────────
// runLogs.buildFailLog 와 같은 "점진적 축소" 스타일. 상한 초과 시 큰 것부터,
// 구체적인 것(채팅 전문)은 마지막에 버린다. note/identity/env 는 절대 안 버린다.
const MAX_TOTAL_BYTES    = 700 * 1024   // jsonb 행 + PostgREST 바디 여유
const CLIP_MESSAGE       = 4_000
const CLIP_ACTIVITY_LINE = 600
export const CLIP_NOTE   = 200
const OPENCLAW_TAIL_FULL = 96 * 1024
const OPENCLAW_TAIL_SLIM = 24 * 1024

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s)

export function payloadBytes(payload: SessionReportPayload): number {
  return JSON.stringify(payload).length
}

export function buildSessionReportPayload(input: SessionReportInput): SessionReportPayload {
  const truncated: string[] = []

  const messages = input.messages.map(m => ({
    id: m.id, role: m.role, ts: m.ts,
    content: redactClip(m.content, CLIP_MESSAGE) ?? '',
  }))
  const activityLog = input.activityLog.map(l => redactClip(l, CLIP_ACTIVITY_LINE) ?? '')
  const runSummary  = summarizeRun(input.runState, input.workflow?.nodeCount ?? 0)

  // run 상세: buildFailLog 가 이미 필드당 2000자 클립 + 200KB 상한을 건다.
  // 그 위에 레닥션을 한 번 더 (prompt/output 에 키가 섞여 들어올 수 있다).
  const runDetail = input.runDetail
    ? JSON.parse(redactSecrets(JSON.stringify(buildFailLog(input.runDetail)))) as unknown
    : null

  const payload: SessionReportPayload = {
    schema:          SESSION_REPORT_SCHEMA,
    note:            input.note ? redactClip(input.note, CLIP_NOTE) ?? null : null,
    conversation:    input.conversation,
    messages,
    activityLog,
    workflow:        input.workflow,
    runSummary,
    runDetail,
    openClawLogTail: input.openClawLogTail
      ? redactSecrets(tail(input.openClawLogTail, OPENCLAW_TAIL_FULL))
      : null,
    env:             input.env,
    identity:        input.identity,
    truncated,
  }
  if (payloadBytes(payload) <= MAX_TOTAL_BYTES) return payload

  // 1) OpenClaw 꼬리 축소 — 가장 크고 가장 덜 구체적.
  if (payload.openClawLogTail) {
    payload.openClawLogTail = tail(payload.openClawLogTail, OPENCLAW_TAIL_SLIM)
    truncated.push('openClawLogTail:24kb')
    if (payloadBytes(payload) <= MAX_TOTAL_BYTES) return payload
  }

  // 2) run 상세에서 성공 노드의 output/prompt 제거.
  if (payload.runDetail && typeof payload.runDetail === 'object') {
    const d = payload.runDetail as { nodes?: Array<Record<string, unknown>> }
    if (Array.isArray(d.nodes)) {
      d.nodes = d.nodes.map(n => ({
        ...n,
        output: undefined,
        prompt: n.status === 'failed' ? n.prompt : undefined,
      }))
      truncated.push('runDetail:outputs-dropped')
      if (payloadBytes(payload) <= MAX_TOTAL_BYTES) return payload
    }
  }

  // 3) 메시지 최근 120건.
  if (payload.messages.length > 120) {
    payload.messages = payload.messages.slice(-120)
    truncated.push('messages:last-120')
    if (payloadBytes(payload) <= MAX_TOTAL_BYTES) return payload
  }

  // 4) 메시지 최근 40건 + OpenClaw 꼬리 완전 제거.
  payload.messages = payload.messages.slice(-40)
  truncated.push('messages:last-40')
  if (payload.openClawLogTail) {
    payload.openClawLogTail = null
    truncated.push('openClawLogTail:dropped')
  }
  if (payloadBytes(payload) <= MAX_TOTAL_BYTES) return payload

  // 5) 바닥 — 재측정 없이 무조건 반환. 항상 종료하고 항상 insert 가능한 결과를 낸다.
  truncated.push('floor')
  return {
    ...payload,
    messages: payload.messages.slice(-20).map(m => ({ ...m, content: clip(m.content, 1_000) ?? '' })),
    activityLog: payload.activityLog.slice(-20),
    runDetail: null,
    openClawLogTail: null,
    truncated,
  }
}

// ── 에러 분류 ───────────────────────────────────────────────────────────────

export type ReportErrorKind =
  | 'not-signed-in' | 'offline' | 'timeout' | 'table-missing'
  | 'rls-denied' | 'too-large' | 'unknown'

export class ReportError extends Error {
  constructor(public kind: ReportErrorKind, public detail?: string) {
    super(detail ?? kind)
    this.name = 'ReportError'
  }
}

export function describeReportError(kind: ReportErrorKind, detail?: string): string {
  switch (kind) {
    case 'not-signed-in': return "You're signed out. Sign in again, then retry."
    case 'offline':       return "Couldn't reach Twixy's servers. Check your connection and try again."
    case 'timeout':       return 'The upload timed out. Try again.'
    // 테이블명을 일부러 노출 — 운영자가 뭘 해야 하는지 바로 알 수 있게.
    case 'table-missing': return "Issue reporting isn't set up on the server yet (session_reports table missing). Contact Twixy support."
    case 'rls-denied':    return 'The upload was rejected. Sign out and back in, then retry.'
    case 'too-large':     return "This session's logs are too large to upload. Contact Twixy support directly."
    default:              return `Upload failed: ${detail ?? 'unknown error'}`
  }
}

function mapPostgrestError(error: { code?: string; message?: string }): ReportErrorKind {
  const code = error.code ?? ''
  const msg  = (error.message ?? '').toLowerCase()
  if (code === '42P01' || code === 'PGRST205' || /could not find the table|relation .* does not exist/.test(msg)) return 'table-missing'
  if (code === '42501' || /row-level security|permission denied/.test(msg)) return 'rls-denied'
  if (code === '54000' || code === '22001' || /too large|value too long/.test(msg)) return 'too-large'
  if (/failed to fetch|network|fetch failed/.test(msg) || !navigator.onLine) return 'offline'
  return 'unknown'
}

// ── 업로드 ──────────────────────────────────────────────────────────────────

export interface SubmitResult {
  id:        string
  bytes:     number
  truncated: string[]
}

const UPLOAD_TIMEOUT_MS = 20_000

export async function submitSessionReport(input: SessionReportInput): Promise<SubmitResult> {
  // 프리플라이트 — RLS 42501 을 사람이 읽을 수 있는 문구로 앞당긴다.
  const { data: sess } = await supabase.auth.getSession()
  const uid = sess.session?.user?.id
  if (!uid) throw new ReportError('not-signed-in')

  const payload = buildSessionReportPayload(input)
  const bytes   = payloadBytes(payload)
  // reporter_user_id 는 반드시 세션 uid — RLS with check 대상과 일치해야 한다.
  const id = crypto.randomUUID()

  const insert = supabase.from('session_reports').insert({
    id,
    reporter_user_id: uid,
    reporter_email:   input.identity.userEmail,
    reporter_name:    input.identity.userName,
    org_id:           input.identity.primaryOrgId,
    conv_id:          input.conversation.id,
    conv_title:       input.conversation.title,
    conv_mode:        input.conversation.mode,
    wf_id:            input.workflow?.id ?? null,
    wf_title:         input.workflow?.title ?? null,
    note:             payload.note,
    app_version:      input.env.appVersion,
    platform:         input.env.platform,
    payload,
    payload_bytes:    bytes,
    truncated:        payload.truncated,
  })

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new ReportError('timeout')), UPLOAD_TIMEOUT_MS))

  let error: { code?: string; message?: string } | null = null
  try {
    ;({ error } = await Promise.race([insert, timeout]))
  } catch (e) {
    if (e instanceof ReportError) { console.warn('[twixy/report]', e.kind, e.detail); throw e }
    const kind: ReportErrorKind = !navigator.onLine ? 'offline' : 'unknown'
    const detail = e instanceof Error ? e.message : String(e)
    console.warn('[twixy/report]', kind, detail)
    throw new ReportError(kind, detail)
  }

  if (error) {
    const kind = mapPostgrestError(error)
    console.warn('[twixy/report]', kind, error.code, error.message)
    throw new ReportError(kind, error.message)
  }

  return { id, bytes, truncated: payload.truncated }
}
