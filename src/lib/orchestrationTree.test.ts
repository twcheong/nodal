import { describe, it, expect } from 'vitest'
import {
  isGroupNode, groupPattern, setNode, removeNode, moveNode, ungroupNode, parentIdOf, ROOT_ID,
} from './orchestrationTree'

const leaf = (id: string, workflowId = 'w'): any => ({ id, workflowId })
const group = (id: string, children: any[], subPattern?: string): any => ({ id, workflowId: '', subPattern, children })

// children 은 optional 이라 그대로 인덱싱하면 TS2532. 그룹이 아니면 여기서 던져서
// 타입을 좁히는 동시에 "그룹이 사라졌다" 를 undefined 접근보다 읽기 쉬운 실패로 만든다.
const kids = (m: OrchestrationMember): OrchestrationMember[] => {
  if (!m.children) throw new Error(`${m.id} is not a group`)
  return m.children
}

// A nested tree: [ A, G(subPattern=parallel)[ B, C ] ]
const tree = (): any[] => [leaf('A'), group('G', [leaf('B'), leaf('C')], 'parallel')]

describe('isGroupNode', () => {
  it('is true for a node with children, false for a leaf', () => {
    expect(isGroupNode(group('g', [leaf('x')]))).toBe(true)
    expect(isGroupNode(leaf('x'))).toBe(false)
    expect(isGroupNode({ id: 'g', workflowId: '', children: [] } as any)).toBe(false)
  })
})

describe('groupPattern', () => {
  it('defaults to pipeline', () => {
    expect(groupPattern(group('g', [leaf('x')]))).toBe('pipeline')
  })
  it('returns the explicit subPattern', () => {
    expect(groupPattern(group('g', [leaf('x')], 'relay'))).toBe('relay')
  })
})

describe('setNode', () => {
  it('patches a nested node immutably', () => {
    const t = tree()
    const out = setNode(t, 'C', { label: 'renamed' })
    const c = kids(out[1])[1]
    expect(c.label).toBe('renamed')
    expect(t[1].children[1].label).toBeUndefined() // original untouched
  })
  it('leaves the tree intact when id is absent', () => {
    const t = tree()
    expect(setNode(t, 'ZZZ', { label: 'x' })).toEqual(t)
  })
})

describe('removeNode', () => {
  it('removes a top-level node', () => {
    expect(removeNode(tree(), 'A').map((m: any) => m.id)).toEqual(['G'])
  })
  it('removes a nested node without touching siblings', () => {
    const out = removeNode(tree(), 'B')
    expect(kids(out[1]).map((m: any) => m.id)).toEqual(['C'])
  })
})

describe('moveNode', () => {
  it('moves a node down within its sibling array', () => {
    const out = moveNode(tree(), 'A', 1)
    expect(out.map((m: any) => m.id)).toEqual(['G', 'A'])
  })
  it('moves a nested node up', () => {
    const out = moveNode(tree(), 'C', -1)
    expect(kids(out[1]).map((m: any) => m.id)).toEqual(['C', 'B'])
  })
  it('is a no-op past the array bounds', () => {
    const t = tree()
    expect(moveNode(t, 'A', -1).map((m: any) => m.id)).toEqual(['A', 'G'])
  })
})

describe('ungroupNode', () => {
  it('replaces a group with its children in place', () => {
    const out = ungroupNode(tree(), 'G')
    expect(out.map((m: any) => m.id)).toEqual(['A', 'B', 'C'])
  })
  it('is a no-op on a leaf', () => {
    const t = tree()
    expect(ungroupNode(t, 'A')).toEqual(t)
  })
})

describe('parentIdOf', () => {
  it('returns ROOT_ID for a top-level node', () => {
    expect(parentIdOf(tree(), 'A')).toBe(ROOT_ID)
  })
  it('returns the enclosing group id for a nested node', () => {
    expect(parentIdOf(tree(), 'C')).toBe('G')
  })
  it('returns null for a missing id', () => {
    expect(parentIdOf(tree(), 'nope')).toBeNull()
  })
})
