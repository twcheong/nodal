import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { VideoPanel } from './VideoPanel'
import { claimNewRuns, markRunSeen, resetRunOwnership, runsForConversation } from './runOwnership'
import type { RunSummary } from './engineApi'

type Reply = { ok: true; data: unknown } | { ok: false; error: string }
function mockEngine(handlers: Record<string, (payload: unknown) => unknown>) {
  const productInvoke = vi.fn(async (name: string, payload?: unknown): Promise<Reply> => {
    const fn = handlers[name]
    if (!fn) return { ok: false, error: `unknown ${name}` }
    return { ok: true, data: fn(payload) }
  })
  ;(window as unknown as { twixy: unknown }).twixy = { productInvoke }
  return productInvoke
}

const NOW = '2026-09-24T00:00:00Z'
const run = (id: string, status: string, elapsed_ms: number | null = null, created_at = new Date().toISOString()) =>
  ({ run_id: id, status, node_count: 1, created_at, elapsed_ms })
const ready = () => ({ state: 'ready', url: 'http://127.0.0.1:8188', dataDir: '/d', running: true })

// 노드 보기(React Flow)가 크기를 재는 데 쓴다 — jsdom 에는 없다.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

// 노드 보기는 엔진 WS(127.0.0.1:8188)에 붙는다 — 테스트에서 실제로 붙으면 연결 실패 이벤트가 jsdom 과
// 부딪혀 가끔 "unhandled error" 로 번진다. 아무것도 하지 않는 소켓으로 바꾼다.
class FakeSocket { addEventListener() {} close() {} }

beforeEach(() => { resetRunOwnership(); vi.stubGlobal('WebSocket', FakeSocket) })
afterEach(() => { delete (window as unknown as { twixy?: unknown }).twixy; vi.unstubAllGlobals() })

