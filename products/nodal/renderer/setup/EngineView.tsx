// 엔진 탭 — 첫 실행 설치(파이썬 런타임 + 모델 팩)와 엔진 상태·로그.
//
// 설치는 메인(electron/setup.ts)이 하고 이 화면은 nodal-setup-status 를 폴링해 그리기만 한다.
// 순서: ① 런타임 설치(uv sync) → 엔진이 뜬다 → ② 모델 팩 받기 (팩마다 엔진 재시작).
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '../../../../src/components/ui/Badge'
import { Button } from '../../../../src/components/ui/Button'
import { Spinner } from '../../../../src/components/ui/Spinner'
import type { ProductViewProps } from '../../../../src/lib/productShell'
import { engineApi, type PackStatus, type SetupStatus } from '../engineApi'
import { ENGINE_STATE_LABEL } from '../useEngineStatus'

const sectionTitle: React.CSSProperties = {
  margin: '0 0 6px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)',
}
const card: React.CSSProperties = {
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 14, background: 'var(--bg-surface)',
  display: 'flex', flexDirection: 'column', gap: 8,
}

export function EngineView({ active }: ProductViewProps) {
  const [st, setSt] = useState<SetupStatus | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setSt(await engineApi.setup.status())
      if (showLogs) setLogs(await engineApi.logs())
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [showLogs])

  const jobRunning = !!st?.job && ['preparing', 'running', 'verifying'].includes(st.job.phase)
  useEffect(() => {
    if (!active) return
    void refresh()
    const t = setInterval(() => void refresh(), jobRunning || st?.engine.state === 'starting' ? 1000 : 5000)
    return () => clearInterval(t)
  }, [active, refresh, jobRunning, st?.engine.state])

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    void refresh()
  }

  if (!st) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={16} /></div>

  const job = st.job
  const pct = job && job.bytesTotal > 0 ? Math.min(100, (job.bytesDone / job.bytesTotal) * 100) : null

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px', maxWidth: 820 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600 }}>엔진</h2>
      <p style={{ margin: '0 0 28px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        이미지·영상은 이 PC 에서 만들어집니다. 처음 한 번 엔진과 모델을 설치해 주세요. 생성 자체는 무료이고, 크레딧은 대화(AI)에만 쓰입니다.
      </p>

      {error && <div style={{ ...card, borderColor: 'var(--danger, #b42318)', color: 'var(--danger, #b42318)', fontSize: 12, marginBottom: 20 }}>{error}</div>}

      {/* ① 상태 */}
      <section style={{ marginBottom: 32 }}>
        <h3 style={sectionTitle}>상태</h3>
        <div style={card}>
          <Row label="엔진">
            <Badge variant={st.engine.state === 'ready' || st.engine.state === 'external' ? 'success' : st.engine.state === 'crashed' ? 'danger' : st.engine.state === 'starting' ? 'info' : 'neutral'}>
              {ENGINE_STATE_LABEL[st.engine.state]}
            </Badge>
            {st.engine.detail && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{st.engine.detail}</span>}
          </Row>
          <Row label="GPU">
            <span style={{ fontSize: 12 }}>
              {st.gpu ? `${st.gpu.name} · ${(st.gpu.vramMB / 1024).toFixed(0)} GB` : 'NVIDIA GPU 없음 — 영상 생성은 쓸 수 없고 이미지는 느리게 만들어집니다'}
            </span>
          </Row>
          <Row label="데이터 폴더"><code style={{ fontSize: 11 }}>{st.dataDir}</code></Row>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {st.runtimeInstalled && <Button size="sm" onClick={() => run(engineApi.restart)} disabled={jobRunning || st.engine.state === 'starting'}>엔진 재시작</Button>}
            <Button size="sm" variant="ghost" onClick={() => { setShowLogs((v) => !v); void engineApi.logs().then(setLogs).catch(() => {}) }}>
              {showLogs ? '로그 닫기' : '로그 보기'}
            </Button>
          </div>
          {showLogs && (
            <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', fontSize: 11, lineHeight: 1.5, background: 'var(--bg-base)', padding: 10, borderRadius: 'var(--radius-sm)', whiteSpace: 'pre-wrap' }}>
              {logs.length ? logs.join('\n') : '(로그 없음)'}
            </pre>
          )}
        </div>
      </section>

      {/* ② 런타임 */}
      <section style={{ marginBottom: 32 }}>
        <h3 style={sectionTitle}>1. 엔진 설치</h3>
        <div style={card}>
          <div style={{ fontSize: 13 }}>
            {st.runtimeInstalled
              ? '설치됨'
              : `파이썬 런타임과 ${st.cuda ? 'CUDA 용 PyTorch' : 'PyTorch'} 를 내려받아 설치합니다 (수 GB, 몇 분 걸립니다).`}
          </div>
          {!st.uv && <div style={{ fontSize: 12, color: 'var(--danger, #b42318)' }}>설치 도구(uv)를 찾을 수 없습니다.{st.platform === 'darwin' ? ' 개발 환경이면 npm run prepare:nodal-uv 를 실행해 주세요.' : ' 앱을 다시 설치해 주세요.'}</div>}
          {job?.kind === 'runtime' && <JobView job={job} pct={null} />}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant={st.runtimeInstalled ? 'secondary' : 'primary'} disabled={!st.uv || jobRunning} onClick={() => run(engineApi.setup.installRuntime)}>
              {st.runtimeInstalled ? '다시 설치 (복구)' : '설치하기'}
            </Button>
            {job?.kind === 'runtime' && jobRunning && <Button size="sm" variant="ghost" onClick={() => run(engineApi.setup.cancel)}>취소</Button>}
          </div>
        </div>
      </section>

      {/* ③ 모델 팩 */}
      <section style={{ marginBottom: 32 }}>
        <h3 style={sectionTitle}>2. 모델 받기</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          모델이 없어도 썸네일·제품 카드 합성은 됩니다. 중간에 멈춰도 다시 누르면 이어받습니다.
        </p>
        <div style={{ ...card, marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>이미 받은 모델이 있나요?</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            ComfyUI 의 models 폴더나 예전에 받아 둔 폴더를 고르면, 파일 이름·크기가 맞는 모델을 찾아 다시 받지 않고 연결합니다.
            같은 드라이브면 디스크 용량을 더 쓰지 않습니다. 여러 폴더에 나뉘어 있으면 한 번씩 골라 주세요.
          </div>
          {job?.kind === 'import' && <JobView job={job} pct={pct} />}
          {job?.kind === 'import' && job.phase === 'done' && <ImportResults job={job} />}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="secondary" disabled={jobRunning} onClick={() => run(engineApi.setup.importFolder)}>폴더에서 가져오기</Button>
            {job?.kind === 'import' && jobRunning && <Button size="sm" variant="ghost" onClick={() => run(engineApi.setup.cancel)}>취소</Button>}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {st.packs.map((p) => (
            <PackCard
              key={p.id}
              pack={p}
              packs={st.packs}
              runtimeReady={st.runtimeInstalled}
              job={job?.kind === 'pack' && job.id === p.id ? job : null}
              pct={job?.kind === 'pack' && job.id === p.id ? pct : null}
              busy={jobRunning}
              onDownload={() => run(() => engineApi.setup.downloadPack(p.id))}
              onCancel={() => run(engineApi.setup.cancel)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function PackCard({ pack, packs, runtimeReady, job, pct, busy, onDownload, onCancel }: {
  pack: PackStatus; packs: PackStatus[]; runtimeReady: boolean; job: SetupStatus['job']; pct: number | null; busy: boolean
  onDownload: () => void; onCancel: () => void
}) {
  const missing = pack.requires.filter((r) => !packs.find((p) => p.id === r)?.installed)
  const running = !!job && ['preparing', 'running', 'verifying'].includes(job.phase)
  return (
    <div style={{ ...card, opacity: pack.available ? 1 : 0.55 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{pack.label}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{pack.description}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {pack.approxGB >= 1 ? `${pack.approxGB.toFixed(1)} GB` : `${Math.round(pack.approxGB * 1024)} MB`} · 라이선스 {pack.license}
          </div>
        </div>
        {pack.installed ? <Badge variant="success">설치됨</Badge> : !pack.available ? <Badge variant="neutral">NVIDIA 전용</Badge> : null}
      </div>
      {job && <JobView job={job} pct={pct} />}
      {!pack.installed && pack.available && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button size="sm" variant="primary" disabled={!runtimeReady || busy || missing.length > 0} onClick={onDownload}>받기</Button>
          {running && <Button size="sm" variant="ghost" onClick={onCancel}>일시 정지</Button>}
          {missing.length > 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>먼저: {missing.map((m) => packs.find((p) => p.id === m)?.label ?? m).join(', ')}</span>}
          {!runtimeReady && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>엔진 설치 후 받을 수 있습니다</span>}
        </div>
      )}
    </div>
  )
}

function JobView({ job, pct }: { job: NonNullable<SetupStatus['job']>; pct: number | null }) {
  const label =
    job.phase === 'preparing' ? (job.kind === 'import' ? '폴더에서 모델을 찾는 중…' : '준비 중…') :
    job.phase === 'running' ? (job.kind === 'pack' ? `받는 중 ${job.fileIndex}/${job.fileCount}` : job.kind === 'import' ? `연결하는 중 ${job.fileIndex}/${job.fileCount}` : '설치 중…') :
    job.phase === 'verifying' ? '확인 중…' :
    job.phase === 'done' ? '완료' :
    job.phase === 'cancelled' ? (job.kind === 'import' ? '취소됨' : '멈춤 — 다시 누르면 이어받습니다') :
    `실패: ${job.error ?? ''}`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12, color: job.phase === 'failed' ? 'var(--danger, #b42318)' : 'var(--text-muted)' }}>
        {label}{pct !== null && job.phase === 'running' ? ` · ${pct.toFixed(1)}% (${(job.bytesDone / 1e9).toFixed(1)} / ${(job.bytesTotal / 1e9).toFixed(1)} GB)` : ''}
      </div>
      {pct !== null && (
        <div style={{ height: 6, background: 'var(--bg-hover)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s' }} />
        </div>
      )}
      {job.kind === 'runtime' && job.log.length > 0 && (
        <pre style={{ margin: 0, maxHeight: 140, overflow: 'auto', fontSize: 11, background: 'var(--bg-base)', padding: 8, borderRadius: 'var(--radius-sm)', whiteSpace: 'pre-wrap' }}>
          {job.log.slice(-40).join('\n')}
        </pre>
      )}
    </div>
  )
}

function ImportResults({ job }: { job: NonNullable<SetupStatus['job']> }) {
  const results = job.imported ?? []
  if (!results.length) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>이 폴더에서 팩 파일을 찾지 못했습니다. 다른 폴더를 골라 보세요.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {results.map((r) => (
        <div key={r.packId} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <Badge variant={r.installed ? 'success' : 'neutral'}>{r.installed ? '설치됨' : '일부'}</Badge>
          <span>{r.label}</span>
          <span style={{ color: 'var(--text-muted)' }}>
            {r.installed ? '' : `${r.missing.length}개 파일 없음 — 받기를 누르면 나머지만 받습니다 · `}
            연결 {r.linked - r.copied}{r.copied ? ` · 복사 ${r.copied}` : ''}{r.present ? ` · 이미 있음 ${r.present}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 80, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  )
}
