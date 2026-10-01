// ─────────────────────────────────────────────────────────────────────────────
// parseDeckSpec — Content mode의 앱↔LLM 프로토콜.
//
// Content 모드의 에이전트는 tool-less 'builder' 라서 파일을 못 쓴다. 대신 덱
// 스펙을 펜스 블록으로 authoring 하고 앱이 렌더/프리뷰/내보내기를 소유한다
// (```workflow-spec``` 과 같은 패턴).
//
//   ```deck-spec    전체 덱 (첫 생성, 전면 재작성)
//   ```deck-patch   슬라이드 단위 교체 { index, slide } — "3번만 차트로" 용
//
// 스펙은 shared/deck 의 SlideSpec 을 그대로 쓴다. 검증은 buildDeck 이 던지는
// 에러에 맡기고(unknown kind/theme/style 은 이미 hard error), 여기서는 JSON
// 파싱과 모양 확인까지만 한다.
// ─────────────────────────────────────────────────────────────────────────────

import { SLIDE_KINDS } from '../../shared/deck/spec'

export type ParsedDeck = { kind: 'deck'; payload: TwixyWritePptxPayload }
/** `slide: null` = delete this slide. See applyPatches for the index rules. */
export type ParsedPatch = { kind: 'patch'; index: number; slide: TwixySlideSpec | null }
export type ParsedDeckBlock = ParsedDeck | ParsedPatch

/**
 * 파싱 결과.
 *
 * 'none'(블록 없음, 평범한 대화)과 'invalid'(블록은 냈는데 깨짐)를 반드시
 * 구분한다. 예전엔 둘 다 null 이었고, 그래서 모델이 깨진 JSON 을 냈을 때
 * 사용자는 아무것도 못 보고 모델은 아무것도 못 배웠다 — 두 번 연속으로
 * 프리뷰가 "그냥 안 뜨는" 사고가 났고 원인이 매번 달랐는데 증상이 같았다.
 */
export type DeckParseOutcome =
  | { status: 'none' }
  | { status: 'ok'; block: ParsedDeckBlock }
  | { status: 'invalid'; error: string }

/** 펜스 블록 본문을 꺼낸다. 스트리밍 중 닫히지 않은 블록은 무시. */
function extractFence(text: string, tag: string): string | null {
  const re = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'i')
  return re.exec(text)?.[1] ?? null
}

function isSlide(v: unknown): v is TwixySlideSpec {
  if (!v || typeof v !== 'object') return false
  const k = (v as { kind?: unknown }).kind
  return typeof k === 'string' && (SLIDE_KINDS as string[]).includes(k)
}

/**
 * JSON 에러를 모델이 고칠 수 있는 형태로. V8 은 위치를 주므로 문제의 줄을
 * 그대로 붙여준다 — "position 4707" 만으로는 모델도 어디를 고칠지 모른다.
 */
function explainJsonError(raw: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const line = /line (\d+)/.exec(msg)?.[1]
  if (!line) return msg
  const lines = raw.split('\n')
  const i = Number(line) - 1
  const near = lines.slice(Math.max(0, i - 1), i + 1).map((l, k) => `  ${Math.max(1, i) + k}: ${l.slice(0, 120)}`)
  return `${msg}\n${near.join('\n')}`
}

/**
 * 패치가 가리키는 슬라이드 번호.
 *
 * QA 시트는 슬라이드를 1번부터 라벨링하고 슬라이드 자체의 페이지 배지도
 * 1-based 인데 `index` 는 0-based 였다. 모델이 시트에서 "3번을 고치자" 하고
 * `index: 3` 을 쓰면 4번에 착지해 3번은 원본으로 남고 4번이 덮인다 — 실제로
 * 거의 같은 슬라이드 두 장이 나온 사고의 원인. `page` 를 받으면 변환이 없어
 * 어긋날 수도 없다. `index` 는 하위호환으로 남긴다.
 */
