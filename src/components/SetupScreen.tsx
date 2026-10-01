/**
 * SetupScreen — 첫 실행/기동 실패 복구 화면.
 * OpenClaw 게이트웨이 기동에 실패했을 때(주로 Windows 에서 Node 22 부재) 사용자에게 보임.
 *
 * 플로우:
 *   1) 원본 startup 에러 메시지와 함께 카드 렌더링
 *   2) Node 22 이슈로 보이면 원클릭 자동 설치 버튼 제공 (관리자 권한 불필요)
 *   3) portable node.exe (~22MB) 를 %LOCALAPPDATA%\Twixy\node\ 에 다운로드/추출
 *   4) retryOpenClaw() 호출 → 성공 시 onSuccess() 로 이 화면 닫고 정상 부팅 계속
 *
 * 진행률은 메인 프로세스의 node-install-progress 이벤트로 수신.
 * 디버그용 "Show openclaw log" 섹션으로 로그 확인/파일 오픈 제공.
 */

import { useState, useEffect } from 'react'

interface Props {
  errorMsg: string
  onSuccess: () => void
}

// Node 설치 진행 단계. 프로그레스바와 버튼 가시성이 이 값에 따라 분기된다.
type Phase = 'idle' | 'downloading' | 'extracting' | 'installing' | 'done' | 'failed'

// 에러 메시지에서 "Node 미설치" 느낌을 휴리스틱으로 감지.
// 정확하지 않아도 됨 — 일치하면 자동 설치 버튼이 뜨고, 아니면 Retry 버튼만 표시된다.
function isNodeMissingError(msg: string) {
  return (
    msg.includes('Node 22') ||
    msg.includes('node22') ||
    msg.includes('ENOENT') ||
    msg.includes('not found') ||
    msg.includes('spawn') ||
    msg.toLowerCase().includes('node')
  )
}

const PHASE_LABELS: Record<string, string> = {
  downloading: 'Downloading Node.js…',
  extracting:  'Extracting…',
  installing:  'Installing…',
  done:        'Done!',
}

