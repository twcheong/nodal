// @vitest-environment node
//
// 번들 스킬 자동 갱신 — "사용자 편집을 절대 지우지 않는다" 를 고정한다.
//
// 이 기능이 틀리면 증상은 사용자 워크스페이스 파괴다. 판정 함수(projectionAction)만
// 보는 것으로는 부족해서 실제 임시 폴더에 shared/user 를 만들어 투영을 돌린다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECTED_MANIFEST, compileTskillFiles, loadProjectedManifest, projectBundledSkills, projectionAction,
} from './skills'

const copyFile = (src: string, dst: string) => {
  try { fs.copyFileSync(src, dst); return { ok: true, downgraded: false } }
  catch (err) { return { ok: false, downgraded: false, err } }
}

let tmp = ''
const shared = () => path.join(tmp, 'shared', 'skills')
const user   = () => path.join(tmp, 'user', 'skills')

function writeBundle(skill: string, body: string) {
  fs.mkdirSync(path.join(shared(), skill), { recursive: true })
  fs.writeFileSync(path.join(shared(), skill, `${skill}.tskill`), body, 'utf8')
}
const userFile  = (skill: string) => path.join(user(), skill, `${skill}.tskill`)
const readUser  = (skill: string) => fs.readFileSync(userFile(skill), 'utf8')

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twixy-skills-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('projectionAction — 파일 하나를 어떻게 할지', () => {
  it('표', () => {
    expect(projectionAction(null, undefined, 'b')).toBe('copy')        // 없다
    expect(projectionAction('b', undefined, 'b')).toBe('up-to-date')   // 이미 같다
    expect(projectionAction('b', 'a', 'b')).toBe('up-to-date')         // 같으면 장부보다 우선
    expect(projectionAction('a', 'a', 'b')).toBe('update')             // 준 그대로 → 갱신
    expect(projectionAction('x', 'a', 'b')).toBe('keep-local')         // 사용자가 고쳤다
    expect(projectionAction('x', undefined, 'b')).toBe('adopt')        // 기준값 없음(업그레이드 첫 실행)
  })
})