function slideIndexOf(o: Record<string, unknown>): number | string {
  if (typeof o.page === 'number') {
    if (!Number.isInteger(o.page) || o.page < 1) return '`page` is 1-based — the number printed on the slide'
    return o.page - 1
  }
  if (typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0) return o.index
  return 'needs `page` (1-based, the number on the slide) or `index` (0-based)'
}

/**
 * 어시스턴트 메시지에서 덱 블록을 뽑는다.
 * deck-patch 를 먼저 본다 — 한 메시지에 둘 다 있으면 부분 수정이 의도다.
 */
export function parseDeckBlock(text: string): DeckParseOutcome {
  for (const [tag, build] of [
    ['deck-patch', (o: Record<string, unknown>): ParsedDeckBlock | string => {
      const at = slideIndexOf(o)
      if (typeof at === 'string') return at
      if (o.delete === true) return { kind: 'patch', index: at, slide: null }
      if (!isSlide(o.slide)) return '`slide` is missing or has an unknown `kind`'
      return { kind: 'patch', index: at, slide: o.slide }
    }],
    ['deck-spec', (o: Record<string, unknown>): ParsedDeckBlock | string => {
      const slides = o.slides
      if (!Array.isArray(slides) || slides.length === 0) return '`slides` must be a non-empty array'
      const bad = slides.findIndex((s) => !isSlide(s))
      if (bad !== -1) return `slides[${bad}] has a missing or unknown \`kind\``
      return {
        kind: 'deck',
        payload: {
          title: o.title as string | undefined, theme: o.theme as string | undefined,
          style: o.style as string | undefined, accent: o.accent as string | undefined,
          // 이 pick 에 없는 필드는 조용히 사라진다 — 새 payload 필드는 여기에도.
          purpose: o.purpose as TwixyWritePptxPayload['purpose'],
          brand: o.brand as string | undefined,
          slides: slides as TwixySlideSpec[],
        },
      }
    }],
  ] as const) {
    const raw = extractFence(text, tag)
    if (!raw) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      return { status: 'invalid', error: `The JSON in your \`${tag}\` block is malformed — ${explainJsonError(raw, err)}` }
    }
    const built = build(parsed)
    return typeof built === 'string'
      ? { status: 'invalid', error: `\`${tag}\` block: ${built}` }
      : { status: 'ok', block: built }
  }
  return { status: 'none' }
}

/**
 * 한 메시지의 deck-patch 블록 **전부** (등장 순서). QA 라운드는 "고칠
 * 슬라이드마다 patch 하나"를 요구하므로 복수가 정상인데, parseDeckBlock 은
 * 첫 펜스만 읽는다 — 나머지가 조용히 버려지는 걸 막는 전용 파서.
 * 깨진 블록은 건너뛰지 않고 에러로 세운다(조용한 드롭 금지).
 */
export function parseAllPatches(text: string): { patches: ParsedPatch[]; errors: string[] } {
  const patches: ParsedPatch[] = []
  const errors: string[] = []
  const re = /```deck-patch\s*\n([\s\S]*?)```/gi
  for (let m = re.exec(text); m; m = re.exec(text)) {
    try {
      const o = JSON.parse(m[1]) as Record<string, unknown>
      const at = slideIndexOf(o)
      if (typeof at === 'string') { errors.push(at); continue }
      if (o.delete === true) { patches.push({ kind: 'patch', index: at, slide: null }); continue }
      if (!isSlide(o.slide)) { errors.push('`slide` is missing or has an unknown `kind`'); continue }
      patches.push({ kind: 'patch', index: at, slide: o.slide })
    } catch (err) {
      errors.push(explainJsonError(m[1], err))
    }
  }
  return { patches, errors }
}

/**
 * 덱 블록을 걷어낸 나머지 텍스트 — 채팅 버블에는 이걸 보여준다.
 *
 * 닫히지 않은 마지막 펜스도 지운다: 스트리밍 중에는 ``` 이 아직 안 왔으므로
 * 첫 정규식이 안 걸리고, 그 몇 초 동안 사용자는 스펙 JSON 이 한 글자씩
 * 찍히는 걸 그대로 본다. 어차피 완성되면 사라질 텍스트다.
 */
