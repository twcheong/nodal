// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { GraphDocument } from '../../engine/apps/web/src/graph/types'
import { layoutGraph, nodeIdFromError, runtimeFromDetail } from './runGraphModel'

// 엔진이 RunDetail.graph 로 주는 모양 — zimage_txt2img 를 평탄화한 것 (노드 ID = call:<안쪽>).
const graph: GraphDocument = {
  nodal_version: '1',
  nodes: {
    'call:load': { type: 'diffusion.ZImageLoader', inputs: { transformer: 'z_image_bf16.safetensors' } },
    'call:generate': { type: 'diffusion.ZImageTxt2Img', inputs: { model: { $link: ['call:load', 'model'] }, prompt: 'k-pop idol', seed: 7 } },
    'call:save': { type: 'image.Save', inputs: { image: { $link: ['call:generate', 'image'] } } },
  },
  outputs: ['call:save'],
}

describe('layoutGraph', () => {
  it('places nodes left → right along links and keeps existing positions', () => {
    const laid = layoutGraph(graph)
    const x = (id: string) => (laid.ui?.[id] as { pos: [number, number] }).pos[0]
    expect(x('call:load')).toBeLessThan(x('call:generate'))
    expect(x('call:generate')).toBeLessThan(x('call:save'))
    const pinned = layoutGraph({ ...graph, ui: { 'call:save': { pos: [5, 6] } } })
    expect((pinned.ui?.['call:save'] as { pos: number[] }).pos).toEqual([5, 6])
    // 입력값은 그대로 — 카드가 이 실행의 프롬프트·시드를 보여 준다.
    expect(laid.nodes?.['call:generate']?.inputs?.prompt).toBe('k-pop idol')
  })
})

describe('runtimeFromDetail', () => {
  it('shows the current step right away from the detail progress', () => {
    const rt = runtimeFromDetail(graph, {
      status: 'running', executed: ['call:load'],
      progress: { node_id: 'call:generate', step: 5, total_steps: 30 },
    }, {})
    expect(rt['call:load'].status).toBe('succeeded')
    expect(rt['call:generate']).toMatchObject({ status: 'running', progress: { step: 5, total: 30 } })
    expect(rt['call:save'].status).toBe('queued')
  })

  it('marks the failing node from the engine error', () => {
    const msg = "nodes.call:load: 'x.safetensors' 를 로드하지 못했다"
    expect(nodeIdFromError(msg)).toBe('call:load')
    const rt = runtimeFromDetail(graph, { status: 'failed', error: { message: msg } }, {})
    expect(rt['call:load'].status).toBe('error')
    expect(rt['call:load'].error?.message).toBe(msg)
  })

  it('does not roll back what live events already showed, and keeps previews', () => {
    const preview = { kind: 'inline' as const, data_uri: 'data:image/png;base64,AA', width: 1, height: 1 }
    const prev = { 'call:generate': { status: 'running' as const, progress: { step: 9, total: 30, etaMs: null }, preview } }
    const rt = runtimeFromDetail(graph, { status: 'running', executed: ['call:load'] }, prev)
    expect(rt['call:generate']).toMatchObject({ status: 'running', progress: { step: 9 } })
    expect(rt['call:generate'].preview).toEqual(preview)
  })

  it('attaches output assets of finished nodes', () => {
    const out = [{ socket: 'asset', type: 'Asset', asset: { hash: 'h', media_type: 'image/png', size_bytes: 1 } }]
    const rt = runtimeFromDetail(graph, { status: 'succeeded', executed: ['call:load', 'call:generate', 'call:save'], outputs: { 'call:save': out } }, {})
    expect(rt['call:save']).toMatchObject({ status: 'succeeded', outputs: out })
  })
})