describe('VideoPanel', () => {
  it('sends the user to the install screen when the engine is not installed', async () => {
    mockEngine({ 'nodal-engine-status': () => ({ state: 'not-installed', url: 'http://127.0.0.1:8188', dataDir: '/d', running: false, detail: '엔진이 아직 설치되지 않았습니다' }) })
    render(<VideoPanel convId="c" turnCount={1} isThinking={false} />)
    expect(await screen.findByText('엔진 설치가 필요합니다')).toBeInTheDocument()
    expect(screen.getByText('설치 화면으로')).toBeInTheDocument()
  })

  it('plays the newest run this conversation made (first poll after the panel opens claims recent runs)', async () => {
    mockEngine({
      'nodal-engine-status': ready,
      'nodal-runs': () => ({ running: null, queued: [], history: [run('aaaaaaaa1', 'succeeded', 2_284_000), run('bbbbbbbb2', 'failed', 1000)] }),
      'nodal-run': () => ({ run: run('aaaaaaaa1', 'succeeded'), assets: [{ hash: 'h1', media_type: 'video/webm', size_bytes: 5_242_880 }] }),
    })
    const { container } = render(<VideoPanel convId="c" turnCount={1} isThinking={false} />)
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    expect(container.querySelector('video')!.getAttribute('src')).toBe('http://127.0.0.1:8188/api/assets/h1')
    expect(screen.getByText('38m 4s')).toBeInTheDocument()
    expect(screen.getByText('5.0 MB')).toBeInTheDocument()
    expect(screen.getByText('outputs/ 에 저장')).toBeInTheDocument()
  })

  it('does not show old runs from before in this conversation, but does under "전체 보기"', async () => {
    mockEngine({
      'nodal-engine-status': ready,
      'nodal-runs': () => ({ running: null, queued: [], history: [run('oldoldold', 'succeeded', 10, NOW.replace('2026', '2020'))] }),
      'nodal-run': () => ({ run: run('oldoldold', 'succeeded'), assets: [] }),
    })
    render(<VideoPanel convId="c" turnCount={1} isThinking={false} />)
    expect(await screen.findByText('이 대화에서 만든 것이 아직 없습니다.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('전체 보기'))
    expect(await screen.findByText('oldoldol')).toBeInTheDocument()
  })

  it('shows progress with a cancel button while a run is still going', async () => {
    const invoke = mockEngine({
      'nodal-engine-status': ready,
      'nodal-runs': () => ({ running: run('cccccccc3', 'running'), queued: [], history: [] }),
      'nodal-run': () => ({ run: run('cccccccc3', 'running'), assets: [] }),
      'nodal-cancel-run': () => true,
    })
    const { container } = render(<VideoPanel convId="c" turnCount={1} isThinking={false} />)
    fireEvent.click(await screen.findByText('결과'))   // 진행 중이면 노드 보기가 먼저다
    expect(await screen.findByText(/만드는 중/)).toBeInTheDocument()
    expect(container.querySelector('video')).toBeNull()
    fireEvent.click(screen.getByText('취소'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('nodal-cancel-run', { runId: 'cccccccc3' }))
  })

  // 엔진이 주는 실제 실행 그래프 (RunDetail.graph — 평탄화 후 ID).
  const runGraph = { nodal_version: '1', nodes: { 'call:a': { type: 'x.A', inputs: { prompt: 'k-pop idol' } } }, outputs: ['call:a'] }
  const nodesHttp = () => ({ status: 200, body: { nodes: [], types_version: '1' } })

  it('shows the engine run graph in the editor canvas by default, and results on demand', async () => {
    const tpl = { ...run('dddddddd4', 'running'), template_id: 'demo' }
    mockEngine({
      'nodal-engine-status': ready,
      'nodal-runs': () => ({ running: tpl, queued: [], history: [] }),
      'nodal-run': () => ({ run: { ...tpl, executed: [], graph: runGraph }, assets: [] }),
      'nodal-http': nodesHttp,
      'nodal-cancel-run': () => true,
    })
    const { container } = render(<VideoPanel convId="c" turnCount={1} isThinking={false} />)
    expect(await screen.findByText('demo')).toBeInTheDocument()   // 그래프 머리의 템플릿 ID
    expect(screen.getByText('0/1 노드')).toBeInTheDocument()       // 엔진 그래프의 노드 수
    expect(container.querySelector('.nodal-run-view .react-flow')).not.toBeNull()   // 웹 에디터 캔버스
    expect(screen.queryByText(/만드는 중/)).toBeNull()
    fireEvent.click(screen.getByText('결과'))
    expect(await screen.findByText(/만드는 중/)).toBeInTheDocument()
  })

  it('keeps the node view when switching to results and back (no reload, no blank graph)', async () => {
    const tpl = { ...run('eeeeeeee5', 'running'), template_id: 'demo2' }
    mockEngine({
      'nodal-engine-status': ready,
      'nodal-runs': () => ({ running: tpl, queued: [], history: [] }),
      'nodal-run': () => ({ run: { ...tpl, executed: [], graph: runGraph }, assets: [] }),
      'nodal-http': nodesHttp,
    })
    render(<VideoPanel convId="c" turnCount={1} isThinking={false} />)
    expect(await screen.findByText('demo2')).toBeInTheDocument()
    fireEvent.click(screen.getByText('결과'))
    fireEvent.click(screen.getByText('노드'))
    // 실행별 스토어가 남아 있어 바로 그린다 — "불러오는 중" 을 거치지 않는다.
    expect(screen.getByText('demo2')).toBeInTheDocument()
    expect(screen.queryByText('그래프를 불러오는 중…')).toBeNull()
  })

  it('shows the engine error for a failed run the user picks', async () => {
    mockEngine({
      'nodal-engine-status': ready,
      'nodal-runs': () => ({ running: null, queued: [], history: [run('aaaaaaaa1', 'succeeded'), run('bbbbbbbb2', 'failed')] }),
      'nodal-run': (p) => (p as { runId: string }).runId === 'bbbbbbbb2'
        ? { run: { ...run('bbbbbbbb2', 'failed'), error: { code: 'node_failed', message: 'H3 model folder not found' } }, assets: [] }
        : { run: run('aaaaaaaa1', 'succeeded'), assets: [] },
      'nodal-http': nodesHttp,
    })
    render(<VideoPanel convId="c" turnCount={1} isThinking={false} />)
    fireEvent.click(await screen.findByText('bbbbbbbb'))
    fireEvent.click(await screen.findByText('결과'))   // 실패면 노드 보기가 먼저다
    expect(await screen.findByText('H3 model folder not found')).toBeInTheDocument()
  })
})
describe('runOwnership', () => {
  it('claims runs that appear while the agent is working, never editor runs, and keeps conversations apart', () => {
    const now = Date.parse(NOW)
    const at = (min: number) => new Date(now - min * 60_000).toISOString()
    const run = (id: string, status: RunSummary['status'], elapsed_ms = 0, created_at = NOW): RunSummary =>
      ({ run_id: id, status, node_count: 1, created_at, elapsed_ms })
    // 패널 첫 조회: 오래된 것은 귀속 안 됨, 최근 것은 귀속
    claimNewRuns('A', [run('old', 'succeeded', 0, at(60)), run('new', 'succeeded', 0, at(1))], { thinking: false, firstPoll: true, now })
    // 에디터에서 돌린 실행
    markRunSeen('editor')
    // B 대화 에이전트가 일하는 중
    claimNewRuns('B', [run('editor', 'running', 0, at(0)), run('b1', 'running', 0, at(0))], { thinking: true, firstPoll: false, now })
    const all = ['old', 'new', 'editor', 'b1'].map((id) => run(id, 'succeeded'))
    expect(runsForConversation('A', all).map((r) => r.run_id)).toEqual(['new'])
    expect(runsForConversation('B', all).map((r) => r.run_id)).toEqual(['b1'])
  })
})