export function stripDeckBlocks(text: string): string {
  return text
    .replace(/```deck-(spec|patch)\s*\n[\s\S]*?```/gi, '')
    .replace(/```deck-(spec|patch)\s*\n[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 덱 블록을 **사람이 볼 것**으로 요약한다 (등장 순서).
 *
 * 사용자에게 스펙 JSON 은 소음이다 — 결과는 우측 프리뷰에 이미 그려져 있고,
 * `{"page": 3, "slide": {"kind": "stats", …}}` 를 읽어서 할 수 있는 일이 없다.
 * 버블에는 "3번 슬라이드를 이렇게 바꿨다"만 남기고(교체는 썸네일로 그린다)
 * 원문은 모델 채널에만 둔다.
 *
 * 깨진 블록은 여기서 조용히 건너뛴다 — 에러 표면은 parseDeckBlock 쪽이다.
 */
export type DeckBlockNote =
  | { kind: 'deck'; slides: number; title?: string }
  | { kind: 'patch'; page: number; slide: TwixySlideSpec | null }

export function summarizeDeckBlocks(text: string): DeckBlockNote[] {
  const notes: DeckBlockNote[] = []
  const re = /```deck-(spec|patch)\s*\n([\s\S]*?)```/gi
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let o: Record<string, unknown>
    try { o = JSON.parse(m[2]) as Record<string, unknown> } catch { continue }
    if (m[1].toLowerCase() === 'spec') {
      if (Array.isArray(o.slides)) notes.push({ kind: 'deck', slides: o.slides.length, title: typeof o.title === 'string' ? o.title : undefined })
      continue
    }
    const at = slideIndexOf(o)
    if (typeof at === 'string') continue
    // 삭제(slide: null)와 '깨진 slide' 를 같은 모양으로 만들면 안 된다 —
    // 후자를 "삭제했음" 으로 그리게 된다. 깨진 건 건너뛴다.
    if (o.delete === true) notes.push({ kind: 'patch', page: at + 1, slide: null })
    else if (isSlide(o.slide)) notes.push({ kind: 'patch', page: at + 1, slide: o.slide })
  }
  return notes
}

/**
 * 패치 여러 개를 **원본 인덱스 기준**으로 한 번에 적용한다 (불변).
 *
 * 삭제가 없던 시절엔 순차 적용으로 충분했지만, 삭제가 섞이면 순차 적용은
 * 뒤 패치의 인덱스를 전부 밀어버린다. 모델은 "3·6·9번이 디바이더니까
 * 지워라"를 한 화면(원본)을 보고 말하므로, 계약도 원본 스냅샷 기준이어야
 * 한다: 교체를 먼저 제자리에 적용하고, 삭제는 내림차순으로 걷어낸다.
 *
 * 실사고(2026-08-16): 삭제 수단이 없어서 모델이 "뒤 슬라이드를 앞으로 당겨
 * 덮어쓰기"로 삭제를 흉내냈고, 디바이더는 그대로 남은 채 s5/s6·s7/s8 이
 * 중복된 13장 덱이 나왔다.
 */
export function applyPatches(payload: TwixyWritePptxPayload, patches: ParsedPatch[]): TwixyWritePptxPayload {
  const slides = payload.slides.slice()
  for (const p of patches) {
    if (p.slide && p.index < slides.length) slides[p.index] = p.slide
  }
  const doomed = [...new Set(patches.filter((p) => !p.slide).map((p) => p.index))]
    .filter((i) => i < slides.length)
    .sort((a, b) => b - a)
  for (const i of doomed) slides.splice(i, 1)
  return { ...payload, slides }
}

/** 슬라이드 하나짜리 편의 래퍼. */
export function applyPatch(payload: TwixyWritePptxPayload, patch: ParsedPatch): TwixyWritePptxPayload {
  return applyPatches(payload, [patch])
}
