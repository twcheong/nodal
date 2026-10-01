// @vitest-environment node
// 창 진입 페이지 + IPC 발신자 검증. 파일시스템을 건드리지 않는다 (문자열·URL 만).
//
// 이 검증이 **정상 창을 거부하면** 패키지 앱에서 guardrail 승인이 안 눌린다. 그래서 표로 덮는다:
// dev/패키지 × 제품 3개 × 창 5개 × OS 2종 × Chromium 이 낼 법한 URL 표기 변형.
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  frameMatchesEntry, senderRejection, windowEntry,
  type AllowedWindow, type EntryEnv, type WindowKind,
} from './windowEntry'

const KINDS: WindowKind[] = ['main', 'sidetab', 'composer', 'testOverlay', 'guardrail']

/** products/<id>/profile.ts 의 htmlEntry — 값이 바뀌면 이 표도 같이 바뀌어야 한다. */
const PRODUCTS = {
  'twixy':            'index.html',
  'twixy-enterprise': 'twixy-enterprise.html',
  'nodal':            'products/nodal/index.html',
} as const

/** 패키지 앱의 dist 폴더 — 공백·한글·대문자 드라이브가 섞인 현실적인 경로. */
const DIST = {
  win32:  'C:\\Users\\홍 길동\\AppData\\Local\\Programs\\Twixy Enterprise\\resources\\app.asar\\dist',
  darwin: '/Applications/Twixy Enterprise.app/Contents/Resources/app.asar/dist',
} as const
type OS = keyof typeof DIST

const env = (isDev: boolean, product: keyof typeof PRODUCTS, os: OS): EntryEnv =>
  ({ isDev, distDir: DIST[os], mainHtmlEntry: PRODUCTS[product] })

describe('windowEntry — 로더가 여는 대상 (옮기기 전 main.ts 와 같은 문자열)', () => {
  it('dev: 기본 제품의 메인 창만 서버 루트, 나머지는 /<html>', () => {
    expect(windowEntry('main', env(true, 'twixy', 'win32'))).toEqual({ type: 'url', url: 'http://localhost:5173' })
    expect(windowEntry('main', env(true, 'twixy-enterprise', 'win32'))).toEqual({ type: 'url', url: 'http://localhost:5173/twixy-enterprise.html' })
    expect(windowEntry('main', env(true, 'nodal', 'win32'))).toEqual({ type: 'url', url: 'http://localhost:5173/products/nodal/index.html' })
    expect(windowEntry('sidetab', env(true, 'twixy', 'win32'))).toEqual({ type: 'url', url: 'http://localhost:5173/sidetab.html' })
    expect(windowEntry('composer', env(true, 'twixy', 'win32'))).toEqual({ type: 'url', url: 'http://localhost:5173/composer.html' })
    expect(windowEntry('testOverlay', env(true, 'twixy', 'win32'))).toEqual({ type: 'url', url: 'http://localhost:5173/test-overlay.html' })
    expect(windowEntry('guardrail', env(true, 'nodal', 'win32'))).toEqual({ type: 'url', url: 'http://localhost:5173/guardrail.html' })
  })

  it('패키지: dist 안의 파일. 보조 창은 제품과 무관, 메인만 제품의 htmlEntry', () => {
    expect(windowEntry('main', env(false, 'twixy', 'win32'), 'win32')).toEqual({ type: 'file', path: `${DIST.win32}\\index.html` })
    expect(windowEntry('main', env(false, 'nodal', 'win32'), 'win32')).toEqual({ type: 'file', path: `${DIST.win32}\\products\\nodal\\index.html` })
    expect(windowEntry('main', env(false, 'nodal', 'darwin'), 'darwin')).toEqual({ type: 'file', path: `${DIST.darwin}/products/nodal/index.html` })
    expect(windowEntry('guardrail', env(false, 'twixy-enterprise', 'darwin'), 'darwin')).toEqual({ type: 'file', path: `${DIST.darwin}/guardrail.html` })
  })
})

/** Chromium 이 같은 파일에 대해 돌려줄 수 있는 URL 표기들. 전부 통과해야 한다. */
function fileUrlVariants(filePath: string, os: OS): string[] {
  const canonical = pathToFileURL(filePath, { windows: os === 'win32' }).href   // 공백·한글 percent-encode
  const out = [
    canonical,
    `${canonical}?from=tray`,
    `${canonical}#/settings`,
    `${canonical}?a=1&b=2#x`,
    decodeURI(canonical),                                                       // 인코딩 안 된 한글·공백
    canonical.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()),                   // 소문자 hex
  ]
  if (os === 'win32') {
    out.push(
      canonical.replace('file:///C:/', 'file:///c:/'),                          // 소문자 드라이브
      canonical.replace('/Users/', '/USERS/').replace('/dist/', '/DIST/'),      // 경로 대소문자
    )
  }
  return out
}

