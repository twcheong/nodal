// 슬라이드 위의 사진을 렌더러에서 실제로 그리기 위한 바이트 + 모양 공급기.
//
// SVG 페인터(shared/deck/preview/svg.ts)도 레이아웃 코어(shared/deck/layout)도
// 순수하고 동기라 파일을 못 읽는다 — 읽는 건 호스트 몫이다. 렌더러의 호스트
// 통로는 기존 `window.twixy.readImage`(워크스페이스 기준 resolve → data: URI).
// 새 IPC 를 파지 않은 이유가 그거다.
//
// 두 가지를 공급한다:
//   · 바이트(data: URI)  → 페인터가 <image href> 로 그린다
//   · 비율(가로/세로)    → 레이아웃이 액자를 사진 모양에 맞춘다
// 한 번 읽으면 둘 다 나오므로 캐시도 하나다. main 쪽은 sharp 로 같은 두 가지를
// 구한다(electron/tools/files/deckImages.ts) — 두 호스트가 같은 숫자를 주므로
// 프리뷰와 파일이 같은 기하로 수렴한다.
//
// 캐시를 모듈 레벨에 두는 이유: 같은 사진이 한 화면에 여러 번 뜬다 — 히어로
// 프리뷰 1장 + 썸네일 레일 N장 + 디자인 타일 수십 장이 전부 같은 슬라이드를
// 그린다. 컴포넌트마다 캐시를 들면 같은 파일을 수십 번 읽는다.
//
// 실패도 캐시한다(url: null). 없는 파일을 매 렌더마다 다시 물어보면 IPC 가
// 계속 돌고, 화면에는 어차피 같은 '이름 붙은 빈 프레임' 이 나온다.

import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { SlideDisplay } from '../../../../shared/deck/el'
import type { ImageSrc } from '../../../../shared/deck/preview/svg'

type Entry = { url: string | null; aspect?: number }

const cache = new Map<string, Entry>()
const inflight = new Set<string>()
/** 로드가 끝날 때마다 올라간다 — 훅들이 이걸 보고 다시 그린다. */
let version = 0
const listeners = new Set<() => void>()

function announce() {
  version++
  for (const l of listeners) l()
}

/** data: URI 에서 원본 픽셀 크기를 얻는다. 못 얻으면 비율 없이 진행. */
function measure(url: string): Promise<number | undefined> {
  if (typeof Image === 'undefined') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0
      ? img.naturalWidth / img.naturalHeight
      : undefined)
    img.onerror = () => resolve(undefined)
    img.src = url
  })
}

function load(paths: string[]): void {
  const wanted = paths.filter((p) => p && !cache.has(p) && !inflight.has(p))
  if (wanted.length === 0) return
  for (const p of wanted) inflight.add(p)
  void (async () => {
    for (const p of wanted) {
      let entry: Entry = { url: null }
      try {
        const url = (await window.twixy?.readImage?.(p)) ?? null
        entry = url ? { url, aspect: await measure(url) } : { url: null }
      } catch { /* 못 읽으면 프레임으로 남는다 */ }
      cache.set(p, entry)
      inflight.delete(p)
    }
    announce()
  })()
}

/** 로드 완료를 구독한다 — 구독자만 다시 그린다. */
function useImageVersion(): number {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(bump)
    return () => { listeners.delete(bump) }
  }, [])
  return version
}

/** 이 슬라이드가 쓰는 사진 경로들 (중복 제거, 등장 순서). */
export function imagePathsOf(slide: SlideDisplay | null | undefined): string[] {
  if (!slide) return []
  const out: string[] = []
  for (const el of slide.elements) {
    if (el.type === 'image' && el.path && !out.includes(el.path)) out.push(el.path)
  }
  return out
}

/** 덱 스펙 전체에서 사진 경로를 긁는다 (layout 블록 안까지). */
export function imagePathsOfPayload(payload: TwixyWritePptxPayload | null | undefined): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'imagePath' && typeof v === 'string') { if (!out.includes(v)) out.push(v) }
      else walk(v)
    }
  }
  walk(payload)
  return out
}

/**
 * 슬라이드가 쓰는 사진을 (한 번씩) 읽어 두고, 페인터에 넘길 resolver 를 준다.
 *
 * 아직 안 읽혔으면 undefined 를 돌려준다 — 페인터가 파일명이 적힌 프레임을
 * 그리고, 로드가 끝나면 리렌더되며 진짜 그림으로 바뀐다.
 */
export function useSlideImages(slide: SlideDisplay | null | undefined): ImageSrc {
  const paths = imagePathsOf(slide)
  const key = paths.join('|')
  const v = useImageVersion()

  useEffect(() => { load(key ? key.split('|') : []) }, [key])

  // v 가 의존성에 있어야 로드 완료 후 resolver 신원이 바뀌고, 이걸 memo 로
  // 감싼 소비처(디자인 타일)도 다시 그린다.
  return useCallback((p: string) => cache.get(p)?.url ?? undefined, [key, v])
}

/**
 * 덱이 쓰는 사진들의 가로/세로 비율 — `buildDeck(payload, { imageAspects })` 로.
 *
 * 비어 있는 동안(첫 프레임)에는 코어가 비율 없이 그리고, 도착하면 한 번 다시
 * 그린다. 최종 상태는 main 이 계산하는 것과 같은 숫자라 파일과 어긋나지 않는다.
 */
export function useImageAspects(payload: TwixyWritePptxPayload | null | undefined): Record<string, number> {
  const paths = imagePathsOfPayload(payload)
  const key = paths.join('|')
  const v = useImageVersion()

  useEffect(() => { load(key ? key.split('|') : []) }, [key])

  return useMemo(() => {
    const out: Record<string, number> = {}
    for (const p of key ? key.split('|') : []) {
      const a = cache.get(p)?.aspect
      if (a) out[p] = a
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, v])
}
