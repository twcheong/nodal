// 스튜디오 탭 → 메인(products/nodal/electron/studio.ts) 호출 래퍼, 그리고 스토리보드 초안용 LLM 한 번 묻기.
import { createRendererTransport } from '../../../../src/lib/gateway/rendererTransport'
import { createSession, extractText, releaseSessions } from '../../../../src/lib/gateway/sessionClient'
import type { Asset, StudioProject } from './model'

export interface ProjectSummary { id: string; name: string; updatedAt: number; stage: number }

async function invoke<T>(name: string, payload?: unknown): Promise<T> {
  const res = await window.twixy?.productInvoke?.(name, payload)
  if (!res) throw new Error('not running inside the desktop app')
  if (!res.ok) throw new Error(res.error)
  return res.data as T
}

export const studioApi = {
  list:   () => invoke<ProjectSummary[]>('studio-list'),
  create: (project: Omit<StudioProject, 'id' | 'createdAt' | 'updatedAt'>) => invoke<StudioProject>('studio-create', { project }),
  load:   (id: string) => invoke<StudioProject>('studio-load', { id }),
  save:   (project: StudioProject) => invoke<{ updatedAt: number }>('studio-save', { project }),
  reveal: (id: string) => invoke<boolean>('studio-reveal', { id }),
  run:    (template: string, args: Record<string, unknown>) => invoke<{ runId: string }>('studio-run', { template, args }),
  concat: (hashes: string[]) => invoke<{ runId: string }>('studio-concat', { hashes }),
  keep:   (id: string, hash: string, subdir: string, name: string) => invoke<Asset>('studio-keep', { id, hash, subdir, name }),
  importImages: (id: string, subdir: string) => invoke<Asset[]>('studio-import', { id, subdir }),
}

/**
 * 채팅 모델에 한 번 묻고 답 텍스트를 받는다 — 게이트웨이에 툴 없는 에이전트(builder) 세션을 잠깐 열어서.
 * 키·모델은 앱 채팅과 같은 것을 쓴다 (게이트웨이가 가진다). 세션은 끝나면 반납한다.
 */
export async function askModel(prompt: string, timeoutMs = 180_000): Promise<string> {
  const transport = createRendererTransport('Nodal Studio', 'Studio WS error')
  let key: string | null = null
  try {
    await transport.ensureConnected()
    key = await createSession(transport, { agentId: 'builder' })
    const sessionKey = key
    const answer = new Promise<string>((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => { off(); reject(new Error('모델 응답이 너무 늦습니다')) }, timeoutMs)
      const off = transport.onEvent((frame) => {
        const payload = frame.payload ?? {}
        const frameKey = (payload.sessionKey ?? payload.key) as string | undefined
        if (frameKey !== sessionKey) return
        if (frame.event === 'session.message') {
          const msg = payload.message as { role?: string; content?: unknown } | undefined
          if (msg?.role === 'assistant') text = extractText(msg.content) || text
        } else if (frame.event === 'chat') {
          if (payload.state === 'final') { clearTimeout(timer); off(); resolve(text) }
          else if (payload.state === 'error') {
            clearTimeout(timer); off()
            reject(new Error((payload.error as { message?: string } | undefined)?.message ?? '모델 호출 실패'))
          }
        }
      })
    })
    await transport.rpc('sessions.send', { key: sessionKey, message: prompt })
    const text = await answer
    if (!text.trim()) throw new Error('모델이 빈 답을 보냈습니다')
    return text
  } finally {
    if (key) releaseSessions(transport, [key])
    transport.dispose()
  }
}
