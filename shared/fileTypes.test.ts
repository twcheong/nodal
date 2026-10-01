// @vitest-environment node
// "OS 기본 앱으로 열어도 되는가" allowlist. 파일시스템을 건드리지 않는다 (문자열 판정만).
import { describe, expect, it } from 'vitest'
import { isOpenable, OPENABLE_EXTS, ATTACHABLE_EXTS } from './fileTypes'

describe('isOpenable — 열려야 하는 것', () => {
  it('앱이 워크스페이스에 만드는 산출물', () => {
    for (const p of [
      'data/reports/q3.pdf', 'data/reports/deck.pptx', 'data/reports/sheet.xlsx',
      'data/insights/summary.md', 'data/raw/rows.csv', 'data/raw/api.json',
      'logs/sessions/2026-09-20_x.jsonl', 'data/tmp/deck-qa/preview.png', 'data/raw/scraped.html',
    ]) expect(isOpenable(p), p).toBe(true)
  })

  it('절대경로 · 한글 이름 · 공백 든 폴더 · 대문자 확장자', () => {
    for (const p of [
      String.raw`C:\Users\홍 길동\ws\data\보고서.pdf`,
      '/Users/x/My Workspace/data/report.PDF',
      String.raw`C:\ws\data\REPORT.PPTX`,
      'data/reports/지난번 자료.xlsx',
    ]) expect(isOpenable(p), p).toBe(true)
  })

  it('첨부 가능한 확장자는 전부 열 수 있어야 한다 (읽히는데 못 여는 건 앞뒤가 안 맞는다)', () => {
    for (const e of ATTACHABLE_EXTS) expect(isOpenable('data/raw/file' + e), e).toBe(true)
  })
})

describe('isOpenable — 막혀야 하는 것', () => {
  it('네이티브로 실행되는 부류 (에이전트가 워크스페이스에 쓸 수 있다)', () => {
    for (const e of [
      '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
      '.wsf', '.wsh', '.hta', '.lnk', '.url', '.scf', '.reg', '.jar', '.msc', '.cpl', '.pif', '.inf',
      '.sh', '.bash', '.zsh', '.command', '.app', '.pkg', '.dmg', '.applescript', '.scpt', '.workflow', '.desktop',
    ]) expect(isOpenable('data/raw/payload' + e), e).toBe(false)
  })

  it('확장자 위장 — 끝의 점·공백은 Win32 가 떼어 낸다', () => {
    for (const p of ['payload.exe ', 'payload.exe.', 'payload.exe..', 'payload.bat ', 'report.pdf ', 'report.pdf.']) {
      expect(isOpenable('data/raw/' + p), JSON.stringify(p)).toBe(false)
    }
  })

  it('확장자가 없거나, 상위 폴더에만 점이 있는 경로', () => {
    for (const p of ['data/raw/README', 'data/my.reports/README', String.raw`C:\my.dir\payload`, 'data/raw/.hidden', '']) {
      expect(isOpenable(p), p).toBe(false)
    }
  })

  it('NTFS 대체 데이터 스트림 · 이중 확장자', () => {
    for (const p of ['data/raw/report.pdf:evil.exe', 'data/raw/report.pdf.exe', 'data/raw/report.exe.pdf.lnk']) {
      expect(isOpenable(p), p).toBe(false)
    }
    // 마지막 확장자가 허용이면 통과한다 — 실행 결정도 마지막 확장자로 나므로 일관적이다.
    expect(isOpenable('data/raw/report.exe.pdf')).toBe(true)
  })

  it('문자열이 아닌 입력', () => {
    for (const p of [undefined, null, 42, {}, ['x.pdf']]) {
      expect(isOpenable(p as unknown as string), String(p)).toBe(false)
    }
  })
})

describe('OPENABLE_EXTS 목록 자체', () => {
  it('전부 소문자 · 점으로 시작 · 중복 없음', () => {
    for (const e of OPENABLE_EXTS) {
      expect(e, e).toBe(e.toLowerCase())
      expect(e.startsWith('.'), e).toBe(true)
      expect(e.slice(1).includes('.'), e).toBe(false)
    }
    expect(new Set(OPENABLE_EXTS).size).toBe(OPENABLE_EXTS.length)
  })

  it('실행 부류가 실수로 섞여 들어오지 않는다 (목록을 늘릴 때의 가드)', () => {
    for (const e of ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.lnk', '.url', '.jar', '.hta', '.sh', '.app', '.reg', '.msi']) {
      expect(OPENABLE_EXTS.includes(e), e).toBe(false)
    }
  })
})
