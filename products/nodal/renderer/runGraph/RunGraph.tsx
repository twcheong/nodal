// 채팅 패널의 "노드" 보기 — 에이전트가 돌린 실행을 **웹 에디터 카드 그대로**(NodalNode: 입력값·위젯·
// 미리보기·진행률) 보여 준다. 노드 탭과 같은 GraphCanvas 를 보기 전용으로 쓰되, 에디터 상태는 실행마다
// 따로 만든다 (createEditorStore) — 기본 스토어를 쓰면 노드 탭에서 편집 중인 그래프·자동 저장을 덮어쓴다.
//
// 그래프와 입력값은 엔진이 준다 (RunDetail.graph — 실제로 돈 그래프). 진행은 처음 한 번 상세
// (RunDetail.progress)로 그리고, 이후는 엔진 WS 이벤트를 에디터 스토어가 그대로 접는다.
import '@xyflow/react/dist/style.css'
import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import editorCss from '../../engine/apps/web/src/styles.css?inline'
import { AssetUrlContext } from '../../engine/apps/web/src/api/context'
import type { AssetRef, NodesResponse, WsEvent } from '../../engine/apps/web/src/api/types'
import { API_PATHS, assetSrc } from '../../engine/apps/web/src/api/types'
import { GraphCanvas } from '../../engine/apps/web/src/components/GraphCanvas'
import type { GraphDocument } from '../../engine/apps/web/src/graph/types'
import { createEditorStore, EditorStoreProvider, type EditorStore } from '../../engine/apps/web/src/state/editorStore'
import { ENGINE_URL } from '../../engineConfig'
import { engineApi, type RunSummary } from '../engineApi'
import { installScopedCss } from '../nodes/scopedCss'
import { Centered } from '../useEngineStatus'
import { layoutGraph, runtimeFromDetail, type DetailLike } from './runGraphModel'

const SCOPE = '.nodal-editor'
// 패널 크기에 맞추고, 보기 전용이라 카드 안 위젯은 누를 수 없게 (값은 보이되 바뀌지 않는다).
const HOST_CSS = `
.nodal-run-view .canvas-shell { position: absolute; inset: 0; }
.nodal-run-view .react-flow__node input,
.nodal-run-view .react-flow__node textarea,
.nodal-run-view .react-flow__node select { pointer-events: none; }
`
const assetUrl = (asset: AssetRef) => `${ENGINE_URL}${assetSrc(asset)}`

// 노드 스키마는 엔진이 켜져 있는 동안 바뀌지 않는다 — 한 번만 읽는다.
let schemasPromise: Promise<NodesResponse['nodes']> | null = null
function loadSchemas(): Promise<NodesResponse['nodes']> {
  schemasPromise ??= engineApi.http({ method: 'GET', path: API_PATHS.nodes })
    .then((res) => {
      if (res.status >= 400) throw new Error(`노드 목록을 읽지 못했습니다 (${res.status})`)
      return (res.body as NodesResponse).nodes ?? []
    })
    .catch((err: unknown) => { schemasPromise = null; throw err })
  return schemasPromise
}

// 실행마다 스토어 하나 — "결과" 로 갔다 돌아와도 보던 그대로다. 최근 것만 둔다.
interface Entry { store: EditorStore; loaded: boolean }
const entries = new Map<string, Entry>()
const MAX_ENTRIES = 20
function entryFor(runId: string): Entry {
  let entry = entries.get(runId)
  if (entry) { entries.delete(runId); entries.set(runId, entry); return entry }
  entry = { store: createEditorStore({ nodal_version: '1', nodes: {}, outputs: [] }), loaded: false }
  entries.set(runId, entry)
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string)
  return entry
}

