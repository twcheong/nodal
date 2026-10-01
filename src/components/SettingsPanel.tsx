// ═════════════════════════════════════════════════════════════════════════════
// SettingsPanel.tsx — 앱의 설정 화면 (사용자/플랜/키/모델/모바일 채널).
//
// 포함 섹션:
//   · 계정 정보 (Supabase 이메일 + 로그아웃)
//   · 플랜 & 사용량 (오늘 메시지·토큰·USD, 파이 차트 by model, 리셋)
//   · Twixy/BYOK 모드 토글
//   · BYOK 모드 전용: API 키 입력 + 모델 선택 (Anthropic/OpenAI)
//   · 서브에이전트 모델 선택
//   · 모바일 채널 설정 (Telegram/Discord/Signal/BlueBubbles)
//
// 사용량 수치는 useEntitlements + fetchUsageCost(상위에서 주입) 두 경로로 수집.
// 핀 차트(UsagePieByModel) 로 모델별 지출 분포를 시각화.
// ═════════════════════════════════════════════════════════════════════════════

import { useState, useEffect } from 'react'
import { GuardrailSettings } from './GuardrailSettings'
import { SegmentedControl } from './ui'
import { getThemePref, setThemePref, type ThemePref } from '../design/theme'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { useEntitlements } from '../hooks/useEntitlements'
import { FREE_PLAN } from '../lib/entitlements'
import { DisplayCost } from '../lib/useDisplayUsd'
import { PRODUCT } from '../lib/product'
import { isMaskedSecret } from '../../shared/secretMask'

// OpenClaw usage.cost 가 반환하는 총합 필드 스키마.
interface UsageTotals {
  input:        number
  output:       number
  cacheRead:    number
  cacheWrite:   number
  totalTokens:  number
  totalCost:    number
  inputCost:    number
  outputCost:   number
}

// 큰 수 축약 표시 (1234 → "1.2K", 1200000 → "1.20M"). 토큰 카운트 등에 사용.
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

// USD 표시는 DisplayCost (lib/useDisplayUsd) 가 markup IPC 까지 처리하도록 통일됨.
// 잔여 raw 표시 자리에 폴백 필요 시 modelPricing.formatCostUsd 사용.

interface ApiKeys {
  anthropic: string
  openai: string
}

// BYOK (Bring-Your-Own-Key) UI 토글: LLM Mode 토글, API 키 카드, Active Main Model
// 픽커, Sub-Agent Model 픽커 등 모든 BYOK 관련 섹션 가시성 제어. 기본값 false 로
// Settings 탭에서 숨김. true 로 바꾸면 한 줄로 다시 노출. 상태/로드/저장 effect
// 는 아래에 그대로 살려둬서 재활성화가 1-line 으로 가능하다.
const SHOW_BYOK = false

