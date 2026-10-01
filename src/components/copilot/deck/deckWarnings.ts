// 레이아웃 경고를 **모델에게** 보여줄 때의 규칙.
//
// 청중이 하나로 정리됐다. 경고는 전부 모델 채널로만 간다(시각 QA 되먹임 ·
// 툴 반환값) — 사람 화면에는 뜨지 않는다. "overflows its box by 0.27in" 을
// 보고 사용자가 할 수 있는 일이 없고, 같은 목록이 첫 생성 직후 QA 라운드로
// 모델에게 가서 patch 로 돌아오기 때문이다. 좌측 패널은 그 자리에 사용자가
// 실제로 조작할 수 있는 것(팔레트·형태·페이지 얼굴)을 놓는다 — DeckDesigner.
//
// 모델에게는 정밀도를 깎지 않는다: `shrunk` 는 정의상 내용 무손실이지만
// (autofit 이 60% 바닥에서도 안 들어가면 `overflow` 를 낸다) 그것도 그대로
// 넘긴다. 요약은 사람용 표면이 있을 때만 의미가 있었다.

import type { LayoutWarning } from '../../../../shared/deck/el'

const cut = (n: number) => (n === 1 ? '1 was cut' : `${n} were cut`)

export function warningText(w: LayoutWarning): string {
  switch (w.code) {
    case 'clamped': return `${w.what} — showing ${w.kept}, ${cut(w.dropped)}`
    case 'rowsTruncated': return `table shows ${w.kept} row${w.kept === 1 ? '' : 's'}, ${cut(w.dropped)}`
    case 'overflow': return `${w.what} — overflows its box by ${w.overBy.toFixed(2)}in`
    case 'shrunk': return `${w.what} — shrunk ${w.from}→${w.to}pt to fit`
  }
}

export type SlideWarning = { slide: number; w: LayoutWarning }

/** 모델 채널용 평문 — QA 되먹임 메시지에 그대로 실린다. */
export function warningsToText(all: SlideWarning[], structure: string[]): string {
  const lines: string[] = []
  if (structure.length) {
    lines.push('[Structure]')
    for (const s of structure) lines.push(`- ${s}`)
  }
  if (all.length) {
    if (lines.length) lines.push('')
    lines.push('[Slides]')
    for (const { slide, w } of all) lines.push(`- Slide ${slide}: ${warningText(w)}`)
  }
  return lines.join('\n') || 'No issues'
}
