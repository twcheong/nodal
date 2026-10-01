// Nodal 엔진(로컬 Python 서버)의 REST API 클라이언트 — 메인 프로세스 전용.
//
// 왜 렌더러에서 직접 fetch 하지 않는가: 엔진은 CORS 헤더를 내지 않으므로 file:// 나
// vite 오리진의 렌더러에서는 JSON API 를 읽을 수 없다. (에셋은 <video>/<img> 로 직접
// 불러도 된다 — 미디어 요소 재생에는 CORS 가 필요 없다.)
//
// 응답 형태는 엔진 저장소의 schemas/openapi.json 을 따른다.

export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:8188'

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface RunSummary {
  run_id: string
  status: RunStatus
  node_count: number
  /** MCP 템플릿 실행이면 카탈로그 ID — 노드 ID 는 `call:<정의 안쪽>` 으로 평탄화돼 있다. */
  template_id?: string | null
  created_at: string
  started_at?: string | null
  finished_at?: string | null
  elapsed_ms?: number | null
}

export interface AssetRef {
  hash: string
  media_type: string
  size_bytes: number
  width?: number | null
  height?: number | null
}

export interface RunDetail extends RunSummary {
  outputs: Record<string, Array<{ socket: string; asset?: AssetRef | null }>>
  /** 실행된 · 캐시로 건너뛴 · 막힌 노드 (평탄화 후 ID). 실행 중이면 지금까지. */
  executed?: string[]
  cached?: string[]
  blocked?: string[]
  error?: { code: string; message: string } | null
  /** 실제로 돈 그래프 (평탄화 후 — 노드 ID 가 이벤트와 같다). 캐논 그래프 문서 그대로라 여기선 모양을 묻지 않는다. */
  graph?: unknown
  /** 실행 중 진행. */
  progress?: { completed_nodes: number; total_nodes?: number | null; node_id?: string | null; step?: number | null; total_steps?: number | null }
}

export interface EngineRuns {
  running: RunSummary | null
  queued: RunSummary[]
  history: RunSummary[]
}

/** 엔진은 루프백 전용이고 인증이 없다 — 다른 호스트로 요청이 나가지 않게 막는다. */
export function assertLoopback(baseUrl: string): URL {
  const u = new URL(baseUrl)
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error(`engine URL must be a local http address, got ${baseUrl}`)
  }
  return u
}

async function getJson<T>(baseUrl: string, path: string, timeoutMs = 4000): Promise<T> {
  const url = new URL(path, assertLoopback(baseUrl))
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`engine ${path} → ${res.status}`)
  return await res.json() as T
}

/** 엔진이 떠 있는가. 꺼져 있는 것은 오류가 아니라 정상적인 상태 중 하나다. */
export async function engineStatus(baseUrl: string): Promise<{ running: boolean; nodeCount?: number }> {
  try {
    const nodes = await getJson<unknown[] | { nodes?: unknown[] }>(baseUrl, '/api/nodes', 2500)
    const list = Array.isArray(nodes) ? nodes : nodes.nodes
    return { running: true, nodeCount: Array.isArray(list) ? list.length : undefined }
  } catch {
    return { running: false }
  }
}

export function listRuns(baseUrl: string): Promise<EngineRuns> {
  return getJson<EngineRuns>(baseUrl, '/api/runs')
}

export async function getRun(baseUrl: string, runId: string): Promise<RunDetail> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error('invalid run id')
  return getJson<RunDetail>(baseUrl, `/api/runs/${runId}`)
}

/** RunDetail.outputs 에서 저장소 에셋만 뽑는다 (영상·이미지). 같은 해시는 한 번만. */
export function collectAssets(run: RunDetail): AssetRef[] {
  const seen = new Set<string>()
  const out: AssetRef[] = []
  for (const refs of Object.values(run.outputs ?? {})) {
    for (const ref of refs) {
      if (ref.asset && !seen.has(ref.asset.hash)) { seen.add(ref.asset.hash); out.push(ref.asset) }
    }
  }
  return out
}

