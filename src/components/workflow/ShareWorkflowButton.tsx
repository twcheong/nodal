// ─────────────────────────────────────────────────────────────────────────────
// ShareWorkflowButton.tsx — 워크플로를 팀에 "명시적 공유"/해제하는 컨트롤.
//
// 공유 = shared_workflows 에 workflow_json 스냅샷 upsert (renderer 직접, RLS 보호).
// 재공유(수정본 반영)는 같은 (org, owner, source_wf_id) 로 upsert 되어 스냅샷 갱신.
// 태그(콤마 구분)는 Team Dashboard 의 필터 칩이 된다 — 기존 공유면 프리필.
// 조직 미소속(primaryOrgId 없음)이면 아무것도 렌더하지 않는다.
//
// 팀에서 내리기는 "Archive"(되돌릴 수 있는 소프트 삭제)다. 영구 삭제는 org admin 이
// Team Dashboard 의 Archived 목록에서만 할 수 있다 — 여기엔 노출하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { shareWorkflow, setSharedArchived, findSharedRow, normalizeTags, logActivity } from '../../lib/sharedWorkflows'
import { useConfirm } from '../TwixyConfirm'
import { WorkflowDiffView } from './WorkflowDiffView'

interface Props {
  workflow:     TwixyWorkflow | null
  userId:       string
  userEmail:    string | null
  userName:     string | null
  orgIds:       string[]
  primaryOrgId: string | null
}

