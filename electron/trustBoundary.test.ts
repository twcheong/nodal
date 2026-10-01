// @vitest-environment node
// 신뢰 경계 헬퍼 — 실제 파일시스템에서 검증한다 (링크/junction 은 mock 으로는 의미가 없다).
// 전부 OS temp 아래 mkdtemp 폴더 안에서만 만들고 지운다. 실제 워크스페이스는 건드리지 않는다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isAllowedExternalUrl, isInside, isSamePathAsAny, realpathDeepest, resolveCdpPort, safeSegment, samePath } from './trustBoundary'

let base: string      // mkdtemp 루트
let root: string      // "워크스페이스" 역할:   <base>/users/abc
let sibling: string   // prefix 가 같은 형제:    <base>/users/abc-evil
let outside: string   // 완전히 밖:              <base>/outside

/** junction(Windows) / symlink(POSIX). OS 가 거부하면 false → 해당 테스트는 skip. */
function tryLink(target: string, link: string): boolean {
  try { fs.symlinkSync(target, link, 'junction'); return true } catch { return false }
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'twixy-boundary-'))
  root = path.join(base, 'users', 'abc')
  sibling = path.join(base, 'users', 'abc-evil')
  outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, 'data', 'reports'), { recursive: true })
  fs.mkdirSync(sibling, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(root, 'data', 'reports', 'a.md'), 'in')
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'sibling')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'out')
})

afterAll(() => {
  // 링크를 따라가 지우지 않도록 링크부터 끊는다 (rmSync 는 링크 자체만 지우지만 방어적으로).
  fs.rmSync(base, { recursive: true, force: true })
})