describe('projectBundledSkills', () => {
  it('새 스킬은 그대로 들어오고 기준값이 기록된다', () => {
    writeBundle('pptx', 'v1')
    const r = projectBundledSkills(shared(), user(), copyFile)
    expect(r.copied).toEqual(['pptx/pptx.tskill'])
    expect(readUser('pptx')).toBe('v1')
    expect(loadProjectedManifest(user())['pptx']['pptx.tskill']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('건드리지 않은 파일은 새 번들로 **갱신된다** (예전에는 영영 안 왔다)', () => {
    writeBundle('pptx', 'v1')
    projectBundledSkills(shared(), user(), copyFile)
    writeBundle('pptx', 'v2')                      // 앱 업그레이드
    const r = projectBundledSkills(shared(), user(), copyFile)
    expect(r.updated).toEqual(['pptx/pptx.tskill'])
    expect(readUser('pptx')).toBe('v2')
  })

  it('사용자가 고친 파일은 건드리지 않는다 — 몇 번을 다시 돌려도', () => {
    writeBundle('pptx', 'v1')
    projectBundledSkills(shared(), user(), copyFile)
    fs.writeFileSync(userFile('pptx'), '내가 고친 것', 'utf8')
    writeBundle('pptx', 'v2')
    const r = projectBundledSkills(shared(), user(), copyFile)
    expect(r.keptLocal).toEqual(['pptx/pptx.tskill'])
    expect(readUser('pptx')).toBe('내가 고친 것')
    writeBundle('pptx', 'v3')
    projectBundledSkills(shared(), user(), copyFile)
    expect(readUser('pptx')).toBe('내가 고친 것')   // 기준값이 밀리지 않는다
  })

  it('기준값이 없으면(업그레이드 첫 실행) 번들본으로 맞추되 원본을 .bak 로 남긴다', () => {
    fs.mkdirSync(path.join(user(), 'pptx'), { recursive: true })
    fs.writeFileSync(userFile('pptx'), '8월판', 'utf8')   // 장부 없이 존재하는 옛 사본
    writeBundle('pptx', '9월판')
    const r = projectBundledSkills(shared(), user(), copyFile)
    expect(r.adopted).toEqual(['pptx/pptx.tskill'])
    expect(readUser('pptx')).toBe('9월판')
    expect(fs.readFileSync(`${userFile('pptx')}.bak`, 'utf8')).toBe('8월판')
    // 두 번째 실행은 이미 기준값이 있으므로 조용하다.
    expect(projectBundledSkills(shared(), user(), copyFile).adopted).toEqual([])
  })

  it('사용자가 지운 스킬은 되살리지 않는다', () => {
    writeBundle('pptx', 'v1')
    projectBundledSkills(shared(), user(), copyFile)
    fs.rmSync(path.join(user(), 'pptx'), { recursive: true })
    const r = projectBundledSkills(shared(), user(), copyFile)
    expect(r.userDeleted).toEqual(['pptx'])
    expect(fs.existsSync(path.join(user(), 'pptx'))).toBe(false)
  })

  it('only 목록 밖의 스킬은 투영하지 않고, 장부의 다른 항목도 잃지 않는다', () => {
    writeBundle('pptx', 'v1')
    projectBundledSkills(shared(), user(), copyFile, ['pptx'])
    writeBundle('teammate', 'v1')                  // 팀원 공유 스킬 — 자동 투영 대상 아님
    projectBundledSkills(shared(), user(), copyFile, ['pptx'])
    expect(fs.existsSync(path.join(user(), 'teammate'))).toBe(false)
    expect(Object.keys(loadProjectedManifest(user()))).toEqual(['pptx'])
  })

  it('장부 내용이 그대로면 다시 쓰지 않는다 (워처 되먹임 방지)', () => {
    writeBundle('pptx', 'v1')
    projectBundledSkills(shared(), user(), copyFile)
    const manifest = path.join(user(), PROJECTED_MANIFEST)
    const before = fs.statSync(manifest).mtimeMs
    projectBundledSkills(shared(), user(), copyFile)
    expect(fs.statSync(manifest).mtimeMs).toBe(before)
  })
})

// ── .tskill 이 있는 스킬의 SKILL.md 는 파생물이다 ─────────────────────────
// 패키지 첫 실행에서 실제로 난 버그: 투영 → compileTskillFiles 가 SKILL.md 를 다시 씀 →
// 다음 투영이 그걸 "사용자가 고친 파일" 로 보고 그 스킬을 영영 갱신하지 않았다.
// 번들 SKILL.md 는 런타임 컴파일러 출력과 다르므로(현재 번들 15개 전부), 진짜 스킬로 재현한다.
describe('SKILL.md 파생물 — 앱이 다시 쓴 산출물을 사용자 편집으로 보지 않는다', () => {
  const REAL = path.join('skills', 'pptx')
  function writeRealBundle(tskillSuffix = '') {
    fs.mkdirSync(path.join(shared(), 'pptx'), { recursive: true })
    fs.writeFileSync(path.join(shared(), 'pptx', 'pptx.tskill'),
      fs.readFileSync(path.join(REAL, 'pptx.tskill'), 'utf8') + tskillSuffix, 'utf8')
    fs.copyFileSync(path.join(REAL, 'SKILL.md'), path.join(shared(), 'pptx', 'SKILL.md'))
  }
  const md = () => path.join(user(), 'pptx', 'SKILL.md')

  it('투영 → 컴파일 → 투영: 두 번째 투영은 아무것도 "로컬 수정" 으로 보고하지 않는다', () => {
    writeRealBundle()
    projectBundledSkills(shared(), user(), copyFile)
    const before = fs.readFileSync(md(), 'utf8')
    compileTskillFiles(user(), true)                          // 앱이 SKILL.md 를 다시 쓴다
    expect(fs.readFileSync(md(), 'utf8')).not.toBe(before)    // 전제: 정말로 내용이 바뀌었다
    const r = projectBundledSkills(shared(), user(), copyFile)
    expect(r.keptLocal).toEqual([])
    expect(r.adopted).toEqual([])
  })

  it('그 뒤 번들이 바뀌면 .tskill 과 SKILL.md 가 짝으로 갱신된다', () => {
    writeRealBundle()
    projectBundledSkills(shared(), user(), copyFile)
    compileTskillFiles(user(), true)
    writeRealBundle('\n# v2\n')
    const r = projectBundledSkills(shared(), user(), copyFile)
    expect(r.updated).toEqual(['pptx/pptx.tskill'])
    expect(r.keptLocal).toEqual([])
    expect(fs.readFileSync(md(), 'utf8')).toBe(fs.readFileSync(path.join(shared(), 'pptx', 'SKILL.md'), 'utf8'))
  })

  it('사용자가 .tskill 을 고쳤으면 SKILL.md 도 번들로 덮지 않는다', () => {
    writeRealBundle()
    projectBundledSkills(shared(), user(), copyFile)
    fs.appendFileSync(userFile('pptx'), '\n# 내 수정\n')
    fs.writeFileSync(md(), '내 컴파일 결과', 'utf8')
    writeRealBundle('\n# v2\n')
    const r = projectBundledSkills(shared(), user(), copyFile)
    expect(r.keptLocal).toEqual(['pptx/pptx.tskill'])
    expect(fs.readFileSync(md(), 'utf8')).toBe('내 컴파일 결과')
  })

  it('SKILL.md 는 장부에 오르지 않는다 — 보호 대상은 소스뿐', () => {
    writeRealBundle()
    projectBundledSkills(shared(), user(), copyFile)
    expect(Object.keys(loadProjectedManifest(user())['pptx'])).toEqual(['pptx.tskill'])
  })

  it('.tskill 이 없는 스킬은 SKILL.md 가 소스라 예전처럼 보호된다', () => {
    fs.mkdirSync(path.join(shared(), 'mdonly'), { recursive: true })
    fs.writeFileSync(path.join(shared(), 'mdonly', 'SKILL.md'), 'v1', 'utf8')
    projectBundledSkills(shared(), user(), copyFile)
    fs.writeFileSync(path.join(user(), 'mdonly', 'SKILL.md'), '내 수정', 'utf8')
    fs.writeFileSync(path.join(shared(), 'mdonly', 'SKILL.md'), 'v2', 'utf8')
    const r = projectBundledSkills(shared(), user(), copyFile)
    expect(r.keptLocal).toEqual(['mdonly/SKILL.md'])
    expect(fs.readFileSync(path.join(user(), 'mdonly', 'SKILL.md'), 'utf8')).toBe('내 수정')
  })
})
