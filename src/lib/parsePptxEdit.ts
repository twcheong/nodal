// ─────────────────────────────────────────────────────────────────────────────
// parsePptxEdit — Content 모드의 ```pptx-edit``` 블록 파서.
//
// 원본 디자인을 유지한 채 사용자의 .pptx 를 고치는 경로. Content 모드 에이전트는
// 툴이 없는 'builder' 라 tool_edit_pptx 를 직접 부를 수 없다 — 그래서 deck-patch
// 와 같은 계약으로 간다: 모델은 op 목록을 블록으로 내놓고, 앱이 파싱해 Apply
// 게이트 뒤에서 IPC(tool-edit-pptx → editPptx)로 실행한다. 파일이 진실이므로
// 자동 반영은 없다.
//
// op 어휘는 electron/tools/files/pptxEdit.ts 의 PptxEditOp 와 1:1 — 여기서
// 검증하는 이유는 모델이 자기 출력이 파싱됐는지 모르기 때문이다. 깨진 op 은
// 어느 번째 op 이 왜 틀렸는지까지 돌려줘 1회 재요청에 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

export type PptxEditOp =
  | { op: 'replaceText'; slide: number; find: string; replace: string }
  | { op: 'setText'; slide: number; shape: number; paragraphs: string[] }
  | { op: 'setNotes'; slide: number; notes: string }
  | { op: 'duplicateSlide'; slide: number; after?: number }
  | { op: 'insertSlide'; layout: number | string; after?: number; fill?: { title?: string; subtitle?: string; body?: string[] } }
  | { op: 'deleteSlide'; slide: number }
  | { op: 'reorderSlides'; order: number[] }

export type PptxEditParseOutcome =
  | { status: 'none' }
  | { status: 'ok'; ops: PptxEditOp[]; outRelPath?: string }
  | { status: 'invalid'; error: string }

const FENCE = /```pptx-edit\s*\n([\s\S]*?)```/i

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

/** op 하나를 검증한다. 오류면 사람이 읽을 이유를 돌려준다. */
function checkOp(raw: unknown, i: number): PptxEditOp | string {
  const at = `ops[${i}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${at}: must be an object`
  const o = raw as Record<string, unknown>
  switch (o.op) {
    case 'replaceText':
      if (!isInt(o.slide) || o.slide < 1) return `${at}: replaceText needs a 1-based "slide" number`
      if (!isStr(o.find) || o.find.length === 0) return `${at}: replaceText needs a non-empty "find" string`
      if (!isStr(o.replace)) return `${at}: replaceText needs a "replace" string`
      return { op: 'replaceText', slide: o.slide, find: o.find, replace: o.replace }
    case 'setText': {
      if (!isInt(o.slide) || o.slide < 1) return `${at}: setText needs a 1-based "slide" number`
      if (!isInt(o.shape) || o.shape < 1) return `${at}: setText needs a 1-based "shape" number (see the slide's text shapes list)`
      if (!Array.isArray(o.paragraphs) || o.paragraphs.length === 0 || !o.paragraphs.every(isStr)) return `${at}: setText needs a non-empty "paragraphs" array of strings — one entry per line`
      return { op: 'setText', slide: o.slide, shape: o.shape, paragraphs: [...(o.paragraphs as string[])] }
    }
    case 'insertSlide': {
      const layoutOk = (isInt(o.layout) && o.layout >= 1) || (isStr(o.layout) && o.layout.trim().length > 0)
      if (!layoutOk) return `${at}: insertSlide needs "layout" — a 1-based layout number or the exact layout name from the layouts list`
      if (o.after !== undefined && (!isInt(o.after) || o.after < 0)) return `${at}: "after" must be a slide number (0 = front)`
      let fill: { title?: string; subtitle?: string; body?: string[] } | undefined
      if (o.fill !== undefined) {
        if (!o.fill || typeof o.fill !== 'object' || Array.isArray(o.fill)) return `${at}: "fill" must be an object { title?, subtitle?, body?: string[] }`
        const f = o.fill as Record<string, unknown>
        if (f.title !== undefined && !isStr(f.title)) return `${at}: fill.title must be a string`
        if (f.subtitle !== undefined && !isStr(f.subtitle)) return `${at}: fill.subtitle must be a string`
        if (f.body !== undefined && (!Array.isArray(f.body) || !f.body.every(isStr))) return `${at}: fill.body must be an array of strings`
        fill = { ...(f.title !== undefined ? { title: f.title as string } : {}), ...(f.subtitle !== undefined ? { subtitle: f.subtitle as string } : {}), ...(f.body !== undefined ? { body: [...(f.body as string[])] } : {}) }
      }
      return { op: 'insertSlide', layout: o.layout as number | string, ...(o.after !== undefined ? { after: o.after } : {}), ...(fill ? { fill } : {}) }
    }
    case 'setNotes':
      if (!isInt(o.slide) || o.slide < 1) return `${at}: setNotes needs a 1-based "slide" number`
      if (!isStr(o.notes)) return `${at}: setNotes needs a "notes" string`
      return { op: 'setNotes', slide: o.slide, notes: o.notes }
    case 'duplicateSlide':
      if (!isInt(o.slide) || o.slide < 1) return `${at}: duplicateSlide needs a 1-based "slide" number`
      if (o.after !== undefined && (!isInt(o.after) || o.after < 0)) return `${at}: "after" must be a slide number (0 = front)`
      return { op: 'duplicateSlide', slide: o.slide, ...(o.after !== undefined ? { after: o.after } : {}) }
    case 'deleteSlide':
      if (!isInt(o.slide) || o.slide < 1) return `${at}: deleteSlide needs a 1-based "slide" number`
      return { op: 'deleteSlide', slide: o.slide }
    case 'reorderSlides': {
      if (!Array.isArray(o.order) || o.order.length === 0) return `${at}: reorderSlides needs a non-empty "order" array`
      if (!o.order.every(n => isInt(n) && n >= 1)) return `${at}: "order" must hold 1-based slide numbers`
      const seen = new Set<number>(o.order as number[])
      if (seen.size !== o.order.length) return `${at}: "order" repeats a slide number`
      const max = Math.max(...(o.order as number[]))
      if (max !== o.order.length) return `${at}: "order" must be a full permutation of 1..${o.order.length} (got a gap or an out-of-range number)`
      return { op: 'reorderSlides', order: [...(o.order as number[])] }
    }
    default:
      return `${at}: unknown op "${String(o.op)}" — use replaceText | setText | setNotes | duplicateSlide | insertSlide | deleteSlide | reorderSlides`
  }
}

