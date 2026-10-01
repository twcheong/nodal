// ── Session log — 세션 단위 채팅/툴 로그 추가 ────────────────────
// 채팅 메시지 1 건이 끝날 때마다 렌더러가 줄 단위로 append 한다 (session-log-append).
//
// ── 세션 로그 · 스킬 통계 · 요약 (main.ts 에서 이동) ─────────────────────────
//
// 워크스페이스 아래 logs/ 를 읽고 쓰는 IPC 7개와 그 포맷터들. main.ts 에서 옮겨 온 것이며
// 핸들러 본문은 들여쓰기 말고는 그대로다 (Stage 4 슬라이스 1).
//
// 바깥에서 필요한 것은 워크스페이스 경로뿐이라 thunk 하나만 주입받는다 — guardrail/ipc.ts ·
// designated-paths/ipc.ts 와 같은 패턴. electron 의존은 ipcMain 한 줄뿐이고, 위쪽 포맷터
// 4개는 순수 함수라 테스트에서 그대로 부를 수 있다.
//
// ⚠ activeSessionFiles 는 모듈 상태다. set-project-dir 이 프로젝트 폴더를 바꿀 때
// clearActiveSessionFiles() 로 비워야 한다 — 안 비우면 append 가 **이전 워크스페이스**의
// 파일로 계속 쓴다 (main.ts 의 호출부 주석 참고).
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { isInside } from './trustBoundary'

export interface SessionLogDeps {
  getWorkspace: () => string
}

// 세션 요약/분석 도구가 이 로그를 역으로 읽는다.
// Appends a raw WS gateway frame (one JSONL line) to the Twixy session log.
// File: logs/sessions/YYYY-MM-DD_<sessionId>.jsonl
// One file per session, created on first append.
const activeSessionFiles = new Map<string, string>()  // sessionId → absolute path

/** 프로젝트 폴더가 바뀌면 세션 파일 맵을 비운다 (set-project-dir 에서 호출). */
export function clearActiveSessionFiles(): void {
  activeSessionFiles.clear()
}

// sessionId often contains characters like `:` (e.g. "agent:main:dashboard:<uuid>")
// which are valid in POSIX filenames but RESERVED on Windows (drive / ADS).
// Strip anything unsafe so session log files can be created cross-platform.
// The raw sessionId is still used as the in-memory map key; only the filename
// fragment is sanitized.
export function sanitizeSessionIdForFilename(id: string): string {
  return id
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\.+$/, '-')       // no trailing dots on Windows
    .replace(/\s+$/, '')        // no trailing spaces on Windows
    .slice(0, 180) || 'session' // stay well under MAX_PATH budget
}

// Format browser/web tool args into a one-line human-readable detail string.

export function inferEvaluateIntentMain(fn: string): string {
  const f = fn.toLowerCase()
  if (f.includes('ytinitialdata') || f.includes('ytinitialplayerresponse')) return 'Reading page data'
  if (f.includes('interactioncount') || (f.includes('view') && (f.includes('count') || f.includes('text')))) return 'Reading view count'
  if (f.includes('subscriber')) return 'Reading subscriber count'
  if (f.includes('likecount') || (f.includes('like') && f.includes('button'))) return 'Reading like count'
  if (f.includes('comment')) return 'Reading comments'
  if (f.includes('date') || f.includes('info-string') || f.includes('published')) return 'Reading publish date'
  if (f.includes('description')) return 'Reading description'
  if ((f.includes('/@') || f.includes('/channel/')) && f.includes('href')) return 'Finding channel link'
  if (f.includes('channel') && f.includes('href')) return 'Finding channel link'
  if (f.includes('channel')) return 'Reading channel info'
  if (f.includes('follower')) return 'Reading follower count'
  if (f.includes('h1') || (f.includes('title') && !f.includes('titlewrapper'))) return 'Reading page title'
  if (f.includes('href') || (f.includes('queryselectorall') && f.includes('"a"'))) return 'Reading page links'
  if (f.includes('src') || f.includes('img')) return 'Reading images'
  const m = fn.match(/querySelector(?:All)?\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/)
  if (m) return `Reading ${m[1].replace(/[#.\[\]"=*]+/g, ' ').trim().slice(0, 40)}`
  return 'Evaluating page'
}

