// 렌더러(Electron) 환경 바인딩 — transport 본체가 window.twixy 를 모르게 하려고 분리.
// 엔드포인트·토큰 IPC·플랫폼은 7개 훅이 전부 같은 값을 쓴다.

import { GATEWAY_WS_URL } from '../product'
import { createControlUiTransport, type ControlUiTransport } from './controlUiTransport'

export const isElectron = typeof window !== 'undefined' && !!window.twixy

export function createRendererTransport(
  displayName: string,
  wsErrorMessage: string,
  opts?: { caps?: readonly string[] },
): ControlUiTransport {
  return createControlUiTransport({
    url: GATEWAY_WS_URL,
    displayName,
    wsErrorMessage,
    platform: window.twixy?.platform ?? 'darwin',
    caps: opts?.caps,
    // 캐시하지 말 것 — transport 가 connect 시도마다 부른다.
    getToken: () => window.twixy.getGatewayToken(),
  })
}
