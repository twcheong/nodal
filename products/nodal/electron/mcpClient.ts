// 엔진 MCP 를 메인에서 직접 부르는 아주 작은 클라이언트 — 스튜디오 탭이 템플릿을 에이전트와 같은
// 길(run_template_<id>)로 돌리게 한다. 그래야 Image 파라미터(asset:<hash>)·검증·template_id 가
// 에이전트 실행과 똑같다.
//
// 엔진은 Streamable HTTP 를 json_response 로 연다 (mcp_server.py) — 요청마다 JSON 한 덩어리가
// 돌아오므로 SSE 를 다룰 필요가 없다. 세션은 initialize 응답 헤더의 mcp-session-id 로 잇고,
// 엔진이 재시작되면(404/400) 한 번 다시 연다.
import { ENGINE_MCP_URL } from '../engineConfig'

const PROTOCOL = '2025-06-18'
let session: string | null = null
let nextId = 1

async function post(body: unknown, withSession: boolean, timeoutMs: number): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL,
  }
  if (withSession && session) headers['mcp-session-id'] = session
  return fetch(ENGINE_MCP_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
}

async function open(): Promise<void> {
  session = null
  const res = await post({
    jsonrpc: '2.0', id: nextId++, method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'nodal-studio', version: '1' } },
  }, false, 15_000)
  if (!res.ok) throw new Error(`엔진 MCP 연결 실패 (${res.status})`)
  session = res.headers.get('mcp-session-id')
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, true, 15_000)
}

export interface ToolResult { isError: boolean; data: Record<string, unknown> }

/** 엔진 MCP 툴 하나를 부른다. 툴 수준 실패(isError)는 그대로 돌려주고, 전송 실패만 throw. */
export async function callEngineTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session) await open()
    const res = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, true, timeoutMs)
    if ((res.status === 404 || res.status === 400) && attempt === 0) { session = null; continue }   // 엔진 재시작 — 세션을 새로
    if (!res.ok) throw new Error(`엔진 MCP 오류 (${res.status})`)
    const body = await res.json() as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> }
      error?: { message?: string }
    }
    if (body.error) throw new Error(body.error.message ?? '엔진 MCP 오류')
    const result = body.result ?? {}
    let data = result.structuredContent
    if (!data) {
      const text = result.content?.find((c) => c.type === 'text')?.text
      try { data = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { data = { message: text } }
    }
    return { isError: !!result.isError, data: data ?? {} }
  }
  throw new Error('엔진 MCP 에 연결할 수 없습니다')
}

/** 테스트용. */
export function resetMcpSession(): void { session = null }
