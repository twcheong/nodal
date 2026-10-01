// 렌더러용 제품 프로필 진입점. 제품마다 다른 값(게이트웨이 포트, Supabase, 웹 백엔드,
// 브랜딩, 켜진 기능)은 전부 여기서 읽는다 — 컴포넌트·훅에 리터럴로 적지 않는다.
// 값의 출처: products/<id>/profile.ts (빌드 시 scripts/write-product.ts 가 고른다).
import { PRODUCT } from '../../shared/product/current.generated'

export { PRODUCT }
export type { View, ProductProfile } from '../../shared/product/types'

/** 로컬 openclaw 게이트웨이 WebSocket. 포트는 제품별 — 두 제품이 같은 PC 에서 공존한다. */
export const GATEWAY_WS_URL = `ws://127.0.0.1:${PRODUCT.gatewayPort}`

/** 워크플로 병렬 슬롯 wf-N 의 Chrome CDP 포트. 슬롯이 없으면 채팅용 기본 포트. */
export function cdpPortForSlot(slot: number | null | undefined): number {
  return (slot ? PRODUCT.workflowCdpPorts[slot - 1] : undefined) ?? PRODUCT.cdpPort
}
