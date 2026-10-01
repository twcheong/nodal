// ─────────────────────────────────────────────────────────────────────────────
// TeamDashboardPanel.tsx — 대시보드.
//
// 팀 소속 시: 팀원들이 "명시적 공유"한 워크플로를 자주 쓰는 순으로 보여주는 갤러리.
//   각 카드의 "Copy to my workflows" 는 공유 스냅샷을 내 디스크에 fork.
// 팀 미소속(솔로) 시: 본인 워크플로 + 오늘 사용량 통계를 보여준다(막다른 빈 화면 대신).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RunsDashboard } from './RunsDashboard'
import { ChatDrawer } from './ChatDrawer'
import { TagSelectMenu } from './workflow/TagSelectMenu'
import { WorkflowDiffView, WorkflowNodeList } from './workflow/WorkflowDiffView'
import { markWorkflowNew } from '../lib/workflowDots'
import { Tooltip } from './Tooltip'
import { listOrgMembers, type OrgMemberRow } from '../lib/orgMembers'
import { InviteManager, JoinTeamBox } from './TeamInvite'
import { LiveDocsStrip } from './workflow/LiveCollabControls'
import { usePresence, type PresenceStatus } from '../hooks/usePresence'
import {
  unreadCounts,
  subscribeIncomingDMs,
  unsubscribeChannel,
  type DirectMessageRow,
} from '../lib/directMessages'
import { useConfirm } from './TwixyConfirm'
import { DisplayCost } from '../lib/useDisplayUsd'
import {
  listSharedForOrgs,
  rankShared,
  recordSharedUse,
  logActivity,
  listActivity,
  updateSharedTags,
  updateSharedMeta,
  setSharedArchived,
  deleteSharedWorkflow,
  listSharedVersions,
  DEFAULT_TAGS,
  type SharedWorkflowRow,
  type SharedVersionRow,
  type OrgActivityRow,
  type OrgActivityAction,
} from '../lib/sharedWorkflows'

interface Usage {
  usdToday:      number
  tokensToday:   number
  messagesToday: number
}

interface Props {
  userId:     string
  // 활동 피드에 찍히는 표시 이름 (없으면 이메일 fallback 을 상위에서 넘김).
  userName?:  string | null
  orgIds:     string[]
  // 그 중 내가 admin 인 org — 공유본 영구 삭제 권한 판정(행의 org_id 로 대조).
  adminOrgIds: string[]
  orgLoading: boolean
  // 복사 완료 후 워크플로 리스트를 갱신하도록 상위에 알림.
  onCopied?: () => void
  // 솔로 뷰에서 카드를 눌러 워크플로 에디터로 이동.
  onOpenWorkflow?: (id: string) => void
  // 본인 통계용 오늘 사용량(선택).
  usage?: Usage
  // Runs 대시보드 (Epic 2) — App 브리지에서 내려오는 라이브 run + 제어.
  liveRuns?:    Record<string, import('../hooks/useWorkflowTest').WorkflowTestState>
  workflows?:   TwixyWorkflow[]
  onStopRun?:   (wfId: string) => void
  onResumeRun?: (wf: TwixyWorkflow) => void
  onRetryFromNode?: (wf: TwixyWorkflow, nodeId: string) => void
  // 초대 수락/발급으로 org 소속이 바뀌면 상위 useOrg 를 갱신.
  onOrgChanged?: () => void
}

export function TeamDashboardPanel({ userId, userName, orgIds, adminOrgIds, orgLoading, onCopied, onOpenWorkflow, usage, liveRuns, workflows, onStopRun, onResumeRun, onRetryFromNode, onOrgChanged }: Props) {
  const hasTeam = orgIds.length > 0

  // ── 친구 레일 상태 (org 단위: 멤버 로스터 + 온라인 presence + 1:1 DM) ──────
  // 대시보드 본문과 별개로 우측에 고정 표시. 이 컴포넌트는 App 의 display 토글로
  // 항상 마운트라 presence/인박스 구독이 다른 탭에서도 유지된다("온라인"=앱 실행중).
  const primaryOrgId = orgIds[0] ?? null
  // 내 상태(online/busy/offline) — 레일 헤더에서 선택, localStorage 유지.
  const [myStatus, setMyStatus] = useState<PresenceStatus>(
    () => (localStorage.getItem('twixy.presence.status') as PresenceStatus) || 'online',
  )
  const setStatus = (s: PresenceStatus) => { setMyStatus(s); localStorage.setItem('twixy.presence.status', s) }
  const statuses = usePresence(primaryOrgId, userId, userName ?? null, myStatus)
  // 레일 열닫 — localStorage 유지.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('twixy.friendsRail.open') !== 'false')
  const toggleRail = () => setRailOpen(v => { localStorage.setItem('twixy.friendsRail.open', String(!v)); return !v })
  const [members, setMembers] = useState<OrgMemberRow[]>([])
  const [chatPeer, setChatPeer] = useState<OrgMemberRow | null>(null)
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [lastIncoming, setLastIncoming] = useState<DirectMessageRow | null>(null)
  const chatPeerRef = useRef(chatPeer)
  chatPeerRef.current = chatPeer

  const reloadMembers = () => { listOrgMembers().then(setMembers).catch(() => {}) }
  useEffect(() => {
    if (!hasTeam) { setMembers([]); return }
    reloadMembers()
  }, [hasTeam, orgIds])
  // 초대 발급/취소·멤버 변동 후 갱신. 본인이 admin 이어야 초대 UI 노출.
  const isAdmin = members.find(m => m.user_id === userId)?.role === 'admin'
  const onTeamChanged = () => { reloadMembers(); onOrgChanged?.() }

  useEffect(() => {
    if (!userId || !hasTeam) return
    unreadCounts(userId).then(setUnread).catch(() => {})
    const ch = subscribeIncomingDMs(userId, (m) => {
      setLastIncoming(m)
      // 대화창이 열려 있는 상대면 ChatDrawer 가 즉시 읽음 처리 — 배지 스킵.
      if (chatPeerRef.current?.user_id !== m.sender_id) {
        setUnread(prev => ({ ...prev, [m.sender_id]: (prev[m.sender_id] ?? 0) + 1 }))
      }
    })
    return () => unsubscribeChannel(ch)
  }, [userId, hasTeam])

  function openChat(m: OrgMemberRow) {
    setChatPeer(m)
    setUnread(prev => ({ ...prev, [m.user_id]: 0 }))
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      {/* 본문 (좌/중앙, 스크롤) */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px', minWidth: 0 }}>
        {orgLoading ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>
        ) : (
          <>
            <RunsDashboard
              userId={userId}
              orgIds={orgIds}
              liveRuns={liveRuns ?? {}}
              workflows={workflows ?? []}
              onStopRun={onStopRun ?? (() => {})}
              onResumeRun={onResumeRun ?? (() => {})}
              onRetryFromNode={onRetryFromNode}
              onOpenWorkflow={onOpenWorkflow}
            />
            {hasTeam ? (
              <TeamView userId={userId} userName={userName ?? null} orgIds={orgIds} adminOrgIds={adminOrgIds} onCopied={onCopied} onOpenWorkflow={onOpenWorkflow} />
            ) : (
              <PersonalView onOpenWorkflow={onOpenWorkflow} usage={usage} onJoined={onOrgChanged} />
            )}
          </>
        )}
      </div>

      {/* 우측 고정 친구 레일 — 팀 소속일 때만. 열닫 토글. */}
      {hasTeam && !orgLoading && (
        <FriendsRail
          members={members}
          userId={userId}
          userName={userName ?? null}
          statuses={statuses}
          myStatus={myStatus}
          onSetStatus={setStatus}
          unread={unread}
          onChat={openChat}
          open={railOpen}
          onToggle={toggleRail}
          orgId={primaryOrgId}
          isAdmin={isAdmin}
          onInviteChanged={onTeamChanged}
        />
      )}

      {/* 채팅 드로어 (레일 위로 슬라이드-인) */}
      {chatPeer && (
        <ChatDrawer
          userId={userId}
          peer={chatPeer}
          status={statuses.get(chatPeer.user_id) ?? 'offline'}
          incoming={lastIncoming}
          onClose={() => setChatPeer(null)}
        />
      )}
    </div>
  )
}

