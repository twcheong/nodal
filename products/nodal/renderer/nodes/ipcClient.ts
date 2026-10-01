// 노드 에디터용 API 클라이언트 — 엔진의 GraphApiClient 인터페이스를 IPC 로 구현한다.
//
// 에디터 기본 클라이언트(HttpGraphApiClient)는 렌더러에서 엔진 REST 를 직접 fetch 하는데, 엔진은
// CORS 를 내지 않고 우리 렌더러는 file:// 라 막힌다. REST 는 메인이 중계하고(nodal-http),
// WebSocket 과 에셋 URL 은 CORS 대상이 아니라 엔진에 직접 붙는다.
import type { EventListener, GraphApiClient } from '../../engine/apps/web/src/api/client'
import { ApiError } from '../../engine/apps/web/src/api/client'
import type {
  AssetRef, CreateRunResponse, ErrorResponse, ExtensionsResponse, GraphFromPngResponse, NodesResponse, ValidateResponse, WsEvent,
} from '../../engine/apps/web/src/api/types'
import { API_PATHS, assetSrc } from '../../engine/apps/web/src/api/types'
import type { GraphDocument } from '../../engine/apps/web/src/graph/types'
import { ENGINE_URL } from '../../engineConfig'
import { engineApi } from '../engineApi'
import { markRunSeen } from '../runOwnership'

export class IpcGraphApiClient implements GraphApiClient {
  readonly mode = 'live' as const
  readonly #listeners = new Set<EventListener>()
  #socket: WebSocket | null = null
  #retry: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  assetUrl(asset: AssetRef): string {
    return `${ENGINE_URL}${assetSrc(asset)}`
  }

  listNodes(): Promise<NodesResponse> {
    return this.#request<NodesResponse>('GET', API_PATHS.nodes)
  }

  // 서드파티 확장(엔진 프로세스 안에서 도는 코드)은 이 앱에서 쓰지 않는다 — 빈 목록.
  async listExtensions(): Promise<ExtensionsResponse> {
    return { loaded: [], failed: [] }
  }

  validateGraph(graph: GraphDocument): Promise<ValidateResponse> {
    return this.#request<ValidateResponse>('POST', API_PATHS.validate, { graph })
  }

  async createRun(graph: GraphDocument, useCache: boolean): Promise<CreateRunResponse> {
    const res = await this.#request<CreateRunResponse>('POST', API_PATHS.runs, { graph, use_cache: useCache })
    // 에디터에서 직접 돌린 실행은 어느 채팅 대화에도 속하지 않는다.
    markRunSeen(res.run_id)
    return res
  }

  async graphFromPng(file: File): Promise<GraphFromPngResponse> {
    const data = await file.arrayBuffer()
    const res = await engineApi.http({ method: 'POST', path: API_PATHS.graphFromPng, file: { name: file.name, type: file.type, data } })
    return this.#unwrap<GraphFromPngResponse>(res.status, res.body)
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    this.#ensureSocket()
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    this.#disposed = true
    if (this.#retry) clearTimeout(this.#retry)
    this.#socket?.close()
    this.#socket = null
    this.#listeners.clear()
  }

  async #request<T>(method: 'GET' | 'POST', path: string, json?: unknown): Promise<T> {
    const res = await engineApi.http({ method, path, json: json === undefined ? undefined : JSON.stringify(json) })
    return this.#unwrap<T>(res.status, res.body)
  }

  #unwrap<T>(status: number, body: unknown): T {
    if (status >= 400) {
      const error = body as ErrorResponse | undefined
      throw new ApiError(error?.error?.message ?? `HTTP ${status}`, status, error)
    }
    return body as T
  }

  // 엔진이 재시작되면(템플릿 저장·모델 설치) 소켓이 끊긴다 — 조용히 다시 붙는다.
  #ensureSocket(): void {
    if (this.#socket || this.#disposed || typeof window === 'undefined') return
    const url = new URL(API_PATHS.ws, ENGINE_URL)
    url.protocol = 'ws:'
    const socket = new WebSocket(url)
    this.#socket = socket
    socket.addEventListener('message', (message) => {
      const event = JSON.parse(String(message.data)) as WsEvent
      this.#listeners.forEach((listener) => listener(event))
    })
    socket.addEventListener('close', () => {
      if (this.#socket === socket) this.#socket = null
      if (!this.#disposed && this.#listeners.size > 0) this.#retry = setTimeout(() => this.#ensureSocket(), 3000)
    })
  }
}
