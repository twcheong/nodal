// @vitest-environment node
// resolveInsideWorkspace / resolveInsideDesignated — 렌더러 IPC(tool-*)와 에이전트 툴 브릿지가
// 공통으로 지나는 관문. 정상 호출은 그대로 되고 우회만 막히는지 실제 temp 폴더에서 본다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveInsideWorkspace } from './safePath'
import { resolveInsideDesignated, setDesignatedPathsConfigResolver } from './designatedPaths'

let base: string
let ws: string
let outside: string
let linked = false

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'twixy-safepath-'))
  ws = path.join(base, 'users', 'u1')
  outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(ws, 'data', 'reports'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'data', 'raw'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'secret.xlsx'), 'x')
  try { fs.symlinkSync(outside, path.join(ws, 'data', 'reports', 'escape'), 'junction'); linked = true } catch { /* OS 가 거부 → 링크 테스트 skip */ }
  setDesignatedPathsConfigResolver(() => ({
    version: 1, roots: ['data/reports'], allowedSubdirs: { 'data/reports': ['escape', 'weekly'] },
  }))
})

afterAll(() => { fs.rmSync(base, { recursive: true, force: true }) })

describe('resolveInsideWorkspace', () => {
  it('워크스페이스 상대경로는 절대경로로 돌려준다 (없는 파일 포함)', () => {
    expect(resolveInsideWorkspace(ws, 'data/raw/in.csv')).toBe(path.join(ws, 'data', 'raw', 'in.csv'))
    expect(resolveInsideWorkspace(ws, '.')).toBe(ws)
  })

  it('절대경로 · ~ · traversal · 형제 prefix 는 null', () => {
    expect(resolveInsideWorkspace(ws, path.join(ws, 'data', 'raw', 'in.csv'))).toBeNull()
    expect(resolveInsideWorkspace(ws, '~/x')).toBeNull()
    expect(resolveInsideWorkspace(ws, '../u1-evil/x')).toBeNull()
    expect(resolveInsideWorkspace(ws, 'data/../../../outside/secret.xlsx')).toBeNull()
  })

  it('밖을 가리키는 링크 너머는 null', (ctx) => {
    if (!linked) return ctx.skip()
    expect(resolveInsideWorkspace(ws, 'data/reports/escape/secret.xlsx')).toBeNull()
  })
})

describe('resolveInsideDesignated', () => {
  it('버킷 직속·허용된 하위 폴더는 통과, 버킷 밖은 null', () => {
    expect(resolveInsideDesignated(ws, 'data/reports/q3.pdf')).toBe(path.join(ws, 'data', 'reports', 'q3.pdf'))
    expect(resolveInsideDesignated(ws, 'data/reports/weekly/q3.pdf')).toBe(path.join(ws, 'data', 'reports', 'weekly', 'q3.pdf'))
    expect(resolveInsideDesignated(ws, 'data/raw/q3.pdf')).toBeNull()
  })

  it('허용 목록에 있는 하위 폴더라도 밖을 가리키는 링크면 null', (ctx) => {
    if (!linked) return ctx.skip()
    expect(resolveInsideDesignated(ws, 'data/reports/escape/new.pdf')).toBeNull()
  })
})
