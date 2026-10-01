import { useEffect, useRef, useState, useCallback } from 'react'

type Decision = 'allow-once' | 'allow-always' | 'deny'

// 'save-as' = 덮어쓰기 대신 새 이름으로 저장 (twixy.overwrite 전용).
export type GuardrailDecision = 'approve' | 'session' | 'remember' | 'deny' | 'save-as'

/** "다른 이름으로 저장"의 기본 제안 이름 — foo.pptx → foo-v2.pptx. */
export function suggestSaveAsName(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext  = dot > 0 ? base.slice(dot) : ''
  // 이미 -vN 이면 다음 번호로. 아니면 -v2 부터.
  const m = /^(.*)-v(\d+)$/.exec(stem)
  return m ? `${m[1]}-v${Number(m[2]) + 1}${ext}` : `${stem}-v2${ext}`
}

// 덮어쓰기 승인 요청(pluginId twixy.overwrite)의 description 에서 대상 경로를
// 파싱 — approval 스키마가 params 필드를 안 받아(additionalProperties:false)
// 경로가 description 으로만 온다. 형식은 openclaw 패치와의 계약:
// "The agent wants to OVERWRITE the existing file: <path>"
export function overwritePathFromDescription(desc: string): string {
  const m = /OVERWRITE the existing file:\s*(.+)$/.exec(desc)
  return m ? m[1].trim() : ''
}

// Fingerprint a pending approval so the session cache / allowlist can match
// it against past decisions. For file tools we key on normalized path; for
// Bash we key on the first token (the binary name).
function fingerprint(req: GuardrailApprovalRequest): { kind: 'write' | 'edit' | 'bash' | null; key: string } {
  const tn = req.toolName
  const params = (req.params ?? {}) as Record<string, unknown>
  // 덮어쓰기 요청은 write allowlist/세션캐시를 공유 — "Always allow" 하면 그
  // 경로의 이후 덮어쓰기(및 guardrail write 게이트)가 함께 통과된다.
  if (req.pluginId === 'twixy.overwrite') {
    return { kind: 'write', key: overwritePathFromDescription(req.description) }
  }
  if (tn === 'Write' || tn === 'write') {
    return { kind: 'write', key: String(params.path ?? params.file_path ?? '') }
  }
  if (tn === 'Edit' || tn === 'edit' || tn === 'NotebookEdit') {
    return { kind: 'edit', key: String(params.path ?? params.file_path ?? '') }
  }
  if (tn === 'Bash' || tn === 'bash' || tn === 'exec') {
    const cmd = String(params.command ?? '').trim()
    const bin = cmd.split(/\s+/)[0] ?? ''
    return { kind: 'bash', key: bin }
  }
  return { kind: null, key: '' }
}

function matchesAllowlist(req: GuardrailApprovalRequest, cfg: GuardrailConfig): boolean {
  if (cfg.mode === 'strict') return false  // strict never skips prompt
  const fp = fingerprint(req)
  if (!fp.kind) return false
  const list = cfg.allowlist[fp.kind]
  if (!list?.length || !fp.key) return false
  return list.some(pattern => {
    if (pattern === fp.key) return true
    if (pattern.endsWith('/**')) return fp.key.startsWith(pattern.slice(0, -2))
    if (pattern.endsWith('/*'))  return fp.key.startsWith(pattern.slice(0, -1))
    return false
  })
}