/**
 * 첫 pptx-edit 블록을 파싱한다. 한 답장에 블록은 하나가 계약이다(소울).
 * 블록이 없으면 none — 그건 "그냥 대화" 라 에러가 아니다.
 */
export function parsePptxEditBlock(text: string): PptxEditParseOutcome {
  const m = FENCE.exec(text)
  if (!m) return { status: 'none' }
  let parsed: unknown
  try {
    parsed = JSON.parse(m[1].trim())
  } catch (e) {
    return { status: 'invalid', error: `pptx-edit block is not valid JSON — ${(e as Error).message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'invalid', error: 'pptx-edit block must be an object { "ops": [ … ] }' }
  }
  const o = parsed as Record<string, unknown>
  if (!Array.isArray(o.ops) || o.ops.length === 0) {
    return { status: 'invalid', error: 'pptx-edit block needs a non-empty "ops" array' }
  }
  const ops: PptxEditOp[] = []
  for (let i = 0; i < o.ops.length; i++) {
    const r = checkOp(o.ops[i], i)
    if (typeof r === 'string') return { status: 'invalid', error: r }
    ops.push(r)
  }
  if (o.outRelPath !== undefined) {
    if (!isStr(o.outRelPath) || !o.outRelPath.toLowerCase().endsWith('.pptx')) {
      return { status: 'invalid', error: '"outRelPath" must end in .pptx' }
    }
    return { status: 'ok', ops, outRelPath: o.outRelPath }
  }
  return { status: 'ok', ops }
}

/** 채팅 버블용 — 블록 펜스를 걷어낸 산문. */
export function stripPptxEditBlocks(text: string): string {
  return text.replace(/```pptx-edit\s*\n[\s\S]*?```/gi, '').trim()
}

const STRUCTURAL = new Set<PptxEditOp['op']>(['duplicateSlide', 'insertSlide', 'deleteSlide', 'reorderSlides'])

/**
 * 순서 경고. Anthropic pptx 스킬의 규칙 — 구조 작업(복제·삭제·순서)을 전부
 * 끝낸 뒤 내용을 편집한다. 편집 뒤 복제하면 편집본이 복제되고, 슬라이드 번호가
 * 내용 op 사이에서 밀린다. 거부하지 않고 경고만 낸다: op 은 순차 적용이 계약이라
 * 재정렬하면 의미가 바뀐다. 카드에 띄우고 소울이 지키게 한다.
 */
export function pptxEditOrderWarnings(ops: PptxEditOp[]): string[] {
  const out: string[] = []
  let contentSeen = false
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (STRUCTURAL.has(op.op)) {
      if (contentSeen) out.push(`ops[${i}] ${op.op} comes after a text edit — structural ops should run first (a duplicate copies edited text; slide numbers shift).`)
    } else {
      contentSeen = true
    }
  }
  return out
}

/** 한 줄 요약 — 카드와 확인 메시지에 쓴다. */
export function describePptxEditOp(op: PptxEditOp): string {
  switch (op.op) {
    case 'replaceText': return `Slide ${op.slide}: "${op.find}" → "${op.replace}"`
    case 'setText': return `Slide ${op.slide} shape ${op.shape}: ${op.paragraphs.length} paragraph${op.paragraphs.length === 1 ? '' : 's'}`
    case 'setNotes': return `Slide ${op.slide}: notes`
    case 'duplicateSlide': return `Duplicate slide ${op.slide}${op.after !== undefined ? ` after ${op.after}` : ''}`
    case 'insertSlide': return `New slide from layout ${typeof op.layout === 'string' ? `"${op.layout}"` : op.layout}${op.after !== undefined ? ` after ${op.after}` : ' at end'}${op.fill?.title ? ` — "${op.fill.title}"` : ''}`
    case 'deleteSlide': return `Delete slide ${op.slide}`
    case 'reorderSlides': return `Reorder → ${op.order.join(', ')}`
  }
}
