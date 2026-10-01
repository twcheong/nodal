// ── plan-changed 브로드캐스트 (main.ts 에서 이동) ────────────────────────────
//
// Stage 4 슬라이스 3 의 **seam**. 플랜 IPC 가 모듈로 나가기 전에 이것부터 분리해 둬야
// 플랜 쪽 이동이 순수 이동이 된다 (창 전역을 붙든 채로는 못 나간다).
//
// 창은 열리고 닫히므로 참조를 보관하지 않는다 — 부를 때마다 현재 창을 받는다.
import type { BrowserWindow } from 'electron'

export interface PlanChangeTargets {
  main:     BrowserWindow | null
  overlay:  BrowserWindow | null
  composer: BrowserWindow | null
}

/** 플랜 상태 변화를 구독 중인 창들에 알린다. 순서는 원본 그대로 main → overlay → composer. */
export function broadcastPlanChangeTo(targets: PlanChangeTargets, id: string, kind: string): void {
  targets.main?.webContents.send('plan-changed', { id, kind })
  // Overlay + composer both subscribe to the same event so they can
  // refresh their plan-derived state (step list, isRunning/isDraft,
  // Start vs Send button) in real time as the planner advances.
  targets.overlay?.webContents.send('plan-changed', { id, kind })
  targets.composer?.webContents.send('plan-changed', { id, kind })
}