export function useGuardrail(resolveRpc: (id: string, decision: Decision) => Promise<void>) {
  const [config, setConfig] = useState<GuardrailConfig>({ mode: 'bypass', allowlist: { write: [], edit: [], bash: [] } })
  const [pending, setPending] = useState<GuardrailApprovalRequest[]>([])
  const configRef = useRef(config)
  const sessionAllowRef = useRef<Set<string>>(new Set())

  useEffect(() => { configRef.current = config }, [config])

  // Load config + subscribe to changes
  useEffect(() => {
    let alive = true
    window.twixy?.guardrailGetConfig?.().then(cfg => { if (alive && cfg) setConfig(cfg) }).catch(() => {})
    const off = window.twixy?.onGuardrailConfigChanged?.((cfg) => setConfig(cfg)) ?? (() => {})
    return () => { alive = false; off() }
  }, [])

  // Listen for plugin.approval.requested events broadcast by useOpenClaw
  // on its already-authenticated gateway WS.
  useEffect(() => {
    const handle = (e: Event) => {
      const p = (e as CustomEvent).detail as Record<string, unknown> | undefined
      if (!p) return
      const req: GuardrailApprovalRequest = {
        id:          String(p.id ?? ''),
        pluginId:    String((p.request as Record<string, unknown> | undefined)?.pluginId ?? p.pluginId ?? ''),
        toolName:    String((p.request as Record<string, unknown> | undefined)?.toolName ?? p.toolName ?? ''),
        title:       String((p.request as Record<string, unknown> | undefined)?.title ?? 'Action approval'),
        description: String((p.request as Record<string, unknown> | undefined)?.description ?? ''),
        severity:    ((p.request as Record<string, unknown> | undefined)?.severity ?? null) as GuardrailApprovalRequest['severity'],
        params:      ((p.request as Record<string, unknown> | undefined)?.params ?? {}) as Record<string, unknown>,
        createdAtMs: Number(p.createdAtMs ?? Date.now()),
        expiresAtMs: Number(p.expiresAtMs ?? Date.now() + 5 * 60 * 1000),
      }
      if (!req.id) return

      const cfg = configRef.current
      // 덮어쓰기 승인(twixy.overwrite)은 guardrail 이 bypass 여도 항상 사람이
      // 결정한다 — "기존 파일 덮어쓰기는 유저 허락 없인 안 됨" 이 이 게이트의
      // 존재 이유라 자동 allow 에서 제외. 세션캐시/allowlist 통과는 허용
      // (같은 파일을 한 run 에서 여러 번 쓰는 흐름이 매번 모달을 띄우지 않게).
      const isOverwrite = req.pluginId === 'twixy.overwrite'
      if (cfg.mode === 'bypass' && !isOverwrite) { void resolveRpc(req.id, 'allow-once'); return }

      const fp = fingerprint(req)
      const cacheKey = `${fp.kind}:${fp.key}`
      if (fp.kind && cfg.mode !== 'strict' && sessionAllowRef.current.has(cacheKey)) {
        void resolveRpc(req.id, 'allow-once')
        return
      }
      if (matchesAllowlist(req, cfg)) { void resolveRpc(req.id, 'allow-once'); return }

      setPending(prev => prev.some(p2 => p2.id === req.id) ? prev : [...prev, req])
    }

    const handleResolved = (e: Event) => {
      const p = (e as CustomEvent).detail as Record<string, unknown> | undefined
      const id = p?.id as string | undefined
      if (!id) return
      // Another surface (or timeout) resolved it — drop from our queue.
      setPending(prev => prev.filter(r => r.id !== id))
    }

    window.addEventListener('twixy:plugin.approval.requested', handle)
    window.addEventListener('twixy:plugin.approval.resolved', handleResolved)
    return () => {
      window.removeEventListener('twixy:plugin.approval.requested', handle)
      window.removeEventListener('twixy:plugin.approval.resolved', handleResolved)
    }
  }, [resolveRpc])

  const decide = useCallback((req: GuardrailApprovalRequest, action: GuardrailDecision, opts?: { saveAsName?: string }) => {
    const fp = fingerprint(req)
    const cacheKey = `${fp.kind}:${fp.key}`
    if (action === 'save-as') {
      // 덮어쓰기 대신 새 이름으로: main 에 <승인 id> → 새 경로를 먼저 등록하고,
      // 등록이 성공한 뒤에만 승인한다. 등록이 실패했는데 승인하면 원본이
      // 날아가므로 실패 시엔 deny (fail-closed).
      const originalRel = overwritePathFromDescription(req.description)
      const fileName = (opts?.saveAsName ?? '').trim() || suggestSaveAsName(originalRel)
      void (async () => {
        let ok = false
        try {
          const res = await window.twixy?.guardrailOverwriteRedirect?.({ id: req.id, originalRel, fileName })
          ok = Boolean(res?.ok)
          if (!ok) console.warn('[guardrail] save-as redirect failed:', res?.error)
        } catch (err) {
          console.warn('[guardrail] save-as redirect failed:', err)
        }
        await resolveRpc(req.id, ok ? 'allow-once' : 'deny')
      })()
      setPending(prev => prev.filter(p => p.id !== req.id))
      return
    }
    if (action === 'approve') {
      void resolveRpc(req.id, 'allow-once')
    } else if (action === 'session') {
      if (fp.kind) sessionAllowRef.current.add(cacheKey)
      void resolveRpc(req.id, 'allow-once')
    } else if (action === 'remember') {
      if (fp.kind && fp.key) {
        const current = configRef.current
        const next = { ...current.allowlist, [fp.kind]: [...current.allowlist[fp.kind], fp.key] }
        void window.twixy?.guardrailSetConfig?.({ allowlist: next })
      }
      void resolveRpc(req.id, 'allow-always')
    } else {
      void resolveRpc(req.id, 'deny')
    }
    setPending(prev => prev.filter(p => p.id !== req.id))
  }, [resolveRpc])

  const current = pending[0] ?? null
  return { config, current, decide }
}
