// @vitest-environment node
// mergeMR 은 디스크의 meta.json 에 적힌 경로를 다시 검증해야 한다 — shared-folder 모드에서
// 그 파일은 팀원이 쓸 수 있다. 전부 OS temp 의 mkdtemp 폴더 안에서만 만들고 지운다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as MR from './mr'

let base: string        // mkdtemp 루트 (프로젝트 폴더의 부모 역할)
let project: string
let meta: string
let shared: string
let user: string
const copy = (src: string, dst: string) => fs.copyFileSync(src, dst)

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'twixy-mr-'))
  project = path.join(base, 'project')
  meta = path.join(project, '.twixy')
  shared = path.join(project, 'shared')
  user = path.join(project, 'users', 'u1')
  for (const d of [meta, shared, user]) fs.mkdirSync(d, { recursive: true })
})
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }) })

function createAddMR(relPath: string): MR.MergeRequest {
  return MR.createMR(project, meta, 'proj_test', {
    title: 't', author: { uid: 'u1' }, changes: [{ op: 'add', path: relPath, content: 'hello' }],
  })
}

describe('mergeMR', () => {
  it('정상 MR 은 shared/ 와 사용자 폴더에 반영된다', () => {
    const mr = createAddMR('shared/notes/a.md')
    const merged = MR.mergeMR(project, meta, shared, user, mr.id, copy, { allowSelfMerge: true })
    expect(merged.status).toBe('merged')
    expect(fs.readFileSync(path.join(shared, 'notes', 'a.md'), 'utf8')).toBe('hello')
    expect(fs.readFileSync(path.join(user, 'notes', 'a.md'), 'utf8')).toBe('hello')
  })

  it('meta.json 의 경로가 shared/ 밖으로 고쳐져 있으면 병합을 거부하고 아무것도 쓰지 않는다', () => {
    for (const evil of ['../escaped.md', 'shared/../../escaped.md', 'users/u1/MEMORY.md', '.twixy/config.json']) {
      const mr = createAddMR(`shared/ok-${Math.random().toString(36).slice(2)}.md`)
      // 팀원이 공유 폴더에서 meta.json 을 직접 고친 상황을 재현
      const metaPath = path.join(meta, 'mr', mr.id, 'meta.json')
      const onDisk = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      onDisk.changes[0].path = evil
      fs.writeFileSync(metaPath, JSON.stringify(onDisk))

      expect(() => MR.mergeMR(project, meta, shared, user, mr.id, copy, { allowSelfMerge: true }), evil).toThrow()
      expect(MR.readMR(meta, mr.id)?.status, evil).toBe('open')
    }
    expect(fs.existsSync(path.join(base, 'escaped.md'))).toBe(false)
    expect(fs.existsSync(path.join(project, 'escaped.md'))).toBe(false)
    expect(fs.existsSync(path.join(user, 'MEMORY.md'))).toBe(false)
    expect(fs.existsSync(path.join(meta, 'config.json'))).toBe(false)
  })
})