export function humanizeSelectorMain(sel: string): string {
  if (!sel) return ''
  const s = sel.toLowerCase()
  if (s.includes('title') || s === 'h1') return 'title'
  if (s.includes('channel-header') || s.includes('channel-name')) return 'channel info'
  if (s.includes('below') || s.includes('secondary')) return 'related content'
  if (s.includes('watch-header') || s.includes('video-primary')) return 'video header'
  if (s.includes('ytinitial')) return 'page data'
  if (s.includes('description')) return 'description'
  if (s.includes('comment')) return 'comments'
  if (s.includes('subscriber')) return 'subscribers'
  if (s.includes('meta')) return 'page metadata'
  if (s.includes('like')) return 'like button'
  return sel.replace(/[#\[\]"=*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 36)
}

export function formatToolDetailMain(toolName: string, args: Record<string, unknown>): string | null {
  const action   = args.action   as string | undefined
  const kind     = args.kind     as string | undefined
  const url      = (args.url ?? args.targetUrl) as string | undefined
  const selector = (args.selector ?? args.element) as string | undefined
  const text     = args.text     as string | undefined
  const query    = (args.query ?? args.q) as string | undefined
  const fn       = args.fn       as string | undefined

  if (toolName === 'browser') {
    if (action === 'open' || action === 'navigate') {
      if (!url) return 'Opening page'
      try {
        const u = new URL(String(url))
        const host = u.hostname.replace(/^www\./, '')
        return `Opening ${host}${u.pathname.length > 1 ? u.pathname.slice(0, 40) : ''}`
      } catch { return `Opening ${String(url).slice(0, 60)}` }
    }
    if (action === 'act') {
      if (kind === 'evaluate') return fn ? inferEvaluateIntentMain(fn) : 'Evaluating page'
      if (kind === 'click')    return 'Clicking element on page'
      if (kind === 'type')     return text ? `Typing "${String(text).slice(0, 50)}"` : 'Typing'
      if (kind === 'wait')     return `Waiting${args.timeMs ? ` ${args.timeMs}ms` : '…'}`
      if (kind === 'scroll')   return 'Scrolling'
      if (kind === 'key')      return text ? `Pressing ${text}` : 'Pressing key'
      return kind ?? 'Performing action'
    }
    if (action === 'snapshot') {
      const label = selector ? humanizeSelectorMain(selector) : ''
      return label ? `Reading ${label}` : 'Reading page'
    }
    if (action === 'screenshot') return 'Taking screenshot'
    if (action === 'close')      return 'Closing tab'
    return action ?? null
  }
  if (toolName === 'web_fetch') {
    if (!url) return null
    try { return `Fetching ${new URL(String(url)).hostname.replace(/^www\./,'')}` } catch { return `Fetching ${String(url).slice(0,60)}` }
  }
  if (toolName === 'web_search')    return query ? `Searching "${String(query).slice(0, 60)}"` : null
  if (toolName === 'memory_search') return query ? `Recalling "${String(query).slice(0, 60)}"` : 'Searching memory'
  if (toolName === 'exec' || toolName === 'bash') {
    const cmd = (args.command ?? args.cmd) as string | undefined
    return cmd ? String(cmd).slice(0, 80) : null
  }

  const filePath = (args.path ?? args.file ?? args.filePath) as string | undefined
  const shortPath = filePath ? String(filePath).split('/').slice(-2).join('/') : undefined

  if (toolName === 'read')  return shortPath ? `Reading ${shortPath}` : 'Reading file'
  if (toolName === 'write') return shortPath ? `Writing ${shortPath}` : 'Writing file'
  if (toolName === 'edit')  return shortPath ? `Editing ${shortPath}` : 'Editing file'
  if (toolName === 'glob')  return args.pattern ? `Searching ${args.pattern}` : 'Searching files'
  if (toolName === 'grep')  return args.pattern ? `Searching for "${String(args.pattern).slice(0, 50)}"` : 'Searching content'

  if (toolName === 'sessions_spawn') {
    const task = (args.task ?? args.prompt) as string | undefined
    return task ? `Spawning sub-agent: ${String(task).slice(0, 60)}` : 'Spawning sub-agent'
  }
  if (toolName === 'sessions_yield') return 'Returning to parent agent'

  return null
}


/** 세션 로그 관련 IPC 7개를 등록한다. import 시점 부작용은 없다 — 이 함수를 불러야 등록된다. */
export function registerSessionLogIpc(deps: SessionLogDeps): void {
  // 구조분해로 받아 두면 아래 핸들러 본문의 getWorkspace() 호출이 그대로 동작한다
  // (main.ts 에서 옮겨 올 때 본문을 한 글자도 안 고치기 위한 것).
  const { getWorkspace } = deps

  ipcMain.handle('session-log-append', (_e, payload: { sessionId: string; line: string }) => {
    try {
      const { sessionId, line } = payload
      if (!sessionId || !line) return

      let filePath = activeSessionFiles.get(sessionId)
      if (!filePath) {
        const date    = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
        const logsDir = path.join(getWorkspace(), 'logs', 'sessions')
        fs.mkdirSync(logsDir, { recursive: true })
        const safeId = sanitizeSessionIdForFilename(sessionId)
        filePath = path.join(logsDir, `${date}_${safeId}.jsonl`)
        activeSessionFiles.set(sessionId, filePath)
      }

      fs.appendFileSync(filePath, line + '\n', 'utf8')
    } catch (e) {
      console.error('[session-log] append failed:', e)
    }
  })

  // ── Session log reader — 과거 세션 조회/포맷 ─────────────────────
  // list-session-logs: 모든 세션 파일 메타 반환.
  // read-session-log: 저장된 JSON-lines 를 파싱하고 툴 호출 인자를 사람이 읽기 쉽게 가공.
  // (예: evaluate() 가 뭘 했는지 추정, CSS selector 를 한국어 설명으로)

  /** List all session log files, newest first */
  ipcMain.handle('list-session-logs', () => {
    const dir = path.join(getWorkspace(), 'logs', 'sessions')
    if (!fs.existsSync(dir)) return []

    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath  = path.join(dir, f)
        const stat      = fs.statSync(filePath)
        // filename: YYYY-MM-DD_<sessionId>.jsonl
        const [date, ...rest] = f.replace('.jsonl', '').split('_')
        const sessionId = rest.join('_')
        // Scan for first user message (preview) and sum assistant token usage
        let preview = ''
        let totalTokens = 0
        try {
          const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
          for (const line of lines) {
            const frame = JSON.parse(line)
            if (frame.event === 'session.message') {
              const msg = frame.payload?.message
              if (msg?.role === 'user' && !preview) {
                const content = msg.content
                const text = Array.isArray(content)
                  ? content.find((b: Record<string,unknown>) => b.type === 'text')?.text ?? ''
                  : typeof content === 'string' ? content : ''
                if (text.trim()) preview = String(text).slice(0, 80)
              }
              if (msg?.role === 'assistant' && typeof msg.usage?.totalTokens === 'number') {
                totalTokens += msg.usage.totalTokens
              }
            }
          }
        } catch { /* skip */ }
        return { date, sessionId, filePath, mtimeMs: stat.mtimeMs, preview, totalTokens: totalTokens || undefined }
      })
      .filter(s => s.preview !== '')   // skip sessions with no user messages
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  })

  /** Parse a session JSONL file into a flat message list for the UI */
  ipcMain.handle('read-session-log', (_e, filePath: string) => {
    const safe = path.resolve(filePath)
    if (!isInside(path.join(getWorkspace(), 'logs', 'sessions'), safe)) return []
    if (!fs.existsSync(safe)) return []

    // Raw parsed rows before sorting — each row carries a seq number for ordering.
    const rows: { seq: number; role: string; text: string; tools: string[]; timestamp: string }[] = []
    try {
      const lines = fs.readFileSync(safe, 'utf8').split('\n').filter(Boolean)
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const frame = JSON.parse(lines[lineIdx])
        // Use line index as the sort key — the JSONL file is written in
        // chronological order, so this preserves correct event ordering
        // without mixing incompatible seq namespaces across event types.
        const seq: number = lineIdx

        // ── Chat messages ──────────────────────────────────────────
        if (frame.event === 'session.message') {
          const msg  = frame.payload?.message
          const role = msg?.role as string | undefined
          if (!role) continue

          // Skip system messages — OpenClaw-internal injections not user-visible.
          if (role === 'system') continue

          // Skip assistant messages without a responseId — these are synthetic
          // accumulated messages (e.g. chat-history summaries that concatenate
          // multiple previous responses). Real model responses always carry a
          // responseId (e.g. "gen-..."); messages without one are duplicates.
          // _langCorrected entries update the previously-parsed message in-place
          // rather than adding a new row. This way history shows the corrected
          // text while the original raw entry is still in the file.
          if (frame.payload?._langCorrected && frame.payload?.messageId) {
            const targetId = frame.payload.messageId as string
            const correctedText = typeof msg.content === 'string' ? msg.content : ''
            if (correctedText) {
              const idx = rows.findLastIndex(r => (r as Record<string,unknown>)._msgId === targetId)
              if (idx !== -1) rows[idx].text = correctedText
            }
            continue
          }

          if (role === 'assistant' && !msg.responseId) continue

          const content  = msg.content ?? []
          const blocks   = Array.isArray(content) ? content : []
          const textParts: string[] = []
          const tools:     string[] = []

          for (const b of blocks as Record<string,unknown>[]) {
            if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text)
            if (b.type === 'toolCall' && typeof b.name === 'string') tools.push(b.name)
            if (b.type === 'toolResult' && typeof b.name === 'string') tools.push(`${b.name} → result`)
          }

          let text = textParts.join('').trim()

          if (role === 'user') {
            // OpenClaw's control-UI channel wraps messages with sender metadata
            // and appends bootstrap warnings. Strip them so only the actual user
            // text is shown.
            if (text.startsWith('Sender (untrusted metadata):')) {
              // Real message starts after the [Day YYYY-MM-DD HH:MM TZ] timestamp
              const afterTs = text.match(/\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]+\] ([\s\S]*)/)
              text = afterTs ? afterTs[1].trim() : ''
            }
            // Strip [Bootstrap truncation warning] block and everything after
            const bsIdx = text.indexOf('[Bootstrap truncation warning]')
            if (bsIdx !== -1) text = text.slice(0, bsIdx).trim()
            // Strip internal [system: ...] padding lines
            text = text.replace(/\[system:[^\]]*\]\s*/g, '').trim()
            // Strip bare placeholder lines injected as padding
            text = text.replace(/^placeholder\s+placeholder.*$/gm, '').trim()
          }

          // Skip assistant messages that only triggered tool calls (no visible text).
          // They'll appear via session.tool events instead.
          if (!text && tools.length === 0) continue
          if (!text && role === 'assistant') continue

          const msgId = frame.payload?.messageId as string | undefined
          rows.push({ seq, role, text, tools, timestamp: frame.payload?.timestamp ?? '', _msgId: msgId } as typeof rows[number] & { _msgId?: string })
          continue
        }

        // ── Tool action steps (browser / web_fetch / exec) ─────────
        if (frame.event === 'session.tool') {
          const data  = (frame.payload?.data ?? frame.payload) as Record<string, unknown>
          const phase = data?.phase as string | undefined
          if (phase !== 'start' && phase !== 'tool_use') continue
          const toolName = (data?.tool_name ?? data?.toolName ?? data?.name) as string | undefined
          if (!toolName) continue
          const args = (data?.args ?? data?.arguments ?? data?.input ?? {}) as Record<string, unknown>
          const detail = formatToolDetailMain(toolName, args)
          if (!detail) continue

          rows.push({ seq, role: 'tool_action', text: detail, tools: [toolName], timestamp: '' })
        }
      }
    } catch { /* skip */ }

    // Sort by seq so tool actions appear in correct order relative to messages.
    rows.sort((a, b) => a.seq - b.seq)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return rows.map(({ seq, ...rest }) => rest)
  })

  // ── Skill usage stats — 스킬별 호출/성공률 통계 ──────────────────
  // 세션 로그를 스캔해 각 스킬의 호출 횟수, 성공/실패, 평균 소요 시간 등을 집계.
  // SkillsPanel 의 카드 배지와 정렬에 사용.
  // Parse session logs to extract per-skill execution metrics.

  interface SkillExec {
    skill:       string
    tokens:      number
    cost:        number
    model:       string
    timestamp:   number
  }

  interface SkillStats {
    executions:  number
    totalTokens: number
    avgTokens:   number
    totalCost:   number
    lastUsed:    number
    models:      Record<string, number>
  }

  ipcMain.handle('get-skill-stats', () => {
    const sessionsDir = path.join(getWorkspace(), 'logs', 'sessions')
    if (!fs.existsSync(sessionsDir)) return {}

    const skillPattern = /skills\/([^/]+)\/SKILL\.md/i
    const execs: SkillExec[] = []

    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))

    for (const file of files) {
      try {
        const lines = fs.readFileSync(path.join(sessionsDir, file), 'utf8')
          .split('\n').filter(Boolean)

        let activeSkill: string | null = null
        let activeTokens = 0
        let activeCost   = 0
        let activeModel  = ''
        let activeTs     = 0

        const flush = () => {
          if (activeSkill && activeTokens > 0) {
            execs.push({ skill: activeSkill, tokens: activeTokens, cost: activeCost, model: activeModel, timestamp: activeTs })
          }
          activeSkill = null; activeTokens = 0; activeCost = 0; activeModel = ''; activeTs = 0
        }

        for (const line of lines) {
          const frame = JSON.parse(line)
          if (frame.event !== 'session.message') continue
          const msg = frame.payload?.message
          if (!msg) continue

          if (msg.role === 'user') {
            flush()
            continue
          }

          if (msg.role === 'assistant') {
            // Detect SKILL.md read in tool calls
            const content: unknown[] = Array.isArray(msg.content) ? msg.content : []
            for (const block of content) {
              if (typeof block !== 'object' || block === null) continue
              const b = block as Record<string, unknown>
              if (b.type === 'toolCall' && b.name === 'read') {
                const p = ((b.arguments as Record<string, unknown>)?.path as string) ?? ''
                const m = p.match(skillPattern)
                if (m) {
                  flush()
                  activeSkill = m[1]
                  activeTs    = (msg.timestamp as number) ?? Date.now()
                }
              }
            }

            // Accumulate tokens for active skill
            if (activeSkill && msg.usage) {
              const u = msg.usage as Record<string, number>
              activeTokens += u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0)
              activeCost   += (u.cost as unknown as Record<string, number>)?.total ?? 0
              if (!activeModel && msg.model) activeModel = String(msg.model)
            }
          }
        }
        flush()
      } catch { /* skip malformed */ }
    }

    // Aggregate by skill name
    const stats: Record<string, SkillStats> = {}
    for (const e of execs) {
      if (!stats[e.skill]) stats[e.skill] = { executions: 0, totalTokens: 0, avgTokens: 0, totalCost: 0, lastUsed: 0, models: {} }
      const s = stats[e.skill]
      s.executions++
      s.totalTokens += e.tokens
      s.totalCost   += e.cost
      if (e.timestamp > s.lastUsed) s.lastUsed = e.timestamp
      s.models[e.model] = (s.models[e.model] ?? 0) + 1
    }
    for (const s of Object.values(stats)) {
      s.avgTokens = Math.round(s.totalTokens / s.executions)
    }

    return stats
  })

  // ── Pattern analysis metadata — 자동 패턴 분석 상태 ──────────────
  // "지난 N개 세션에서 공통 패턴을 뽑아내는" 분석 작업의 메타정보 (마지막 실행 시각 등).
  // UI 가 "analyze sessions for skill suggestions" 배너를 표시할지 결정할 때 사용한다.

  function getAnalysisMetaPath() { return path.join(getWorkspace(), 'logs', 'sessions', '.analysis-meta.json') }

  ipcMain.handle('get-analysis-meta', () => {
    try {
      return JSON.parse(fs.readFileSync(getAnalysisMetaPath(), 'utf8'))
    } catch {
      return { lastAnalyzedAt: null }
    }
  })

  ipcMain.handle('mark-analysis-done', () => {
    try {
      fs.mkdirSync(path.dirname(getAnalysisMetaPath()), { recursive: true })
      fs.writeFileSync(getAnalysisMetaPath(), JSON.stringify({ lastAnalyzedAt: Date.now() }, null, 2))
      return { ok: true }
    } catch (e) {
      console.error('[analysis-meta] write failed:', e)
      return { ok: false }
    }
  })

  // ── Session summary — 서버 업로드용 구조화 로그 생성 ─────────────
  // 세션 raw 로그를 LLM-친화적인 구조화 요약(JSON)으로 변환한다.
  // 원격 학습/개선을 위해 Supabase 로 업로드 가능한 포맷.
  // Writes logs/summary/YYYY-MM-DD_<sessionId>.json when a thinking session ends.
  // Contains: full chat messages, sanitized tool call sequence (no arg values),
  // skills run, duration, success rate. PII/sensitive data stays in raw JSONL only.

  function getSummaryDir() { return path.join(getWorkspace(), 'logs', 'summary') }

  ipcMain.handle('generate-session-summary', (_e, sessionId: string) => {
    try {
      const sessionsDir = path.join(getWorkspace(), 'logs', 'sessions')
      if (!fs.existsSync(sessionsDir)) return { ok: false }

      // Resolve JSONL path: prefer activeSessionFiles map, fallback to dir scan.
      // Match against both the raw id and the sanitized filename token since
      // old logs created on POSIX may contain raw `:` while new Windows-safe
      // logs use the sanitized variant.
      let filePath = activeSessionFiles.get(sessionId)
      if (!filePath || !fs.existsSync(filePath)) {
        const safeId = sanitizeSessionIdForFilename(sessionId)
        const found = fs.readdirSync(sessionsDir).find(f =>
          f.endsWith('.jsonl') && (f.includes(sessionId) || f.includes(safeId))
        )
        if (!found) return { ok: false, error: 'session file not found' }
        filePath = path.join(sessionsDir, found)
      }

      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)

      const messages: { role: string; text: string }[] = []
      // Map callId → start metadata for pairing with results
      const startMap = new Map<string, { name: string; action?: string; kind?: string }>()
      const toolCalls: { name: string; action?: string; kind?: string; success: boolean; errorType?: string }[] = []
      const skillsRun = new Set<string>()
      let firstTs = 0, lastTs = 0

      for (const line of lines) {
        try {
          const frame = JSON.parse(line)
          const ts = frame.payload?.ts as number | undefined
          if (ts) { if (!firstTs) firstTs = ts; lastTs = ts }

          // ── Chat messages ──────────────────────────────────
          if (frame.event === 'session.message') {
            const msg  = frame.payload?.message
            const role = msg?.role as string | undefined
            if (role !== 'user' && role !== 'assistant') continue
            const content = msg.content ?? []
            const blocks  = Array.isArray(content) ? content : []
            const parts: string[] = []
            for (const b of blocks as Record<string, unknown>[]) {
              if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
            }
            const text = parts.join('').trim()
            if (text) {
              messages.push({ role, text })
              // Detect skill runs from assistant messages like "[run] skill-name"
              if (role === 'assistant') {
                for (const m of text.matchAll(/\[run\]\s+([\w-]+)/g)) skillsRun.add(m[1])
              }
            }
          }

          // ── Tool calls ─────────────────────────────────────
          if (frame.event === 'session.tool') {
            const data    = (frame.payload?.data ?? frame.payload) as Record<string, unknown>
            const phase   = data?.phase as string | undefined
            const name    = (data?.tool_name ?? data?.toolName ?? data?.name) as string | undefined
            const callId  = (data?.call_id ?? data?.callId ?? data?.toolCallId) as string | undefined
            const args    = (data?.args ?? {}) as Record<string, unknown>

            if ((phase === 'start' || phase === 'tool_use') && name && callId) {
              startMap.set(callId, { name, action: args.action as string, kind: args.kind as string })
            } else if ((phase === 'result' || phase === 'error' || phase === 'tool_result') && callId) {
              const start = startMap.get(callId)
              if (!start) continue
              const isError = !!(data?.isError)
              let errorType: string | undefined
              if (isError) {
                const meta = String(data?.meta ?? '')
                if (start.name === 'browser' && start.action === 'snapshot') errorType = 'timeout'
                else if (start.name === 'web_fetch') errorType = /bot|captcha|unusual/i.test(meta) ? 'bot_block' : 'fetch_error'
                else if (start.name === 'browser') errorType = 'browser_error'
                else errorType = 'error'
              }
              toolCalls.push({
                name: start.name,
                ...(start.action ? { action: start.action } : {}),
                ...(start.kind   ? { kind:   start.kind   } : {}),
                success: !isError,
                ...(errorType    ? { errorType }            : {}),
              })
              startMap.delete(callId)
            }
          }
        } catch { /* skip malformed lines */ }
      }

      const succeeded = toolCalls.filter(t => t.success).length
      const summary = {
        sessionId,
        date:             filePath ? path.basename(filePath).split('_')[0] : '',
        generatedAt:      Date.now(),
        durationMs:       firstTs && lastTs ? lastTs - firstTs : 0,
        messages,
        toolCalls,
        skillsRun:        [...skillsRun],
        toolSuccessRate:  toolCalls.length > 0 ? Math.round(succeeded / toolCalls.length * 100) / 100 : null,
      }

      fs.mkdirSync(getSummaryDir(), { recursive: true })
      const outPath = path.join(getSummaryDir(), path.basename(filePath).replace('.jsonl', '.json'))
      fs.writeFileSync(outPath, JSON.stringify(summary, null, 2))
      return { ok: true, filePath: outPath }
    } catch (e) {
      console.error('[session-summary] failed:', e)
      return { ok: false, error: String(e) }
    }
  })
}