// ── 팀 뷰 (공유 갤러리) ──────────────────────────────────────────────────────
function TeamView({
  userId,
  userName,
  orgIds,
  adminOrgIds,
  onCopied,
  onOpenWorkflow,
}: {
  userId: string
  userName: string | null
  orgIds: string[]
  adminOrgIds: string[]
  onCopied?: () => void
  onOpenWorkflow?: (id: string) => void
}) {
  const [rows, setRows] = useState<SharedWorkflowRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 클라이언트 필터 — 행 수가 팀 갤러리 규모(수십)라 서버 쿼리 불필요.
  const [query, setQuery] = useState('')
  // 멀티태그 필터 — 선택 칩들의 교집합(AND)으로 좁힌다.
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set())
  const toggleTag = (t: string) => setActiveTags(prev => {
    const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n
  })
  // 카드 클릭 → 워크플로 노드 상세 모달.
  const [detailRow, setDetailRow] = useState<SharedWorkflowRow | null>(null)
  // 활동 피드 — 로드 실패는 무시(피드는 부가 기능, 갤러리는 계속 동작).
  const [activity, setActivity] = useState<OrgActivityRow[]>([])
  // 확인 다이얼로그는 뷰 레벨에 하나만 — 카드마다 훅을 두지 않는다.
  const { confirm, confirmDialog } = useConfirm()
  // 관리 동작 실패 메시지(archive/삭제/편집) — 카드 상태와 분리해 상단에 표시.
  const [adminErr, setAdminErr] = useState<string | null>(null)
  // Archived 섹션 열닫 — localStorage 유지(친구 레일과 동일 패턴).
  const [archivedOpen, setArchivedOpen] = useState(
    () => localStorage.getItem('twixy.team.archivedOpen') === 'true',
  )
  const toggleArchived = () => setArchivedOpen(v => {
    localStorage.setItem('twixy.team.archivedOpen', String(!v)); return !v
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listSharedForOrgs(orgIds)
      setRows(rankShared(list))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
    listActivity(orgIds).then(setActivity).catch(() => {})
  }, [orgIds])

  useEffect(() => {
    void load()
  }, [load])

  // 활성 / 보관 분리 — 한 번의 조회로 받아 클라이언트에서 가른다.
  const activeRows = useMemo(() => rows.filter(r => !r.archived_at), [rows])
  const archivedRows = useMemo(
    () => rows.filter(r => r.archived_at)
              .sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? '')),
    [rows],
  )

  // ── 관리 동작 (org 멤버 누구나: archive/복구/메타 편집 · admin: 영구 삭제) ──
  // 성공 후에만 활동 피드에 기록한다 — 실패한 삭제가 유령 항목을 남기지 않도록.
  const runAction = useCallback(async (
    row: SharedWorkflowRow,
    action: OrgActivityAction,
    fn: () => Promise<void>,
  ) => {
    setAdminErr(null)
    try {
      await fn()
      void logActivity(row.org_id, action, { id: row.source_wf_id, title: row.title }, userName).catch(() => {})
      void load()
    } catch (e) {
      setAdminErr(e instanceof Error ? e.message : String(e))
    }
  }, [load, userName])

  const archiveRow = useCallback(async (row: SharedWorkflowRow) => {
    const ok = await confirm({
      title: 'Archive from team?',
      message: `Remove "${row.title}" from the Team Dashboard?\n\nTeammates will no longer see or copy it. Their existing copies are kept, and version history is preserved. Anyone on the team can restore it from the Archived list.`,
      confirmLabel: 'Archive',
    })
    if (!ok) return
    await runAction(row, 'archived', () => setSharedArchived(row.id, true))
  }, [confirm, runAction])

  const restoreRow = useCallback(
    (row: SharedWorkflowRow) => runAction(row, 'unarchived', () => setSharedArchived(row.id, false)),
    [runAction],
  )

  const deleteRow = useCallback(async (row: SharedWorkflowRow) => {
    const ok = await confirm({
      title: 'Delete permanently?',
      message: `Permanently delete "${row.title}" and its entire version history?\n\nThis can't be undone. Teammates' existing copies on their own disks are kept.`,
      danger: true, confirmLabel: 'Delete permanently',
    })
    if (!ok) return
    await runAction(row, 'deleted', () => deleteSharedWorkflow(row.id))
  }, [confirm, runAction])

  const saveMeta = useCallback(
    (row: SharedWorkflowRow, patch: { title: string; description: string }) =>
      runAction(row, 'edited', () => updateSharedMeta(row.id, patch)),
    [runAction],
  )

  // 태그 필터 칩은 활성 행 기준 — 보관된 행에만 있는 태그가 죽은 칩으로 남지 않도록.
  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const r of activeRows) for (const t of r.tags ?? []) s.add(t)
    return [...s].sort()
  }, [activeRows])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return activeRows.filter((r) => {
      // 선택된 태그를 모두 가진 행만(AND 교집합).
      if (activeTags.size && ![...activeTags].every(t => (r.tags ?? []).includes(t))) return false
      if (!q) return true
      return (
        r.title.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q) ||
        (r.owner_name ?? '').toLowerCase().includes(q)
      )
    })
  }, [activeRows, query, activeTags])

  return (
    <>
      <Header
        title="Team Dashboard"
        subtitle="Workflows your teammates shared — most used first. Copy any into your own to run and edit."
        onRefresh={() => void load()}
      />
      {/* 팀 실시간 공동편집 문서 — 클릭해 참여+편집기로 열기 (US-R1-04) */}
      {onOpenWorkflow && <LiveDocsStrip orgIds={orgIds} onOpen={onOpenWorkflow} />}
      {adminErr && (
        <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 10 }}>{adminErr}</div>
      )}
      {(activeRows.length > 0 || query || activeTags.size > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workflows…"
            style={{
              border: '1px solid var(--border)', background: 'var(--bg-surface)',
              color: 'var(--text)', borderRadius: 7, padding: '5px 10px',
              fontSize: 12, width: 220, outline: 'none',
            }}
          />
          {allTags.map((t) => (
            <button
              key={t}
              onClick={() => toggleTag(t)}
              style={{
                border: '1px solid var(--border)',
                background: activeTags.has(t) ? 'var(--accent, #0d5c50)' : 'var(--bg-surface)',
                color: activeTags.has(t) ? '#fff' : 'var(--text-muted)',
                borderRadius: 20, padding: '3px 10px', fontSize: 11, cursor: 'pointer',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>
      ) : error ? (
        <p style={{ color: 'var(--red)', fontSize: 13 }}>Error: {error}</p>
      ) : activeRows.length === 0 ? (
        <EmptyState
          title="No shared workflows yet"
          body="Open a workflow and click “Share to team” to publish it. It'll appear here for everyone on your team."
        />
      ) : visible.length === 0 ? (
        <EmptyState title="No matches" body="No shared workflows match your search or tag filter." />
      ) : (
        <Grid>
          {visible.map((row) => (
            <SharedCard
              key={row.id}
              row={row}
              isOwner={row.owner_user_id === userId}
              isAdmin={adminOrgIds.includes(row.org_id)}
              actorName={userName}
              orgTags={allTags}
              onOpenDetail={() => setDetailRow(row)}
              onTagsChanged={() => void load()}
              onArchive={() => void archiveRow(row)}
              onEditMeta={(patch) => saveMeta(row, patch)}
              onCopied={() => {
                void load()
                onCopied?.()
              }}
            />
          ))}
        </Grid>
      )}
      {/* 보관함 — 필터 칩이 아니라 접힌 별도 구역. 영구 삭제(admin)가 여기에만
          있으므로 "다른 장소"처럼 보이는 편이 2단계 삭제의 의미를 살린다. */}
      {!loading && !error && archivedRows.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <button
            onClick={toggleArchived}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent',
              color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0,
            }}
          >
            <span style={{ fontSize: 9 }}>{archivedOpen ? '▾' : '▸'}</span>
            Archived ({archivedRows.length})
          </button>
          {archivedOpen && (
            <div style={{ marginTop: 12 }}>
              <Grid>
                {archivedRows.map((row) => (
                  <SharedCard
                    key={row.id}
                    row={row}
                    archived
                    isOwner={row.owner_user_id === userId}
                    isAdmin={adminOrgIds.includes(row.org_id)}
                    actorName={userName}
                    orgTags={allTags}
                    onOpenDetail={() => setDetailRow(row)}
                    onTagsChanged={() => void load()}
                    onRestore={() => void restoreRow(row)}
                    onDelete={() => void deleteRow(row)}
                    onCopied={() => {
                      void load()
                      onCopied?.()
                    }}
                  />
                ))}
              </Grid>
            </div>
          )}
        </div>
      )}
      {detailRow && (
        <SharedWorkflowDetailModal row={detailRow} onClose={() => setDetailRow(null)} />
      )}
      <ActivityFeed rows={activity} userId={userId} />
      {confirmDialog}
    </>
  )
}

