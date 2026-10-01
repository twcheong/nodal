// ─────────────────────────────────────────────────────────────────────────────
// productShell.ts — 제품이 앱 셸(사이드바·메인 패널·로고)에 끼워 넣는 자리.
//
// copilotModes.ts 와 같은 방식이다: products/<id>/renderer/main.tsx 가 App 을 렌더하기
// **전에** 여기에 등록하고, 코어(Sidebar·App)는 등록된 것이 무엇인지 모른 채 읽기만 한다.
//
// 탭이 보일지·순서는 여전히 profile 의 features.views / features.panels 가 정한다 —
// 등록만 하고 views 에 id 를 넣지 않으면 사이드바에 안 나온다.
// ─────────────────────────────────────────────────────────────────────────────
import type { ComponentType } from 'react'
import { createAgentRegistry } from './agents/registry'

export interface ProductViewProps {
  /** 이 탭이 지금 보이는가 — 숨겨진 채로 마운트돼 있을 때 폴링을 멈추는 데 쓴다. */
  active: boolean
  /** 다른 탭으로 이동 (예: 에디터 → 채팅). */
  navigate: (view: string) => void
}

export interface ProductView {
  /** features.views / panels 에 적는 id. 코어 탭 id 와 겹치면 안 된다. */
  id: string
  /** 사이드바 아이콘 (유니코드 한 글자 — 코어 탭과 같은 표기). */
  icon: string
  label: string
  Component: ComponentType<ProductViewProps>
}

const views = createAgentRegistry<ProductView>()

export function registerProductView(view: ProductView): void {
  views.register(view)
}

export function getProductView(id: string | null | undefined): ProductView | undefined {
  return views.get(id)
}

export function listProductViews(): ProductView[] {
  return views.list()
}

// ── 로고 ──────────────────────────────────────────────────────────────────────
// 사이드바 맨 위(copilot 탭) 로고. 제품이 안 정하면 Sidebar 의 기본(Twixy) 로고를 쓴다.
// 이미지 import 는 렌더러 번들에서만 되므로 profile.ts(순수 데이터)가 아니라 여기로 받는다.
export interface ProductLogo { light: string; dark: string }

let logo: ProductLogo | null = null

export function setProductLogo(next: ProductLogo): void {
  logo = next
}

export function getProductLogo(): ProductLogo | null {
  return logo
}

// ── 탭 이동 ───────────────────────────────────────────────────────────────────
// 제품 코드가 탭을 바꿔야 할 때 (예: 채팅 패널의 "설치하기" → 엔진 탭). SidePanel 처럼
// navigate prop 을 못 받는 자리에서도 쓸 수 있게 App 이 마운트 때 한 번 연결한다.
let shellNavigate: ((view: string) => void) | null = null
const readyListeners: Array<() => void> = []

export function setShellNavigator(fn: ((view: string) => void) | null): void {
  shellNavigate = fn
  if (fn) for (const l of readyListeners.splice(0)) l()
}

/** 앱 셸이 떠서(로그인 뒤) 탭 이동이 가능해지면 한 번 부른다 — 예: 첫 실행이면 설치 탭으로. */
export function onShellReady(fn: () => void): void {
  if (shellNavigate) fn()
  else readyListeners.push(fn)
}

export function navigateToView(view: string): void {
  shellNavigate?.(view)
}
