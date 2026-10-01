// ─────────────────────────────────────────────────────────────────────────────
// copilotDecks — Content 모드 덱 스펙의 대화별 영속화.
//
// copilotPlans 와 같은 패턴(localStorage, 대화 단위). 덱은 대화당 1개이고,
// 스펙이 진실이라 파일은 Export 때만 만들어진다.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = (convId: string) => `twixy.copilot.deck.${convId}`
/** 한 덱의 상한 — 스펙은 텍스트라 작지만 localStorage 를 채우진 않게. */
const MAX_CHARS = 200_000

export function loadDeckLS(convId: string): TwixyWritePptxPayload | null {
  try {
    const raw = localStorage.getItem(KEY(convId))
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<TwixyWritePptxPayload>
    return Array.isArray(o.slides) && o.slides.length > 0 ? (o as TwixyWritePptxPayload) : null
  } catch { return null }
}

export function saveDeckLS(convId: string, payload: TwixyWritePptxPayload) {
  try {
    const raw = JSON.stringify(payload)
    if (raw.length > MAX_CHARS) return
    localStorage.setItem(KEY(convId), raw)
  } catch { /* quota — 프리뷰는 메모리로 계속 동작 */ }
}

export function clearDeckLS(convId: string) {
  try { localStorage.removeItem(KEY(convId)) } catch { /* ignore */ }
}

/** 파일명으로 쓸 slug. 한글은 그대로 두되 경로 문자만 걷어낸다. */
export function deckSlug(payload: TwixyWritePptxPayload): string {
  const base = (payload.title ?? 'deck').replace(/[/\\:*?"<>|]/g, '').trim().slice(0, 60)
  return base.replace(/\s+/g, '-') || 'deck'
}

// ── 원본 유지 편집 대상 ───────────────────────────────────────────────────────
// 사용자의 .pptx 를 디자인 그대로 고치는 경로. 여기서는 파일이 진실이고 스펙은
// 없다 — 우리 painter 는 남의 덱을 그리지 못하므로 화면에는 텍스트 아웃라인만
// 보인다. 대화당 1개, 덱 스펙과 배타적(둘 다 있으면 어느 쪽을 고칠지 모호).

export type PptxEditTarget = {
  /** 지금 편집 중인 파일. 첫 Apply 전에는 원본과 같고, 그 뒤로는 작업 복사본. */
  relPath: string
  /** 사용자가 올린 원본 — 규칙상 절대 쓰지 않는다. 되돌아갈 지점이자 표시용. */
  originalRelPath: string
  slideCount: number
  /** readPptx 아웃라인 — 모델의 눈이자 사람의 눈. Apply 마다 갱신한다.
   *  `shapes` 는 와이어프레임 요약("3 text · 1 pic") — 어느 장을 복제할지 고를 때 쓴다. */
  outline: { slide: number; title?: string; texts: number; shapes?: string; textShapes?: { shape: number; first: string; paragraphs: number }[] }[]
  /** 와이어프레임 시트 PNG 의 절대경로 — 모델에게 `[Image: source: …]` 로 보여준다. */
  sketchAbsPath?: string
  /** 덱의 slideLayout 목록 — insertSlide 가 고를 수 있는 메뉴. */
  layouts?: { index: number; name: string; placeholders: string[] }[]
}

const TARGET_KEY = (convId: string) => `twixy.copilot.pptxEditTarget.${convId}`

export function loadEditTargetLS(convId: string): PptxEditTarget | null {
  try {
    const raw = localStorage.getItem(TARGET_KEY(convId))
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<PptxEditTarget>
    if (typeof o.relPath !== 'string' || !Array.isArray(o.outline)) return null
    // 이 필드가 생기기 전에 저장된 대상은 원본=현재로 본다.
    return { ...(o as PptxEditTarget), originalRelPath: o.originalRelPath ?? o.relPath }
  } catch { return null }
}

export function saveEditTargetLS(convId: string, t: PptxEditTarget) {
  try { localStorage.setItem(TARGET_KEY(convId), JSON.stringify(t)) } catch { /* quota */ }
}

export function clearEditTargetLS(convId: string) {
  try { localStorage.removeItem(TARGET_KEY(convId)) } catch { /* ignore */ }
}

/**
 * 모델에게 주는 대상 설명 — 매 메시지 앞에 붙는다(아웃라인이 곧 눈이다).
 * `withImage` 면 와이어프레임 시트도 같이 — 대상이 바뀐 직후(시작·Apply 뒤)
 * 한 번만. 매 턴 붙이면 vision 비용이 턴마다 든다.
 */
export function describeEditTarget(t: PptxEditTarget, opts?: { withImage?: boolean }): string {
  const lines = t.outline.flatMap(s => [
    `  ${s.slide}. ${s.title ?? '(no title)'}${s.shapes ? ` [${s.shapes}]` : s.texts ? ` — ${s.texts} text blocks` : ''}`,
    // setText 의 주소 공간 — "shape 2" 가 어느 상자인지 첫 줄로 보여준다.
    ...(s.textShapes?.length ? [`      text shapes: ${s.textShapes.map(ts => `${ts.shape}=\"${ts.first.slice(0, 24)}${ts.first.length > 24 ? '…' : ''}\"(${ts.paragraphs}p)`).join(' · ')}`] : []),
  ])
  const layoutLines = t.layouts?.length
    ? ['layouts (for insertSlide — number or exact name):', ...t.layouts.map(l => `  ${l.index}. ${l.name} [${l.placeholders.join(', ') || 'no placeholders'}]`)]
    : []
  const image = opts?.withImage && t.sketchAbsPath
    ? [`[Image: source: ${t.sketchAbsPath}]`, 'Above: a wireframe contact sheet of the deck — every shape as a box in its real position (hatched = picture, grid = table, "chart" = chart, text boxes show their first lines). Use it to pick which slide to duplicate or where a reorder should land.', '']
    : []
  return [
    ...image,
    '[Original-deck edit target]',
    `file: ${t.relPath}${t.relPath !== t.originalRelPath ? `  (a working COPY of ${t.originalRelPath} — the user's original is never written)` : '  (edits go to a copy; the original is never written)'}`,
    `slides: ${t.slideCount}`,
    'outline (1-based, current order):',
    ...lines,
    ...layoutLines,
    'Reply with ONE ```pptx-edit``` block (see the soul). Do NOT emit deck-spec or deck-patch while this target is active.',
    '',
  ].join('\n')
}
