// ── Tray — 시스템 트레이 아이콘/메뉴 ─────────────────────────────
// main.ts 에서 옮겨 온 것 (동작 동일). 이 모듈은 main.ts 를 import 하지 않는다 — 필요한 건
// 전부 주입받는다. import 시점 부작용 없음: Tray 는 buildTray() 를 부를 때만 만들어진다
// (app ready 이후여야 하므로 호출 시점은 main 이 정한다).
//
// 아이콘을 경로가 아니라 이미지로 받는 이유: 경로 계산(app.isPackaged / resourcesPath /
// __dirname)은 macOS dock 아이콘과 공유하는 main 쪽 관심사다.
import { Menu, Tray, type NativeImage } from 'electron'

export interface TrayDeps {
  icon:        NativeImage
  displayName: string
  /** 메뉴의 "Open <제품명>". */
  onOpen:   () => void
  /** 트레이 아이콘 클릭 — 창 보이기/숨기기 토글. */
  onToggle: () => void
  onQuit:   () => void
}

/** 반환된 Tray 는 호출부가 **참조를 쥐고 있어야** 한다 — GC 되면 아이콘이 사라진다. */
export function buildTray(deps: TrayDeps): Tray {
  const tray = new Tray(deps.icon)
  tray.setToolTip(deps.displayName)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${deps.displayName}`, click: () => deps.onOpen() },
    { type: 'separator' },
    { label: 'Quit',       click: () => deps.onQuit() },
  ]))
  tray.on('click', () => deps.onToggle())
  return tray
}
