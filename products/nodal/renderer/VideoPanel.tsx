// 채팅(생성 모드)의 오른쪽 패널 — 엔진의 실행 큐와 결과를 보여준다.
//
// 에이전트의 답장을 파싱해 run_id 를 뽑지 않는다. 엔진이 단일 출처이므로 패널이 엔진에
// 직접 묻는다 (GET /api/runs). 그래서 에이전트가 결과를 빠뜨리거나 잘못 말해도 패널은
// 실제 상태를 보여준다.
//
// 대화별로 나누기: 엔진은 대화를 모른다. 이 대화의 에이전트가 일하는 중(isThinking)에 새로
// 나타난 실행을 이 대화 것으로 기록한다 (runOwnership.ts). 기본은 "이 대화", 토글로 "전체".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CopilotSidePanelProps } from '../../../src/lib/copilotModes'
import { Badge } from '../../../src/components/ui/Badge'
import { Button } from '../../../src/components/ui/Button'
import { Spinner } from '../../../src/components/ui/Spinner'
import { engineApi, flattenRuns, assetUrl, formatBytes, formatElapsed, type AssetRef, type RunSummary } from './engineApi'
import { RunGraph } from './runGraph/RunGraph'
import { SystemStatsBar } from './SystemStatsBar'
import { claimNewRuns, runsForConversation } from './runOwnership'
import { Centered, EngineNotice, useEngineStatus } from './useEngineStatus'

const POLL_ACTIVE_MS = 3000    // 실행 중·대기 중인 작업이 있을 때
const POLL_IDLE_MS   = 15000   // 없을 때

const STATUS_VARIANT: Record<RunSummary['status'], 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  queued: 'neutral', running: 'info', succeeded: 'success', failed: 'danger', cancelled: 'warning',
}
const STATUS_LABEL: Record<RunSummary['status'], string> = {
  queued: '대기', running: '생성 중', succeeded: '완료', failed: '실패', cancelled: '취소됨',
}

