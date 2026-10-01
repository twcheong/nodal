// @vitest-environment node
// 엔진 REST 클라이언트 — 엔진 저장소의 schemas/openapi.json 형태를 내는 가짜 서버에 붙여 본다.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertLoopback, collectAssets, engineStatus, getRun, listRuns, type RunDetail } from './engine'

const RUN: RunDetail = {
  run_id: 'abc123', status: 'succeeded', node_count: 3, created_at: '2026-09-18T00:00:00Z', elapsed_ms: 2284000,
  outputs: {
    n1: [{ socket: 'video', asset: { hash: 'h-video', media_type: 'video/webm', size_bytes: 5_000_000 } }],
    // 같은 에셋이 두 출력에 걸려도 한 번만 나와야 한다. inline 값(에셋 없음)은 건너뛴다.
    n2: [{ socket: 'video', asset: { hash: 'h-video', media_type: 'video/webm', size_bytes: 5_000_000 } }, { socket: 'seed' }],
    n3: [{ socket: 'image', asset: { hash: 'h-img', media_type: 'image/png', size_bytes: 1000, width: 128, height: 128 } }],
  },
}

let server: http.Server
let base: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.url === '/api/nodes') return send(200, [{ type: 'a' }, { type: 'b' }])
    if (req.url === '/api/runs') return send(200, { running: null, queued: [], history: [RUN], limit: 50 })
    if (req.url === '/api/runs/abc123') return send(200, RUN)
    return send(404, { code: 'run_not_found', message: 'nope' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('nodal engine client', () => {
  it('reports a running engine', async () => {
    expect(await engineStatus(base)).toEqual({ running: true, nodeCount: 2 })
  })

  it('treats an unreachable engine as "not running", not as an error', async () => {
    expect(await engineStatus('http://127.0.0.1:1')).toEqual({ running: false })
  })

  it('lists runs and reads one', async () => {
    expect((await listRuns(base)).history[0].run_id).toBe('abc123')
    expect((await getRun(base, 'abc123')).status).toBe('succeeded')
  })

  it('surfaces a missing run as an error', async () => {
    await expect(getRun(base, 'missing')).rejects.toThrow(/404/)
  })

  it('collects stored assets once each and skips inline values', () => {
    expect(collectAssets(RUN).map((a) => a.hash)).toEqual(['h-video', 'h-img'])
  })

  it('refuses run ids that could escape the path', async () => {
    await expect(getRun(base, '../assets/x')).rejects.toThrow(/invalid run id/)
  })

  it('only talks to a local engine — it has no auth', () => {
    expect(() => assertLoopback('http://evil.example.com:8188')).toThrow()
    expect(() => assertLoopback('https://127.0.0.1:8188')).toThrow()
    expect(assertLoopback('http://localhost:8193').port).toBe('8193')
  })
})
