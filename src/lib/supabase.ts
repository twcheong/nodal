// ─────────────────────────────────────────────────────────────────────────────
// supabase.ts — 렌더러에서 사용하는 싱글톤 Supabase 클라이언트.
// useAuth / useEntitlements 등이 import 해서 사용.
//
// anon 키는 공개되어도 안전한 값이지만, 실제 보안은 RLS(Row Level Security) 규칙으로 강제된다.
// 이 파일은 해당 키를 하드코딩해 Electron 번들에 포함시켜 첫 기동부터 바로 인증이 되도록 한다.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'
import { processLock } from '@supabase/auth-js'
import { PRODUCT } from './product'

// in-process 락 + 타임아웃 제거. processLock 은 auth 호출을 프로미스 체인으로
// 직렬화해 navigator 락의 "steal" 경합을 없애지만, 기본 acquireTimeout 이 걸려
// 있어 호출이 몰리면 "Acquiring process lock … timed out" 을 던진다. auth-js 규약상
// acquireTimeout 이 음수면 타임아웃이 비활성화되므로(-1), 앞 작업만 기다리고
// 절대 타임아웃하지 않는다. 단일 창 데스크톱 앱이라 무한 대기 위험은 없다
// (Supabase 요청 자체는 네트워크 레벨에서 종료됨).
const noTimeoutLock = <R,>(name: string, _acquireTimeout: number, fn: () => Promise<R>): Promise<R> =>
  processLock(name, -1, fn)

// X Viral Marketing Tool 웹앱과 동일한 Supabase 프로젝트 사용.
// 계정을 공유해 웹/데스크톱 어느 쪽에서 로그인해도 하나의 세션처럼 느껴지도록.
//
// URL + anon 키는 제품 프로필이 단일 출처다 (products/<id>/profile.ts). electron main 도
// 같은 프로필을 읽으므로 예전의 두 벌 복제(TWIX-18)는 없어졌다. anon 키는 공개 안전(실제 보안은 RLS).
const SUPABASE_URL = PRODUCT.supabase.url
const SUPABASE_ANON_KEY = PRODUCT.supabase.anonKey

// Electron 렌더러의 localStorage 는 앱별로 격리되므로 supabase-js 기본 storage 로 세션 캐싱 OK.
// 다만 "진리 원본" 세션은 메인 프로세스가 auth-save-session IPC 로 디스크에 미러링한다 —
// 이 덕분에 리로드·재기동 후에도 로그인 상태가 유지된다 (useAuth.ts 참고).
// detectSessionInUrl=false: 데스크톱 앱이라 URL 해시에서 OAuth 세션 추출이 필요 없음.
/** 제품 프로필에 Supabase 가 아직 안 채워졌다 (백엔드가 생기기 전의 새 제품).
 *  createClient 는 빈 URL 에 throw 해서 모듈 import 단계에서 앱이 흰 화면으로 죽는다 —
 *  자리표시자로 만들어 두고, App 이 이 플래그를 보고 로그인 대신 안내 화면을 띄운다. */
export const BACKEND_CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY && PRODUCT.webUrl)

export const supabase = createClient(
  SUPABASE_URL || 'http://backend-not-configured.invalid',
  SUPABASE_ANON_KEY || 'backend-not-configured', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    // Electron 렌더러는 브라우저처럼 멀티탭이 아니므로 navigator.locks 대신
    // in-process 락을 쓴다. navigator 락의 "steal"(AbortError)도, processLock
    // 기본 타임아웃("… timed out")도 없애기 위해 타임아웃 비활성 래퍼를 쓴다.
    lock: noTimeoutLock,
  },
  },
)