describe('isInside', () => {
  it('루트 아래의 기존 파일·폴더는 통과', () => {
    expect(isInside(root, path.join(root, 'data', 'reports', 'a.md'))).toBe(true)
    expect(isInside(root, path.join(root, 'data'))).toBe(true)
  })

  it('prefix 만 같은 형제 폴더는 거부 (startsWith 가 놓치던 것)', () => {
    expect(sibling.startsWith(root)).toBe(true)   // 예전 검사는 이걸 "안" 으로 봤다
    expect(isInside(root, sibling)).toBe(false)
    expect(isInside(root, path.join(sibling, 'secret.txt'))).toBe(false)
  })

  it('.. traversal 은 거부', () => {
    expect(isInside(root, path.join(root, '..', '..', 'outside', 'secret.txt'))).toBe(false)
    expect(isInside(root, path.resolve(root, 'data/../../abc-evil/secret.txt'))).toBe(false)
    expect(isInside(root, path.join(root, '..'))).toBe(false)
  })

  it('이름이 ".." 로 시작할 뿐인 자식은 통과 (traversal 아님)', () => {
    expect(isInside(root, path.join(root, '..notes', 'x.md'))).toBe(true)
  })

  it('아직 없는 출력 경로도 루트 아래면 통과', () => {
    expect(isInside(root, path.join(root, 'data', 'reports', 'new.pdf'))).toBe(true)
    expect(isInside(root, path.join(root, 'not', 'yet', 'there', 'new.pdf'))).toBe(true)
  })

  it('루트 자체는 기본 거부, allowRoot 일 때만 통과', () => {
    expect(isInside(root, root)).toBe(false)
    expect(isInside(root, path.join(root, 'data', '..'))).toBe(false)
    expect(isInside(root, root + path.sep)).toBe(false)
    expect(isInside(root, root, { allowRoot: true })).toBe(true)
    // allowRoot 는 루트만 연다 — 밖은 여전히 거부.
    expect(isInside(root, sibling, { allowRoot: true })).toBe(false)
  })

  it('빈 값·NUL·문자열 아닌 입력은 거부', () => {
    expect(isInside(root, '')).toBe(false)
    expect(isInside('', root)).toBe(false)
    expect(isInside(root, path.join(root, 'a\0b'))).toBe(false)
    expect(isInside(root, undefined as unknown as string)).toBe(false)
  })

  it('밖을 가리키는 링크 아래의 기존 파일은 거부', (ctx) => {
    const link = path.join(root, 'data', 'link-existing')
    if (!tryLink(outside, link)) return ctx.skip()
    expect(isInside(root, path.join(link, 'secret.txt'))).toBe(false)
    expect(isInside(root, link)).toBe(false)
  })

  it('아직 없는 경로라도 실존하는 부모가 밖을 가리키는 링크면 거부', (ctx) => {
    const link = path.join(root, 'data', 'link-newfile')
    if (!tryLink(outside, link)) return ctx.skip()
    expect(isInside(root, path.join(link, 'new.txt'))).toBe(false)
    expect(isInside(root, path.join(link, 'deep', 'er', 'new.txt'))).toBe(false)
  })

  it('안을 가리키는 링크는 통과 (링크 자체를 금지하는 게 아니다)', (ctx) => {
    const link = path.join(root, 'link-inside')
    if (!tryLink(path.join(root, 'data', 'reports'), link)) return ctx.skip()
    expect(isInside(root, path.join(link, 'a.md'))).toBe(true)
  })

  it('대상이 없는 dangling 링크는 거부 — 쓰면 링크 너머(밖)에 파일이 생긴다', (ctx) => {
    const link = path.join(root, 'data', 'link-dangling')
    if (!tryLink(path.join(outside, 'does-not-exist'), link)) return ctx.skip()
    expect(isInside(root, link)).toBe(false)
    expect(isInside(root, path.join(link, 'new.txt'))).toBe(false)
  })

  it('루트가 링크를 거쳐 도달하는 경로여도 오탐 없음', (ctx) => {
    const viaLink = path.join(base, 'ws-link')
    if (!tryLink(root, viaLink)) return ctx.skip()
    expect(isInside(viaLink, path.join(viaLink, 'data', 'reports', 'a.md'))).toBe(true)
    expect(isInside(viaLink, path.join(root, 'data', 'reports', 'a.md'))).toBe(true)
    expect(isInside(viaLink, path.join(viaLink, 'data', 'new.csv'))).toBe(true)
    expect(isInside(viaLink, sibling)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('win32: 대소문자만 다른 경로는 같은 경로', () => {
    expect(isInside(root.toUpperCase(), path.join(root, 'data', 'reports', 'a.md').toLowerCase())).toBe(true)
    expect(isInside(root, path.join(root.toUpperCase(), 'brand-new.txt'))).toBe(true)
    expect(isInside(root, sibling.toUpperCase())).toBe(false)
  })

  it.runIf(process.platform === 'win32')('win32: 다른 드라이브는 거부', () => {
    const other = path.parse(root).root.toUpperCase().startsWith('C') ? 'D:\\' : 'C:\\'
    expect(isInside(root, path.join(other, 'users', 'abc', 'x.txt'))).toBe(false)
    expect(isInside(root, other)).toBe(false)
  })
})

describe('realpathDeepest', () => {
  it('없는 꼬리는 그대로 붙이고, 있는 부분만 실제 경로로 푼다', () => {
    const real = fs.realpathSync.native(root)
    expect(realpathDeepest(path.join(root, 'nope', 'x.txt'))).toBe(path.join(real, 'nope', 'x.txt'))
    expect(realpathDeepest(root)).toBe(real)
  })
})

describe('isAllowedExternalUrl', () => {
  it('http · https · mailto 만 통과', () => {
    expect(isAllowedExternalUrl('https://twixy.app/pricing')).toBe(true)
    expect(isAllowedExternalUrl('http://localhost:3000/x')).toBe(true)
    expect(isAllowedExternalUrl('HTTPS://EXAMPLE.COM')).toBe(true)
    expect(isAllowedExternalUrl('mailto:support@twixy.app')).toBe(true)
  })

  it('로컬 파일·스크립트·OS 핸들러 스킴은 거부', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'C:\\Windows\\System32\\calc.exe',       // URL 로 파싱하면 스킴이 "c:"
      '\\\\evil-host\\share\\payload.exe',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x',
      'x-apple.systempreferences:com.apple.preference.security',
      'twixy://auth#access_token=x',
      'smb://evil-host/share',
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false)
    }
  })

  it('URL 이 아니거나 문자열이 아니면 거부', () => {
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl('data/reports/a.md')).toBe(false)
    expect(isAllowedExternalUrl(undefined)).toBe(false)
    expect(isAllowedExternalUrl({ href: 'https://x' })).toBe(false)
  })
})

describe('safeSegment', () => {
  it('main 이 만드는 id·파일명은 그대로 통과', () => {
    for (const ok of ['wf_mf3k2a9c1d2e3f4a5b6c7', 'plan_x', 's1', '1726712345678.json', '.DS_Store', '..notes', 'agent:main:1']) {
      expect(safeSegment(ok)).toBe(ok)
    }
  })

  it('끝이 점·공백이면 throw — Win32 정규화가 떼어 내서 다른 경로가 된다', () => {
    for (const bad of ['.. ', '..  ', '.. .', '. ', 'x.', 'x ', 'wf_1. ', 'name...', ' ']) {
      expect(() => safeSegment(bad), JSON.stringify(bad)).toThrow()
    }
    // 앞·중간의 점과 공백은 그대로 통과 (정규화 대상이 아니다).
    for (const ok of ['.hidden', 'a.b', 'a b', ' lead', '1726712345678.json']) {
      expect(safeSegment(ok)).toBe(ok)
    }
  })

  it('경로를 벗어날 수 있는 값은 throw', () => {
    for (const bad of ['', '.', '..', '../x', '..\\x', 'a/b', 'a\\b', '/abs', 'C:\\abs', 'a\0b', undefined, null, 42]) {
      expect(() => safeSegment(bad), String(bad)).toThrow()
    }
  })
})