// ── 친구 레일 (우측 고정, 게임 친구목록식, 열닫 가능) ─────────────────────────
// 상단: 내 상태 선택기(online/busy/offline). 아래: 팀원 online/offline 그룹.
// 상태 = presence track. offline = appear-offline. presence 미등록 = 진짜 오프라인.
const STATUS_COLOR: Record<PresenceStatus, string> = {
  online:  'var(--green, #0d5c50)',
  busy:    '#e0a11b',
  offline: 'var(--text-muted)',
}
const STATUS_LABEL: Record<PresenceStatus, string> = { online: 'Online', busy: 'Busy', offline: 'Appear offline' }

function FriendsRail({
  members, userId, userName, statuses, myStatus, onSetStatus, unread, onChat, open, onToggle,
  orgId, isAdmin, onInviteChanged,
}: {
  members: OrgMemberRow[]
  userId: string
  userName: string | null
  statuses: Map<string, PresenceStatus>
  myStatus: PresenceStatus
  onSetStatus: (s: PresenceStatus) => void
  unread: Record<string, number>
  onChat: (m: OrgMemberRow) => void
  open: boolean
  onToggle: () => void
  orgId: string | null
  isAdmin: boolean
  onInviteChanged?: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  // 팀원(나 제외) dedup + 정렬 (안읽음 → 이름).
  const peers = useMemo(() => {
    const seen = new Map<string, OrgMemberRow>()
    for (const m of members) if (m.user_id !== userId && !seen.has(m.user_id)) seen.set(m.user_id, m)
    return [...seen.values()].sort((a, b) => {
      const ua = unread[a.user_id] ?? 0, ub = unread[b.user_id] ?? 0
      if (ua !== ub) return ub - ua
      return (a.display_name || a.email || '').localeCompare(b.display_name || b.email || '')
    })
  }, [members, unread, userId])

  // 접속(online/busy) vs 오프라인. 내가 offline 이어도 남에겐 안 보이는 건 track 레벨.
  const isActive = (uid: string) => { const s = statuses.get(uid); return s === 'online' || s === 'busy' }
  const activePeers  = peers.filter(m => isActive(m.user_id))
  const offlinePeers = peers.filter(m => !isActive(m.user_id))
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0)

  // ── 접힘 상태: 얇은 스트립(펼치기 버튼 + 접속 아바타 도트) ──
  if (!open) {
    return (
      <aside style={{
        width: 48, flexShrink: 0, borderLeft: '1px solid var(--border)', background: 'var(--bg-surface)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0', gap: 8,
      }}>
        <button onClick={onToggle} title="Show team" style={{
          border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text)',
          borderRadius: 7, width: 30, height: 26, cursor: 'pointer', fontSize: 12, position: 'relative',
        }}>
          ‹
          {totalUnread > 0 && (
            <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 14, height: 14, borderRadius: 7,
              background: 'var(--red)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '0 3px',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {totalUnread > 99 ? '99+' : totalUnread}
            </span>
          )}
        </button>
        {activePeers.slice(0, 8).map(m => (
          <Avatar key={m.user_id} label={m.display_name || m.email || 'Member'}
            status={statuses.get(m.user_id) ?? 'offline'} size={30}
            badge={unread[m.user_id] ?? 0} onClick={() => onChat(m)} />
        ))}
      </aside>
    )
  }

  return (
    <aside style={{
      width: 232, flexShrink: 0, borderLeft: '1px solid var(--border)',
      background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* 헤더 + 접기 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 12px 8px' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Team</span>
        <button onClick={onToggle} title="Collapse" style={{
          border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-muted)',
          borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 12,
        }}>›</button>
      </div>

      {/* 내 상태 선택기 */}
      <div style={{ position: 'relative', padding: '0 8px 8px', borderBottom: '1px solid var(--border)' }}>
        <div
          onClick={() => setMenuOpen(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px', borderRadius: 8, cursor: 'pointer' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-base)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          title="Set your status"
        >
          <Avatar label={userName || 'Me'} status={myStatus} size={30} badge={0} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userName || 'Me'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              <span style={{ color: STATUS_COLOR[myStatus] }}>●</span> {STATUS_LABEL[myStatus]} ▾
            </div>
          </div>
        </div>
        {menuOpen && (
          <div style={{
            position: 'absolute', left: 8, right: 8, top: '100%', zIndex: 10, marginTop: -4,
            background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 6px 20px rgba(0,0,0,0.25)', overflow: 'hidden',
          }}>
            {(['online', 'busy', 'offline'] as PresenceStatus[]).map(s => (
              <div key={s} onClick={() => { onSetStatus(s); setMenuOpen(false) }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 12, cursor: 'pointer',
                         color: 'var(--text)', background: s === myStatus ? 'var(--bg-surface)' : 'transparent' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-surface)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = s === myStatus ? 'var(--bg-surface)' : 'transparent' }}>
                <span style={{ color: STATUS_COLOR[s], fontSize: 10 }}>●</span> {STATUS_LABEL[s]}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 팀원 목록 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
        {/* admin 은 앱에서 직접 초대 코드 발급 (웹 admin 위임 제거) */}
        {isAdmin && orgId && <InviteManager orgId={orgId} onChanged={onInviteChanged} />}
        {peers.length === 0 && !isAdmin && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 10px', lineHeight: 1.5 }}>
            No teammates yet. Ask an admin for an invite code.
          </div>
        )}
        {activePeers.length > 0 && <RailGroup label={`Online — ${activePeers.length}`} />}
        {activePeers.map(m => (
          <FriendRow key={m.user_id} m={m} status={statuses.get(m.user_id) ?? 'online'} badge={unread[m.user_id] ?? 0} onChat={onChat} />
        ))}
        {offlinePeers.length > 0 && <RailGroup label={`Offline — ${offlinePeers.length}`} />}
        {offlinePeers.map(m => (
          <FriendRow key={m.user_id} m={m} status="offline" badge={unread[m.user_id] ?? 0} onChat={onChat} />
        ))}
      </div>
    </aside>
  )
}

function RailGroup({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase',
                  letterSpacing: 0.5, padding: '10px 10px 4px' }}>
      {label}
    </div>
  )
}

function Avatar({ label, status, size, badge, onClick }: {
  label: string; status: PresenceStatus; size: number; badge: number; onClick?: () => void
}) {
  const initials = label.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join('') || '?'
  const dot = Math.round(size * 0.34)
  return (
    <span style={{ position: 'relative', width: size, height: size, flexShrink: 0, cursor: onClick ? 'pointer' : 'default' }} onClick={onClick} title={onClick ? `Message ${label}` : undefined}>
      <span style={{
        width: size, height: size, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--accent, #0d5c50)', color: '#fff', fontSize: size * 0.4, fontWeight: 700,
      }}>
        {initials}
      </span>
      <span style={{
        position: 'absolute', right: -1, bottom: -1, width: dot, height: dot, borderRadius: '50%',
        border: '2px solid var(--bg-surface)', background: STATUS_COLOR[status],
      }} />
      {badge > 0 && (
        <span style={{ position: 'absolute', top: -4, right: -4, minWidth: 14, height: 14, borderRadius: 7, padding: '0 3px',
          background: 'var(--red)', color: '#fff', fontSize: 9, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </span>
  )
}

function FriendRow({ m, status, badge, onChat }: {
  m: OrgMemberRow; status: PresenceStatus; badge: number; onChat: (m: OrgMemberRow) => void
}) {
  const label = m.display_name || m.email || 'Member'
  const active = status === 'online' || status === 'busy'
  return (
    <div
      title={`Message ${label}`}
      onClick={() => onChat(m)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '6px 10px', borderRadius: 8,
        cursor: 'pointer', opacity: active ? 1 : 0.55,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-base)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <Avatar label={label} status={status} size={28} badge={0} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {m.role === 'admin' ? 'Admin · ' : ''}{status === 'busy' ? 'Busy' : active ? 'Online' : 'Offline'}
        </div>
      </div>
      {badge > 0 && (
        <span style={{
          minWidth: 17, height: 17, borderRadius: 9, padding: '0 5px',
          background: 'var(--red)', color: '#fff', fontSize: 10, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </div>
  )
}

// ── 활동 피드 ────────────────────────────────────────────────────────────────
const ACTION_LABEL: Record<OrgActivityAction, string> = {
  shared:     'shared',
  unshared:   'unshared',
  copied:     'copied',
  run:        'ran',
  archived:   'archived',
  unarchived: 'restored',
  deleted:    'permanently deleted',
  edited:     'edited',
}

function ActivityFeed({ rows, userId }: { rows: OrgActivityRow[]; userId: string }) {
  const [filter, setFilter] = useState<OrgActivityAction | null>(null)
  if (!rows.length) return null
  const visible = filter ? rows.filter((r) => r.action === filter) : rows
  const kinds = [...new Set(rows.map((r) => r.action))]
  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Recent activity</div>
        {kinds.length > 1 && kinds.map((k) => (
          <button
            key={k}
            onClick={() => setFilter(filter === k ? null : k)}
            style={{
              border: '1px solid var(--border)',
              background: filter === k ? 'var(--accent, #0d5c50)' : 'var(--bg-surface)',
              color: filter === k ? '#fff' : 'var(--text-muted)',
              borderRadius: 20, padding: '2px 9px', fontSize: 10, cursor: 'pointer',
            }}
          >
            {ACTION_LABEL[k]}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map((r) => (
          <div key={r.id} style={{ display: 'flex', gap: 6, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>
              {r.actor_user_id === userId ? 'You' : r.actor_name || 'Teammate'}
            </span>
            <span>{ACTION_LABEL[r.action] ?? r.action}</span>
            <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
              {r.target_title || r.target_id || 'a workflow'}
            </span>
            <span style={{ opacity: 0.7 }}>· {timeAgo(r.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 개인 뷰 (팀 미소속) ─────────────────────────────────────────────────────
function PersonalView({
  onOpenWorkflow,
  usage,
  onJoined,
}: {
  onOpenWorkflow?: (id: string) => void
  usage?: Usage
  onJoined?: () => void
}) {
  const [workflows, setWorkflows] = useState<TwixyWorkflow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = (await window.twixy?.workflowList?.()) ?? []
      setWorkflows(Array.isArray(list) ? list : [])
    } catch {
      setWorkflows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const totalSteps = useMemo(
    () => workflows.reduce((sum, w) => sum + (w.nodes?.length ?? 0), 0),
    [workflows],
  )

  const recent = useMemo(
    () => [...workflows].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    [workflows],
  )

  const tokensLabel = usage
    ? usage.tokensToday >= 1000
      ? `${(usage.tokensToday / 1000).toFixed(1)}K`
      : String(usage.tokensToday)
    : '—'

  return (
    <>
      <Header
        title="Your Dashboard"
        subtitle="Your workflows and today's activity. Join or create a team to share workflows with colleagues."
        onRefresh={() => void load()}
      />

      {/* 무팀 유저가 초대 코드로 팀 가입 */}
      <JoinTeamBox onJoined={onJoined} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 22 }}>
        <Stat label="Workflows" value={String(workflows.length)} />
        <Stat label="Total steps" value={String(totalSteps)} />
        {/* usdToday 는 RAW 원가(openrouter_usd_today) — 표시 전 markup 필요. */}
        {usage && <Stat label="Spent today" value={<DisplayCost rawUsd={usage.usdToday} showZero />} />}
        {usage && <Stat label="Tokens today" value={tokensLabel} />}
        {usage && <Stat label="Messages today" value={String(usage.messagesToday)} />}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>Your workflows</div>
      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>
      ) : recent.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          body="Head to the Workflow tab to build your first one — it'll show up here."
        />
      ) : (
        <Grid>
          {recent.map((wf) => (
            <PersonalCard key={wf.id} wf={wf} onOpen={onOpenWorkflow ? () => onOpenWorkflow(wf.id) : undefined} />
          ))}
        </Grid>
      )}
    </>
  )
}

// ── 공통 조각 ────────────────────────────────────────────────────────────────
// 상대시간 라벨 — 카드 메타용이라 대략적인 단위면 충분하다.
// UTC 타임스탬프를 사용자 로컬 시간대로 포맷 (tz 이름 표기). created_at 은
// timestamptz(UTC) — tz 지정자가 없으면 UTC 로 간주해 로컬로 변환한다.
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z'
  const d = new Date(norm)
  if (!Number.isFinite(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  })
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

function Header({ title, subtitle, onRefresh }: { title: string; subtitle: string; onRefresh: () => void }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{title}</h1>
        <button onClick={onRefresh} style={ghostBtn}>Refresh</button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0, marginBottom: 20 }}>{subtitle}</p>
    </>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ ...card, padding: '12px 16px', minWidth: 120, flex: '0 0 auto' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', marginTop: 4 }}>{value}</div>
    </div>
  )
}

function PersonalCard({ wf, onOpen }: { wf: TwixyWorkflow; onOpen?: () => void }) {
  const nodeCount = wf.nodes?.length ?? 0
  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3 }}>{wf.title}</div>
      {wf.description && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.45, maxHeight: 54, overflow: 'hidden' }}>
          {wf.description}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 10, fontSize: 11, color: 'var(--text-muted)', opacity: 0.8 }}>
        <span>{nodeCount} step{nodeCount === 1 ? '' : 's'}</span>
        {wf.updatedAt && (<><span>·</span><span>updated {wf.updatedAt.slice(0, 10)}</span></>)}
      </div>
      {onOpen && (
        <div style={{ marginTop: 12 }}>
          <button onClick={onOpen} style={primaryBtn}>Open</button>
        </div>
      )}
    </div>
  )
}

// 공유 워크플로 카드. 공유본은 팀 공용 자산이라 태그·제목·설명 편집과 archive 는
// owner 가 아니어도 누구나 할 수 있다. 영구 삭제만 admin 전용이고, 그것도 보관함
// (archived) 안에서만 노출된다.
function SharedCard({
  row,
  isOwner,
  isAdmin,
  archived,
  actorName,
  orgTags,
  onOpenDetail,
  onTagsChanged,
  onArchive,
  onRestore,
  onDelete,
  onEditMeta,
  onCopied,
}: {
  row: SharedWorkflowRow
  isOwner: boolean
  isAdmin: boolean
  archived?: boolean
  actorName: string | null
  orgTags: string[]
  onOpenDetail: () => void
  onTagsChanged: () => void
  onArchive?: () => void
  onRestore?: () => void
  onDelete?: () => void
  onEditMeta?: (patch: { title: string; description: string }) => void
  onCopied: () => void
}) {
  const [state, setState] = useState<'idle' | 'copying' | 'done' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState<string | null>(null)
  // 태그 — 칩 클릭 시 옵션 팝오버, 옵션 클릭 즉시 저장(Done 없음).
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const [tagBusy, setTagBusy] = useState(false)
  // ⋯ 관리 메뉴 + 제목/설명 편집 모달.
  const [menuOpen, setMenuOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)

  const currentTags = row.tags ?? []
  // 옵션 = 기본 팔레트 ∪ org 에서 쓰인 태그 (소문자·중복 제거). max N 이라 다중.
  const tagOptions = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = []
    for (const t of [...DEFAULT_TAGS, ...orgTags]) {
      const n = t.trim().toLowerCase()
      if (n && !seen.has(n)) { seen.add(n); out.push(n) }
    }
    return out
  }, [orgTags])

  // 옵션 클릭 → 해당 태그 토글(있으면 제거, 없으면 추가). 즉시 저장. org 저장이 진실.
  async function saveTag(tag: string) {
    const cur = row.tags ?? []
    const next = cur.includes(tag) ? cur.filter(t => t !== tag) : [...cur, tag]
    setTagBusy(true)
    try {
      await updateSharedTags(row.id, next)
      // org 우선권: 태그는 Team Dashboard(org)에서만 지정 가능. owner 의 로컬
      // 워크플로 파일(wf.tags)로 단방향 write-back → WF 탭은 읽기 전용 표시/필터만.
      if (isOwner && row.source_wf_id) {
        void Promise.resolve(window.twixy?.workflowUpdate?.(row.source_wf_id, { tags: next })).catch(() => {})
      }
      onTagsChanged()             // 부모 재로드 → 필터 칩/카드 동기화
      // 멀티 선택이라 메뉴는 열어둔다 — 바깥 클릭으로 닫힘.
    } catch {
      /* 실패 시 팝오버 유지 — 재시도 가능 */
    } finally {
      setTagBusy(false)
    }
  }

  async function copy() {
    setState('copying')
    setErrMsg(null)
    try {
      const wf = row.workflow_json
      const created = await window.twixy.workflowCreate({
        // 제목·설명은 row 레벨(팀이 큐레이션한) 값을 우선한다 — 메타 편집은
        // workflow_json 을 건드리지 않으므로 스냅샷 안의 값은 옛 이름일 수 있다.
        title:       row.title || wf.title,
        description: row.description ?? wf.description,
        prompt:      wf.prompt,
        inputs:      wf.inputs,
        type:        wf.type,
        outputDir:   wf.outputDir,
        nodes:       wf.nodes,
        // 원본 참조 — 공유본이 재공유(갱신)되면 이 사본에 "Update available" 배지를 띄우는 근거.
        sourceShared: { sharedId: row.id, sourceWfId: row.source_wf_id, copiedUpdatedAt: row.updated_at },
      })
      // 새 복사본 → WF/CT 리스트에 초록 점(new). 열면 회색으로.
      if (created?.id) markWorkflowNew(created.id)
      void recordSharedUse(row.id, 'copy').catch(() => {})
      void logActivity(row.org_id, 'copied', { id: row.source_wf_id, title: row.title }, actorName).catch(() => {})
      setState('done')
      onCopied()
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }

  const nodeCount = row.workflow_json?.nodes?.length ?? 0

  return (
    <div
      style={{ ...card, cursor: 'pointer', ...(archived ? { opacity: 0.62 } : {}) }}
      onClick={onOpenDetail}
      title="View workflow steps"
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3 }}>{row.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {row.copy_count > 0 && (
            <Tooltip text="Times copied by teammates">
              <span style={badge}>★ {row.copy_count}</span>
            </Tooltip>
          )}
          {/* 관리 메뉴 — 활성 카드에만. 보관 카드는 하단의 Restore/Delete 로 다룬다. */}
          {!archived && (onEditMeta || onArchive) && (
            <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
              <button
                onClick={() => setMenuOpen(v => !v)}
                title="Manage this shared workflow"
                style={{
                  border: 'none', background: 'transparent', color: 'var(--text-muted)',
                  fontSize: 14, lineHeight: 1, cursor: 'pointer', padding: '0 2px',
                }}
              >
                ⋯
              </button>
              {menuOpen && (
                <>
                  <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 41, minWidth: 148,
                    background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: 4,
                  }}>
                    {onEditMeta && (
                      <button
                        onClick={() => { setMenuOpen(false); setEditOpen(true) }}
                        style={menuItem}
                      >
                        Edit details…
                      </button>
                    )}
                    {onArchive && (
                      <button onClick={() => { setMenuOpen(false); onArchive() }} style={menuItem}>
                        Archive
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {row.description && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.45, maxHeight: 54, overflow: 'hidden' }}>
          {row.description}
        </div>
      )}
      {/* 하단 고정 블록 — 태그 + 메타 + Copy 를 한 덩어리로 카드 바닥에 붙인다.
          설명 길이와 무관하게 이 세 행이 한 줄의 카드들끼리 같은 높이로 정렬됨. */}
      <div style={{ marginTop: 'auto', paddingTop: 12 }}>
      {/* 태그 — 칩 클릭 → 옵션 펼침 → 옵션 클릭 즉시 저장. 새 태그 생성은
          여기(Team Dashboard)에서만 가능(allowCreate). 공유본 분류는 팀 공용이라
          owner 가 아니어도 누구나 고칠 수 있다. */}
      {(
        <div style={{ marginTop: 8, position: 'relative' }} onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setTagMenuOpen(v => !v)}
            disabled={tagBusy}
            title="Set tag"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              border: `1px ${currentTags.length ? 'solid' : 'dashed'} var(--border)`,
              background: currentTags.length ? 'var(--accent-dim, rgba(13, 92, 80,0.14))' : 'transparent',
              color: currentTags.length ? 'var(--accent, #0d5c50)' : 'var(--text-muted)',
              borderRadius: 20, padding: '1px 9px', fontSize: 10, fontWeight: currentTags.length ? 600 : 400,
              cursor: tagBusy ? 'default' : 'pointer',
            }}
          >
            {tagBusy ? '…' : (currentTags.length === 0 ? '+ tag' : currentTags.length === 1 ? currentTags[0] : `${currentTags.length} tags`)}
            <span style={{ fontSize: 7, opacity: 0.7 }}>{tagMenuOpen ? '▴' : '▾'}</span>
          </button>
          {tagMenuOpen && (
            <>
              {/* 카드를 밀지 않고 위로 떠오르는 팝오버 (WF 리스트와 동일 동작). */}
              <div onClick={() => setTagMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 41, width: 280,
                background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: '10px 12px',
              }}>
                <TagSelectMenu
                  options={tagOptions}
                  current={currentTags}
                  allowCreate
                  busy={tagBusy}
                  onPick={(t) => void saveTag(t)}
                />
              </div>
            </>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 10, fontSize: 11, color: 'var(--text-muted)', opacity: 0.8 }}>
        <span>{nodeCount} step{nodeCount === 1 ? '' : 's'}</span>
        <span>·</span>
        <span>{isOwner ? 'You' : row.owner_name || row.owner_email || 'Teammate'}</span>
        {archived && row.archived_at ? (
          <>
            <span>·</span>
            <span title={`Archived ${fmtDateTime(row.archived_at)}`}>
              Archived {timeAgo(row.archived_at)}
            </span>
          </>
        ) : timeAgo(row.updated_at) && (
          <>
            <span>·</span>
            <span title={`Last updated ${fmtDateTime(row.updated_at)}`}>
              Updated {timeAgo(row.updated_at)}
            </span>
          </>
        )}
      </div>
      {/* 보관 카드: 복구(전원) + 영구 삭제(admin). 복사는 제공하지 않는다 —
          내려둔 템플릿을 계속 퍼뜨리면 archive 의 의미가 없다. */}
      {archived ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }} onClick={e => e.stopPropagation()}>
          {onRestore && <button onClick={onRestore} style={{ ...primaryBtn, flex: 1 }}>Restore</button>}
          {isAdmin && onDelete && (
            <button
              onClick={onDelete}
              title="Permanently delete this shared workflow and its version history"
              style={{ ...primaryBtn, flex: 1, background: 'transparent', color: 'var(--red)', border: '1px solid var(--red)' }}
            >
              Delete permanently
            </button>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 12 }} onClick={e => e.stopPropagation()}>
          <button
            onClick={copy}
            disabled={state === 'copying'}
            style={{
              ...primaryBtn,
              opacity: state === 'copying' ? 0.6 : 1,
              ...(state === 'done' ? { background: 'var(--green, #0d5c50)', color: '#fff' } : {}),
            }}
          >
            {state === 'copying' ? 'Copying…' : state === 'done' ? 'Copied ✓' : 'Copy to my workflows'}
          </button>
          {state === 'error' && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 6 }}>{errMsg}</div>}
        </div>
      )}
      </div>
      {editOpen && onEditMeta && (
        <EditSharedMetaModal
          row={row}
          onClose={() => setEditOpen(false)}
          onSave={(patch) => { setEditOpen(false); onEditMeta(patch) }}
        />
      )}
    </div>
  )
}

