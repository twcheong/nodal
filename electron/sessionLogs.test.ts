// @vitest-environment node
// 세션 로그 포맷터 — main.ts 안에 있을 때는 테스트할 방법이 없던 순수 함수들.
// 슬라이스 1 로 모듈이 되면서 처음으로 덮는다 (추출의 실제 이득).
import { describe, expect, it } from 'vitest'
import {
  formatToolDetailMain, humanizeSelectorMain,
  inferEvaluateIntentMain, sanitizeSessionIdForFilename,
} from './sessionLogs'

describe('sanitizeSessionIdForFilename — 세션 id 를 파일명으로', () => {
  it('POSIX 에서는 멀쩡하지만 Windows 예약인 문자를 바꾼다', () => {
    // 실제 세션 id 모양: "agent:main:dashboard:<uuid>"
    expect(sanitizeSessionIdForFilename('agent:main:dashboard:abc-123'))
      .toBe('agent-main-dashboard-abc-123')
    for (const ch of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
      expect(sanitizeSessionIdForFilename(`a${ch}b`), ch).toBe('a-b')
    }
  })

  it('제어문자도 바꾼다', () => {
    expect(sanitizeSessionIdForFilename('a\u0000b')).toBe('a-b')
    expect(sanitizeSessionIdForFilename('a\tb')).toBe('a-b')
  })

  it('끝의 점·공백은 Windows 가 떼어 내므로 미리 처리한다', () => {
    expect(sanitizeSessionIdForFilename('sess...')).toBe('sess-')
    expect(sanitizeSessionIdForFilename('sess   ')).toBe('sess')
  })

  it('MAX_PATH 예산 — 180자로 자른다', () => {
    expect(sanitizeSessionIdForFilename('x'.repeat(500))).toHaveLength(180)
  })

  it('전부 날아가면 session 으로 떨어진다 (빈 파일명 방지)', () => {
    expect(sanitizeSessionIdForFilename('')).toBe('session')
    expect(sanitizeSessionIdForFilename('   ')).toBe('session')
  })
})

describe('inferEvaluateIntentMain — evaluate() 가 뭘 하려던 건지', () => {
  it('YouTube 페이지 데이터 접근을 알아본다', () => {
    expect(inferEvaluateIntentMain('return ytInitialData.contents')).toMatch(/Reading/)
    expect(inferEvaluateIntentMain('window.ytInitialPlayerResponse')).toMatch(/Reading/)
  })

  it('지표별로 다른 설명을 낸다', () => {
    expect(inferEvaluateIntentMain('document.querySelector("#subscriber-count")')).toBe('Reading subscriber count')
    expect(inferEvaluateIntentMain('el.likeCount')).toMatch(/like/i)
    expect(inferEvaluateIntentMain('getComments()')).toBe('Reading comments')
  })

  it('대소문자를 가리지 않는다', () => {
    expect(inferEvaluateIntentMain('SUBSCRIBER')).toBe(inferEvaluateIntentMain('subscriber'))
  })
})

describe('humanizeSelectorMain — CSS 셀렉터를 사람 말로', () => {
  it('아는 셀렉터는 이름을 준다', () => {
    expect(humanizeSelectorMain('h1')).toBe('title')
    expect(humanizeSelectorMain('#comments')).toBe('comments')
    expect(humanizeSelectorMain('#description-inline-expander')).toBe('description')
    expect(humanizeSelectorMain('ytd-channel-name')).toBe('channel info')
  })

  it('모르는 셀렉터는 기호를 걷어내고 짧게 줄인다', () => {
    expect(humanizeSelectorMain('div[data-x="y"]')).toBe('div data-x y')
    expect(humanizeSelectorMain('#' + 'z'.repeat(80))).toHaveLength(36)
  })

  it('빈 값은 빈 값', () => {
    expect(humanizeSelectorMain('')).toBe('')
  })
})

describe('formatToolDetailMain — 툴 인자 한 줄 요약', () => {
  it('모르는 툴은 null (호출부가 기본 표시로 떨어진다)', () => {
    expect(formatToolDetailMain('totally_unknown_tool', { a: 1 })).toBeNull()
  })

  it('인자가 없어도 죽지 않는다', () => {
    expect(() => formatToolDetailMain('browser', {})).not.toThrow()
  })
})