describe('resolveCdpPort', () => {
  const CHAT = 18800
  const ALLOWED = [CHAT, 18801, 18802, 18803]   // products/twixy: cdpPort + workflowCdpPorts

  it('값이 없으면 기본 포트 (기존 `opts?.cdpPort` → DEFAULT_CDP_PORT 와 동일)', () => {
    expect(resolveCdpPort(undefined, CHAT, ALLOWED)).toBe(CHAT)
    expect(resolveCdpPort(null, CHAT, ALLOWED)).toBe(CHAT)
  })

  it('제품이 쓰는 포트는 그대로', () => {
    for (const p of ALLOWED) expect(resolveCdpPort(p, CHAT, ALLOWED)).toBe(p)
  })

  it('허용 밖 포트는 null — 사용자의 개인 브라우저 디버그 포트에 못 붙는다', () => {
    for (const p of [9222, 18804, 18799, 1, 65535, 0, -18800, 80]) {
      expect(resolveCdpPort(p, CHAT, ALLOWED), String(p)).toBeNull()
    }
  })

  it('숫자가 아니거나 이상한 값은 null', () => {
    for (const p of ['18800', ' 18800', '18800abc', true, {}, [], [18800], NaN, Infinity, 18800.5, 1e400]) {
      expect(resolveCdpPort(p, CHAT, ALLOWED), JSON.stringify(p)).toBeNull()
    }
  })

  it('워크플로 슬롯이 없는 제품(nodal)은 채팅 포트만', () => {
    expect(resolveCdpPort(undefined, 18900, [18900])).toBe(18900)
    expect(resolveCdpPort(18900, 18900, [18900])).toBe(18900)
    expect(resolveCdpPort(18801, 18900, [18900])).toBeNull()   // 다른 제품의 슬롯 포트
  })
})

describe('samePath / isSamePathAsAny (set-project-dir 의 출처 검사)', () => {
  it('같은 폴더는 표기가 달라도 같다', () => {
    const nested = path.join(root, 'data', 'reports')
    expect(samePath(nested, nested)).toBe(true)
    expect(samePath(nested, path.join(root, 'data', '..', 'data', 'reports'))).toBe(true)
    expect(samePath(nested, nested + path.sep)).toBe(true)
    expect(samePath(root, path.join(root, 'data', '..'))).toBe(true)
  })

  it('다른 폴더 — 특히 prefix 만 같은 형제와 상위/하위', () => {
    expect(samePath(root, sibling)).toBe(false)
    expect(samePath(root, path.join(root, 'data'))).toBe(false)
    expect(samePath(path.join(root, 'data'), root)).toBe(false)
    expect(samePath(root, outside)).toBe(false)
  })

  it('junction 으로 가리켜도 실제 위치가 같으면 같다', (ctx) => {
    const link = path.join(base, 'picked-link')
    try { fs.symlinkSync(root, link, 'junction') } catch { return ctx.skip() }
    expect(samePath(link, root)).toBe(true)
    expect(samePath(root, link)).toBe(true)
    expect(samePath(link, sibling)).toBe(false)
  })

  it('빈 값·NUL·문자열 아닌 입력은 false', () => {
    expect(samePath('', root)).toBe(false)
    expect(samePath(root, '')).toBe(false)
    expect(samePath(root, root + '\0')).toBe(false)
    expect(samePath(undefined as unknown as string, root)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('win32 은 대소문자·구분자를 무시', () => {
    expect(samePath(root.toUpperCase(), root.toLowerCase())).toBe(true)
    expect(samePath(root, root.split(path.sep).join('/'))).toBe(true)
  })

  it('isSamePathAsAny — 목록에 있는 것만 통과, null/undefined 는 건너뛴다', () => {
    expect(isSamePathAsAny(root, [null, undefined, root])).toBe(true)
    expect(isSamePathAsAny(root, [sibling, outside])).toBe(false)
    expect(isSamePathAsAny(root, [])).toBe(false)
    expect(isSamePathAsAny(root, [null, undefined])).toBe(false)
    // 첫 등록 전(현재 값 null, 고른 것 없음) = 아무것도 통과 못 한다.
    expect(isSamePathAsAny(outside, [null])).toBe(false)
  })
})