// BYOK 모드에서 선택 가능한 모델 프리셋. id 는 어느 업체 키를 요구하는지 나타냄.
// UI 에서 카드 형태로 나열되고, 선택 시 해당 업체 키 입력창이 활성화된다.
const PROVIDERS = [
  {
    id: 'anthropic' as const,
    name: 'Anthropic',
    description: 'Claude models (Opus, Sonnet, Haiku)',
    placeholder: 'sk-ant-api03-...',
    model: 'anthropic/claude-sonnet-4-5',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai' as const,
    name: 'OpenAI',
    description: 'GPT-5.4, GPT-5.4 mini',
    placeholder: 'sk-proj-...',
    model: 'openai/gpt-5.4',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openai' as const,
    name: 'OpenAI',
    description: 'GPT-5.4 mini',
    placeholder: 'sk-proj-...',
    model: 'openai/gpt-5.4-mini',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
]

// 게이트웨이 cron.* RPC 응답 프레임 (useOpenClaw 의 ResponseFrame 미러).
type CronRpcFrame = { ok: boolean; payload?: Record<string, unknown>; error?: { code?: string; message?: string } }
// SettingsPanel 이 받는 cron 메서드 묶음 — App.tsx 가 useOpenClaw 결과에서 주입.
// 기존 window.twixy.cron* IPC 를 대체하며, 게이트웨이 WS RPC 로 직접 호출한다.
interface SettingsCronApi {
  cronList:        () => Promise<CronRpcFrame>
  cronAddFromForm: (form: {
    name: string; description?: string
    scheduleKind: 'cron' | 'every'; schedule: string; tz?: string
    prompt: string; delivery: 'in-app' | 'channel'; channel?: string; to?: string
  }) => Promise<CronRpcFrame>
  cronRemove:  (id: string) => Promise<CronRpcFrame>
  cronRun:     (id: string, mode?: 'due' | 'force') => Promise<CronRpcFrame>
  cronEnable:  (id: string) => Promise<CronRpcFrame>
  cronDisable: (id: string) => Promise<CronRpcFrame>
}

export function SettingsPanel({ fetchUsageCost, resetUsageBaseline, usageRefreshKey, cron, visible = true }: {
  fetchUsageCost: () => Promise<unknown>
  resetUsageBaseline: () => Promise<void>
  usageRefreshKey: number
  cron: SettingsCronApi
  // 이 패널은 항상 마운트(숨김)이라, 사용량 조회를 마운트 즉시 하면 콜드
  // 게이트웨이에 usage.cost/sessions.usage(각 3~4s)를 던져 시작이 느려진다.
  // 실제로 Settings 탭이 보일 때만 조회한다.
  visible?: boolean
}) {
  const [twixyMode, setTwixyModeState] = useState<'twixy' | 'byok'>('twixy')
  const [twixyModeSwitching, setTwixyModeSwitching] = useState(false)
  const [keys, setKeys]         = useState<ApiKeys>({ anthropic: '', openai: '' })
  const [show, setShow]         = useState<Record<string, boolean>>({})
  const [saving, setSaving]     = useState(false)
  const [saved, setSaved]       = useState(false)
  const [activeModel, setActiveModel] = useState('openai/gpt-5.4')
  const [subagentModel, setSubagentModel] = useState('openai/gpt-5.4-mini')
  const [subagentSaving, setSubagentSaving] = useState(false)
  const [subagentSavedMsg, setSubagentSavedMsg] = useState<string | null>(null)
  const [langCorrection, setLangCorrectionState] = useState(() =>
    localStorage.getItem('twixy-lang-correction') !== 'false'
  )
  const [usage, setUsage]       = useState<UsageTotals | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  type ByModelEntry = { provider?: string; model?: string; totals: Record<string, number> }
  const [usageByModel, setUsageByModel] = useState<ByModelEntry[]>([])

  // Account / entitlements
  const { user, signOut } = useAuth()
  // 표시 이름 편집 — auth.updateUser 로 user_metadata.full_name 갱신.
  // USER_UPDATED 이벤트를 useAuth 가 구독 중이라 저장 즉시 앱 전체에 반영된다.
  const [nameDraft, setNameDraft] = useState('')
  const [nameBusy, setNameBusy] = useState(false)
  const [nameMsg, setNameMsg] = useState<string | null>(null)
  useEffect(() => {
    setNameDraft((user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string) ?? '')
  }, [user?.id])  // eslint-disable-line react-hooks/exhaustive-deps
  async function saveDisplayName() {
    const name = nameDraft.trim().slice(0, 60)
    if (!name) { setNameMsg('Name cannot be empty'); return }
    setNameBusy(true)
    setNameMsg(null)
    try {
      const { error } = await supabase.auth.updateUser({ data: { full_name: name } })
      if (error) throw new Error(error.message)
      setNameMsg('Saved')
      setTimeout(() => setNameMsg(null), 2000)
    } catch (e) {
      setNameMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setNameBusy(false)
    }
  }
  const ent = useEntitlements()
  const [signingOut, setSigningOut] = useState(false)

  // Live "resets in Xh Ym" until UTC midnight (Postgres day boundary used by
  // record_usage). Tick once a minute — that's plenty for an hour-grain UI.
  const [resetLabel, setResetLabel] = useState(formatResetLabel())
  useEffect(() => {
    const t = setInterval(() => setResetLabel(formatResetLabel()), 60_000)
    return () => clearInterval(t)
  }, [])

  // App version — read once from main (get-app-version IPC). Shown under the
  // Settings header; also the groundwork for the future "update available" check.
  const [appVersion, setAppVersion] = useState<string>('')
  useEffect(() => {
    let cancelled = false
    window.twixy.getAppVersion().then(v => { if (!cancelled) setAppVersion(v) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // ── Mobile channels (Telegram / Discord / Signal / BlueBubbles) ──
  const [channels, setChannels] = useState<ChannelsConfig>({})
  const [channelsSaving, setChannelsSaving] = useState(false)
  const [channelsSavedMsg, setChannelsSavedMsg] = useState<string | null>(null)

  // ── Designated Paths (workspace bucket whitelist) ─────────────────
  // Editable view uses plain text — `rootsText` is one root per line, and
  // `subdirsByRoot` is comma-separated subdir names keyed by root. We keep
  // the canonical DesignatedPathsConfig as the load/save shape and derive
  // these on hydrate / save. Saving restarts the OpenClaw gateway so the
  // env-driven guard inside pi-embedded picks up the new whitelist.
  const [dpRootsText, setDpRootsText] = useState<string>('')
  const [dpSubdirsByRoot, setDpSubdirsByRoot] = useState<Record<string, string>>({})
  const [dpSaving, setDpSaving] = useState(false)
  const [dpSavedMsg, setDpSavedMsg] = useState<string | null>(null)
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})

  // ── 예약 작업 (Scheduled Tasks, OpenClaw cron) ────────────────────
  // 게이트웨이 내장 스케줄러. 잡 결과는 기본 main 세션으로 발사돼 인앱 채팅에
  // 표시된다. 앱(게이트웨이)이 켜져 있을 때만 동작 — 상단 경고 박스로 안내.
  const [cronJobs, setCronJobs] = useState<TwixyCronJob[]>([])
  const [cronLoading, setCronLoading] = useState(false)
  const [cronMsg, setCronMsg] = useState<string | null>(null)
  const [cronBusyId, setCronBusyId] = useState<string | null>(null)
  // 추가 폼 상태
  const [cronName, setCronName] = useState('')
  const [cronPreset, setCronPreset] = useState<'daily9' | 'weeklyMon9' | 'hourly' | 'custom'>('daily9')
  const [cronCustomExpr, setCronCustomExpr] = useState('')
  const [cronPrompt, setCronPrompt] = useState('')
  const [cronDelivery, setCronDelivery] = useState<'in-app' | 'channel'>('in-app')
  const [cronAdding, setCronAdding] = useState(false)

  // ── 장기 기억(Memory) ─────────────────────────────────────────────
  // MEMORY.md 본문을 textarea 로 편집 + 저장. 그 아래 memory/*.md 일일 노트
  // 목록을 띄우고, 클릭하면 읽기전용으로 본문을 표시한다.
  const [memoryText, setMemoryText] = useState<string>('')
  const [memorySaving, setMemorySaving] = useState(false)
  const [memorySavedMsg, setMemorySavedMsg] = useState<string | null>(null)
  const [memoryNotes, setMemoryNotes] = useState<{ name: string; mtime: number }[]>([])
  const [memoryNoteOpen, setMemoryNoteOpen] = useState<string | null>(null)
  const [memoryNoteContent, setMemoryNoteContent] = useState<string>('')

  useEffect(() => {
    if (!window.twixy?.getChannels) return
    window.twixy.getChannels().then((c: ChannelsConfig) => setChannels(c ?? {}))
  }, [])

  // 장기 기억 하이드레이트: MEMORY.md 본문 + 일일 노트 목록.
  useEffect(() => {
    if (!window.twixy?.memoryRead) return
    window.twixy.memoryRead().then(r => { if (r?.ok) setMemoryText(r.content ?? '') })
    window.twixy.memoryListNotes?.().then(r => { if (r?.ok) setMemoryNotes(r.notes ?? []) })
  }, [])

  // Hydrate the editable designated-paths view from main's cache (which
  // already merged any saved config on top of in-code defaults).
  useEffect(() => {
    if (!window.twixy?.designatedPathsGetConfig) return
    window.twixy.designatedPathsGetConfig().then((cfg: DesignatedPathsConfig) => {
      const roots = Array.isArray(cfg?.roots) ? cfg.roots : []
      setDpRootsText(roots.join('\n'))
      const subdirs: Record<string, string> = {}
      for (const r of roots) {
        const arr = cfg?.allowedSubdirs?.[r] ?? []
        subdirs[r] = arr.join(', ')
      }
      setDpSubdirsByRoot(subdirs)
    })
  }, [])

  function dpParseRootsText(text: string): string[] {
    // Split on newline OR comma so users can paste either format. parseList()
    // is comma-only — designated roots can contain `/` so newlines are the
    // primary separator, but accept commas for one-liner convenience.
    return text.split(/[\n,]/).map(s => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean)
  }

  async function handleSaveDesignatedPaths() {
    if (!window.twixy?.designatedPathsSetConfig) return
    setDpSaving(true)
    setDpSavedMsg(null)
    try {
      const roots = dpParseRootsText(dpRootsText)
      const allowedSubdirs: Record<string, string[]> = {}
      for (const r of roots) {
        allowedSubdirs[r] = parseList(dpSubdirsByRoot[r] ?? '')
      }
      const res = await window.twixy.designatedPathsSetConfig({
        version: 1,
        roots,
        allowedSubdirs,
      })
      setDpSavedMsg(res.ok
        ? '✓ Saved — gateway restarted'
        : `Save failed: ${res.error ?? 'unknown'}`)
      setTimeout(() => setDpSavedMsg(null), 4000)
    } catch (err) {
      setDpSavedMsg(`Save failed: ${String(err)}`)
      setTimeout(() => setDpSavedMsg(null), 4000)
    } finally {
      setDpSaving(false)
    }
  }

  function patchChannel<K extends keyof ChannelsConfig>(
    key: K,
    patch: Partial<NonNullable<ChannelsConfig[K]>>,
  ) {
    setChannels(prev => ({
      ...prev,
      [key]: { ...(prev[key] ?? { enabled: false }), ...patch } as ChannelsConfig[K],
    }))
  }

  async function handleSaveChannels() {
    if (!window.twixy?.saveChannels) return
    setChannelsSaving(true)
    setChannelsSavedMsg(null)
    try {
      const res = await window.twixy.saveChannels(channels)
      setChannelsSavedMsg(res.ok
        ? '✓ Saved — gateway restarted'
        : `Save failed: ${res.error ?? 'unknown'}`)
      setTimeout(() => setChannelsSavedMsg(null), 4000)
    } catch (err) {
      setChannelsSavedMsg(`Save failed: ${String(err)}`)
    } finally {
      setChannelsSaving(false)
    }
  }

  // ── 예약 작업 (cron) 로드 + CRUD 핸들러 ───────────────────────────
  // 게이트웨이 cron.* RPC 직접 호출(App.tsx → useOpenClaw 주입). 응답은
  // ResponseFrame { ok, payload, error } 형태 — 잡 배열은 payload.jobs 에 담긴다.
  // 게이트웨이 미연결 시 RPC 가 throw → catch 에서 명확한 한국어 에러로 surface.
  function cronErr(r: CronRpcFrame): string { return r.error?.message ?? r.error?.code ?? 'unknown' }
  async function loadCronJobs() {
    setCronLoading(true)
    try {
      const r = await cron.cronList()
      if (r.ok) {
        const jobs = (r.payload?.jobs ?? r.payload?.items ?? []) as TwixyCronJob[]
        setCronJobs(Array.isArray(jobs) ? jobs : [])
        setCronMsg(null)
      } else setCronMsg(`불러오기 실패: ${cronErr(r)}`)
    } catch (err) {
      setCronMsg(`불러오기 실패: ${String(err)}`)
    } finally {
      setCronLoading(false)
    }
  }
  // cron 이 꺼진 제품은 게이트웨이에 cron 을 안 켜므로 조회하면 에러만 난다.
  useEffect(() => { if (PRODUCT.features.cron) void loadCronJobs() }, [])

  // 프리셋 → cron 식 변환. '직접 입력'은 사용자가 친 cronCustomExpr 를 그대로 사용.
  function cronExprForPreset(): { schedule: string; kind: 'cron' | 'every' } {
    switch (cronPreset) {
      case 'daily9':     return { schedule: '0 9 * * *',   kind: 'cron' }
      case 'weeklyMon9': return { schedule: '0 9 * * 1',   kind: 'cron' }
      case 'hourly':     return { schedule: '0 * * * *',   kind: 'cron' }
      case 'custom':     return { schedule: cronCustomExpr.trim(), kind: 'cron' }
    }
  }

  async function handleAddCron() {
    const name = cronName.trim()
    const prompt = cronPrompt.trim()
    if (!name)   { setCronMsg('이름을 입력하세요.'); return }
    if (!prompt) { setCronMsg('수행할 작업(프롬프트)을 입력하세요.'); return }
    const { schedule, kind } = cronExprForPreset()
    if (!schedule) { setCronMsg('cron 식을 입력하세요 (예: 0 9 * * *).'); return }
    // cron 식 가벼운 검증(5/6 필드) — 게이트웨이 거부 전에 명확한 한국어 안내.
    if (kind === 'cron' && !/^(\S+\s+){4,5}\S+$/.test(schedule)) {
      setCronMsg('cron 식은 5 또는 6개의 필드여야 합니다 (예: 0 9 * * *).'); return
    }

    setCronAdding(true)
    setCronMsg(null)
    try {
      const r = await cron.cronAddFromForm({
        name, schedule, scheduleKind: kind, tz: 'Asia/Seoul',
        prompt, delivery: cronDelivery,
        ...(cronDelivery === 'channel' ? { channel: 'telegram' } : {}),
      })
      if (r.ok) {
        setCronMsg('✓ 예약 작업이 추가되었습니다.')
        setCronName(''); setCronPrompt(''); setCronCustomExpr('')
        await loadCronJobs()
      } else {
        setCronMsg(`추가 실패: ${cronErr(r)}`)
      }
    } catch (err) {
      setCronMsg(`추가 실패: ${String(err)}`)
    } finally {
      setCronAdding(false)
      setTimeout(() => setCronMsg(null), 5000)
    }
  }

  async function handleCronRemove(id: string) {
    setCronBusyId(id)
    try {
      const r = await cron.cronRemove(id)
      if (r.ok) await loadCronJobs()
      else setCronMsg(`삭제 실패: ${cronErr(r)}`)
    } catch (err) {
      setCronMsg(`삭제 실패: ${String(err)}`)
    } finally { setCronBusyId(null) }
  }

  async function handleCronRun(id: string) {
    setCronBusyId(id)
    setCronMsg(null)
    try {
      const r = await cron.cronRun(id, 'force')
      setCronMsg(r.ok ? '✓ 지금 실행을 요청했습니다 — 결과는 메인 채팅에 표시됩니다.' : `실행 실패: ${cronErr(r)}`)
    } catch (err) {
      setCronMsg(`실행 실패: ${String(err)}`)
    } finally {
      setCronBusyId(null)
      setTimeout(() => setCronMsg(null), 5000)
    }
  }

  async function handleCronToggle(id: string, enabled: boolean) {
    setCronBusyId(id)
    try {
      const r = enabled ? await cron.cronDisable(id) : await cron.cronEnable(id)
      if (r.ok) await loadCronJobs()
      else setCronMsg(`상태 변경 실패: ${cronErr(r)}`)
    } catch (err) {
      setCronMsg(`상태 변경 실패: ${String(err)}`)
    } finally { setCronBusyId(null) }
  }

  // 잡의 스케줄을 사람이 읽기 쉽게. cron 식이면 알려진 프리셋만 한국어로,
  // 나머지는 식을 그대로 노출(직접입력 케이스).
  function cronScheduleLabel(job: TwixyCronJob): string {
    const sched = job.schedule
    const expr = typeof sched === 'string' ? sched : (sched?.expr ?? sched?.every ?? sched?.at ?? '')
    const known: Record<string, string> = {
      '0 9 * * *': '매일 09:00',
      '0 9 * * 1': '매주 월요일 09:00',
      '0 * * * *': '매시간 정각',
    }
    return known[expr] || String(expr || '(스케줄 미상)')
  }

  // ── Connections (연동) — Claude.ai-connector-style service cards ──
  // Status only: window.twixy.connections* IPC returns { service, connected,
  // account? } — raw tokens never reach the renderer (main keeps them in a
  // safeStorage vault / the existing Google token file).
  const [conns, setConns] = useState<TwixyConnectionInfo[]>([])
  const [connBusy, setConnBusy] = useState<TwixyConnectionService | null>(null)
  const [connMsg, setConnMsg] = useState<Partial<Record<TwixyConnectionService, string>>>({})
  const [discordToken, setDiscordToken] = useState('')

  useEffect(() => { void refreshConnections() }, [])

  async function refreshConnections() {
    if (!window.twixy?.connectionsList) return
    try {
      const r = await window.twixy.connectionsList()
      if (r.ok) setConns(r.connections)
    } catch { /* ignore */ }
  }

  function setConnMsgFor(service: TwixyConnectionService, msg: string | null, clearAfterMs = 5000) {
    setConnMsg(prev => ({ ...prev, [service]: msg ?? undefined }))
    if (msg && clearAfterMs > 0) {
      setTimeout(() => setConnMsg(prev => (prev[service] === msg ? { ...prev, [service]: undefined } : prev)), clearAfterMs)
    }
  }

  async function handleConnConnect(service: TwixyConnectionService) {
    if (!window.twixy?.connectionsConnect) return
    setConnBusy(service)
    if (service === 'google') setConnMsgFor(service, '브라우저가 열렸습니다 — 거기서 로그인을 완료하세요.', 0)
    try {
      const r = await window.twixy.connectionsConnect(service)
      setConnMsgFor(service, r.ok
        ? `✓ 연결됨${r.connection.account ? ` — ${r.connection.account}` : ''}`
        : `연결 실패: ${r.error ?? 'unknown'}`)
      await refreshConnections()
      if (service === 'google') await refreshGws()
    } finally { setConnBusy(null) }
  }

  async function handleConnDisconnect(service: TwixyConnectionService) {
    if (!window.twixy?.connectionsDisconnect) return
    setConnBusy(service)
    try {
      const r = await window.twixy.connectionsDisconnect(service)
      setConnMsgFor(service, r.ok ? '✓ 연결 해제됨' : `해제 실패: ${r.error ?? 'unknown'}`)
      await refreshConnections()
      if (service === 'google') await refreshGws()
    } finally { setConnBusy(null) }
  }

  async function handleConnSetToken(service: TwixyConnectionService, token: string) {
    if (!window.twixy?.connectionsSetToken) return
    if (!token.trim()) { setConnMsgFor(service, '토큰을 입력하세요.'); return }
    setConnBusy(service)
    setConnMsgFor(service, '토큰 검증 중…', 0)
    try {
      const r = await window.twixy.connectionsSetToken(service, token.trim())
      setConnMsgFor(service, r.ok
        ? `✓ 연결됨 — ${r.connection.account ?? '(이름 없음)'}`
        : `저장 실패: ${r.error ?? 'unknown'}`)
      if (r.ok && service === 'discord') setDiscordToken('')
      await refreshConnections()
    } finally { setConnBusy(null) }
  }

  // ── MCP 클라이언트 서버 ────────────────────────────────────────────
  // 사용자가 등록한 외부 MCP 서버 목록 + "서버 추가" 폼. 저장/삭제 시
  // 게이트웨이가 재시작된다(openclaw.json 의 mcp.servers 재적용). 토큰 원문은
  // 렌더러로 오지 않고 main 의 vault(mcp:<id>)에만 저장된다.
  const [mcpServers, setMcpServers] = useState<TwixyMcpServerMeta[]>([])
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpMsg, setMcpMsg] = useState<string | null>(null)
  const [mcpForm, setMcpForm] = useState<{
    id: string
    label: string
    kind: 'stdio' | 'http'
    command: string
    args: string
    env: string
    url: string
    transport: 'sse' | 'streamable-http'
    token: string
    // http 인증 방식: 'oauth'(권장, Twixy 가 브라우저로 OAuth) | 'token'(직접 입력)
    authMode: 'oauth' | 'token'
    // DCR 미지원 서버(예: Slack)용 — 접힌 선택 입력
    clientId: string
  }>({ id: '', label: '', kind: 'http', command: '', args: '', env: '', url: '', transport: 'streamable-http', token: '', authMode: 'oauth', clientId: '' })

  useEffect(() => { void refreshMcpServers() }, [])

  async function refreshMcpServers() {
    if (!window.twixy?.mcpList) return
    try {
      const r = await window.twixy.mcpList()
      if (r.ok) setMcpServers(r.servers)
    } catch { /* ignore */ }
  }

  function setMcpMsgTimed(msg: string | null, ms = 6000) {
    setMcpMsg(msg)
    if (msg && ms > 0) setTimeout(() => setMcpMsg(prev => (prev === msg ? null : prev)), ms)
  }

  function resetMcpForm() {
    setMcpForm({ id: '', label: '', kind: 'http', command: '', args: '', env: '', url: '', transport: 'streamable-http', token: '', authMode: 'oauth', clientId: '' })
  }

  function buildMcpDef(): TwixyMcpServerMeta | null {
    const id = mcpForm.id.trim()
    const label = mcpForm.label.trim() || id
    if (!id) { setMcpMsgTimed('서버 ID를 입력하세요 (영문/숫자/_).'); return null }
    if (mcpForm.kind === 'stdio') {
      if (!mcpForm.command.trim()) { setMcpMsgTimed('stdio 서버는 실행 명령(command)이 필요합니다.'); return null }
      const args = mcpForm.args.split('\n').map(s => s.trim()).filter(Boolean)
      const env: Record<string, string> = {}
      for (const line of mcpForm.env.split('\n')) {
        const t = line.trim()
        if (!t) continue
        const eq = t.indexOf('=')
        if (eq <= 0) continue
        env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
      }
      return {
        id, label, kind: 'stdio', command: mcpForm.command.trim(),
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      }
    }
    const url = mcpForm.url.trim()
    if (!url) { setMcpMsgTimed('HTTP 서버는 URL이 필요합니다.'); return null }
    try { new URL(url) } catch { setMcpMsgTimed('URL 형식이 올바르지 않습니다.'); return null }
    const hasToken = !!mcpForm.token.trim()
    return { id, label, kind: 'http', url, transport: mcpForm.transport, hasToken, authMode: hasToken ? 'token' : 'none' }
  }

  async function handleMcpUpsert() {
    if (!window.twixy?.mcpUpsert) return
    const def = buildMcpDef()
    if (!def) return
    setMcpBusy(true)
    setMcpMsg('저장 중 — 게이트웨이가 재시작됩니다…')
    try {
      const token = mcpForm.kind === 'http' ? mcpForm.token.trim() : undefined
      const r = await window.twixy.mcpUpsert(def, token || undefined)
      if (r.ok) {
        setMcpMsgTimed('✓ 저장됨 — 게이트웨이를 재시작했습니다.')
        resetMcpForm()
        await refreshMcpServers()
      } else {
        setMcpMsgTimed(`저장 실패: ${r.error ?? 'unknown'}`)
      }
    } finally { setMcpBusy(false) }
  }

  async function handleMcpRemove(id: string) {
    if (!window.twixy?.mcpRemove) return
    setMcpBusy(true)
    setMcpMsg('삭제 중 — 게이트웨이가 재시작됩니다…')
    try {
      const r = await window.twixy.mcpRemove(id)
      setMcpMsgTimed(r.ok ? '✓ 삭제됨 — 게이트웨이를 재시작했습니다.' : `삭제 실패: ${r.error ?? 'unknown'}`)
      await refreshMcpServers()
    } finally { setMcpBusy(false) }
  }

  // OAuth 연결(Phase 2). URL(+표시 이름)만 받아 main 에서 OAuth 디스커버리 →
  // (DCR 가능 시) 클라이언트 자동 등록 → 시스템 브라우저 로그인 → 토큰을 vault
  // 에 저장 → 게이트웨이 재시작. 브라우저에서 사용자가 로그인하는 동안 대기.
  async function handleMcpOAuthConnect() {
    if (!window.twixy?.mcpOAuthConnect) return
    const url = mcpForm.url.trim()
    if (!url) { setMcpMsgTimed('HTTP 서버는 URL이 필요합니다.'); return }
    try { new URL(url) } catch { setMcpMsgTimed('URL 형식이 올바르지 않습니다.'); return }
    setMcpBusy(true)
    setMcpMsg('브라우저에서 로그인하세요 — 연결을 기다리는 중…')
    try {
      const r = await window.twixy.mcpOAuthConnect({
        url,
        label: mcpForm.label.trim() || mcpForm.id.trim() || undefined,
        clientId: mcpForm.clientId.trim() || undefined,
      })
      if (r.ok) {
        setMcpMsgTimed('✓ 연결됨 — 게이트웨이를 재시작했습니다.')
        resetMcpForm()
        await refreshMcpServers()
      } else {
        setMcpMsgTimed(`연결 실패: ${r.error ?? 'unknown'}`)
      }
    } catch (e) {
      setMcpMsgTimed(`연결 실패: ${String(e)}`)
    } finally { setMcpBusy(false) }
  }

  function applyNotionPreset() {
    setMcpForm(f => ({
      ...f,
      kind: 'http',
      id: f.id.trim() || 'notion',
      label: f.label.trim() || 'Notion',
      url: 'https://mcp.notion.com/mcp',
      transport: 'streamable-http',
      // Notion 은 DCR 지원 — OAuth 한 번으로 연결.
      authMode: 'oauth',
    }))
  }

  function applyAtlassianPreset() {
    setMcpForm(f => ({
      ...f,
      kind: 'http',
      id: f.id.trim() || 'atlassian',
      label: f.label.trim() || 'Jira',
      // Atlassian 원격 MCP (Streamable HTTP, OAuth 2.1 + DCR). Jira/Confluence 도구 노출.
      url: 'https://mcp.atlassian.com/v1/mcp/authv2',
      transport: 'streamable-http',
      authMode: 'oauth',
    }))
  }

  function applySlackPreset() {
    setMcpForm(f => ({
      ...f,
      kind: 'http',
      id: f.id.trim() || 'slack',
      label: f.label.trim() || 'Slack',
      url: 'https://mcp.slack.com/mcp',
      transport: 'streamable-http',
      // Slack 은 DCR 미지원일 수 있어 client_id 입력이 필요할 수 있음.
      authMode: 'oauth',
    }))
  }

  // ── Google Workspace (Docs / Sheets) ─────────────────────────────
  // The user pastes a Desktop OAuth client (clientId + clientSecret) once,
  // then clicks Connect to walk through the browser sign-in. Tokens are
  // encrypted in <projectRoot>/.twixy/google-tokens.enc by main.
  type GoogleConnState = { connected: boolean; hasClient: boolean; email?: string | null; scopes?: string[] }
  const [gws, setGws] = useState<GoogleConnState>({ connected: false, hasClient: false })
  const [gwsClientId, setGwsClientId] = useState('')
  const [gwsClientSecret, setGwsClientSecret] = useState('')
  const [gwsBusy, setGwsBusy] = useState<'connect' | 'save-client' | 'clear-client' | 'disconnect' | null>(null)
  const [gwsMsg, setGwsMsg] = useState<string | null>(null)

  useEffect(() => { void refreshGws() }, [])

  async function refreshGws() {
    if (!window.twixy?.tools?.googleGetStatus) return
    try {
      const [s, c] = await Promise.all([
        window.twixy.tools.googleGetStatus(),
        window.twixy.tools.googleGetClient(),
      ])
      const connected = s.ok ? s.connected : false
      const email     = s.ok ? s.email : null
      const scopes    = s.ok ? s.scopes : []
      const hasClient = c.ok ? !!c.hasClient : false
      const cid       = c.ok && c.clientId ? c.clientId : ''
      setGws({ connected, hasClient, email, scopes })
      if (cid && !gwsClientId) setGwsClientId(cid)
    } catch { /* ignore */ }
  }

  async function handleGwsSaveClient() {
    if (!window.twixy?.tools?.googleSetClient) return
    if (!gwsClientId.trim() || !gwsClientSecret.trim()) {
      setGwsMsg('Both Client ID and Client Secret are required.')
      return
    }
    setGwsBusy('save-client'); setGwsMsg(null)
    try {
      const r = await window.twixy.tools.googleSetClient({ clientId: gwsClientId.trim(), clientSecret: gwsClientSecret.trim() })
      setGwsMsg(r.ok ? '✓ Client saved' : `Save failed: ${r.error ?? 'unknown'}`)
      if (r.ok) { setGwsClientSecret(''); await refreshGws() }
    } finally { setGwsBusy(null); setTimeout(() => setGwsMsg(null), 4000) }
  }

  async function handleGwsClearClient() {
    if (!window.twixy?.tools?.googleClearClient) return
    setGwsBusy('clear-client'); setGwsMsg(null)
    try {
      const r = await window.twixy.tools.googleClearClient()
      setGwsMsg(r.ok ? '✓ Client cleared' : `Clear failed: ${r.error ?? 'unknown'}`)
      setGwsClientId(''); setGwsClientSecret('')
      await refreshGws()
    } finally { setGwsBusy(null); setTimeout(() => setGwsMsg(null), 4000) }
  }

  async function handleGwsConnect() {
    if (!window.twixy?.tools?.googleConnect) return
    setGwsBusy('connect'); setGwsMsg('Browser opened — complete sign-in there.')
    try {
      const r = await window.twixy.tools.googleConnect()
      setGwsMsg(r.ok ? `✓ Connected as ${r.email ?? '(no email scope)'}` : `Connect failed: ${r.error ?? 'unknown'}`)
      await refreshGws()
    } finally { setGwsBusy(null); setTimeout(() => setGwsMsg(null), 5000) }
  }

  async function handleGwsDisconnect() {
    if (!window.twixy?.tools?.googleDisconnect) return
    setGwsBusy('disconnect'); setGwsMsg(null)
    try {
      const r = await window.twixy.tools.googleDisconnect()
      setGwsMsg(r.ok ? '✓ Disconnected' : `Disconnect failed: ${r.error ?? 'unknown'}`)
      await refreshGws()
    } finally { setGwsBusy(null); setTimeout(() => setGwsMsg(null), 4000) }
  }

  // Load Twixy mode (hosted vs BYOK)
  useEffect(() => {
    if (!window.twixy?.getTwixyMode) return
    window.twixy.getTwixyMode().then(m => setTwixyModeState(m ?? 'twixy'))
  }, [])

  async function handleTwixyModeChange(next: 'twixy' | 'byok') {
    if (next === twixyMode || twixyModeSwitching) return
    setTwixyModeSwitching(true)
    try {
      const res = await window.twixy.setTwixyMode(next)
      if (res.ok) setTwixyModeState(next)
    } finally {
      setTwixyModeSwitching(false)
    }
  }

  // Load existing keys on mount
  useEffect(() => {
    if (!window.twixy) return
    window.twixy.getAuthProfiles().then((profiles: Record<string, unknown> | null) => {
      if (!profiles) return
      const next = { anthropic: '', openai: '' }
      if (profiles['anthropic:default'] && typeof profiles['anthropic:default'] === 'object') {
        const p = profiles['anthropic:default'] as Record<string, unknown>
        if (typeof p.key === 'string') next.anthropic = p.key
      }
      if (profiles['openai:default'] && typeof profiles['openai:default'] === 'object') {
        const p = profiles['openai:default'] as Record<string, unknown>
        if (typeof p.key === 'string') next.openai = p.key
      }
      setKeys(next)
    })
    window.twixy.getAgentModel().then((model: string | null) => {
      // Ignore OAuth models — API key only
      if (model && !model.startsWith('openai-codex')) setActiveModel(model)
    })
    if (window.twixy.getSubagentModel) {
      window.twixy.getSubagentModel().then((m: string | null) => {
        if (m && !m.startsWith('openai-codex')) setSubagentModel(m)
      })
    }
  }, [])

  async function handleSaveSubagent(model: string) {
    setSubagentModel(model)
    if (!window.twixy?.saveSubagentModel) return
    setSubagentSaving(true)
    setSubagentSavedMsg(null)
    try {
      const res = await window.twixy.saveSubagentModel(model)
      setSubagentSavedMsg(res.ok ? '✓ Saved — restart Twixy to apply' : `Save failed: ${res.error ?? 'unknown'}`)
      setTimeout(() => setSubagentSavedMsg(null), 4000)
    } finally {
      setSubagentSaving(false)
    }
  }

  // Settings 탭이 실제로 보일 때만 사용량 조회 — 숨겨진 상태(시작 직후)에서
  // 콜드 게이트웨이를 때리지 않는다. 탭을 열면/refreshKey 가 바뀌면 조회.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setUsageLoading(true)
    fetchUsageCost().then((data: unknown) => {
      if (cancelled) return
      const d = data as { totals?: UsageTotals; byModel?: ByModelEntry[] } | null
      setUsage(d?.totals ?? null)
      setUsageByModel(d?.byModel ?? [])
      setUsageLoading(false)
    }).catch(() => { if (!cancelled) setUsageLoading(false) })
    return () => { cancelled = true }
  }, [visible, fetchUsageCost, usageRefreshKey])

  async function handleSave() {
    if (!window.twixy) return
    setSaving(true)
    try {
      await window.twixy.saveApiKeys({ keys, model: activeModel })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 13,
    padding: '8px 36px 8px 10px',
    outline: 'none',
    fontFamily: 'monospace',
    boxSizing: 'border-box',
  }

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      padding: '32px 40px',
      color: 'var(--text-primary)',
    }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600 }}>Settings</h2>
      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
        API keys are stored locally on your machine only.
      </p>
      {appVersion && (
        <p style={{ margin: '0 0 32px', fontSize: 12, color: 'var(--text-muted)' }}>
          Twixy v{appVersion}
        </p>
      )}

      {/* Appearance — 라이트(Paper/Petrol) / 다크(기존 다크 테마) / 시스템 */}
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Appearance
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          Light is the new paper theme; Dark keeps the classic look. System follows your OS.
        </p>
        <ThemeToggle />
      </section>

      {/* Guardrail — 파일쓰기/삭제·네트워크 Bash 승인 정책 (Admin 탭에서 이동). */}
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Guardrail
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          Approve or auto-allow file writes/edits and destructive or network shell commands.
        </p>
        <GuardrailSettings />
      </section>

      {/* Account */}
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Twixy Account
        </h3>

        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)',
          padding: '18px 22px',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>
          {/* Identity row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.email ?? '(no email)'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                {(user?.user_metadata?.full_name as string)
                  || (user?.user_metadata?.name as string)
                  || (user?.user_metadata?.user_name as string)
                  || (user?.user_metadata?.preferred_username as string)
                  || 'Signed in'}
                {user?.app_metadata?.provider ? ` · ${String(user.app_metadata.provider)}` : ''}
              </div>
              {/* 표시 이름 편집 — 팀 대시보드/활동피드/run 기록에 이 이름이 찍힌다. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void saveDisplayName() }}
                  placeholder="Display name"
                  style={{
                    background: 'var(--bg-input)', border: '1px solid var(--border-subtle)',
                    borderRadius: 6, padding: '5px 10px', fontSize: 12, color: 'var(--text-primary)',
                    outline: 'none', width: 200,
                  }}
                />
                <button
                  onClick={() => void saveDisplayName()}
                  disabled={nameBusy}
                  style={{
                    border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)',
                    color: 'var(--text-primary)', borderRadius: 6, padding: '5px 12px',
                    fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: nameBusy ? 0.6 : 1,
                  }}
                >
                  {nameBusy ? 'Saving…' : 'Save name'}
                </button>
                {nameMsg && (
                  <span style={{ fontSize: 11, color: nameMsg === 'Saved' ? 'var(--green, #0d5c50)' : 'var(--red)' }}>
                    {nameMsg}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Shown to teammates in the team dashboard, activity feed, and run history.
              </div>
            </div>
            <div style={{
              padding: '4px 10px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              background: ent.tier === 'pro' ? 'rgba(124,58,237,0.15)' : 'var(--bg-input)',
              color: ent.tier === 'pro' ? 'var(--accent)' : 'var(--text-muted)',
              border: ent.tier === 'pro' ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
              flexShrink: 0,
            }}>
              {ent.tier}
            </div>
          </div>

          {/* Usage bars */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
            <UsageBar
              label="Messages today"
              used={ent.usage.messages}
              limit={ent.limits.messagesPerDay}
            />
            {twixyMode === 'twixy' && (
              <UsageBar
                label="AI tokens today"
                used={ent.openRouterUsage.tokensIn + ent.openRouterUsage.tokensOut}
                limit={FREE_PLAN.tokensPerMonth}
                barPct={ent.openRouterUsage.usdToday > 0
                  ? Math.min(100, (ent.openRouterUsage.usdToday / FREE_PLAN.monthlyBudgetUsd) * 100)
                  : undefined}
              />
            )}
            <UsageBar
              label="Scheduled jobs"
              used={ent.usage.scheduledRuns}
              limit={ent.limits.scheduledJobs}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Resets in <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{resetLabel}</span>
              <span style={{ marginLeft: 6, opacity: 0.6 }}>(00:00 UTC)</span>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
            {ent.tier === 'free' && (
              <button
                onClick={() => window.twixy?.openExternal?.(PRODUCT.pricingUrl)}
                style={{
                  padding: '8px 18px',
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Upgrade to Pro
              </button>
            )}
            <button
              onClick={() => ent.refresh()}
              disabled={ent.loading}
              style={{
                padding: '8px 14px',
                background: 'transparent',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-muted)',
                fontSize: 12,
                cursor: ent.loading ? 'default' : 'pointer',
              }}
            >
              {ent.loading ? 'Refreshing…' : 'Refresh usage'}
            </button>
            <button
              onClick={async () => {
                if (signingOut) return
                setSigningOut(true)
                try { await signOut() } finally { setSigningOut(false) }
              }}
              disabled={signingOut}
              style={{
                marginLeft: 'auto',
                padding: '8px 14px',
                background: 'transparent',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--red, #b5482f)',
                fontSize: 12,
                cursor: signingOut ? 'default' : 'pointer',
              }}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </section>

      {/* LLM Mode (Twixy hosted vs BYOK) */}
      {SHOW_BYOK && (
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          LLM Mode
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          Twixy mode runs gpt-5.4-mini via OpenRouter — no API key needed, and client talks to OpenRouter directly so latency matches BYOK. Free gets a small daily budget; Pro raises it.
        </p>
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)',
          padding: '14px 18px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {(['twixy', 'byok'] as const).map(opt => (
            <label key={opt} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              cursor: twixyModeSwitching ? 'wait' : 'pointer', fontSize: 13,
              opacity: twixyModeSwitching ? 0.6 : 1,
            }}>
              <input
                type="radio"
                name="twixy-mode"
                checked={twixyMode === opt}
                disabled={twixyModeSwitching}
                onChange={() => handleTwixyModeChange(opt)}
                style={{ accentColor: 'var(--accent)', marginTop: 3 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {opt === 'twixy' ? 'Twixy hosted (recommended)' : 'Use my own API key'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {opt === 'twixy'
                    ? `gpt-5.4-mini via OpenRouter. ${ent.tier === 'pro' ? 'Pro: $5.00/day' : 'Free: $0.10/day'} budget, auto-resets at 00:00 UTC.`
                    : 'Bring your OpenAI or Anthropic key. Bypasses the Twixy budget and bills your provider directly.'}
                </div>
              </div>
            </label>
          ))}
          {/* Token usage is no longer tracked server-side in Twixy mode —
              OpenRouter enforces the daily USD budget on their end. To see
              exact spend, check the OpenRouter dashboard (key names are
              prefixed `twixy:<your-id-prefix>:<date>`). */}
        </div>
      </section>
      )}

      {/* API Keys */}
      {SHOW_BYOK && (
      <section style={{ marginBottom: 40, opacity: twixyMode === 'twixy' ? 0.45 : 1 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          API Keys {twixyMode === 'twixy' && <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0 }}>(disabled in Twixy mode)</span>}
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Dedupe by provider id so we don't show two API key cards for OpenAI
              just because PROVIDERS has separate entries for gpt-5.4 and gpt-5.4-mini. */}
          {PROVIDERS.filter((p, i, a) => a.findIndex(x => x.id === p.id) === i).map(p => (
            <div key={p.id} style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius)',
              padding: '16px 20px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{p.description}</div>
                </div>
                <a
                  href="#"
                  onClick={e => { e.preventDefault(); window.twixy?.openExternal(p.docsUrl) }}
                  style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}
                >
                  Get key ↗
                </a>
              </div>

              {/* 저장된 키는 마스크로만 온다 — 칸은 비우고 안내는 placeholder 로.
                  SecretInput 과 같은 규칙(위 컴포넌트 주석 참고). */}
              <div style={{ position: 'relative' }}>
                <input
                  type={show[p.id] && !isMaskedSecret(keys[p.id]) ? 'text' : 'password'}
                  value={isMaskedSecret(keys[p.id]) ? '' : keys[p.id]}
                  onChange={e => setKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
                  placeholder={isMaskedSecret(keys[p.id]) ? `Saved ${keys[p.id]} — type to replace` : p.placeholder}
                  style={inputStyle}
                  onFocus={e => (e.target as HTMLInputElement).style.borderColor = 'var(--accent)'}
                  onBlur={e => (e.target as HTMLInputElement).style.borderColor = 'var(--border-subtle)'}
                />
                <button
                  title={isMaskedSecret(keys[p.id]) ? 'Remove the saved key' : undefined}
                  onClick={() => isMaskedSecret(keys[p.id])
                    ? setKeys(prev => ({ ...prev, [p.id]: '' }))
                    : setShow(prev => ({ ...prev, [p.id]: !prev[p.id] }))}
                  style={{
                    position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', color: 'var(--text-muted)',
                    cursor: 'pointer', fontSize: 12, padding: 2,
                  }}
                >
                  {isMaskedSecret(keys[p.id]) ? 'clear' : show[p.id] ? '🙈' : '👁'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
      )}

      {/* Model Selection */}
      {SHOW_BYOK && (
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Active Main Model
        </h3>
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)',
          padding: '16px 20px',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PROVIDERS.map(p => (
              <label key={p.model} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                cursor: keys[p.id] ? 'pointer' : 'default', fontSize: 13,
                opacity: keys[p.id] ? 1 : 0.4,
              }}>
                <input
                  type="radio" name="model" value={p.model}
                  checked={activeModel === p.model}
                  onChange={() => setActiveModel(p.model)}
                  disabled={!keys[p.id]}
                  style={{ accentColor: 'var(--accent)' }}
                />
                <span>{p.name} · {p.model.split('/')[1]}</span>
                {!keys[p.id] && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(API key required)</span>
                )}
              </label>
            ))}
          </div>
        </div>
      </section>
      )}

      {/* Sub-Agent Model — used for delegated mechanical work */}
      {SHOW_BYOK && (
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Sub-Agent Model
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          Used for browser automation, file parsing, OCR, and other mechanical extraction work.
          Pick something cheap and high-throughput — quality of user-facing copy is unaffected.
        </p>
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)',
          padding: '16px 20px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <select
            value={subagentModel}
            onChange={e => handleSaveSubagent(e.target.value)}
            disabled={subagentSaving}
            style={{
              ...inputStyle,
              fontFamily: 'inherit',
              padding: '8px 10px',
              cursor: subagentSaving ? 'wait' : 'pointer',
            }}
          >
            <optgroup label="OpenAI">
              <option value="openai/gpt-5.4-mini">gpt-5.4-mini · cheap, fast, ~2M TPM (recommended)</option>
              <option value="openai/gpt-5.4-nano">gpt-5.4-nano · cheapest, ~4M TPM (very basic tasks only)</option>
              <option value="openai/gpt-5.4">gpt-5.4 · same as main (no savings)</option>
            </optgroup>
            <optgroup label="Anthropic">
              <option value="anthropic/claude-haiku-4-5">claude-haiku-4-5 · cheap, fast</option>
              <option value="anthropic/claude-sonnet-4-5">claude-sonnet-4-5 · same as main</option>
            </optgroup>
          </select>
          {subagentSavedMsg && (
            <div style={{ fontSize: 12, color: subagentSavedMsg.startsWith('✓') ? 'var(--accent)' : 'var(--text-muted)' }}>
              {subagentSavedMsg}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--text-secondary)' }}>Delegated tasks:</strong>{' '}
            browser snapshots/clicks · CSV/XLSX parsing · PDF extraction · long log filtering ·
            big directory listings · image OCR · bulk URL fetching.
            <br />
            <strong style={{ color: 'var(--text-secondary)' }}>Always on main model:</strong>{' '}
            copywriting · strategy · insight interpretation · user conversation · code authoring.
          </div>
        </div>
      </section>
      )}

      {/* Language Correction — Twixy mode only */}
      {twixyMode === 'twixy' && (
        <section style={{ marginBottom: 40 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
            Language Correction
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
            After each response, the sub-agent model scans for language mismatches and rewrites the reply in your language.
            Turn this on if your model occasionally hallucinates in the wrong language (e.g. Chinese characters leaking into English).
          </p>
          <div style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius)',
            padding: '16px 20px',
          }}>
            <ChannelHeader
              name="Auto-correct language"
              hint="Recommended when the agent mixes in Chinese, Japanese, or other unexpected languages mid-response."
              enabled={langCorrection}
              onToggle={v => {
                setLangCorrectionState(v)
                localStorage.setItem('twixy-lang-correction', String(v))
              }}
            />
          </div>
        </section>
      )}

      {/* Connections (연동) */}
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          연동 (Connections)
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          외부 서비스를 연결하면 에이전트가 해당 서비스로 작업을 내보낼 수 있습니다.
          토큰은 메인 프로세스에서 암호화되어 저장되며, 화면에는 연결 상태만 표시됩니다.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* ── Google ── */}
          {PRODUCT.features.googleWorkspace && (() => {
            const c = conns.find(x => x.service === 'google')
            const state = c?.state ?? 'disconnected'
            const busy = connBusy === 'google'
            const hint =
              state === 'connected'    ? `연결된 계정: ${c?.account ?? '(이메일 없음)'} — Docs · Sheets · Gmail 전송`
              : state === 'needs_reauth' ? `연결된 계정: ${c?.account ?? '(이메일 없음)'} — Gmail 전송 권한(gmail.send)이 없습니다. 권한을 갱신하세요.`
              : gws.hasClient ? 'Docs · Sheets · Gmail 전송. OAuth 클라이언트 저장됨 — 연결을 진행하세요.'
              : 'Docs · Sheets · Gmail 전송. 아래 Google Workspace 섹션에서 Client ID/Secret을 먼저 저장하세요.'
            return (
              <div style={channelCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Google</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>
                  </div>
                  <ConnBadge state={state} />
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                  {state === 'connected' && (
                    <button type="button" onClick={() => handleConnDisconnect('google')} disabled={busy} style={ghostBtnStyle}>
                      {busy ? '해제 중…' : '연결 해제'}
                    </button>
                  )}
                  {state === 'needs_reauth' && (
                    <>
                      <button type="button" onClick={() => handleConnConnect('google')} disabled={busy} style={primaryBtnStyle(busy)}>
                        {busy ? '브라우저 대기 중…' : '권한 갱신'}
                      </button>
                      <button type="button" onClick={() => handleConnDisconnect('google')} disabled={busy} style={ghostBtnStyle}>
                        연결 해제
                      </button>
                    </>
                  )}
                  {(state === 'disconnected' || state === 'coming_soon') && (
                    <button
                      type="button"
                      onClick={() => handleConnConnect('google')}
                      disabled={busy || !gws.hasClient}
                      style={primaryBtnStyle(busy)}
                      title={gws.hasClient ? '' : 'Client ID + Secret 을 먼저 저장하세요.'}
                    >
                      {busy ? '브라우저 대기 중…' : '연결'}
                    </button>
                  )}
                </div>
                {connMsg.google && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>{connMsg.google}</div>
                )}
              </div>
            )
          })()}

          {/* ── Discord ── */}
          {PRODUCT.features.channels && (() => {
            const c = conns.find(x => x.service === 'discord')
            const connected = !!c?.connected
            const busy = connBusy === 'discord'
            return (
              <div style={channelCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Discord</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {connected
                        ? `연결된 봇: ${c?.account ?? '(이름 없음)'}`
                        : '봇 토큰을 저장하면 이후 에이전트 도구가 사용합니다. 저장 시 Discord API로 유효성을 확인합니다.'}
                    </div>
                  </div>
                  <ConnBadge state={c?.state ?? 'disconnected'} />
                </div>
                <div style={channelBodyStyle}>
                  {!connected && (
                    <Field label="Bot Token">
                      <SecretInput
                        value={discordToken}
                        placeholder="MTAxN..."
                        show={!!showSecret.connDiscord}
                        onToggleShow={() => setShowSecret(s => ({ ...s, connDiscord: !s.connDiscord }))}
                        onChange={setDiscordToken}
                      />
                    </Field>
                  )}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {connected ? (
                      <button type="button" onClick={() => handleConnDisconnect('discord')} disabled={busy} style={ghostBtnStyle}>
                        {busy ? '해제 중…' : '연결 해제'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleConnSetToken('discord', discordToken)}
                        disabled={busy || !discordToken.trim()}
                        style={primaryBtnStyle(busy)}
                      >
                        {busy ? '검증 중…' : '토큰 저장'}
                      </button>
                    )}
                  </div>
                  {connMsg.discord && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{connMsg.discord}</div>
                  )}
                  {!connected && (
                    <HelpLink text="Discord 봇 만들기 (Developer Portal)" url="https://discord.com/developers/applications" />
                  )}
                </div>
              </div>
            )
          })()}

          {/* ── Notion / Slack / Kakao (준비 중) ── */}
          {PRODUCT.features.channels && ([
            { service: 'notion' as const, name: 'Notion', hint: '노션 페이지 읽기/쓰기 — 다음 단계(Notion MCP)에서 활성화됩니다.' },
            { service: 'slack'  as const, name: 'Slack',  hint: '채널 메시지 전송 — 다음 단계에서 활성화됩니다.' },
            { service: 'kakao'  as const, name: 'Kakao',  hint: '카카오톡 메시지 — 다음 단계에서 활성화됩니다.' },
          ]).map(meta => (
            <div key={meta.service} style={{ ...channelCardStyle, opacity: 0.7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{meta.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{meta.hint}</div>
                </div>
                <ConnBadge state="coming_soon" />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => setConnMsgFor(meta.service, '아직 준비 중입니다 — 다음 업데이트에서 연결할 수 있어요.')}
                  style={{ ...ghostBtnStyle, cursor: 'pointer', opacity: 0.8 }}
                >
                  연결
                </button>
                {connMsg[meta.service] && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{connMsg[meta.service]}</span>
                )}
              </div>
            </div>
          ))}

          {/* ── MCP 서버 (외부 MCP 서버를 도구로 연결) ── */}
          <div style={channelCardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>MCP 서버</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  외부 MCP 서버를 등록하면 해당 서버의 도구가 에이전트에 자동 노출됩니다
                  (<code>{'<서버명>__<도구명>'}</code>). 저장/삭제 시 게이트웨이가 재시작됩니다.
                </div>
              </div>
            </div>

            <div style={channelBodyStyle}>
              {/* 등록된 서버 목록 */}
              {mcpServers.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>등록된 MCP 서버가 없습니다.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {mcpServers.map(s => (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                        padding: '8px 10px', borderRadius: 8, background: 'var(--bg-input)',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>
                          {s.label} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({s.id})</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.kind === 'stdio'
                            ? `stdio · ${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}`
                            : `${s.transport} · ${s.url}${s.authMode === 'oauth' ? ' · 🔓 OAuth 연결됨' : s.hasToken ? ' · 🔑' : ''}`}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleMcpRemove(s.id)}
                        disabled={mcpBusy}
                        style={ghostBtnStyle}
                      >
                        삭제
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 서버 추가 폼 */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>서버 추가</div>

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="radio" name="mcp-kind" checked={mcpForm.kind === 'http'}
                      onChange={() => setMcpForm(f => ({ ...f, kind: 'http' }))}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    HTTP (원격)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="radio" name="mcp-kind" checked={mcpForm.kind === 'stdio'}
                      onChange={() => setMcpForm(f => ({ ...f, kind: 'stdio' }))}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    stdio (로컬 프로세스)
                  </label>
                </div>

                <Field label="서버 ID (영문/숫자/_ — 도구 접두사로 쓰임)">
                  <input
                    type="text" value={mcpForm.id} placeholder="notion"
                    onChange={e => setMcpForm(f => ({ ...f, id: e.target.value }))}
                    style={textInputStyle}
                  />
                </Field>
                <Field label="표시 이름 (선택)">
                  <input
                    type="text" value={mcpForm.label} placeholder="Notion"
                    onChange={e => setMcpForm(f => ({ ...f, label: e.target.value }))}
                    style={textInputStyle}
                  />
                </Field>

                {mcpForm.kind === 'stdio' ? (
                  <>
                    <Field label="실행 명령 (command)">
                      <input
                        type="text" value={mcpForm.command} placeholder="npx"
                        onChange={e => setMcpForm(f => ({ ...f, command: e.target.value }))}
                        style={textInputStyle}
                      />
                    </Field>
                    <Field label="인자 (args, 한 줄에 하나)">
                      <textarea
                        value={mcpForm.args} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path'}
                        onChange={e => setMcpForm(f => ({ ...f, args: e.target.value }))}
                        rows={3} style={{ ...textInputStyle, resize: 'vertical', fontFamily: 'monospace' }}
                      />
                    </Field>
                    <Field label="환경변수 (env, KEY=VALUE 한 줄에 하나)">
                      <textarea
                        value={mcpForm.env} placeholder={'API_KEY=...'}
                        onChange={e => setMcpForm(f => ({ ...f, env: e.target.value }))}
                        rows={2} style={{ ...textInputStyle, resize: 'vertical', fontFamily: 'monospace' }}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button type="button" onClick={applyNotionPreset} style={{ ...ghostBtnStyle, cursor: 'pointer' }}>
                        Notion 프리셋
                      </button>
                      <button type="button" onClick={applyAtlassianPreset} style={{ ...ghostBtnStyle, cursor: 'pointer' }}>
                        Jira 프리셋
                      </button>
                      <button type="button" onClick={applySlackPreset} style={{ ...ghostBtnStyle, cursor: 'pointer' }}>
                        Slack 프리셋
                      </button>
                    </div>

                    {/* 인증 방식 선택 — OAuth(권장) vs 토큰 직접 입력 */}
                    <Field label="인증 방식">
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                          <input
                            type="radio" name="mcp-auth" checked={mcpForm.authMode === 'oauth'}
                            onChange={() => setMcpForm(f => ({ ...f, authMode: 'oauth' }))}
                            style={{ accentColor: 'var(--accent)' }}
                          />
                          OAuth로 연결 (권장)
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                          <input
                            type="radio" name="mcp-auth" checked={mcpForm.authMode === 'token'}
                            onChange={() => setMcpForm(f => ({ ...f, authMode: 'token' }))}
                            style={{ accentColor: 'var(--accent)' }}
                          />
                          토큰 직접 입력
                        </label>
                      </div>
                    </Field>

                    <Field label="URL">
                      <input
                        type="text" value={mcpForm.url} placeholder="https://mcp.notion.com/mcp"
                        onChange={e => setMcpForm(f => ({ ...f, url: e.target.value }))}
                        style={textInputStyle}
                      />
                    </Field>

                    {mcpForm.authMode === 'oauth' ? (
                      <>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          "연결"을 누르면 시스템 브라우저가 열립니다. 로그인 후 창을 닫고 돌아오면 토큰이
                          안전하게 저장됩니다.
                        </div>
                        <details style={{ fontSize: 11 }}>
                          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
                            client_id 직접 입력 (자동 등록 미지원 서버용 — 예: Slack)
                          </summary>
                          <div style={{ marginTop: 8 }}>
                            <Field label="client_id (선택)">
                              <input
                                type="text" value={mcpForm.clientId} placeholder="자동 등록되면 비워두세요"
                                onChange={e => setMcpForm(f => ({ ...f, clientId: e.target.value }))}
                                style={textInputStyle}
                              />
                            </Field>
                          </div>
                        </details>
                      </>
                    ) : (
                      <>
                        <Field label="전송 방식 (transport)">
                          <select
                            value={mcpForm.transport}
                            onChange={e => setMcpForm(f => ({ ...f, transport: e.target.value as 'sse' | 'streamable-http' }))}
                            style={textInputStyle}
                          >
                            <option value="streamable-http">streamable-http (최신 원격 서버 권장)</option>
                            <option value="sse">sse</option>
                          </select>
                        </Field>
                        <Field label="Bearer 토큰">
                          <SecretInput
                            value={mcpForm.token}
                            placeholder="ntn_..."
                            show={!!showSecret.mcpToken}
                            onToggleShow={() => setShowSecret(s => ({ ...s, mcpToken: !s.mcpToken }))}
                            onChange={v => setMcpForm(f => ({ ...f, token: v }))}
                          />
                        </Field>
                      </>
                    )}
                  </>
                )}

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {mcpForm.kind === 'http' && mcpForm.authMode === 'oauth' ? (
                    <button
                      type="button"
                      onClick={handleMcpOAuthConnect}
                      disabled={mcpBusy}
                      style={primaryBtnStyle(mcpBusy)}
                    >
                      {mcpBusy ? '연결 중…' : '연결'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleMcpUpsert}
                      disabled={mcpBusy}
                      style={primaryBtnStyle(mcpBusy)}
                    >
                      {mcpBusy ? '저장 중…' : '서버 추가 / 저장'}
                    </button>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    저장 시 게이트웨이가 재시작됩니다 (진행 중 세션이 중단될 수 있어요).
                  </span>
                </div>
                {mcpMsg && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{mcpMsg}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Google Workspace */}
      {PRODUCT.features.googleWorkspace && (
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Google Workspace
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          Read and write Google Docs and Sheets. Paste a Desktop OAuth client (Client ID + Secret) once, then sign in. Tokens are encrypted at rest.
        </p>

        <div style={channelCardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                Google Docs · Sheets
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                {gws.connected
                  ? `Connected as ${gws.email ?? '(no email)'}`
                  : gws.hasClient
                    ? 'OAuth client saved — click Connect to sign in.'
                    : 'No OAuth client saved yet.'}
              </div>
              {gws.connected && gws.scopes && gws.scopes.length > 0 && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace', opacity: 0.7 }}>
                  scopes: {gws.scopes.map(s => s.split('/').pop()).join(', ')}
                </div>
              )}
            </div>
            <span style={{
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 999,
              background: gws.connected ? 'var(--accent)' : 'var(--bg-input)',
              color: gws.connected ? '#fff' : 'var(--text-muted)',
            }}>
              {gws.connected ? 'connected' : 'disconnected'}
            </span>
          </div>

          <div style={channelBodyStyle}>
            <Field label="Client ID">
              <input
                type="text"
                value={gwsClientId}
                placeholder="123456-abc.apps.googleusercontent.com"
                onChange={e => setGwsClientId(e.target.value)}
                style={textInputStyle}
              />
            </Field>
            <Field label="Client Secret">
              <SecretInput
                value={gwsClientSecret}
                placeholder={gws.hasClient ? '•••••••••• (saved — paste again to replace)' : 'GOCSPX-...'}
                show={!!showSecret.gwsClient}
                onToggleShow={() => setShowSecret(s => ({ ...s, gwsClient: !s.gwsClient }))}
                onChange={setGwsClientSecret}
              />
            </Field>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <button
                type="button"
                onClick={handleGwsSaveClient}
                disabled={gwsBusy !== null}
                style={primaryBtnStyle(gwsBusy === 'save-client')}
              >
                {gwsBusy === 'save-client' ? 'Saving…' : 'Save Client'}
              </button>
              {gws.hasClient && (
                <button
                  type="button"
                  onClick={handleGwsClearClient}
                  disabled={gwsBusy !== null}
                  style={ghostBtnStyle}
                >
                  {gwsBusy === 'clear-client' ? 'Clearing…' : 'Clear Client'}
                </button>
              )}
              {!gws.connected ? (
                <button
                  type="button"
                  onClick={handleGwsConnect}
                  disabled={gwsBusy !== null || !gws.hasClient}
                  style={primaryBtnStyle(gwsBusy === 'connect')}
                  title={gws.hasClient ? '' : 'Save a Client ID + Secret first.'}
                >
                  {gwsBusy === 'connect' ? 'Waiting for browser…' : 'Connect'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleGwsDisconnect}
                  disabled={gwsBusy !== null}
                  style={ghostBtnStyle}
                >
                  {gwsBusy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              )}
            </div>

            {gwsMsg && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {gwsMsg}
              </div>
            )}

            <HelpLink
              text="Create a Desktop OAuth client (Google Cloud Console)"
              url="https://console.cloud.google.com/apis/credentials"
            />
          </div>
        </div>
      </section>
      )}

      {/* Mobile Channels */}
      {PRODUCT.features.channels && (
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Mobile Channels — Beta
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          Talk to Twixy from your phone via OpenClaw channels. Saving restarts the gateway.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* ── Telegram ── */}
          {(() => {
            const ch = channels.telegram ?? { enabled: false }
            const open = ch.enabled
            return (
              <div style={channelCardStyle}>
                <ChannelHeader
                  name="Telegram"
                  hint="BotFather token. Easiest setup; works on iOS + Android."
                  enabled={!!ch.enabled}
                  onToggle={v => patchChannel('telegram', { enabled: v })}
                />
                {open && (
                  <div style={channelBodyStyle}>
                    <Field label="Bot Token">
                      <SecretInput
                        value={ch.botToken ?? ''}
                        placeholder="123456789:ABCdef..."
                        show={!!showSecret.telegram}
                        onToggleShow={() => setShowSecret(s => ({ ...s, telegram: !s.telegram }))}
                        onChange={v => patchChannel('telegram', { botToken: v })}
                      />
                    </Field>
                    <Field label="DM Policy">
                      <select
                        value={ch.dmPolicy ?? 'allowlist'}
                        onChange={e => patchChannel('telegram', { dmPolicy: e.target.value as 'pairing' | 'allowlist' | 'open' })}
                        style={selectStyle}
                      >
                        <option value="allowlist">allowlist (recommended)</option>
                        <option value="pairing">pairing</option>
                        <option value="open">open (any user)</option>
                      </select>
                    </Field>
                    <Field label="Allowed user IDs (comma-separated)">
                      <input
                        type="text"
                        value={(ch.allowFrom ?? []).join(', ')}
                        placeholder="8734062810, 1234567890"
                        onChange={e => patchChannel('telegram', { allowFrom: parseList(e.target.value) })}
                        style={textInputStyle}
                      />
                    </Field>
                    <HelpLink text="How to get your Telegram user ID" url="https://core.telegram.org/bots/api#getupdates" />
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Discord ── */}
          {(() => {
            const ch = channels.discord ?? { enabled: false }
            const open = ch.enabled
            return (
              <div style={channelCardStyle}>
                <ChannelHeader
                  name="Discord"
                  hint="Discord bot token from the Developer Portal."
                  enabled={!!ch.enabled}
                  onToggle={v => patchChannel('discord', { enabled: v })}
                />
                {open && (
                  <div style={channelBodyStyle}>
                    <Field label="Bot Token">
                      <SecretInput
                        value={ch.token ?? ''}
                        placeholder="MTAxN..."
                        show={!!showSecret.discord}
                        onToggleShow={() => setShowSecret(s => ({ ...s, discord: !s.discord }))}
                        onChange={v => patchChannel('discord', { token: v })}
                      />
                    </Field>
                    <HelpLink text="Create a Discord bot" url="https://discord.com/developers/applications" />
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Slack ── */}
          {(() => {
            const ch = channels.slack ?? { enabled: false }
            const open = ch.enabled
            return (
              <div style={channelCardStyle}>
                <ChannelHeader
                  name="Slack"
                  hint="Socket Mode · Bot Token(xoxb-) + App Token(xapp-) 필요"
                  enabled={!!ch.enabled}
                  onToggle={v => patchChannel('slack', { enabled: v })}
                />
                {open && (
                  <div style={channelBodyStyle}>
                    <Field label="Bot Token">
                      <SecretInput
                        value={ch.botToken ?? ''}
                        placeholder="xoxb-..."
                        show={!!showSecret.slackBot}
                        onToggleShow={() => setShowSecret(s => ({ ...s, slackBot: !s.slackBot }))}
                        onChange={v => patchChannel('slack', { botToken: v })}
                      />
                    </Field>
                    <Field label="App Token">
                      <SecretInput
                        value={ch.appToken ?? ''}
                        placeholder="xapp-..."
                        show={!!showSecret.slackApp}
                        onToggleShow={() => setShowSecret(s => ({ ...s, slackApp: !s.slackApp }))}
                        onChange={v => patchChannel('slack', { appToken: v })}
                      />
                    </Field>
                    <Field label="DM Policy">
                      <select
                        value={ch.dmPolicy ?? 'allowlist'}
                        onChange={e => patchChannel('slack', { dmPolicy: e.target.value as 'pairing' | 'allowlist' | 'open' })}
                        style={selectStyle}
                      >
                        <option value="allowlist">allowlist (recommended)</option>
                        <option value="pairing">pairing</option>
                        <option value="open">open (any user)</option>
                      </select>
                    </Field>
                    <Field label="Allowed user IDs (comma-separated)">
                      <input
                        type="text"
                        value={(ch.allowFrom ?? []).join(', ')}
                        placeholder="U01ABCDEF, U02GHIJKL"
                        onChange={e => patchChannel('slack', { allowFrom: parseList(e.target.value) })}
                        style={textInputStyle}
                      />
                    </Field>
                    <HelpLink text="Slack 앱 만들기 (Socket Mode 활성화 + 토큰 발급)" url="https://api.slack.com/apps" />
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Signal ── */}
          {(() => {
            const ch = channels.signal ?? { enabled: false }
            const open = ch.enabled
            return (
              <div style={channelCardStyle}>
                <ChannelHeader
                  name="Signal"
                  hint="Requires signal-cli installed locally and a linked bot account."
                  enabled={!!ch.enabled}
                  onToggle={v => patchChannel('signal', { enabled: v })}
                />
                {open && (
                  <div style={channelBodyStyle}>
                    <Field label="Bot phone number (E.164)">
                      <input
                        type="text"
                        value={ch.account ?? ''}
                        placeholder="+15551234567"
                        onChange={e => patchChannel('signal', { account: e.target.value.trim() })}
                        style={textInputStyle}
                      />
                    </Field>
                    <Field label="signal-cli path">
                      <input
                        type="text"
                        value={ch.cliPath ?? ''}
                        placeholder="signal-cli"
                        onChange={e => patchChannel('signal', { cliPath: e.target.value.trim() })}
                        style={textInputStyle}
                      />
                    </Field>
                    <Field label="Allowed numbers (comma-separated)">
                      <input
                        type="text"
                        value={(ch.allowFrom ?? []).join(', ')}
                        placeholder="+15557654321"
                        onChange={e => patchChannel('signal', { allowFrom: parseList(e.target.value) })}
                        style={textInputStyle}
                      />
                    </Field>
                    <HelpLink text="signal-cli install + link guide" url="https://github.com/AsamK/signal-cli" />
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── BlueBubbles (iMessage) ── */}
          {(() => {
            const ch = channels.bluebubbles ?? { enabled: false }
            const open = ch.enabled
            return (
              <div style={channelCardStyle}>
                <ChannelHeader
                  name="iMessage (BlueBubbles)"
                  hint="Requires the BlueBubbles server running on this Mac."
                  enabled={!!ch.enabled}
                  onToggle={v => patchChannel('bluebubbles', { enabled: v })}
                />
                {open && (
                  <div style={channelBodyStyle}>
                    <Field label="Server URL">
                      <input
                        type="text"
                        value={ch.serverUrl ?? ''}
                        placeholder="http://192.168.1.100:1234"
                        onChange={e => patchChannel('bluebubbles', { serverUrl: e.target.value.trim() })}
                        style={textInputStyle}
                      />
                    </Field>
                    <Field label="Webhook password">
                      <SecretInput
                        value={ch.password ?? ''}
                        placeholder="example-password"
                        show={!!showSecret.bluebubbles}
                        onToggleShow={() => setShowSecret(s => ({ ...s, bluebubbles: !s.bluebubbles }))}
                        onChange={v => patchChannel('bluebubbles', { password: v })}
                      />
                    </Field>
                    <Field label="Webhook path">
                      <input
                        type="text"
                        value={ch.webhookPath ?? ''}
                        placeholder="/bluebubbles-webhook"
                        onChange={e => patchChannel('bluebubbles', { webhookPath: e.target.value.trim() })}
                        style={textInputStyle}
                      />
                    </Field>
                    <HelpLink text="BlueBubbles install" url="https://bluebubbles.app/install" />
                  </div>
                )}
              </div>
            )
          })()}
        </div>

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSaveChannels}
            disabled={channelsSaving}
            style={{
              padding: '8px 20px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              fontWeight: 600,
              cursor: channelsSaving ? 'not-allowed' : 'pointer',
              opacity: channelsSaving ? 0.7 : 1,
            }}
          >
            {channelsSaving ? 'Saving & restarting…' : 'Save channels'}
          </button>
          {channelsSavedMsg && (
            <span style={{ fontSize: 12, color: channelsSavedMsg.startsWith('✓') ? 'var(--accent)' : 'var(--red, #b5482f)' }}>
              {channelsSavedMsg}
            </span>
          )}
        </div>
      </section>
      )}

      {/* Designated Paths — workspace bucket whitelist */}
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Designated Paths
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          Workspace-relative folders the agent is allowed to write files into. Anything outside this list is hard-blocked (write/edit/PDF/XLSX/PPTX) — the agent gets an error and retries with a corrected path. Saving restarts the gateway.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, var(--text-primary))', marginBottom: 6 }}>
              Allowed roots
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
              One per line. Workspace-relative (e.g. <code>data/raw</code>). No leading slash, no <code>..</code>.
            </div>
            <textarea
              value={dpRootsText}
              onChange={e => {
                const next = e.target.value
                setDpRootsText(next)
                // Preserve existing subdir entries; drop those whose root was removed.
                const liveRoots = new Set(dpParseRootsText(next))
                setDpSubdirsByRoot(prev => {
                  const out: Record<string, string> = {}
                  for (const r of liveRoots) out[r] = prev[r] ?? ''
                  return out
                })
              }}
              rows={Math.max(6, dpRootsText.split('\n').length + 1)}
              placeholder={'data/raw\ndata/insights\nstrategies\ncontent/drafts\ncontent/published\ndata/reports'}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                fontFamily: 'monospace',
                fontSize: 12,
                color: 'var(--text-primary)',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, var(--text-primary))', marginBottom: 6 }}>
              Allowed subdirectories per root
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              Comma-separated subfolder names allowed under each root. Files at
              <code> &lt;root&gt;/&lt;subdir&gt;/&lt;file&gt;</code> pass; deeper nesting is blocked.
              Leave empty to allow only direct children of that root.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {dpParseRootsText(dpRootsText).map(root => (
                <div key={root} style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 10, alignItems: 'center' }}>
                  <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary, var(--text-primary))' }}>{root}</div>
                  <input
                    type="text"
                    value={dpSubdirsByRoot[root] ?? ''}
                    placeholder={root === 'data/raw' ? 'instagram, youtube, tiktok, twitter' : '(none)'}
                    onChange={e => setDpSubdirsByRoot(prev => ({ ...prev, [root]: e.target.value }))}
                    style={textInputStyle}
                  />
                </div>
              ))}
              {dpParseRootsText(dpRootsText).length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Add at least one root above to configure its subdirectories.
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSaveDesignatedPaths}
            disabled={dpSaving}
            style={{
              padding: '8px 20px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              fontWeight: 600,
              cursor: dpSaving ? 'not-allowed' : 'pointer',
              opacity: dpSaving ? 0.7 : 1,
            }}
          >
            {dpSaving ? 'Saving & restarting…' : 'Save designated paths'}
          </button>
          {dpSavedMsg && (
            <span style={{ fontSize: 12, color: dpSavedMsg.startsWith('✓') ? 'var(--accent)' : 'var(--red, #b5482f)' }}>
              {dpSavedMsg}
            </span>
          )}
        </div>
      </section>

      {/* 예약 작업 (Scheduled Tasks, OpenClaw cron) */}
      {PRODUCT.features.cron && (
      <section style={{ marginBottom: 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
            예약 작업 (Scheduled Tasks)
          </h3>
          <button
            onClick={() => void loadCronJobs()}
            disabled={cronLoading}
            style={{ background: 'none', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', fontSize: 11, padding: '2px 8px', cursor: cronLoading ? 'not-allowed' : 'pointer' }}
          >↻ 새로고침</button>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          정해진 시각/주기에 에이전트가 작업을 수행하고 결과를 메인 채팅에 남깁니다.
        </p>

        {/* 앱 켜져 있어야 동작 경고 박스 (guardrail/designated 경고 톤) */}
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid #f59e0b55',
          borderLeft: '3px solid #f59e0b',
          borderRadius: 'var(--radius-sm)',
          padding: '10px 12px',
          marginBottom: 16,
          fontSize: 12,
          color: 'var(--text-secondary, var(--text-primary))',
          lineHeight: 1.5,
        }}>
          ⚠ 예약 작업은 <strong>Twixy가 실행 중일 때만</strong> 동작합니다. 스케줄러는 앱 내부의 로컬 게이트웨이에서 돌아가므로, 앱을 종료하면 예약된 작업도 멈춥니다.
        </div>

        {/* 잡 리스트 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {cronLoading && cronJobs.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>불러오는 중…</div>
          )}
          {!cronLoading && cronJobs.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>등록된 예약 작업이 없습니다.</div>
          )}
          {cronJobs.map(job => {
            const enabled = job.enabled !== false
            const busy = cronBusyId === job.id
            const last = job.lastRunAt
              ? new Date(typeof job.lastRunAt === 'number' ? job.lastRunAt : Date.parse(String(job.lastRunAt))).toLocaleString()
              : '없음'
            return (
              <div key={job.id} style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                opacity: enabled ? 1 : 0.55,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {job.name || '(이름 없음)'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {cronScheduleLabel(job)} · 마지막 실행: {last}
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: busy ? 'not-allowed' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy}
                    onChange={() => void handleCronToggle(job.id, enabled)}
                  />
                  {enabled ? '활성' : '비활성'}
                </label>
                <button onClick={() => void handleCronRun(job.id)} disabled={busy} style={ghostBtnStyle}>지금 실행</button>
                <button onClick={() => void handleCronRemove(job.id)} disabled={busy} style={{ ...ghostBtnStyle, color: 'var(--red, #ef4444)' }}>삭제</button>
              </div>
            )
          })}
        </div>

        {/* 추가 폼 */}
        <div style={{ ...channelCardStyle, ...channelBodyStyle }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>새 예약 작업</div>
          <Field label="이름">
            <input type="text" value={cronName} onChange={e => setCronName(e.target.value)} placeholder="예: 매일 아침 인스타 인사이트 요약" style={textInputStyle} />
          </Field>
          <Field label="스케줄">
            <select value={cronPreset} onChange={e => setCronPreset(e.target.value as typeof cronPreset)} style={selectStyle}>
              <option value="daily9">매일 09:00</option>
              <option value="weeklyMon9">매주 월요일 09:00</option>
              <option value="hourly">매시간 정각</option>
              <option value="custom">직접 입력 (cron 식)</option>
            </select>
          </Field>
          {cronPreset === 'custom' && (
            <Field label="cron 식">
              <input
                type="text"
                value={cronCustomExpr}
                onChange={e => setCronCustomExpr(e.target.value)}
                placeholder="0 9 * * *  (분 시 일 월 요일)"
                style={{ ...textInputStyle, fontFamily: 'monospace' }}
              />
            </Field>
          )}
          <Field label="수행할 작업">
            <textarea
              value={cronPrompt}
              onChange={e => setCronPrompt(e.target.value)}
              rows={3}
              placeholder="에이전트가 무엇을 하면 되는지 적어주세요. 예: data/raw 의 최신 인스타 데이터를 분석해 요약 리포트를 만들어줘."
              style={{ ...textInputStyle, resize: 'vertical' }}
            />
          </Field>
          <Field label="결과 전달">
            <select value={cronDelivery} onChange={e => setCronDelivery(e.target.value as typeof cronDelivery)} style={selectStyle}>
              <option value="in-app">앱 내 표시 (메인 채팅)</option>
              {channels.telegram?.enabled && <option value="channel">채널로 전송 (Telegram)</option>}
            </select>
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => void handleAddCron()} disabled={cronAdding} style={primaryBtnStyle(cronAdding)}>
              {cronAdding ? '추가 중…' : '예약 작업 추가'}
            </button>
            {cronMsg && (
              <span style={{ fontSize: 12, color: cronMsg.startsWith('✓') ? '#22c55e' : 'var(--red, #ef4444)' }}>
                {cronMsg}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            추가 후 <strong>지금 실행</strong>으로 동작을 바로 테스트해볼 수 있습니다.
          </div>
        </div>
      </section>
      )}

      {/* 장기 기억 (Memory) */}
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          장기 기억 (Memory)
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          에이전트가 매 세션 시작 시 읽는 <code>MEMORY.md</code> 입니다. 사용자 선호·진행 중 작업·참고 사항을 직접 적어두면 다음 대화에 반영됩니다. 날짜별 메모는 아래 일일 노트로 쌓입니다.
        </p>

        <textarea
          value={memoryText}
          onChange={e => setMemoryText(e.target.value)}
          rows={14}
          placeholder={'# 장기 기억 (Long-term Memory)\n\n## 사용자 선호\n\n## 진행 중 작업\n\n## 참고\n'}
          style={{
            width: '100%',
            padding: '10px 12px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'monospace',
            fontSize: 12,
            color: 'var(--text-primary)',
            resize: 'vertical',
            boxSizing: 'border-box',
            lineHeight: 1.6,
          }}
        />

        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={async () => {
              if (!window.twixy?.memoryWrite) return
              setMemorySaving(true)
              setMemorySavedMsg(null)
              try {
                const r = await window.twixy.memoryWrite(memoryText)
                setMemorySavedMsg(r?.ok ? '✓ 저장됨' : `⚠ 저장 실패${r?.error ? `: ${r.error}` : ''}`)
              } catch (err) {
                setMemorySavedMsg(`⚠ 저장 실패: ${err instanceof Error ? err.message : String(err)}`)
              } finally {
                setMemorySaving(false)
              }
            }}
            disabled={memorySaving}
            style={{
              padding: '8px 20px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              fontWeight: 600,
              cursor: memorySaving ? 'not-allowed' : 'pointer',
              opacity: memorySaving ? 0.7 : 1,
            }}
          >
            {memorySaving ? 'Saving…' : 'MEMORY.md 저장'}
          </button>
          {memorySavedMsg && (
            <span style={{ fontSize: 12, color: memorySavedMsg.startsWith('✓') ? '#22c55e' : 'var(--red, #ef4444)' }}>
              {memorySavedMsg}
            </span>
          )}
        </div>

        {/* 일일 노트(memory/*.md) — 읽기 전용 뷰어 */}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, var(--text-primary))', marginBottom: 8 }}>
            일일 노트 ({memoryNotes.length})
          </div>
          {memoryNotes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>아직 저장된 일일 노트가 없습니다.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {memoryNotes.map(note => {
                const active = memoryNoteOpen === note.name
                return (
                  <button
                    key={note.name}
                    onClick={async () => {
                      if (active) { setMemoryNoteOpen(null); setMemoryNoteContent(''); return }
                      if (!window.twixy?.memoryReadNote) return
                      const r = await window.twixy.memoryReadNote(note.name)
                      setMemoryNoteOpen(note.name)
                      setMemoryNoteContent(r?.ok ? (r.content ?? '') : `⚠ 읽기 실패${r?.error ? `: ${r.error}` : ''}`)
                    }}
                    style={{
                      padding: '4px 10px',
                      background: active ? 'var(--accent)' : 'var(--bg-input)',
                      color: active ? '#fff' : 'var(--text-muted)',
                      border: active ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      fontFamily: 'monospace',
                      cursor: 'pointer',
                    }}
                  >
                    {note.name}
                  </button>
                )
              })}
            </div>
          )}
          {memoryNoteOpen && (
            <pre style={{
              marginTop: 10,
              padding: '10px 12px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'monospace',
              fontSize: 12,
              color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 320,
              overflowY: 'auto',
              lineHeight: 1.6,
            }}>
              {memoryNoteContent}
            </pre>
          )}
        </div>
      </section>

      {/* Token Usage */}
      <section style={{ marginBottom: 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
            Token Usage
          </h3>
          <button onClick={() => { setUsageLoading(true); fetchUsageCost().then((data: unknown) => { const d = data as { totals?: UsageTotals; byModel?: ByModelEntry[] } | null; setUsage(d?.totals ?? null); setUsageByModel(d?.byModel ?? []); setUsageLoading(false) }) }} style={{ background: 'none', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>↻ Refresh</button>
        </div>
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)',
          padding: '16px 20px',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr 1fr',
          gap: 16,
          opacity: usageLoading ? 0.5 : 1,
          transition: 'opacity 0.2s',
        }}>
          {usage ? (
            <>
              {[
                { label: 'Input',       value: fmt(usage.input)       },
                { label: 'Output',      value: fmt(usage.output)      },
                { label: 'Total',       value: fmt(usage.totalTokens) },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 18, fontWeight: 600, fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                    {value}
                  </div>
                </div>
              ))}
              {/* Cost — DisplayCost 가 markup IPC + loading/error 상태 자동 처리. */}
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Cost</div>
                <div style={{ fontSize: 18, fontWeight: 600, fontFamily: 'monospace', color: 'var(--accent)' }}>
                  <DisplayCost rawUsd={usage.totalCost} showZero />
                </div>
              </div>
              {(usage.cacheRead > 0 || usage.cacheWrite > 0) && (
                <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-muted)' }}>
                  Cache read: {fmt(usage.cacheRead)} · Cache write: {fmt(usage.cacheWrite)}
                </div>
              )}
              {usageByModel.length > 0 && (
                <div style={{ gridColumn: '1 / -1', marginTop: 8 }}>
                  <UsagePieByModel entries={usageByModel} />
                </div>
              )}
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {(() => {
                    const ts = localStorage.getItem('twixy-tracking-start')
                    return ts ? `Tracked since ${new Date(Number(ts)).toLocaleString()}` : ''
                  })()}
                </span>
                <button onClick={async () => {
                  await resetUsageBaseline()
                  setUsage(null)
                }} style={{
                  background: 'none', border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)',
                  fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                }}>Reset tracking</button>
              </div>
            </>
          ) : (
            <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--text-muted)' }}>
              {usageLoading ? 'Loading…' : 'No usage data yet.'}
            </div>
          )}
        </div>
      </section>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          padding: '10px 28px',
          background: saved ? '#0d5c5022' : 'var(--accent)',
          color: saved ? 'var(--accent)' : '#fff',
          border: saved ? '1px solid #0d5c5044' : 'none',
          borderRadius: 'var(--radius-sm)',
          fontSize: 13,
          fontWeight: 600,
          cursor: saving ? 'not-allowed' : 'pointer',
          opacity: saving ? 0.7 : 1,
          transition: 'all 0.2s',
        }}
      >
        {saving ? 'Saving...' : saved ? '✓ Saved — restart app to apply' : 'Save Settings'}
      </button>
    </div>
  )
}

// ── Mobile channel 보조 컴포넌트 ─────────────────────────────────
// Telegram/Discord/Signal/BlueBubbles 각 채널 카드의 공통 UI 조각 (헤더/필드/비밀키 입력).
const channelCardStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius)',
  padding: '14px 18px',
}

const channelBodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  marginTop: 12,
  paddingTop: 12,
  borderTop: '1px solid var(--border-subtle)',
}

const textInputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-input)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: 12,
  padding: '7px 10px',
  outline: 'none',
  fontFamily: 'monospace',
  boxSizing: 'border-box',
}

const selectStyle: React.CSSProperties = {
  ...textInputStyle,
  fontFamily: 'inherit',
}

function primaryBtnStyle(busy: boolean): React.CSSProperties {
  return {
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.7 : 1,
  }
}

const ghostBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
}

// 연동(Connections) 카드 상태 배지 — 연결됨 / 권한 추가 필요 / 준비 중 / 연결 안 됨.
function ConnBadge({ state }: { state: TwixyConnectionState }) {
  const label =
    state === 'connected'    ? '연결됨'
    : state === 'needs_reauth' ? '권한 추가 필요'
    : state === 'coming_soon'  ? '준비 중'
    : '연결 안 됨'
  const style: React.CSSProperties = {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    ...(state === 'connected'
      ? { background: 'var(--accent)', color: '#fff' }
      : state === 'needs_reauth'
        ? { background: 'rgba(234,179,8,0.15)', color: 'var(--yellow, #eab308)', border: '1px solid rgba(234,179,8,0.4)' }
        : { background: 'var(--bg-input)', color: 'var(--text-muted)' }),
  }
  return <span style={style}>{label}</span>
}

// 채널 카드 상단 — 이름/힌트/활성화 토글 스위치.
function ChannelHeader({ name, hint, enabled, onToggle }: {
  name: string
  hint: string
  enabled: boolean
  onToggle: (v: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => onToggle(e.target.checked)}
          style={{ accentColor: 'var(--accent)' }}
        />
        {enabled ? 'enabled' : 'disabled'}
      </label>
    </div>
  )
}

// 레이블 + 자식 입력 필드를 한 행으로 묶는 래퍼. 채널 설정 폼에서 반복 사용.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </label>
  )
}

// 비밀키 입력 컴포넌트. show 상태에 따라 type=password ↔ text 전환 + 눈 아이콘 토글.
// 비밀키 입력 컴포넌트. show 상태에 따라 type=password ↔ text 전환 + 눈 아이콘 토글.
//
// main 은 저장된 비밀값을 평문이 아니라 마스크(끝 4자)로 준다. 마스크는 입력칸의 value 로
// 넣지 않는다 — 넣으면 사용자가 그 뒤에 이어 붙일 수 있고, 그건 "안 바꿨다" 로 읽혀 새 키가
// 조용히 무시된다. 그래서 마스크일 때 칸은 비우고 안내는 placeholder 로, 지우기는 별도
// 버튼으로 분리한다. 한 글자라도 입력하면 그 값이 곧 새 비밀값이다.
function SecretInput({ value, placeholder, show, onToggleShow, onChange }: {
  value: string
  placeholder?: string
  show: boolean
  onToggleShow: () => void
  onChange: (v: string) => void
}) {
  const masked = isMaskedSecret(value)
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={show && !masked ? 'text' : 'password'}
        value={masked ? '' : value}
        placeholder={masked ? `Saved ${value} — type to replace` : placeholder}
        onChange={e => onChange(e.target.value)}
        style={{ ...textInputStyle, paddingRight: 48 }}
      />
      <button
        type="button"
        onClick={() => masked ? onChange('') : onToggleShow()}
        title={masked ? 'Remove the saved value' : undefined}
        style={{
          position: 'absolute',
          right: 6,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: 11,
          cursor: 'pointer',
          padding: '2px 6px',
        }}
      >
        {masked ? 'clear' : show ? 'hide' : 'show'}
      </button>
    </div>
  )
}

// 외부 문서/공식 가이드로 링크하는 작은 "?" 링크. window.twixy.openExternal 로 기본 브라우저 열기.
function HelpLink({ text, url }: { text: string; url: string }) {
  return (
    <a
      href="#"
      onClick={e => { e.preventDefault(); window.twixy?.openExternal(url) }}
      style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', alignSelf: 'flex-start' }}
    >
      {text} ↗
    </a>
  )
}

// 쉼표/줄바꿈 구분 문자열을 string[] 로 파싱 (allowFrom 같은 허용 목록 입력용). 공백/빈값 제거.
function parseList(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

/**
 * Time remaining until the next UTC midnight, formatted as "Xh Ym" (or
 * "Ym" if under an hour). This matches the day boundary used by Postgres
 * `current_date` inside the record_usage RPC, so the displayed countdown
 * is the actual moment usage counters reset.
 */
// 일일 쿼터 리셋 시각 레이블. UTC 기준 자정까지 남은 시간을 "14h 23m" 형태로 표현.
function formatResetLabel(): string {
  const now = new Date()
  const nextUtcMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ))
  const ms = nextUtcMidnight.getTime() - now.getTime()
  const totalMin = Math.max(0, Math.ceil(ms / 60_000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  return `${h}h ${m}m`
}

// 단일 사용량 항목용 가로 프로그레스바. 레이블·수치·잔여량을 함께 보여준다.
// barPct 가 넘어오면 그 값을 그대로 쓰고, 아니면 used/limit 으로 계산.
function UsageBar({ label, used, limit, sublabel, barPct }: { label: string; used: number; limit: number; sublabel?: string; barPct?: number }) {
  const pct = barPct !== undefined ? barPct : (limit > 0 ? Math.min(100, (used / limit) * 100) : 0)
  const danger = pct >= 100
  const warn   = pct >= 80 && !danger
  const color  = danger ? 'var(--red, #b5482f)' : warn ? 'var(--yellow, #b07d18)' : 'var(--accent, #0d5c50)'
  return (
    <div>
      {/* Top row: label + prominent % */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
        <span style={{
          fontSize:    16,
          fontWeight:  700,
          fontFamily: 'monospace',
          color:       danger ? 'var(--red, #b5482f)' : warn ? 'var(--yellow, #b07d18)' : 'var(--text-primary)',
          letterSpacing: '-0.02em',
        }}>
          {Math.round(pct)}%
        </span>
      </div>

      {/* Thicker progress bar */}
      <div style={{
        height: 8,
        background: 'var(--bg-input)',
        borderRadius: 4,
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`,
          height: '100%',
          background: color,
          transition: 'width 0.3s ease',
        }} />
      </div>

      {/* Sub row: raw numbers + optional sublabel */}
      <div style={{
        marginTop: 4,
        fontSize: 10,
        fontFamily: 'monospace',
        color: 'var(--text-muted)',
        opacity: 0.7,
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        {sublabel ? <span>{sublabel}</span> : <span />}
        <span>{fmt(used)} / {fmt(limit)}</span>
      </div>
    </div>
  )
}

// ── 모델별 사용량 파이 차트 ─────────────────────────────────────────
// fetchUsageCost().byModel 배열을 받아 각 모델의 지출 비중을 SVG 파이로 렌더.
// 범례에는 "모델명 $X.XX" 형태로 나열한다.
// Renders a donut chart showing what fraction of total cost each model
// accounted for, with a legend listing tokens + cost per slice. Pure SVG,
// no chart library, so it stays consistent with the rest of the panel.
function UsagePieByModel({ entries }: {
  entries: Array<{ provider?: string; model?: string; totals: Record<string, number> }>
}) {
  // Stable color palette — cycled in order, so the same model always gets
  // roughly the same slot across renders for the brief lifetime of the panel.
  const COLORS = ['var(--accent)', 'var(--accent)', 'var(--warning)', 'var(--accent)', 'var(--danger)', 'var(--accent)', '#EC4899', 'var(--accent)']
  const slices = entries
    .map((e, i) => ({
      key: `${e.provider ?? '?'}::${e.model ?? '?'}`,
      label: e.model ?? '(unknown)',
      provider: e.provider ?? '',
      tokens: e.totals.totalTokens ?? 0,
      cost: e.totals.totalCost ?? 0,
      color: COLORS[i % COLORS.length],
    }))
    .filter(s => s.cost > 0 || s.tokens > 0)
    .sort((a, b) => b.cost - a.cost)

  if (slices.length === 0) return null

  const totalCost = slices.reduce((s, x) => s + x.cost, 0)
  // Avoid division by zero — if all slices are $0 (e.g. cached only) fall
  // back to weighting by token count so the chart still shows something.
  const useCost = totalCost > 0
  const total = useCost ? totalCost : slices.reduce((s, x) => s + x.tokens, 0)

  // Build SVG donut paths
  const cx = 60, cy = 60, r = 50, ir = 30
  const polar = (angle: number, radius: number) => {
    const a = (angle - 90) * Math.PI / 180
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)]
  }
  let acc = 0
  const arcs = slices.map(s => {
    const value = useCost ? s.cost : s.tokens
    const frac = total > 0 ? value / total : 0
    const start = acc * 360
    acc += frac
    const end = acc * 360
    const large = end - start > 180 ? 1 : 0
    const [x1, y1] = polar(start, r)
    const [x2, y2] = polar(end,   r)
    const [x3, y3] = polar(end,   ir)
    const [x4, y4] = polar(start, ir)
    // Single full circle case — SVG arcs can't draw a 360° arc in one path,
    // so just render a stroked circle.
    if (slices.length === 1) {
      return { ...s, frac, d: '', isFull: true }
    }
    const d = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`,
      `L ${x3} ${y3}`,
      `A ${ir} ${ir} 0 ${large} 0 ${x4} ${y4}`,
      'Z',
    ].join(' ')
    return { ...s, frac, d, isFull: false }
  })

  const fmtN = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
  const fmtC = (n: number) => n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(5)}`

  return (
    <div style={{
      display: 'flex',
      gap: 20,
      alignItems: 'center',
      paddingTop: 12,
      borderTop: '1px solid var(--border-subtle)',
    }}>
      <svg width={120} height={120} viewBox="0 0 120 120" style={{ flexShrink: 0 }}>
        {arcs.map(a => a.isFull ? (
          <circle key={a.key} cx={cx} cy={cy} r={(r + ir) / 2}
            fill="none" stroke={a.color} strokeWidth={r - ir} />
        ) : (
          <path key={a.key} d={a.d} fill={a.color} />
        ))}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="11"
          fill="var(--text-muted)" style={{ fontFamily: 'inherit' }}>
          {useCost ? 'cost' : 'tokens'}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize="13" fontWeight="600"
          fill="var(--text-primary)" style={{ fontFamily: 'monospace' }}>
          {useCost ? fmtC(total) : fmtN(total)}
        </text>
      </svg>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        {slices.map(s => {
          const value = useCost ? s.cost : s.tokens
          const pct = total > 0 ? (value / total) * 100 : 0
          return (
            <div key={s.key} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11,
              minWidth: 0,
            }}>
              <span style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: s.color,
                flexShrink: 0,
              }} />
              <span style={{
                color: 'var(--text-primary)',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }} title={`${s.provider}/${s.label}`}>
                {s.label}
              </span>
              <span style={{
                color: 'var(--text-muted)',
                fontFamily: 'monospace',
                flexShrink: 0,
              }}>
                {fmtN(s.tokens)} · {fmtC(s.cost)} · {pct.toFixed(0)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}


// 테마 선택 토글 — theme.ts 저장값과 동기화.
function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(() => getThemePref())
  return (
    <SegmentedControl
      value={pref}
      onChange={(v) => { setPref(v); setThemePref(v) }}
      options={[
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'system', label: 'System' },
      ]}
    />
  )
}