// ── 공유본 제목/설명 편집 — org 멤버 누구나. workflow_json 은 건드리지 않으므로
//    버전 이력에 남지 않고 fork stale 판정(updated_at)도 흔들리지 않는다. ──
function EditSharedMetaModal({
  row, onClose, onSave,
}: {
  row: SharedWorkflowRow
  onClose: () => void
  onSave: (patch: { title: string; description: string }) => void
}) {
  const [title, setTitle] = useState(row.title)
  const [description, setDescription] = useState(row.description ?? '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dirty = title.trim() !== row.title || description.trim() !== (row.description ?? '')

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, cursor: 'default',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(520px, 94%)', display: 'flex', flexDirection: 'column', textAlign: 'left',
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Edit shared details</div>
            <button onClick={onClose} title="Close" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: 0 }}>×</button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
            How this workflow appears to your team. The workflow steps are unchanged.
          </div>
        </div>
        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Title
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={200}
              style={{
                display: 'block', width: '100%', marginTop: 5, boxSizing: 'border-box',
                border: '1px solid var(--border)', background: 'var(--bg-base, transparent)',
                color: 'var(--text)', borderRadius: 7, padding: '6px 10px', fontSize: 12.5, outline: 'none',
              }}
            />
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Description
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={2000}
              rows={4}
              style={{
                display: 'block', width: '100%', marginTop: 5, boxSizing: 'border-box', resize: 'vertical',
                border: '1px solid var(--border)', background: 'var(--bg-base, transparent)',
                color: 'var(--text)', borderRadius: 7, padding: '6px 10px', fontSize: 12.5,
                outline: 'none', fontFamily: 'inherit', lineHeight: 1.5,
              }}
            />
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button
            onClick={() => onSave({ title: title.trim(), description: description.trim() })}
            disabled={!dirty || !title.trim()}
            style={{
              ...secondaryBtn,
              background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)',
              opacity: !dirty || !title.trim() ? 0.5 : 1,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 공유 워크플로 상세 — 카드 클릭 시 노드(스텝)들을 읽기 전용으로 보여준다.
//    우측에 버전 이력 — 재공유마다 append 된 스냅샷을 골라 그 시점 노드를 본다. ──
function SharedWorkflowDetailModal({ row, onClose }: { row: SharedWorkflowRow; onClose: () => void }) {
  const [versions, setVersions] = useState<SharedVersionRow[]>([])
  // 선택된 버전 id (null = 현재 공유 스냅샷). 그 버전의 workflow_json 을 표시.
  const [selVer, setSelVer] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    void listSharedVersions(row.id).then(v => { if (!cancelled) setVersions(v) })
    return () => { cancelled = true }
  }, [row.id])

  // 표시할 워크플로 = 선택 버전 있으면 그 스냅샷, 없으면 현재.
  const shownVersion = selVer ? versions.find(v => v.id === selVer) : null
  const wf = shownVersion?.workflow_json ?? row.workflow_json
  const nodes = wf?.nodes ?? []
  // 비교 모드 — 이전 버전 선택 시 [선택 버전] vs [Current] 나란히.
  const comparing = !!shownVersion
  const verLabel = selVer ? `v${versions.length - versions.findIndex(v => v.id === selVer)}` : ''

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: comparing ? 'min(940px, 96%)' : 'min(640px, 94%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}
      >
        {/* 헤더 */}
        <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>{row.title}</div>
            <button onClick={onClose} title="Close" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: 0 }}>×</button>
          </div>
          {/* 현재 스냅샷을 볼 때는 팀이 편집한 row 레벨 설명을 우선 — 옛 버전을
              고른 상태라면 그 시점 스냅샷의 설명을 그대로 보여준다. */}
          {(shownVersion ? wf?.description : (row.description ?? wf?.description)) && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              {shownVersion ? wf?.description : (row.description ?? wf?.description)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
            <span>{nodes.length} step{nodes.length === 1 ? '' : 's'}</span>
            <span>·</span>
            <span>{row.owner_name || row.owner_email || 'Teammate'}</span>
            {timeAgo(row.updated_at) && (<><span>·</span><span>Updated {timeAgo(row.updated_at)}</span></>)}
          </div>
        </div>
        {/* 버전 이력 선택 바 — 버전이 있을 때만. */}
        {versions.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderBottom: '1px solid var(--border-subtle)', overflowX: 'auto' }}>
            <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', flexShrink: 0, marginRight: 2 }}>Versions</span>
            <button onClick={() => setSelVer(null)} style={verChip(selVer === null)}>Current</button>
            {versions.map((v, i) => (
              <button key={v.id} onClick={() => setSelVer(v.id)} style={verChip(selVer === v.id)} title={fmtDateTime(v.created_at)}>
                v{versions.length - i} · {timeAgo(v.created_at)}
              </button>
            ))}
          </div>
        )}
        {comparing && shownVersion && (
          <div style={{ padding: '6px 18px', fontSize: 10.5, color: 'var(--warning)', background: 'rgba(210,153,34,0.06)', borderBottom: '1px solid var(--border-subtle)' }}>
            Comparing <b style={{ color: 'var(--text-secondary)' }}>{verLabel} · older</b> ({fmtDateTime(shownVersion.created_at)}) → <b style={{ color: 'var(--text-secondary)' }}>Current</b>
          </div>
        )}
        {/* 본문 — 비교 모드면 2단 비교, 아니면 단일 노드 목록. */}
        <div style={{ overflowY: 'auto', padding: comparing ? '12px 14px 18px' : '12px 18px 18px' }}>
          {comparing
            ? <WorkflowDiffView left={shownVersion?.workflow_json} right={row.workflow_json} leftLabel={`${verLabel} · older`} rightLabel="Current" />
            : <WorkflowNodeList nodes={nodes} />}
        </div>
      </div>
    </div>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ border: '1px dashed var(--border-subtle)', borderRadius: 12, padding: '28px 24px', textAlign: 'center', maxWidth: 460 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>{body}</div>
    </div>
  )
}