describe('frameMatchesEntry — 정상 창은 전부 통과 (dev/패키지 × 제품 × 창 × OS × URL 표기)', () => {
  for (const os of Object.keys(DIST) as OS[]) {
    for (const product of Object.keys(PRODUCTS) as (keyof typeof PRODUCTS)[]) {
      for (const kind of KINDS) {
        it(`패키지 · ${os} · ${product} · ${kind}`, () => {
          const entry = windowEntry(kind, env(false, product, os), os)
          if (entry.type !== 'file') throw new Error('expected file entry')
          for (const url of fileUrlVariants(entry.path, os)) {
            expect(frameMatchesEntry(url, entry, os), url).toBe(true)
          }
        })

        it(`dev · ${os} · ${product} · ${kind}`, () => {
          const entry = windowEntry(kind, env(true, product, os), os)
          if (entry.type !== 'url') throw new Error('expected url entry')
          // loadURL('http://localhost:5173') 의 프레임 URL 은 끝에 '/' 가 붙는다.
          const base = new URL(entry.url).href
          for (const url of [base, `${base}?t=1726700000`, `${base}#/x`, `${base}?a=1#b`, base.replace('http://localhost', 'HTTP://LOCALHOST')]) {
            expect(frameMatchesEntry(url, entry, os), url).toBe(true)
          }
        })
      }
    }
  }
})

describe('frameMatchesEntry — 다른 페이지는 거부', () => {
  it('같은 앱의 **다른 창** 페이지 (핵심: 사이드탭이 메인·guardrail 행세를 못 한다)', () => {
    for (const os of Object.keys(DIST) as OS[]) {
      for (const isDev of [true, false]) {
        for (const product of Object.keys(PRODUCTS) as (keyof typeof PRODUCTS)[]) {
          const entries = KINDS.map(k => [k, windowEntry(k, env(isDev, product, os), os)] as const)
          for (const [kind, entry] of entries) {
            for (const [otherKind, other] of entries) {
              if (otherKind === kind) continue
              const url = other.type === 'url' ? new URL(other.url).href : pathToFileURL(other.path, { windows: os === 'win32' }).href
              expect(frameMatchesEntry(url, entry, os), `${otherKind} page as ${kind} (${os}, dev=${isDev}, ${product})`).toBe(false)
            }
          }
        }
      }
    }
  })

  it('dev: origin 이 조금이라도 다르면 거부', () => {
    const entry = windowEntry('main', env(true, 'twixy', 'win32'))
    for (const url of [
      'http://localhost:5174/', 'http://127.0.0.1:5173/', 'https://localhost:5173/', 'http://localhost:5173.evil.example/',
      'http://localhost:5173@evil.example/', 'http://evil.example/?http://localhost:5173/', 'http://localhost:5173/index.html.evil',
      'http://localhost:5173/sidetab.html', 'http://localhost:5173//', 'http://localhost/',
    ]) expect(frameMatchesEntry(url, entry), url).toBe(false)
  })

  it('패키지: 이웃 파일·다른 호스트·다른 스킴은 거부', () => {
    const w = windowEntry('guardrail', env(false, 'twixy', 'win32'), 'win32')
    const d = windowEntry('guardrail', env(false, 'twixy', 'darwin'), 'darwin')
    const winBase = pathToFileURL(DIST.win32, { windows: true }).href
    const macBase = pathToFileURL(DIST.darwin, { windows: false }).href
    for (const url of [
      `${winBase}/guardrail.html.evil`, `${winBase}-evil/guardrail.html`, `${winBase}/sub/guardrail.html`, `${winBase}/index.html`,
      `${winBase}/guardrail.html/`, `${winBase}/guardrail%2Ehtml%2F..%2Findex.html`,
      'file://evil-host/C:/Users/x/dist/guardrail.html',                          // UNC — 다른 호스트의 같은 모양 경로
      `${winBase.replace('file:///C:/', 'file:///D:/')}/guardrail.html`,          // 다른 드라이브
    ]) expect(frameMatchesEntry(url, w, 'win32'), url).toBe(false)
    for (const url of [
      `${macBase}/guardrail.html.evil`, `${macBase}-evil/guardrail.html`, `${macBase}/index.html`,
      `${macBase.replace('/Applications/', '/applications/')}/guardrail.html`,    // POSIX 는 대소문자 구분
      `file://evil-host${new URL(macBase).pathname}/guardrail.html`,
    ]) expect(frameMatchesEntry(url, d, 'darwin'), url).toBe(false)
  })

  it('모드가 엇갈리면 거부 — 패키지 앱에서 http 페이지, dev 에서 file 페이지', () => {
    const packaged = windowEntry('main', env(false, 'twixy', 'win32'), 'win32')
    const dev = windowEntry('main', env(true, 'twixy', 'win32'))
    expect(frameMatchesEntry('http://localhost:5173/', packaged, 'win32')).toBe(false)
    expect(frameMatchesEntry(pathToFileURL(`${DIST.win32}\\index.html`, { windows: true }).href, dev, 'win32')).toBe(false)
  })

  it('페이지가 아닌 URL·깨진 입력은 거부', () => {
    const entries = [windowEntry('main', env(true, 'twixy', 'win32')), windowEntry('main', env(false, 'twixy', 'win32'), 'win32')]
    for (const entry of entries) {
      for (const url of ['', 'about:blank', 'about:srcdoc', 'data:text/html,<p>x</p>', 'blob:null/1234', 'chrome-error://chromewebdata/',
        'devtools://devtools/bundled/x.html', 'javascript:0', 'not a url', 'file://', undefined as unknown as string]) {
        expect(frameMatchesEntry(url, entry, 'win32'), String(url)).toBe(false)
      }
    }
  })
})