export function SetupScreen({ errorMsg, onSuccess }: Props) {
  const [phase, setPhase]       = useState<Phase>('idle')
  const [pct,   setPct]         = useState(0)
  const [errDetail, setErr]     = useState<string | null>(null)
  const [log, setLog]           = useState<string | null>(null)
  const isElectron = typeof window !== 'undefined' && !!window.twixy

  // 메인 프로세스가 방송하는 다운로드/추출 진행률 이벤트 구독.
  // 현재 phase 를 이 이벤트 기준으로 업데이트해 프로그레스바가 실시간 반영되게 한다.
  useEffect(() => {
    if (!isElectron) return
    const off = window.twixy.onNodeInstallProgress(({ phase: p, pct: n }) => {
      if (p === 'downloading') { setPhase('downloading'); setPct(n) }
      if (p === 'extracting')  { setPhase('extracting');  setPct(n) }
      if (p === 'installing')  { setPhase('installing');  setPct(n) }
      if (p === 'done')        { setPhase('done');         setPct(100) }
    })
    return off
  }, [isElectron])

  // "Install Node.js 22" 버튼 핸들러.
  // 1) installNode22 IPC → portable Node 다운로드/추출
  // 2) 설치 후 retryOpenClaw → 게이트웨이 재기동 시도
  // 3) 성공 시 onSuccess(), 실패 시 에러 메시지 표시
  const handleInstall = async () => {
    if (!isElectron) return
    setPhase('downloading')
    setPct(0)
    setErr(null)

    const result = await window.twixy.installNode22()
    if (!result.ok) {
      setPhase('failed')
      setErr(result.error ?? 'Unknown error')
      return
    }

    // Node is installed — retry the gateway
    setPhase('installing')
    const retry = await window.twixy.retryOpenClaw()
    if (retry.ok) {
      setPhase('done')
      onSuccess()
    } else {
      setPhase('failed')
      setErr(retry.error ?? 'Gateway failed to start after install')
    }
  }

  // Node 이슈가 아닌 일반 기동 실패일 때 표시되는 "Retry" 버튼 핸들러.
  // 별도 설치 없이 retryOpenClaw 만 호출해 일시적 문제(포트 충돌 등) 회복 시도.
  const handleRetry = async () => {
    if (!isElectron) return
    setErr(null)
    const retry = await window.twixy.retryOpenClaw()
    if (retry.ok) {
      onSuccess()
    } else {
      setErr(retry.error ?? 'Gateway still not starting')
    }
  }

  const needsNodeInstall = isNodeMissingError(errorMsg)
  const busy = phase === 'downloading' || phase === 'extracting' || phase === 'installing'

  return (
    <div style={{
      position:       'fixed',
      inset:          0,
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      background:     'var(--bg-base, #fafaf6)',
      color:          'var(--text-primary, #14201b)',
      fontFamily:     'system-ui, sans-serif',
      gap:            24,
      padding:        48,
    }}>

      {/* Logo */}
      <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.02em' }}>Twixy</div>

      {/* Card */}
      <div style={{
        background:   'var(--bg-surface, #1a1a1a)',
        border:       '1px solid var(--border-subtle, #d9e1da)',
        borderRadius: 12,
        padding:      32,
        maxWidth:     440,
        width:        '100%',
        display:      'flex',
        flexDirection:'column',
        gap:          20,
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
            Setup required
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted, #4a594f)', lineHeight: 1.6 }}>
            {needsNodeInstall
              ? 'Twixy needs Node.js 22 to run its AI engine. Click below to install it automatically — no admin password needed.'
              : 'The AI engine failed to start. Check the error below and try again.'}
          </div>
        </div>

        {/* Progress bar (visible while busy) */}
        {busy && (
          <div>
            <div style={{
              fontSize: 12,
              color:    'var(--text-muted, #4a594f)',
              marginBottom: 6,
            }}>
              {PHASE_LABELS[phase] ?? 'Working…'} {pct > 0 ? `${pct}%` : ''}
            </div>
            <div style={{
              height:       6,
              background:   'var(--bg-base, #fafaf6)',
              borderRadius: 3,
              overflow:     'hidden',
            }}>
              <div style={{
                height:     '100%',
                width:      `${pct}%`,
                background: 'var(--accent, #0d5c50)',
                borderRadius: 3,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        )}

        {/* Error detail */}
        {errDetail && (
          <div style={{
            fontSize:     11,
            color:        'var(--danger)',
            background:   'rgba(181, 72, 47,0.08)',
            border:       '1px solid rgba(181, 72, 47,0.2)',
            borderRadius: 6,
            padding:      '8px 12px',
            fontFamily:   'monospace',
            whiteSpace:   'pre-wrap',
            wordBreak:    'break-all',
          }}>
            {errDetail}
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {needsNodeInstall && !busy && phase !== 'done' && (
            <button
              onClick={handleInstall}
              style={{
                flex:         1,
                padding:      '10px 18px',
                background:   'var(--accent, #0d5c50)',
                color:        '#fff',
                border:       'none',
                borderRadius: 8,
                fontSize:     13,
                fontWeight:   600,
                cursor:       'pointer',
              }}
            >
              Install Node.js 22
            </button>
          )}

          {!needsNodeInstall && !busy && (
            <button
              onClick={handleRetry}
              style={{
                flex:         1,
                padding:      '10px 18px',
                background:   'var(--accent, #0d5c50)',
                color:        '#fff',
                border:       'none',
                borderRadius: 8,
                fontSize:     13,
                fontWeight:   600,
                cursor:       'pointer',
              }}
            >
              Retry
            </button>
          )}

          {phase === 'failed' && needsNodeInstall && (
            <>
              <button
                onClick={handleInstall}
                style={{
                  flex:         1,
                  padding:      '10px 18px',
                  background:   'var(--accent, #0d5c50)',
                  color:        '#fff',
                  border:       'none',
                  borderRadius: 8,
                  fontSize:     13,
                  fontWeight:   600,
                  cursor:       'pointer',
                }}
              >
                Try again
              </button>
              <button
                onClick={() => window.twixy.openExternal('https://nodejs.org/en/download')}
                style={{
                  padding:      '10px 18px',
                  background:   'transparent',
                  color:        'var(--text-muted, #4a594f)',
                  border:       '1px solid var(--border-subtle, #d9e1da)',
                  borderRadius: 8,
                  fontSize:     13,
                  cursor:       'pointer',
                }}
              >
                Install manually
              </button>
            </>
          )}
        </div>

        {/* Debug log viewer */}
        <details style={{ fontSize: 11, color: 'var(--text-muted, #666)' }}>
          <summary
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => {
              if (!log && isElectron) {
                window.twixy.getOpenClawLog().then(setLog)
              }
            }}
          >
            Show openclaw log
          </summary>
          <div style={{ display: 'flex', gap: 8, margin: '6px 0' }}>
            <button
              onClick={() => isElectron && window.twixy.getOpenClawLog().then(setLog)}
              style={{ fontSize: 10, padding: '3px 8px', cursor: 'pointer', background: 'transparent', color: 'var(--text-muted,var(--text-secondary))', border: '1px solid var(--border-subtle,var(--border-subtle))', borderRadius: 4 }}
            >Refresh</button>
            <button
              onClick={() => isElectron && window.twixy.openLogFile()}
              style={{ fontSize: 10, padding: '3px 8px', cursor: 'pointer', background: 'transparent', color: 'var(--text-muted,var(--text-secondary))', border: '1px solid var(--border-subtle,var(--border-subtle))', borderRadius: 4 }}
            >Open log file</button>
          </div>
          <pre style={{
            marginTop:  4,
            padding:    '8px 10px',
            background: 'var(--bg-base, #fafaf6)',
            borderRadius: 6,
            overflow:   'auto',
            maxHeight:  200,
            fontSize:   10,
            whiteSpace: 'pre-wrap',
            wordBreak:  'break-all',
          }}>
            {log ?? errorMsg}
          </pre>
        </details>
      </div>
    </div>
  )
}