const card: React.CSSProperties = {
  background:   'var(--bg-surface)',
  border:       '1px solid var(--border-subtle)',
  borderRadius: 12,
  padding:      16,
  display:      'flex',
  flexDirection: 'column',
}

function verChip(on: boolean): React.CSSProperties {
  return {
    flexShrink: 0, fontSize: 10, padding: '2px 8px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    background: on ? 'var(--accent)' : 'transparent',
    color: on ? '#fff' : 'var(--text-secondary)',
  }
}

const badge: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--accent)',
  background: 'var(--accent-dim)',
  borderRadius: 999,
  padding: '2px 7px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const primaryBtn: React.CSSProperties = {
  width: '100%',
  border: '1px solid var(--border)',
  background: 'var(--bg-hover)',
  color: 'var(--text)',
  borderRadius: 8,
  padding: '7px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
}

const ghostBtn: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-muted)',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 11,
  cursor: 'pointer',
}

// 모달 푸터의 보조 버튼(Cancel) — primaryBtn 은 카드용이라 width:100% 다.
const secondaryBtn: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--bg-surface)',
  color: 'var(--text)',
  borderRadius: 7,
  padding: '5px 11px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
}

// ⋯ 관리 메뉴 항목.
const menuItem: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 'none',
  background: 'transparent',
  color: 'var(--text)',
  borderRadius: 6,
  padding: '6px 9px',
  fontSize: 12,
  cursor: 'pointer',
}
