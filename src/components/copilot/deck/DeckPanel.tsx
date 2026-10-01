// Content mode의 우측 패널 — 덱 프리뷰 + 슬라이드 단위 조작.
//
// 앱이 렌더를 소유한다: 에이전트는 스펙만 쓰고, buildDeck 이 디스플레이 리스트를
// 만들고, SlidePreview 가 그린다. Export 는 기존 IPC(window.twixy.tools.writePptx)로
// 같은 스펙을 pptx 로 내보낸다 — 즉 프리뷰와 파일이 같은 계산에서 나온다.

import { useState } from 'react'
import type { DeckDisplay } from '../../../../shared/deck/el'
import { SlidePreview } from './SlidePreview'

export type DeckPanelProps = {
  payload: TwixyWritePptxPayload
  /** CopilotView 에서 한 번만 계산해 내려준다 — 좌측 디자인 패널과 공유. */
  deck: DeckDisplay
  /** 패널 폭(px) — 선택 슬라이드가 이 폭을 따라간다. 드래그로 넓히면 커진다. */
  panelWidth: number
  /** 선택은 CopilotView 가 소유한다 — 좌측 디자인 패널의 타일이 "지금 보고
   *  있는 그 장"을 그려야 하므로 두 패널이 같은 선택을 봐야 한다. */
  selected: number
  onSelect: (index: number) => void
  /** 슬라이드 단위 재생성 요청 — 채팅으로 스코프된 지시를 보낸다 */
  onRegenerateSlide: (index: number, instruction: string) => void
  onExport: () => void
  /** 되돌릴 수 있는 편집 수 (0 이면 버튼 비활성) */
  undoDepth: number
  onUndo: () => void
  /** 내보내기가 성공했을 때만 세팅된다 — Open/Reveal 을 걸 대상. */
  exportedPath?: string | null
  onOpenExported: () => void
  onRevealExported: () => void
  exportMsg?: string | null
  busy?: boolean
}

const barBtn: React.CSSProperties = {
  fontSize: 11, padding: '5px 10px', borderRadius: 6,
  border: '1px solid rgba(0,0,0,.16)', background: 'transparent', color: 'inherit', cursor: 'pointer',
}

export function DeckPanel({
  payload, deck, panelWidth, selected, onSelect, onRegenerateSlide,
  onExport, undoDepth, onUndo, exportedPath, onOpenExported, onRevealExported, exportMsg, busy,
}: DeckPanelProps) {
  const [instruction, setInstruction] = useState('')

  const slides = deck.slides
  const heroW = Math.max(240, Math.min(panelWidth - 24, 720))
  const current = slides[Math.min(selected, slides.length - 1)]
  // 레이아웃 경고는 어느 패널에도 뜨지 않는다.
  //
  // 이건 모델에게 주는 정보지 사용자에게 주는 정보가 아니다: "overflows its
  // box by 0.27in" 을 보고 사용자가 할 수 있는 일이 없고, 어차피 첫 생성 직후
  // 시각 QA 라운드가 같은 목록을 모델에게 넘겨 patch 로 고쳐서 돌아온다.
  // 전문은 모델 채널(warningsToText)에만 있다 — 청중이 다르면 표면도 다르다.

  const submit = () => {
    const text = instruction.trim()
    if (!text || busy) return
    onRegenerateSlide(current.index, text)
    setInstruction('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 헤더 — 덱 메타 + Export */}
      <div style={{ padding: '10px 12px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {slides.length} slides · {payload.theme ?? 'twixy'}{payload.style ? ` · ${payload.style}` : ''}
        </div>
        {/* 되돌리기 — 모델 수정·언어 교정·디자인 편집 전부 한 스택에 쌓인다.
            깊이를 라벨에 띄워 "몇 단계 남았는지"가 보이게. */}
        <button onClick={onUndo} disabled={undoDepth === 0}
          title={undoDepth ? `Undo the last deck change (${undoDepth} available)` : 'Nothing to undo'}
          style={{ ...barBtn, opacity: undoDepth === 0 ? .4 : 1, cursor: undoDepth === 0 ? 'default' : 'pointer' }}>
          ↶ Undo{undoDepth > 1 ? ` ${undoDepth}` : ''}
        </button>
        <button onClick={onExport} disabled={busy} style={barBtn}>
          Export PPTX
        </button>
      </div>
      {exportMsg && (
        <div style={{ padding: '4px 12px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{exportMsg}</span>
          {/* 저장된 파일은 여기서 바로 연다 — 폴더를 찾아 들어가지 않도록. */}
          {exportedPath && (
            <>
              <button onClick={onOpenExported} style={{ ...barBtn, fontSize: 10, padding: '3px 8px' }}>Open</button>
              <button onClick={onRevealExported} style={{ ...barBtn, fontSize: 10, padding: '3px 8px' }}>Show in folder</button>
            </>
          )}
        </div>
      )}

      {/* 선택된 슬라이드 크게 */}
      <div style={{ padding: '10px 12px 6px', display: 'flex', justifyContent: 'center' }}>
        <SlidePreview slide={current} width={heroW} />
      </div>

      {/* 슬라이드 단위 지시 */}
      <div style={{ padding: '0 12px 8px', display: 'flex', gap: 6 }}>
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder={`Fix slide ${current.index + 1} only — e.g. "make it a chart"`}
          disabled={busy}
          style={{
            flex: 1, fontSize: 11, padding: '6px 8px', borderRadius: 6,
            border: '1px solid rgba(0,0,0,.16)', background: 'transparent', color: 'inherit',
          }}
        />
        <button onClick={submit} disabled={busy || !instruction.trim()}
          style={{ fontSize: 11, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(0,0,0,.16)', cursor: 'pointer' }}>
          Fix this slide
        </button>
      </div>

      {/* 썸네일 레일 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 12px 12px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {slides.map((s) => (
          <div key={s.index} style={{ position: 'relative' }}>
            <SlidePreview slide={s} width={128} selected={s.index === current.index} onClick={() => onSelect(s.index)} />
            <div style={{ position: 'absolute', top: 2, left: 4, fontSize: 9, color: '#999' }}>{s.index + 1}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
