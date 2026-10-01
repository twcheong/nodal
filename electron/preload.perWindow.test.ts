// @vitest-environment node
//
// preload 가 **창마다 다른 표면**을 노출하는지 확인한다 (Stage 5 slice 3).
//
// 왜 소스 검사(check:preload)만으로 부족한가: 그 검사는 "목록과 호출부가 맞는가" 를 본다.
// 여기서 보는 건 목록을 실제로 **적용하는 코드** — kind 파싱, Object.fromEntries 필터,
// twixyTestOverlay 의 조건부 노출. 이게 틀리면 목록이 아무리 맞아도 창이 빈 표면을 받거나
// 전부 받는다. electron 을 띄우지 않고(ipcRenderer 를 mock) 모듈을 그대로 import 해서 본다.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exposed = new Map<string, Record<string, unknown>>()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (k: string, v: Record<string, unknown>) => { exposed.set(k, v) } },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}))

async function loadPreload(kind?: string) {
  exposed.clear()
  vi.resetModules()
  const saved = process.argv
  process.argv = kind ? [...saved, `--twixy-window=${kind}`] : [...saved]
  try { await import('./preload') } finally { process.argv = saved }
  return { twixy: exposed.get('twixy')!, testOverlay: exposed.get('twixyTestOverlay') }
}

describe('preload per-window 표면', () => {
  beforeEach(() => { exposed.clear() })

  it('표식이 없으면(main/enterprise/nodal) 전체 표면', async () => {
    const { twixy, testOverlay } = await loadPreload()
    expect(Object.keys(twixy).length).toBeGreaterThan(200)
    expect(typeof twixy.getGatewayToken).toBe('function')
    expect(typeof twixy.platform).toBe('string')
    // 전용 브릿지는 메인 창에도 가지 않는다 — 메인은 twixy.pushTestOverlaySnapshot 을 쓴다.
    expect(testOverlay).toBeUndefined()
  })

  it('sidetab 은 자기 8개만 받는다', async () => {
    const { twixy } = await loadPreload('sidetab')
    expect(Object.keys(twixy).sort()).toEqual([
      'closeSidetab', 'onOverlaySync', 'onPlanChanged', 'overlayRequestSync',
      'overlayResume', 'overlaySetOpacity', 'overlayStart', 'planGet',
    ])
    expect(twixy.getGatewayToken).toBeUndefined()
  })

  it('composer 는 사이드탭의 것을 받지 않는다 (창마다 진짜로 다르다)', async () => {
    const { twixy } = await loadPreload('composer')
    expect(typeof twixy.overlaySend).toBe('function')
    expect(twixy.closeSidetab).toBeUndefined()
    expect(twixy.overlayStart).toBeUndefined()
  })

  it('guardrail 은 3개, 전용 브릿지는 못 받는다', async () => {
    const { twixy, testOverlay } = await loadPreload('guardrail')
    expect(Object.keys(twixy).sort()).toEqual([
      'guardrailPopupDecide', 'guardrailPopupRequestSync', 'onGuardrailPopupSync',
    ])
    expect(testOverlay).toBeUndefined()
  })

  it('testOverlay 만 twixyTestOverlay 브릿지를 받는다', async () => {
    const { twixy, testOverlay } = await loadPreload('testOverlay')
    expect(Object.keys(twixy)).toEqual(['applyDisplayMarkup'])
    expect(Object.keys(testOverlay ?? {}).sort()).toEqual([
      'close', 'focusMain', 'onSync', 'requestSync', 'sendReviewDecision', 'stop',
    ])
  })

  it('좁힌 표면에 undefined 가 섞이지 않는다 (PER_WINDOW 의 오타를 잡는다)', async () => {
    for (const kind of ['sidetab', 'composer', 'guardrail', 'testOverlay']) {
      const { twixy } = await loadPreload(kind)
      for (const [name, value] of Object.entries(twixy)) {
        expect(value, `${kind}.${name}`).toBeDefined()
      }
    }
  })
})