describe('senderRejection', () => {
  const E = (k: WindowKind) => windowEntry(k, env(true, 'twixy', 'win32'))
  const url = (k: WindowKind) => new URL((E(k) as { url: string }).url).href
  const main: AllowedWindow      = { kind: 'main',      webContentsId: 1, entry: E('main') }
  const sidetab: AllowedWindow   = { kind: 'sidetab',   webContentsId: 2, entry: E('sidetab') }
  const composer: AllowedWindow  = { kind: 'composer',  webContentsId: 3, entry: E('composer') }
  const guardrail: AllowedWindow = { kind: 'guardrail', webContentsId: 5, entry: E('guardrail') }
  const from = (id: number, k: WindowKind, isMainFrame = true) => ({ webContentsId: id, frame: { isMainFrame, url: url(k) } })

  it('허용된 창의 메인 프레임이 자기 페이지에서 부르면 통과', () => {
    expect(senderRejection(from(5, 'guardrail'), [guardrail])).toBeNull()
    expect(senderRejection(from(2, 'sidetab'), [sidetab, composer])).toBeNull()
    expect(senderRejection(from(3, 'composer'), [sidetab, composer])).toBeNull()
  })

  it('허용 목록에 없는 창은 거부 — 사이드탭이 guardrail 승인을 보낼 수 없다', () => {
    expect(senderRejection(from(2, 'sidetab'), [guardrail])).toMatch(/not an allowed window \(guardrail\)/)
    expect(senderRejection(from(1, 'main'), [guardrail])).toMatch(/not an allowed window/)
    expect(senderRejection(from(99, 'guardrail'), [guardrail])).toMatch(/not an allowed window/)   // 모르는 webContents
  })

  it('허용된 창이 지금 안 떠 있으면 아무도 통과 못 한다', () => {
    expect(senderRejection(from(1, 'main'), [])).toMatch(/none open/)
  })

  it('창은 맞는데 **그 창의 페이지가 아니면** 거부 (다른 곳으로 이동된 창)', () => {
    expect(senderRejection({ webContentsId: 5, frame: { isMainFrame: true, url: 'https://evil.example/guardrail.html' } }, [guardrail])).toMatch(/not the guardrail entry/)
    // 허용 창이 둘일 때도 **자기** 진입 페이지와 대조한다 — composer 창에 sidetab 페이지가 떠 있으면 거부.
    expect(senderRejection(from(3, 'sidetab'), [sidetab, composer])).toMatch(/not the composer entry/)
  })

  it('서브프레임·사라진 프레임은 거부', () => {
    expect(senderRejection(from(1, 'main', false), [main])).toMatch(/subframe/)
    expect(senderRejection({ webContentsId: 1 }, [main])).toMatch(/frame is gone/)
  })

  it('거부 사유에 URL 을 담지 않는다 (file: URL 에는 홈 경로가 있다)', () => {
    const reason = senderRejection({ webContentsId: 5, frame: { isMainFrame: true, url: 'file:///C:/Users/secret-name/x.html' } }, [guardrail])
    expect(reason).not.toMatch(/secret-name/)
  })
})
