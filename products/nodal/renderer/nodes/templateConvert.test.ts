// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GraphDocument } from '../../engine/apps/web/src/graph/types'
import { checkTemplatePicks, graphToTemplate, suggestPicks, templateToGraph } from './templateConvert'

const TEMPLATES = path.resolve(__dirname, '../../engine/examples/templates')

const graph: GraphDocument = {
  nodal_version: '1',
  nodes: {
    src:  { type: 'image.Load', inputs: { path: '/tmp/in.png' } },
    fit:  { type: 'image.Resize', inputs: { image: { $link: ['src', 'image'] }, width: 512, height: 512, method: 'lanczos' } },
    save: { type: 'image.Save', inputs: { image: { $link: ['fit', 'image'] }, embed_workflow: true } },
  },
  outputs: ['save'],
  ui: { positions: { src: [0, 0] } },
}

describe('graphToTemplate', () => {
  it('turns image.Load into an Image param, literal picks into typed params, and keeps the editor graph for re-open', () => {
    const t = graphToTemplate(graph, {
      id: 'square_resize',
      doc: '정사각으로 줄인다',
      params: [{ kind: 'image', nodeId: 'src', name: 'image' }, { kind: 'literal', nodeId: 'fit', input: 'width', name: 'size', doc: '한 변' }],
      returns: [{ nodeId: 'save', socket: 'asset', name: 'image' }],
    })
    const def = t.definitions.square_resize
    expect(def.params).toEqual({ image: { type: 'Image' }, size: { type: 'INT', default: 512, doc: '한 변' } })
    expect(def.nodes.src).toBeUndefined()
    expect(def.nodes.fit.inputs).toEqual({ image: { $param: 'image' }, width: { $param: 'size' }, height: 512, method: 'lanczos' })
    expect(def.returns).toEqual({ image: { $link: ['save', 'asset'] } })
    // 원본은 그대로 (clone)
    expect(graph.nodes!.src).toBeDefined()
    // 다시 열면 원래 그래프 그대로
    expect(templateToGraph(t, 'square_resize')).toEqual(graph)
  })
})

describe('templateToGraph (bundled templates without the saved editor graph)', () => {
  it('opens a flat template: Image params become image.Load nodes, other params take their defaults', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'zimage_i2i.nodal.json'), 'utf8'))
    const g = templateToGraph(doc, 'zimage_i2i')
    const loads = Object.entries(g.nodes!).filter(([, n]) => n.type === 'image.Load')
    expect(loads.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(g.nodes)
    expect(serialized).not.toContain('$param')
    // 정의에 기본값이 없는 모델 파일명은 파일 하단 하네스(subgraph.zimage_i2i 호출)의 값으로 채운다
    expect(serialized).toContain('z_image_bf16.safetensors')
    expect(serialized).not.toContain('null')
    expect(loads[0][1].inputs?.path).toBe('examples/sample.png')
    expect(g.outputs!.length).toBeGreaterThan(0)
  })

  it('refuses nested templates with a readable reason', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'thumbnail.nodal.json'), 'utf8'))
    expect(() => templateToGraph(doc, 'thumbnail')).toThrow(/중첩/)
  })
})

describe('picks', () => {
  it('suggests every image.Load as input and every output socket of output nodes as a return', () => {
    const picks = suggestPicks(graph, (t) => (t === 'image.Save' ? ['asset'] : ['image']))
    expect(picks.params).toEqual([{ kind: 'image', nodeId: 'src', name: 'image' }])
    expect(picks.returns).toEqual([{ nodeId: 'save', socket: 'asset', name: 'asset' }])
  })

  it('rejects bad ids, missing doc, no returns, and linked inputs', () => {
    const errs = checkTemplatePicks(graph, 'Bad-Id', '', [{ kind: 'literal', nodeId: 'fit', input: 'image', name: 'x' }], [])
    expect(errs).toHaveLength(4)
  })
})