export function RunGraph({ run }: { run: RunSummary }) {
  installScopedCss('nodal-editor', editorCss, SCOPE)
  installScopedCss('nodal-run-view-host', HOST_CSS, '')
  const entry = entryFor(run.run_id)
  const store = entry.store
  const [loaded, setLoaded] = useState(entry.loaded)
  const [error, setError] = useState<string | null>(null)
  const nodeCount = useStore(store, (s) => Object.keys(s.graph.nodes ?? {}).length)
  const doneCount = useStore(store, (s) => Object.values(s.runtime).filter((r) => r.status === 'succeeded' || r.status === 'cached').length)

  useEffect(() => { setLoaded(entry.loaded); setError(null) }, [entry])

  // 노드 스키마 — 카드가 소켓·위젯을 그리려면 필요하다.
  useEffect(() => {
    if (store.getState().catalogState === 'ready') return
    loadSchemas()
      .then((nodes) => store.getState().setSchemas(nodes))
      .catch((err: unknown) => store.getState().setCatalogError(err instanceof Error ? err.message : String(err)))
  }, [store])

  // 상세 — 처음 열 때(그래프·지금 스텝)와 상태가 바뀔 때(완료·실패 반영).
  useEffect(() => {
    let cancelled = false
    engineApi.run(run.run_id)
      .then(({ run: detail }) => {
        if (cancelled) return
        const graph = detail.graph as GraphDocument | null | undefined
        if (!graph) { if (!entry.loaded) setError('이 실행의 그래프를 엔진이 주지 않았습니다 (엔진을 다시 시작해 주세요)'); return }
        if (!entry.loaded) {
          const s = store.getState()
          s.loadGraph(layoutGraph(graph))
          s.startRun(run.run_id)   // 이벤트를 이 실행으로 거른다 (activeRunId)
          entry.loaded = true
          setLoaded(true)
        }
        store.setState((s) => ({
          // electron/engine.ts 의 RunDetail 은 같은 JSON 을 좁게 적은 손 타입이라 에디터 타입과 직접 겹치지 않는다.
          runtime: runtimeFromDetail(s.graph, detail as unknown as DetailLike, s.runtime),
          runStatus: detail.status,
          message: null,
        }))
      })
      .catch((err: unknown) => { if (!cancelled && !entry.loaded) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [entry, store, run.run_id, run.status])

  // 실시간 이벤트 — 에디터 스토어가 노드별 진행·미리보기·완료를 접는다. 끝난 실행에는 붙지 않는다.
  const live = run.status === 'queued' || run.status === 'running'
  useEffect(() => {
    if (!live || !loaded) return
    const url = new URL(API_PATHS.ws, ENGINE_URL)
    url.protocol = 'ws:'
    const socket = new WebSocket(url)
    socket.addEventListener('message', (m) => {
      let event: WsEvent
      try { event = JSON.parse(String(m.data)) as WsEvent } catch { return }
      // run.done 은 에디터에서 "다음 시드 굴리기" 까지 한다 — 보기 화면에서는 실행에 쓴 시드가 바뀌어
      // 보이면 안 되므로 상태만 바꾼다. 나머지는 편집 화면과 똑같이 접는다.
      if (event.t === 'run.done') {
        if (event.run_id === run.run_id) store.setState({ runStatus: 'succeeded', message: null })
        return
      }
      store.getState().handleEvent(event)
    })
    return () => socket.close()
  }, [live, loaded, store, run.run_id])

  if (error) return <Centered><div style={{ fontSize: 12, color: 'var(--danger, #b42318)', textAlign: 'center', lineHeight: 1.6 }}>{error}</div></Centered>
  if (!loaded) return <Centered><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>그래프를 불러오는 중…</div></Centered>

  return (
    <div style={{ flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '0 2px 6px', display: 'flex', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{run.template_id ?? run.run_id.slice(0, 8)}</span>
        <span style={{ flex: 1 }} />
        <span>{doneCount}/{nodeCount} 노드</span>
      </div>
      <div className="nodal-editor nodal-run-view" style={{ flex: 1, minHeight: 0, position: 'relative', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
        <EditorStoreProvider store={store}>
          <AssetUrlContext.Provider value={assetUrl}>
            <ReactFlowProvider>
              <GraphCanvas readOnly />
            </ReactFlowProvider>
          </AssetUrlContext.Provider>
        </EditorStoreProvider>
      </div>
    </div>
  )
}
