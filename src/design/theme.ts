// 테마 전환 — 라이트(Paper/Petrol, 기본) / 다크(기존 다크/퍼플).
// 기본값 'system'은 OS 설정을 따른다 (tokens.css의 prefers-color-scheme 블록).
// 수동 선택 시 html[data-theme]으로 고정하고 localStorage에 저장한다.
import { useEffect, useState } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'

const KEY = 'twixy.theme'
const CHANGE_EVENT = 'twixy-theme-change'

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function setThemePref(pref: ThemePref): void {
  if (pref === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, pref)
  applyTheme(pref)
}

function applyTheme(pref: ThemePref): void {
  const root = document.documentElement
  if (pref === 'system') delete root.dataset.theme
  else root.dataset.theme = pref
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** 각 렌더러 엔트리에서 렌더 전에 1회 호출 */
export function initTheme(): void {
  applyTheme(getThemePref())
}

/** 지금 실제로 보이는 테마 (system 선택 시 OS 설정 반영) */
export function getEffectiveTheme(): 'light' | 'dark' {
  const forced = document.documentElement.dataset.theme
  if (forced === 'light' || forced === 'dark') return forced
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 테마에 반응하는 컴포넌트용 훅 — 토글·OS 변경 모두 추적 (예: 테마별 로고) */
export function useEffectiveTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => getEffectiveTheme())
  useEffect(() => {
    const update = () => setTheme(getEffectiveTheme())
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', update)
    window.addEventListener(CHANGE_EVENT, update)
    return () => {
      mq.removeEventListener('change', update)
      window.removeEventListener(CHANGE_EVENT, update)
    }
  }, [])
  return theme
}