export function VideoPanel({ convId, turnCount, isThinking }: CopilotSidePanelProps) {
  const { status: engine, refresh: refreshEngine } = useEngineStatus()
  const [allRuns, setAllRuns] = useState<RunSummary[]>([])
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ runId: string; assets: AssetRef[]; error?: string } | null>(null)
  const [saved, setSaved] = useState<Record<string, string>>({})   // hash → 저장된 워크스페이스 경로
  const [actionError, setActionError] = useState<string | null>(null)
  // 사용자가 직접 고른 뒤에는 새 실행이 끝나도 선택을 뺏지 않는다.
  const userPicked = useRef(false)
  const thinkingRef = useRef(isThinking)
  thinkingRef.current = isThinking
  const polledOnce = useRef<string | null>(null)   // 이 대화로 첫 조회를 했는가

  const running = !!engine?.running
  const runs = useMemo(() => (showAll ? allRuns : runsForConversation(convId, allRuns)), [showAll, allRuns, convId])

  const refresh = useCallback(async () => {
    if (!running) return false
    try {
      const list = flattenRuns(await engineApi.runs())
      // 에이전트가 일하는 중에(또는 패널이 막 열린 첫 조회에서) 새로 보인 실행 = 이 대화가 시킨 것.
      claimNewRuns(convId, list, { thinking: thinkingRef.current, firstPoll: polledOnce.current !== convId })
      polledOnce.current = convId
      setAllRuns(list)
      return list.some((r) => r.status === 'queued' || r.status === 'running')
    } catch {
      void refreshEngine()
      return false
    }
  }, [running, convId, refreshEngine])

  // 폴링 — 활성 작업이 있으면 촘촘히. 어시스턴트가 턴을 끝내면 즉시 한 번 더.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const tick = async () => {
      const active = await refresh()
      if (!stopped) timer = setTimeout(tick, active || isThinking ? POLL_ACTIVE_MS : POLL_IDLE_MS)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [refresh, turnCount, isThinking])

  // 대화가 바뀌면 선택을 초기화.
  useEffect(() => { userPicked.current = false; setSelected(null) }, [convId])
  // 노드/결과 보기 — 사용자가 고르기 전에는 실행 상태를 따라간다. 다른 실행을 고르면 다시 자동.
  const [pickedView, setPickedView] = useState<'nodes' | 'results' | null>(null)
  useEffect(() => { setPickedView(null) }, [selected])
  useEffect(() => {
    if (!userPicked.current) setSelected(runs[0]?.run_id ?? null)
  }, [runs])

  // 선택된 실행의 결과 에셋. 끝나지 않은 실행은 상태가 바뀔 때 다시 읽는다.
  const selectedStatus = runs.find((r) => r.run_id === selected)?.status
  useEffect(() => {
    if (!selected) { setDetail(null); return }
    let cancelled = false
    engineApi.run(selected)
      .then(({ run, assets }) => { if (!cancelled) setDetail({ runId: selected, assets, error: run.error?.message }) })
      .catch((err: unknown) => { if (!cancelled) setDetail({ runId: selected, assets: [], error: err instanceof Error ? err.message : String(err) }) })
    return () => { cancelled = true }
  }, [selected, selectedStatus])

  const act = async (fn: () => Promise<void>) => {
    setActionError(null)
    try { await fn() } catch (err) { setActionError(err instanceof Error ? err.message : String(err)) }
    void refresh()
  }

  if (!engine || !running) {
    return <EngineNotice status={engine} onRetry={() => void refreshEngine()} />
  }

  const current = detail && detail.runId === selected ? detail : null
  const inFlight = selectedStatus === 'queued' || selectedStatus === 'running'
  const selectedRun = runs.find((r) => r.run_id === selected) ?? null
  // 끝나서 결과가 있으면 결과, 그 전(대기·실행 중)이나 실패면 어디서 멈췄는지 보이게 노드.
  // 엔진이 모든 실행의 그래프를 준다 (RunDetail.graph) — 노드 탭에서 직접 돌린 실행도.
  const hasGraph = !!selectedRun
  const view = !hasGraph ? 'results' : pickedView ?? (selectedStatus === 'succeeded' ? 'results' : 'nodes')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <SystemStatsBar />
      {hasGraph && (
        <div style={{ display: 'flex', gap: 2, padding: '8px 12px 0' }}>
          {(['nodes', 'results'] as const).map((v) => (
            <button key={v} type="button" onClick={() => setPickedView(v)}
              style={{
                border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', cursor: 'pointer', fontSize: 12,
                fontFamily: 'var(--font-sans)', background: view === v ? 'var(--accent-dim)' : 'transparent',
                color: view === v ? 'var(--accent)' : 'var(--text-muted)', fontWeight: view === v ? 600 : 400,
              }}>
              {v === 'nodes' ? '노드' : '결과'}
            </button>
          ))}
        </div>
      )}
      {selectedRun && view === 'nodes' && (
        <div style={{ flex: 1, minHeight: 0, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <RunGraph run={selectedRun} />
          {inFlight && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button size="sm" variant="ghost" onClick={() => act(() => engineApi.cancel(selectedRun.run_id).then(() => undefined))}>취소</Button>
            </div>
          )}
        </div>
      )}
      {view === 'results' && (
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!selected && (
          <Centered>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{showAll ? '아직 만든 것이 없습니다.' : '이 대화에서 만든 것이 아직 없습니다.'}</div>
          </Centered>
        )}
        {selected && selectedStatus && selectedStatus !== 'succeeded' && selectedStatus !== 'failed' && (
          <Centered>
            {selectedStatus !== 'cancelled' && <Spinner size={16} />}
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {selectedStatus === 'queued' ? '순서를 기다리는 중…' : selectedStatus === 'running' ? '만드는 중… 영상은 몇십 분 걸릴 수 있습니다.' : '취소했습니다.'}
            </div>
            {inFlight && <Button size="sm" variant="ghost" onClick={() => act(() => engineApi.cancel(selected).then(() => undefined))}>취소</Button>}
          </Centered>
        )}
        {current?.error && (
          <div style={{ fontSize: 12, color: 'var(--danger, #b42318)', lineHeight: 1.5 }}>{current.error}</div>
        )}
        {actionError && <div style={{ fontSize: 12, color: 'var(--danger, #b42318)' }}>{actionError}</div>}
        {selectedStatus === 'succeeded' && current && current.assets.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>이 실행은 저장된 이미지·영상 없이 끝났습니다.</div>
        )}
        {selectedStatus === 'succeeded' && current?.assets.map((a) => (
          <figure key={a.hash} style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {a.media_type.startsWith('video/')
              ? <video src={assetUrl(engine.url, a.hash)} controls loop style={{ width: '100%', borderRadius: 'var(--radius-md)', background: '#000' }} />
              : <img src={assetUrl(engine.url, a.hash)} alt="" style={{ width: '100%', borderRadius: 'var(--radius-md)' }} />}
            <figcaption style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{a.media_type}</span>
              {a.width && a.height ? <span>{a.width}×{a.height}</span> : null}
              <span>{formatBytes(a.size_bytes)}</span>
              <span style={{ flex: 1 }} />
              {saved[a.hash]
                ? <span title={saved[a.hash]}>저장됨 · {saved[a.hash]}</span>
                : <Button size="sm" variant="ghost" onClick={() => act(async () => {
                    const { relPath } = await engineApi.saveAsset(a.hash)
                    setSaved((s) => ({ ...s, [a.hash]: relPath }))
                  })}>outputs/ 에 저장</Button>}
            </figcaption>
          </figure>
        ))}
      </div>
      )}

      <div style={{ borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
        <span>{showAll ? '모든 실행' : '이 대화'}</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => { userPicked.current = false; setShowAll((v) => !v) }}
          style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: 0 }}>
          {showAll ? '이 대화만 보기' : '전체 보기'}
        </button>
      </div>
      {runs.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', maxHeight: 190, overflow: 'auto' }}>
          {runs.map((r) => (
            <button
              key={r.run_id}
              type="button"
              onClick={() => { userPicked.current = true; setSelected(r.run_id) }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
                border: 'none', borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', textAlign: 'left',
                background: r.run_id === selected ? 'var(--accent-dim)' : 'transparent',
                color: 'var(--text-primary)', fontSize: 12, fontFamily: 'var(--font-sans)',
              }}
            >
              <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
              <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{r.run_id.slice(0, 8)}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatElapsed(r.elapsed_ms)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