export function ShareWorkflowButton({ workflow, userId, userEmail, userName, orgIds, primaryOrgId }: Props) {
  // null = 공유 안 됨. archived = 공유됐지만 팀 갤러리에서 내려간 상태.
  const [shared, setShared] = useState<{ id: string; archived: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()
  // 태그는 WF 탭에서 지정하지 않는다(룰: Team Dashboard 에서만). 단, 기존 공유본을
  // "Update" 할 때 org 태그를 덮어쓰지 않도록 현재 태그를 보존해 그대로 재업로드한다.
  const [tags, setTags] = useState<string[]>([])
  // Update 팝업 (side-by-side diff). sharedSnapshot = 현재 공유본(=비교 좌측).
  const [updateOpen, setUpdateOpen] = useState(false)
  const [sharedSnapshot, setSharedSnapshot] = useState<TwixyWorkflow | null>(null)

  const wfId = workflow?.id

  // 워크플로 전환 시 현재 공유 여부 조회 (+기존 태그 프리필 — 보존용).
  // findSharedRow 는 archived 행도 돌려주는데 그게 맞다 — 걸러내면 owner 에게
  // "Share to team" 이 보이고, 보이지 않는 archived 행에 upsert 하게 된다.
  useEffect(() => {
    let cancelled = false
    setShared(null)
    setErr(null)
    setTags([])
    setUpdateOpen(false)
    setSharedSnapshot(null)
    if (!wfId || !orgIds.length) return
    findSharedRow(orgIds, userId, wfId)
      .then((row) => {
        if (cancelled) return
        setShared(row ? { id: row.id, archived: !!row.archived_at } : null)
        if (row?.tags?.length) setTags(row.tags)
      })
      .catch(() => { /* 조회 실패는 무시 — 공유 버튼은 여전히 동작 */ })
    return () => { cancelled = true }
  }, [wfId, orgIds, userId])

  if (!workflow || !primaryOrgId) return null

  // 실제 upsert (확인/모달 없이) — 공유·업데이트 공용.
  async function performShare() {
    if (!workflow || !primaryOrgId) return
    setBusy(true)
    setErr(null)
    try {
      await shareWorkflow(primaryOrgId, { id: userId, email: userEmail, name: userName }, workflow, normalizeTags(tags))
      const row = await findSharedRow(orgIds, userId, workflow.id)
      setShared(row ? { id: row.id, archived: !!row.archived_at } : null)
      void logActivity(primaryOrgId, 'shared', { id: workflow.id, title: workflow.title }, userName ?? userEmail).catch(() => {})
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // 신규 공유 — 간단 확인 후 바로 공유 (비교할 이전 버전이 없음).
  async function doShareNew() {
    if (!workflow) return
    const ok = await confirm({ title: 'Share to team', message: `Share "${workflow.title}" to your team?\n\nEveryone in your organization will see it in the Team Dashboard.`, confirmLabel: 'Share' })
    if (ok) await performShare()
  }

  // Update 팝업 열기 — 현재 공유본을 조회해 좌측(이전 버전)으로 둔다.
  async function openUpdate() {
    if (!workflow) return
    const cur = await findSharedRow(orgIds, userId, workflow.id)
    setSharedSnapshot(cur?.workflow_json ?? null)
    setUpdateOpen(true)
  }

  async function doUpdate() {
    await performShare()
    setUpdateOpen(false)
  }

  // 팀에서 내리기 — 되돌릴 수 있는 archive. 스냅샷도 버전 이력도 남는다.
  async function doArchive() {
    if (!shared) return
    const ok = await confirm({
      title: 'Archive from team?',
      message: `Remove "${workflow?.title ?? 'this workflow'}" from the Team Dashboard?\n\nTeammates will no longer see or copy it. Their existing copies are kept, and version history is preserved. You can restore it any time; only an admin can delete it permanently.`,
      confirmLabel: 'Archive',
    })
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      await setSharedArchived(shared.id, true)
      setShared({ id: shared.id, archived: true })
      setUpdateOpen(false)
      if (workflow && primaryOrgId) {
        void logActivity(primaryOrgId, 'archived', { id: workflow.id, title: workflow.title }, userName ?? userEmail).catch(() => {})
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // 보관 해제 — 스냅샷이 그대로 있으므로 재업로드 없이 플래그만 되돌린다.
  async function doRestore() {
    if (!shared) return
    setBusy(true)
    setErr(null)
    try {
      await setSharedArchived(shared.id, false)
      setShared({ id: shared.id, archived: false })
      if (workflow && primaryOrgId) {
        void logActivity(primaryOrgId, 'unarchived', { id: workflow.id, title: workflow.title }, userName ?? userEmail).catch(() => {})
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    // in-flow (NodeCanvas 툴바 헤더 슬롯).
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 10 }}>
      {shared?.archived ? (
        // 보관 상태 — 한 번 눌러 팀 갤러리로 되돌린다(재업로드 없음).
        <button onClick={doRestore} disabled={busy} title="This workflow is archived in the Team Dashboard — restore it for your team" style={btn}>
          {busy ? '…' : 'Archived · Re-share'}
        </button>
      ) : shared ? (
        // Update 는 팝업(diff+Archive)을 연다. Archive 는 팝업 안으로 이동.
        <button onClick={openUpdate} disabled={busy} title="Review changes and push to your team" style={btn}>
          {busy ? '…' : 'Shared ✓ · Update'}
        </button>
      ) : (
        // 바로 공유 — 태그는 공유 후 Team Dashboard 에서 지정한다.
        <button onClick={doShareNew} disabled={busy} title="Publish this workflow to your team (set tags later in Team Dashboard)" style={btn}>
          {busy ? 'Sharing…' : 'Share to team'}
        </button>
      )}
      {err && <span style={{ fontSize: 10, color: 'var(--red)' }}>{err}</span>}

      {/* Update 팝업 — [Shared now] vs [Your version] side-by-side + Unshare. */}
      {updateOpen && workflow && (
        <div
          onClick={() => { if (!busy) setUpdateOpen(false) }}
          style={{ position: 'fixed', inset: 0, zIndex: 990, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: 'min(940px, 96%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: '0 16px 48px rgba(0,0,0,0.4)', overflow: 'hidden', textAlign: 'left' }}
          >
            <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Update team copy</div>
                <button onClick={() => setUpdateOpen(false)} disabled={busy} title="Close" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: 0 }}>×</button>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>Review what will change, then push the update to your team.</div>
            </div>
            <div style={{ overflowY: 'auto', padding: '12px 14px 16px' }}>
              <WorkflowDiffView left={sharedSnapshot} right={workflow} leftLabel="Shared now" rightLabel="Your version (new)" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={doArchive} disabled={busy} title="Remove from the Team Dashboard (restorable)" style={{ ...btn, color: 'var(--red)', border: '1px solid var(--red)' }}>
                Archive
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={() => setUpdateOpen(false)} disabled={busy} style={btn}>Cancel</button>
              <button onClick={doUpdate} disabled={busy} style={{ ...btn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' }}>
                {busy ? '…' : 'Update'}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  )
}

const btn: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--bg-surface)',
  color: 'var(--text)',
  borderRadius: 7,
  padding: '5px 11px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
}

