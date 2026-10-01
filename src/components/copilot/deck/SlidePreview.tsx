// Thin React wrapper over the shared SVG string painter.
//
// The actual El[] → SVG work lives in shared/deck/preview/svg.ts so the same
// painter serves three consumers: this component, scripts/deck/preview-html,
// and the electron-main rasterizer that builds the deck-QA contact sheet the
// model looks at. Keep drawing logic OUT of this file — anything added here is
// invisible to the other two.
//
// dangerouslySetInnerHTML is safe here: the string comes from our own painter,
// which escapes every user string (see esc() in svg.ts).

import type { SlideDisplay } from '../../../../shared/deck/el'
import { PAGE_W, PAGE_H } from '../../../../shared/deck/page'
import { slideSvgInner } from '../../../../shared/deck/preview/svg'
import { useSlideImages } from './useSlideImages'

const PT = 72

export function SlidePreview({ slide, width, onClick, selected }: {
  slide: SlideDisplay
  /** rendered width in px; height follows the 16:9 deck ratio */
  width: number
  onClick?: () => void
  selected?: boolean
}) {
  // The one hook here loads the slide's pictures (see useSlideImages) and
  // nothing else — geometry still comes in fully computed, so buildDeck stays
  // memoized at the caller. Putting it HERE rather than threading a resolver
  // prop means every call site (hero, thumbnail rail, design tiles, chat
  // cards) shows real pictures without four more props; the cache is shared,
  // so the same file is read once no matter how many previews are on screen.
  // Static rendering (scripts/deck/preview-html) never runs the effect and
  // gets the named frame, exactly as before.
  const imgSrc = useSlideImages(slide)
  return (
    <svg
      viewBox={`0 0 ${PAGE_W * PT} ${PAGE_H * PT}`}
      width={width}
      height={(width * PAGE_H) / PAGE_W}
      onClick={onClick}
      style={{
        display: 'block',
        borderRadius: 6,
        border: selected ? '2px solid var(--accent, #7C6AFF)' : '1px solid rgba(0,0,0,.14)',
        boxShadow: '0 1px 4px rgba(0,0,0,.12)',
        cursor: onClick ? 'pointer' : undefined,
        background: `#${slide.background}`,
      }}
      dangerouslySetInnerHTML={{ __html: slideSvgInner(slide, imgSrc) }}
    />
  )
}
