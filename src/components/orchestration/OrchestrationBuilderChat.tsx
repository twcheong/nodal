// OrchestrationBuilderChat — 우측 빌더 챗. useOrchestrationClaw 세션으로 대화하고,
// 어시스턴트가 fenced JSON orchestration 스펙을 내면 Apply 버튼으로 적용한다.
import { useEffect, useRef, useState } from 'react'
import { useOrchestrationClaw } from '../../hooks/useOrchestrationClaw'
import { parseJsonLoose } from '../../lib/orchestrationPatterns/util'

export interface OrchestrationSpec {
  title?:       string
  description?: string
  pattern?:     OrchestrationPattern
  prompt?:      string
  inputs?:      TwixyModuleParam[]
  members?:     OrchestrationMemberInput[]   // workflow leaf 또는 중첩 그룹(subPattern+children)
  config?:      OrchestrationConfig
}

interface Props {
  orchestrationId: string | null
  workflows:       TwixyWorkflow[]
  agents?:         TwixyAiAgent[]
  onApplySpec:     (spec: OrchestrationSpec) => Promise<void>
}

export function OrchestrationBuilderChat({ orchestrationId, workflows, agents, onApplySpec }: Props) {
  const { messages, isThinking, error, sendMessage, resetChat } = useOrchestrationClaw(orchestrationId, workflows, agents)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [messages, isThinking])

  const submit = () => { const t = draft.trim(); if (!t) return; setDraft(''); void sendMessage(t) }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, flex: 1 }}>Builder</span>
        <button onClick={resetChat} title="Reset chat" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>Reset</button>
      </header>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Ask me to compose an orchestration — e.g. <i>"run the SEO and copy workflows in parallel and synthesize"</i>. I reference your existing workflows as members.
          </div>
        )}
        {messages.map(m => {
          const spec = m.role === 'assistant' ? parseJsonLoose<OrchestrationSpec>(m.content) : null
          const hasSpec = spec && (spec.pattern || spec.members)
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '92%', fontSize: 11.5, lineHeight: 1.5, padding: '7px 10px', borderRadius: 8, whiteSpace: 'pre-wrap',
                background: m.role === 'user' ? 'var(--accent-dim)' : 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                color: m.role === 'user' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                {m.content}
              </div>
              {hasSpec && (
                <button onClick={() => void onApplySpec(spec!)}
                  style={{ background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: 11, fontWeight: 600, padding: '4px 12px', cursor: 'pointer' }}>
                  ✓ Apply spec{spec!.pattern ? ` (${spec!.pattern})` : ''}
                </button>
              )}
            </div>
          )
        })}
        {isThinking && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Thinking…</div>}
        {error && <div style={{ fontSize: 11, color: '#f85149' }}>{error}</div>}
      </div>

      <div style={{ borderTop: '1px solid var(--border-subtle)', padding: 8, display: 'flex', gap: 6 }}>
        <textarea value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // Korean/CJK IME: skip Enter that's ending a composition (would
            // otherwise submit AND leave the last jamo behind in the input).
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
          }}
          placeholder={orchestrationId ? 'Describe the orchestration…' : 'Select an orchestration first'}
          disabled={!orchestrationId}
          rows={2}
          style={{ flex: 1, resize: 'none', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12, padding: '6px 8px', outline: 'none', fontFamily: 'inherit' }} />
        <button onClick={submit} disabled={!draft.trim() || !orchestrationId}
          style={{ background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: 12, padding: '0 14px', cursor: !draft.trim() ? 'not-allowed' : 'pointer', opacity: !draft.trim() || !orchestrationId ? 0.5 : 1 }}>↑</button>
      </div>
    </div>
  )
}