// ── 렌더러 중계 ────────────────────────────────────────────────────────────────
// 노드 에디터(engine/apps/web)는 엔진 REST 를 직접 부르는 클라이언트를 갖고 있지만, 엔진은 CORS 를
// 내지 않고 우리 렌더러는 file:// (Origin: null) 이다. 엔진에 null 오리진을 열면 사용자가 연
// 아무 로컬 html 도 엔진 결과를 읽을 수 있게 되므로, 대신 메인 프로세스가 중계한다.
// WebSocket(/ws)과 <img>/<video> 의 에셋 로드는 CORS 대상이 아니라 렌더러가 직접 붙는다.

export interface EngineHttpRequest {
  method: 'GET' | 'POST' | 'DELETE'
  /** '/api/...' 만 허용 — /mcp 나 정적 경로로 새지 않게. */
  path: string
  /** JSON 본문 (문자열 그대로 보낸다). */
  json?: string
  /** multipart 업로드 한 파일 (필드 이름 'file'). */
  file?: { name: string; type: string; data: ArrayBuffer | Uint8Array }
}

export interface EngineHttpResponse {
  status: number
  /** JSON 이면 파싱된 값, 아니면 null. */
  body: unknown
}

export async function engineRequest(baseUrl: string, req: EngineHttpRequest, timeoutMs = 30_000): Promise<EngineHttpResponse> {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw new Error(`method not allowed: ${req.method}`)
  if (!/^\/api\/[A-Za-z0-9_\-/.?=&%]*$/.test(req.path) || req.path.includes('..')) throw new Error(`path not allowed: ${req.path}`)
  const url = new URL(req.path, assertLoopback(baseUrl))
  let body: FormData | string | undefined
  const headers: Record<string, string> = {}
  if (req.file) {
    const form = new FormData()
    // 복사본 — IPC 로 온 Buffer 는 공유 풀(ArrayBufferLike)을 가리킬 수 있어 Blob 에 바로 못 넣는다.
    const bytes = new Uint8Array(req.file.data instanceof Uint8Array ? req.file.data : new Uint8Array(req.file.data))
    form.append('file', new Blob([bytes], { type: req.file.type || 'application/octet-stream' }), req.file.name)
    body = form
  } else if (req.json !== undefined) {
    body = req.json
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(url, { method: req.method, body, headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
  return { status: res.status, body: parsed }
}

export async function cancelRun(baseUrl: string, runId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error('invalid run id')
  const res = await engineRequest(baseUrl, { method: 'DELETE', path: `/api/runs/${runId}` })
  if (res.status >= 400) throw new Error(`cancel failed (${res.status})`)
}

/** 에셋 원본 바이트 — 워크스페이스로 저장할 때. */
export async function fetchAsset(baseUrl: string, hash: string): Promise<{ bytes: Buffer; mediaType: string }> {
  if (!/^[A-Za-z0-9]{8,128}$/.test(hash)) throw new Error('invalid asset hash')
  const url = new URL(`/api/assets/${hash}`, assertLoopback(baseUrl))
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`asset ${hash} → ${res.status}`)
  return { bytes: Buffer.from(await res.arrayBuffer()), mediaType: res.headers.get('content-type') ?? 'application/octet-stream' }
}

/** 파일 업로드 → 엔진 에셋. 반환된 hash 를 `asset:<hash>` 로 템플릿 이미지 입력에 넘긴다. */
export async function uploadAsset(baseUrl: string, file: NonNullable<EngineHttpRequest['file']>): Promise<AssetRef> {
  const res = await engineRequest(baseUrl, { method: 'POST', path: '/api/assets', file }, 120_000)
  if (res.status >= 400) throw new Error(`upload failed (${res.status})`)
  return res.body as AssetRef
}
