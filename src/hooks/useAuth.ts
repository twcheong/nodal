import { useEffect, useState, useCallback } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

/**
 * Twixy 데스크톱 앱의 인증 훅 (Supabase 기반).
 *
 * 로그인 방식:
 *   로그인 UI 는 외부 웹(https://www.twixy.dev/auth/desktop-callback) 에 있고,
 *   로그인 완료 시 브라우저가 `twixy://auth#access_token=...&refresh_token=...` 딥링크로
 *   데스크톱 앱을 호출한다. 메인 프로세스가 이 URL 을 파싱해 디스크에 세션을 저장.
 *
 * 이 훅이 하는 일:
 *   1) 마운트 시: 메인 프로세스가 디스크에 저장해둔 세션(authGetSession) 으로
 *      Supabase 클라이언트를 하이드레이트.
 *   2) onAuthStateChange 구독: Supabase 가 토큰을 자동 갱신할 때마다
 *      authSaveSession IPC 로 디스크에 다시 써서 다음 기동에 이어서 사용 가능.
 *   3) onAuthSession 이벤트: 앱이 이미 실행 중일 때 새 딥링크가 도착하면
 *      해당 세션으로 재-하이드레이트.
 *
 * `loading` 은 최초 하이드레이트 시도가 끝날 때까지 true.
 * App.tsx 는 이 구간에 스플래시를 띄워야 한다 — 안 그러면 이미 로그인된 사용자에게
 * 로그인 화면이 한 프레임 깜빡여 보인다.
 */
export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // 디스크에서 읽어온 세션 페이로드를 Supabase 클라이언트에 주입해 활성화한다.
  // access_token 이나 refresh_token 이 없으면 로그아웃 상태로 처리.
  const applyStoredSession = useCallback(async (stored: { access_token: string; refresh_token: string } | null) => {
    if (!stored?.access_token || !stored?.refresh_token) {
      setSession(null)
      setUser(null)
      return
    }
    const { data, error } = await supabase.auth.setSession({
      access_token: stored.access_token,
      refresh_token: stored.refresh_token,
    })
    if (error) {
      console.warn('[twixy/auth] setSession failed:', error.message)
      setSession(null)
      setUser(null)
      return
    }
    setSession(data.session ?? null)
    setUser(data.session?.user ?? null)
  }, [])

  // 최초 1회: 디스크에 저장된 세션으로 하이드레이트 시도.
  // cancelled 플래그는 StrictMode 더블마운트나 빠른 언마운트 대비.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stored = await window.twixy?.authGetSession?.()
        if (cancelled) return
        await applyStoredSession(stored ?? null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [applyStoredSession])

  // 토큰 로테이션을 디스크에 미러링.
  // Supabase 가 만료 직전 자동 리프레시할 때마다 새 토큰을 파일에 써둬야
  // 다음 기동에서도 로그인 상태가 유지된다.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setUser(newSession?.user ?? null)
      if (newSession?.access_token && newSession?.refresh_token) {
        window.twixy?.authSaveSession?.({
          access_token:  newSession.access_token,
          refresh_token: newSession.refresh_token,
          expires_at:    newSession.expires_at ?? null,
        })
      } else {
        window.twixy?.authSaveSession?.(null)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // 앱이 이미 실행 중일 때 들어오는 새 딥링크 처리 (예: 사용자가 로그아웃 후 재로그인).
  useEffect(() => {
    const off = window.twixy?.onAuthSession?.((stored) => {
      void applyStoredSession(stored)
    })
    return () => { off?.() }
  }, [applyStoredSession])

  // 로그인 트리거: 외부 브라우저로 /auth/desktop-callback 페이지를 연다.
  // 실제 인증은 그 페이지에서 일어나고, 결과는 twixy:// 딥링크로 다시 돌아옴.
  const signIn = useCallback(() => {
    window.twixy?.authSignIn?.()
  }, [])

  // 로그아웃: Supabase 클라이언트 상태와 디스크 세션 모두 정리.
  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    await window.twixy?.authSignOut?.()
    setSession(null)
    setUser(null)
  }, [])

  return { session, user, loading, signIn, signOut }
}
