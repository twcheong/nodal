// ─────────────────────────────────────────────────────────────────────────────
// appRelease.ts — "새 버전 나옴" 알림용. Cursor 식 배너(자동설치 아님).
//
// 최신 버전은 Supabase `app_release` 싱글턴 테이블 1행에서 읽는다. RLS 로 anon 은
// SELECT 만 허용 → 유저는 버전 문자열 + 다운로드 링크만 봄. 우리 레포·소스·파이프라인은
// 노출되지 않는다. 릴리즈는 service-role/dashboard 에서 그 행을 UPDATE.
//   update app_release set latest_version='0.2.0', download_url='…', notes='…';
// 스키마·RLS 는 supabase/app_release.sql 참고.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase'

export interface AppRelease {
  latest_version: string
  download_url:   string
  notes:          string | null
  min_supported:  string | null
}

// "0.2.0" > "0.1.9" 를 정확히 비교. 숫자 파트만 본다(프리릴리즈 태그 무시).
// return: a<b → -1, a==b → 0, a>b → 1.
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

// 최신 릴리즈 1행 조회. 실패(네트워크·행없음·RLS)는 null → 배너 안 뜸(조용히).
export async function fetchLatestRelease(): Promise<AppRelease | null> {
  const { data, error } = await supabase
    .from('app_release')
    .select('latest_version, download_url, notes, min_supported')
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return data as AppRelease
}

export interface UpdateStatus {
  updateAvailable: boolean   // latest > current
  forced:          boolean   // current < min_supported → 강제 업데이트 권고
  release:         AppRelease
}

// 현재 버전 vs 최신. 업데이트 없으면 null.
export async function checkForUpdate(currentVersion: string): Promise<UpdateStatus | null> {
  const release = await fetchLatestRelease()
  if (!release?.latest_version) return null
  if (compareSemver(currentVersion, release.latest_version) >= 0) return null
  const forced = !!release.min_supported &&
    compareSemver(currentVersion, release.min_supported) < 0
  return { updateAvailable: true, forced, release }
}
