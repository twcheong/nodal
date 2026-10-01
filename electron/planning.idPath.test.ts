// @vitest-environment node
// id → 경로 조립 — 렌더러가 준 id 로 워크스페이스 밖(또는 워크스페이스 자체)을 지울 수 없어야 한다.
// 전부 OS temp 의 mkdtemp 폴더 안에서만 만들고 지운다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Planning from './planning'
import * as MR from './mr'

let base: string
let ws: string
const sentinel = () => path.join(ws, 'data', 'keep.txt')

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'twixy-idpath-'))
  ws = path.join(base, 'users', 'u1')
  fs.mkdirSync(path.join(ws, 'data'), { recursive: true })
  fs.writeFileSync(sentinel(), 'keep')
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside')
})
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }) })

describe('planning: id 로 조립하는 경로', () => {
  it('정상 id 의 삭제는 그 폴더만 지운다', () => {
    for (const [kind, del] of [
      ['plans', Planning.deletePlan], ['workflows', Planning.deleteWorkflow],
      ['orchestrations', Planning.deleteOrchestration], ['aiagents', Planning.deleteAiAgent],
    ] as const) {
      const dir = path.join(ws, kind, 'x_1')
      fs.mkdirSync(dir, { recursive: true })
      del(ws, 'x_1')
      expect(fs.existsSync(dir), kind).toBe(false)
      expect(fs.existsSync(sentinel()), kind).toBe(true)
    }
  })

  it("'..' 류 id 의 삭제는 throw 하고 아무것도 지우지 않는다", () => {
    for (const del of [Planning.deletePlan, Planning.deleteWorkflow, Planning.deleteOrchestration, Planning.deleteAiAgent]) {
      for (const bad of ['..', '../..', '../../..', '.', '', '../data', '..\\data']) {
        expect(() => del(ws, bad), bad).toThrow(/invalid id/)
      }
    }
    expect(fs.existsSync(sentinel())).toBe(true)
    expect(fs.existsSync(path.join(base, 'outside.txt'))).toBe(true)
  })

  it('읽기 계열은 기존 "없음" 반환 형태로 떨어진다 (IPC reject 아님)', () => {
    expect(Planning.readPlan(ws, '../..')).toBeNull()
    expect(Planning.readWorkflow(ws, '..')).toBeNull()
    expect(Planning.readRunMd(ws, '../../outside.txt')).toBe('')
    expect(Planning.readStepRaw(ws, 'p1', '../../..')).toEqual([])
    expect(Planning.readRunDetail(ws, 'wf_1', '../../../outside' as unknown as number)).toBeNull()
  })

  it('쓰기 계열은 밖에 파일을 만들지 않는다', () => {
    expect(() => Planning.writeLastTestRun(ws, '../../evil', { a: 1 })).toThrow(/invalid id/)
    expect(fs.existsSync(path.join(base, 'users', 'evil'))).toBe(false)
  })
})

describe('mr: id · sha 로 조립하는 경로', () => {
  it('traversal 은 "없음" 으로 떨어진다', () => {
    const meta = path.join(base, '.twixy')
    fs.mkdirSync(path.join(meta, 'mr'), { recursive: true })
    expect(MR.readMR(meta, '../..')).toBeNull()
    expect(MR.readBlob(meta, 'mr_1', '../../../outside.txt')).toBeNull()
    expect(MR.readBlob(meta, '../../users/u1/data', 'keep.txt')).toBeNull()
  })
})
