// ─────────────────────────────────────────────────────────────────────────────
// LiveCollabControls.tsx — 팀 실시간 공동편집 토글 버튼 + 상태 배너. (US-R1-04)
// 백엔드 supabase/live_workflows.sql, 동기화 useLiveWorkflow.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { createLiveWorkflow, deleteLiveWorkflow, listLiveWorkflows, joinLiveWorkflow, type LiveWorkflowRow } from '../../lib/liveWorkflows'
import type { NodeEditor } from '../../hooks/useLiveWorkflow'

// 라이브 토글 (NodeCanvas headerLeft 에 편입).
export function LiveEditButton({ workflow, orgId, userId, onLiveChange }: {
  workflow:     TwixyWorkflow | null
  orgId:        string | null
  userId:       string
  onLiveChange: (liveId: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  if (!workflow) return null
  const live = !!workflow.liveId

  async function toggle() {
    if (!workflow || !orgId) return
    setBusy(true)
    try {
      if (live && workflow.liveId) {
        await deleteLiveWorkflow(workflow.liveId).catch(() => {})
        onLiveChange(null)
      } else {
        const row = await createLiveWorkflow(orgId, workflow, userId)
        onLiveChange(row.id)
      }
    } catch { /* 무시 — 재시도 가능 */ } finally { setBusy(false) }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy || !orgId}
      title={orgId ? (live ? '함께 편집 종료' : '팀과 실시간 함께 편집') : '팀이 있어야 함께 편집 가능'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        border: `1px solid ${live ? 'var(--green, #16a34a)' : 'var(--border)'}`,
        background: live ? 'rgba(22,163,74,0.14)' : 'transparent',
        color: live ? 'var(--green, #16a34a)' : 'var(--text-muted)',
        borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 600,
        cursor: busy || !orgId ? 'default' : 'pointer', opacity: orgId ? 1 : 0.5,
      }}
    >
      {busy ? '…' : (live ? '● Live' : '함께 편집')}
    </button>
  )
}

// 팀 라이브 문서 목록 — 팀원이 "함께 편집 중"인 문서에 참여(join)해 편집기로 연다.
// 이미 로컬에 참여한 사본이 있으면 중복 생성 없이 그걸 연다.
export function LiveDocsStrip({ orgIds, onOpen }: { orgIds: string[]; onOpen: (id: string) => void }) {
  const [docs, setDocs] = useState<LiveWorkflowRow[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancel = false
    listLiveWorkflows(orgIds).then(r => { if (!cancel) setDocs(r) }).catch(() => {})
    return () => { cancel = true }
  }, [orgIds])

  if (!docs.length) return null

  async function open(row: LiveWorkflowRow) {
    setBusyId(row.id)
    try {
      const list = (await window.twixy?.workflowList?.()) ?? []
      const existing = Array.isArray(list) ? list.find(w => w.liveId === row.id) : undefined
      const localId = existing?.id ?? await joinLiveWorkflow(row)
      if (localId) onOpen(localId)
    } catch { /* 무시 */ } finally { setBusyId(null) }
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green, #16a34a)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        ● 함께 편집 중인 팀 문서
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {docs.map(d => (
          <button key={d.id} onClick={() => open(d)} disabled={busyId === d.id}
            style={{
              border: '1px solid var(--green, #16a34a)', background: 'rgba(22,163,74,0.10)',
              color: 'var(--text)', borderRadius: 8, padding: '6px 12px', fontSize: 12,
              cursor: busyId === d.id ? 'default' : 'pointer',
            }}>
            {busyId === d.id ? '여는 중…' : (d.title || '제목 없음')}
          </button>
        ))}
      </div>
    </div>
  )
}

// 라이브 상태 배너 (NodeCanvas banner 에 편입).
export function LiveEditBanner({ workflow, editors, meUserId }: {
  workflow: TwixyWorkflow | null
  editors:  NodeEditor[]
  meUserId: string
}) {
  if (!workflow?.liveId) return null
  const others = editors.filter(e => e.userId !== meUserId)
  const names = others.map(e => e.name || '익명').join(', ')
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      borderBottom: '1px solid var(--border-subtle)', background: 'rgba(22,163,74,0.10)',
      padding: '5px 16px', fontSize: 11, color: 'var(--text)',
    }}>
      <span style={{ color: 'var(--green, #16a34a)' }}>●</span>
      실시간 함께 편집 중 — 변경이 팀에 바로 반영됩니다.
      {others.length > 0 && <span style={{ color: 'var(--text-muted)' }}>· 지금 함께: {names}</span>}
    </div>
  )
}
