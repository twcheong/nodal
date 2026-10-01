// ── 제품 전용 IPC — 코어를 고치지 않고 제품이 메인 프로세스 기능을 추가하는 자리 ──
//
// 에이전트 툴/IPC 를 코어에 추가하려면 핸들러→preload→global.d.ts 를 전부 손대야 한다.
// 제품 전용 기능(예: Nodal 의 영상 엔진 상태 조회)까지 그렇게 하면 코어에 제품 코드가
// 쌓인다. 그래서 채널을 하나만 열어 둔다:
//
//   renderer: window.twixy.productInvoke('<name>', payload)
//   main:     products/<id>/electron/index.ts 의 registerMain() 이 핸들러를 등록
//
// 이름은 제품이 자유롭게 정한다. 등록 안 된 이름은 에러로 돌려준다.
import { ipcMain } from 'electron'
import { registerMain } from '../shared/product/current.main.generated'
import type { ProductHandler, ProductMainContext } from '../shared/product/types'

const handlers = new Map<string, ProductHandler>()
const beforeGateway: Array<() => Promise<void>> = []
const onQuit: Array<() => void> = []

export function initProductIpc(deps: {
  getWorkspace: () => string
  paths: ProductMainContext['paths']
  restartGateway: () => Promise<void>
}): void {
  const ctx: ProductMainContext = {
    handle: (name, fn) => { handlers.set(name, fn) },
    getWorkspace: deps.getWorkspace,
    paths: deps.paths,
    onBeforeGatewayStart: (fn) => { beforeGateway.push(fn) },
    onQuit: (fn) => { onQuit.push(fn) },
    restartAgentRuntime: deps.restartGateway,
  }
  registerMain(ctx)
  ipcMain.handle('product-invoke', async (_e, name: string, payload: unknown) => {
    const fn = handlers.get(name)
    if (!fn) return { ok: false, error: `unknown product handler: ${name}` }
    try {
      return { ok: true, data: await fn(payload) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** 부팅 때 게이트웨이 시작 직전에 main.ts 가 부른다. 제품 훅의 실패는 부팅을 막지 않는다. */
export async function runProductBeforeGateway(): Promise<void> {
  for (const fn of beforeGateway) {
    try { await fn() } catch (err) { console.error('[product] onBeforeGatewayStart failed:', err) }
  }
}

/** before-quit 에서 main.ts 가 부른다. */
export function runProductQuit(): void {
  for (const fn of onQuit) {
    try { fn() } catch (err) { console.error('[product] onQuit failed:', err) }
  }
}
