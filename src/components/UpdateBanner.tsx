// ─────────────────────────────────────────────────────────────────────────────
// UpdateBanner.tsx — "새 버전 나옴" 전역 배너 (타이틀바 바로 아래, in-flow).
//
// 현재 앱 버전(get-app-version) vs Supabase app_release 최신 버전 비교.
// 최신이 더 높으면 배너 표시 → 클릭 시 download_url 을 외부 브라우저로 연다.
// 자동 다운로드/설치 아님 (코드서명·publish provider 불필요). StaleCopyBanner UX 재사용.
//
// forced(현재 < min_supported): dismiss 불가 + 강조색. 아니면 X 로 닫기 가능.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { checkForUpdate, type UpdateStatus } from '../lib/appRelease'

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.twixy.getAppVersion()
      .then(v => checkForUpdate(v))
      .then(s => { if (!cancelled && s) setStatus(s) })
      .catch(() => { /* 조회 실패는 무시 — 배너 없이 정상 동작 */ })
    return () => { cancelled = true }
  }, [])

  if (!status || dismissed) return null
  const { release, forced } = status

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      borderBottom: '1px solid var(--border-subtle)',
      background: forced ? 'var(--accent, #4ea1ff)' : 'var(--bg-elevated)',
      color: forced ? '#fff' : 'var(--text-primary)',
      padding: '6px 16px',
      fontSize: 12,
      flexShrink: 0,
    }}>
      <span>
        {forced
          ? `이 버전은 더 이상 지원되지 않습니다. v${release.latest_version} 로 업데이트하세요.`
          : `새 버전 v${release.latest_version} 이 나왔습니다.`}
        {release.notes ? ` — ${release.notes}` : ''}
      </span>
      <button
        onClick={() => window.twixy.openExternal(release.download_url)}
        style={{
          border: 'none', background: 'none', padding: 0,
          color: forced ? '#fff' : 'var(--accent, #4ea1ff)',
          fontSize: 12, fontWeight: 600, cursor: 'pointer',
          textDecoration: 'underline',
        }}
      >
        다운로드
      </button>
      {!forced && (
        <button
          onClick={() => setDismissed(true)}
          title="닫기"
          style={{
            marginLeft: 'auto', border: 'none', background: 'none',
            padding: 0, color: 'var(--text-muted)', fontSize: 14, cursor: 'pointer',
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}
