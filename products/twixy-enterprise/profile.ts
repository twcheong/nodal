// Twixy Enterprise — Twixy 에 어드민 대시보드를 얹은 상위집합.
// 같은 사람이 같은 PC 에서 Twixy 와 번갈아 쓰는 도구라 상태 폴더·포트·로그인 세션을
// Twixy 와 의도적으로 공유한다 (동시 실행은 지원하지 않는다).
import type { ProductProfile } from '../../shared/product/types'
import { profile as twixy } from '../twixy/profile'

export const profile: ProductProfile = {
  ...twixy,
  id: 'twixy-enterprise',
  displayName: 'Twixy Enterprise',
  wordmark: 'TWIXY ENTERPRISE',
  appId: 'com.twixy-enterprise.app',
  htmlEntry: 'twixy-enterprise.html',
  features: {
    ...twixy.features,
    initialView: 'admin',
    enterpriseAdmin: true,
  },
}
