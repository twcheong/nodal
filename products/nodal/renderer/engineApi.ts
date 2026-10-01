// 렌더러 → 메인(products/nodal/electron) 호출 래퍼. 타입은 메인 쪽 모듈과 공유한다 (type import 만 —
// 번들에는 node 코드가 들어오지 않는다).
import type { AssetRef, EngineHttpRequest, EngineHttpResponse, EngineRuns, RunDetail, RunSummary } from '../electron/engine'
import type { EngineSnapshot } from '../electron/engineManager'
import type { GpuInfo, ImportResult, SetupJob } from '../electron/setup'
import type { SystemStats } from '../electron/systemStats'

export type { AssetRef, EngineRuns, EngineSnapshot, GpuInfo, ImportResult, RunDetail, RunSummary, SetupJob, SystemStats }

export type EngineStatus = EngineSnapshot & { running: boolean; nodeCount?: number }

export interface PackStatus {
  id: string
  label: string
  description: string
  approxGB: number
  license: string
  templates: string[]
  requires: string[]
  cudaOnly: boolean
  installed: boolean
  available: boolean
}

export interface SetupStatus {
  platform: string
  uv: boolean
  runtimeInstalled: boolean
  gpu: GpuInfo | null
  cuda: boolean
  dataDir: string
  packs: PackStatus[]
  job: SetupJob | null
  engine: EngineSnapshot
}

async function invoke<T>(name: string, payload?: unknown): Promise<T> {
  const res = await window.twixy?.productInvoke?.(name, payload)
  if (!res) throw new Error('not running inside the desktop app')
  if (!res.ok) throw new Error(res.error)
  return res.data as T
}

export const engineApi = {
  status:   () => invoke<EngineStatus>('nodal-engine-status'),
  logs:     () => invoke<string[]>('nodal-engine-logs'),
  start:    () => invoke<EngineSnapshot>('nodal-engine-start'),
  restart:  () => invoke<EngineSnapshot>('nodal-engine-restart'),
  systemStats: () => invoke<SystemStats>('nodal-system-stats'),
  runs:     () => invoke<EngineRuns>('nodal-runs'),
  run:      (runId: string) => invoke<{ run: RunDetail; assets: AssetRef[] }>('nodal-run', { runId }),
  cancel:   (runId: string) => invoke<boolean>('nodal-cancel-run', { runId }),
  saveAsset: (hash: string, name?: string) => invoke<{ relPath: string }>('nodal-save-asset', { hash, name }),
  http:     (req: EngineHttpRequest) => invoke<EngineHttpResponse>('nodal-http', req),
  templates: {
    list: () => invoke<string[]>('nodal-templates-list'),
    read: (id: string) => invoke<unknown>('nodal-template-read', { id }),
    save: (id: string, doc: unknown) => invoke<{ ok: boolean; snapshot: EngineSnapshot }>('nodal-template-save', { id, doc }),
  },
  setup: {
    status:         () => invoke<SetupStatus>('nodal-setup-status'),
    installRuntime: () => invoke<SetupJob>('nodal-setup-install-runtime'),
    downloadPack:   (id: string) => invoke<SetupJob>('nodal-setup-download-pack', { id }),
    /** 폴더 선택 창을 띄워 이미 받은 모델을 연결한다. 창을 취소하면 null. */
    importFolder:   () => invoke<SetupJob | null>('nodal-setup-import-folder'),
    cancel:         () => invoke<SetupJob | null>('nodal-setup-cancel'),
  },
}

/** 최신이 먼저 오는 한 줄 목록 — 실행 중 → 대기 → 완료. */
export function flattenRuns(runs: EngineRuns): RunSummary[] {
  return [...(runs.running ? [runs.running] : []), ...runs.queued, ...runs.history]
}

/** 에셋은 엔진에서 직접 불러온다 — <video>/<img> 재생에는 CORS 가 필요 없다. */
export function assetUrl(engineUrl: string, hash: string): string {
  return `${engineUrl.replace(/\/$/, '')}/api/assets/${encodeURIComponent(hash)}`
}

export function formatElapsed(ms: number | null | undefined): string {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1_048_576).toFixed(1)} MB`
}
