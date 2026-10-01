// ─────────────────────────────────────────────────────────────────────────────
// StaleCopyBanner.tsx — 팀 공유본에서 fork 한 사본에 "원본이 업데이트됨" 배지.
//
// 감지: workflow.sourceShared 가 있으면 공유본을 단건 조회해
//   shared.updated_at > copiedUpdatedAt 이면 배너 표시.
// "Get latest copy" 는 최신 스냅샷으로 새 사본을 생성한다 — 기존 사본은 건드리지
// 않는다 (non-destructive, 삭제 전파 B안과 일관). 원본이 사라졌거나(삭제) 팀에서
// 내려갔으면(archive) 조용히 숨김.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { getSharedById, recordSharedUse, logActivity, type SharedWorkflowRow } from '../../lib/sharedWorkflows'

interface Props {
  workflow: TwixyWorkflow | null
  orgIds:   string[]
  // 새 사본 생성 후 리스트 갱신 + 새 사본으로 전환.
  onCopied: (newId: string) => void
}

export function StaleCopyBanner({ workflow, orgIds, onCopied }: Props) {
  const [staleRow, setStaleRow] = useState<SharedWorkflowRow | null>(null)
  const [busy, setBusy] = useState(false)

  const src = workflow?.sourceShared

  useEffect(() => {
    let cancelled = false
    setStaleRow(null)
    if (!src?.sharedId || !orgIds.length) return
    getSharedById(src.sharedId)
      .then((row) => {
        // archive 된 원본은 unshare 된 것과 동일 취급 — 팀이 내려둔 템플릿이
        // 계속 "최신 받기" 를 조르면 안 된다.
        if (cancelled || !row || row.archived_at) return
        if ((row.updated_at ?? '') > src.copiedUpdatedAt) setStaleRow(row)
      })
      .catch(() => { /* 조회 실패는 무시 — 배너 없이 정상 동작 */ })
    return () => { cancelled = true }
  }, [src?.sharedId, src?.copiedUpdatedAt, orgIds])

  if (!workflow || !staleRow) return null

  async function getLatest() {
    if (!staleRow) return
    setBusy(true)
    try {
      const wf = staleRow.workflow_json
      const created = await window.twixy.workflowCreate({
        title:       wf.title,
        description: wf.description,
        prompt:      wf.prompt,
        inputs:      wf.inputs,
        type:        wf.type,
        outputDir:   wf.outputDir,
        nodes:       wf.nodes,
        sourceShared: { sharedId: staleRow.id, sourceWfId: staleRow.source_wf_id, copiedUpdatedAt: staleRow.updated_at },
      })
      void recordSharedUse(staleRow.id, 'copy').catch(() => {})
      void logActivity(staleRow.org_id, 'copied', { id: staleRow.source_wf_id, title: staleRow.title }).catch(() => {})
      setStaleRow(null)
      onCopied(created.id)
    } catch {
      /* 실패 시 배너 유지 — 재시도 가능 */
    } finally {
      setBusy(false)
    }
  }

  return (
    // NodeCanvas 툴바 바로 아래 전체폭 배너 (in-flow). absolute 오버레이 아님.
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      borderBottom: '1px solid var(--border-subtle)',
      background: 'var(--bg-elevated)',
      padding: '6px 16px',
      fontSize: 11,
    }}>
      <span style={{ color: 'var(--text-muted)' }}>
        Team original was updated {new Date(staleRow.updated_at).toLocaleDateString()} — this copy is behind.
      </span>
      <button
        onClick={getLatest}
        disabled={busy}
        title="Copy the latest team version as a new workflow (this copy stays unchanged)"
        style={{
          border: 'none', background: 'none', padding: 0,
          color: 'var(--accent, #4ea1ff)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
        }}
      >
        {busy ? 'Copying…' : 'Get latest copy'}
      </button>
    </div>
  )
}
