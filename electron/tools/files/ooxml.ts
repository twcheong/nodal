// ─────────────────────────────────────────────────────────────────────────────
// ooxml.ts — .pptx / .docx / .xlsx 가 공유하는 최소 OOXML 스캐너.
//
// pptxRead.ts 가 자기 안에 갖고 있던 스캐너를 그대로 끌어올린 것이다. docx 도
// 같은 것을 필요로 하는데, XML 파서를 새로 하나 더 넣거나 복붙하는 대신 한 곳에
// 둔다. 원래의 설계 근거는 그대로 유효하다:
//
//   PowerPoint/Word 가 쓴 OOXML 은 기계 생성이라 항상 well-formed 이고, 우리에게
//   필요한 건 엘리먼트 중첩과 속성 몇 개뿐이다. 범용 XML 의존성을 하나 더 들이는
//   것보다 목적 특화 스캐너가 싸고, 우리 writer 의 출력으로 라운드트립 검증된다
//   (scripts/deck/roundtrip.ts).
// ─────────────────────────────────────────────────────────────────────────────

export type Node = { tag: string; attrs: Record<string, string>; children: Node[]; text: string }

const TAG_RE = /<(\/?)([A-Za-z0-9_:.-]+)((?:\s+[^>]*?)?)(\/?)>/g
const ATTR_RE = /([A-Za-z0-9_:.-]+)\s*=\s*"([^"]*)"/g

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')   // last, so "&amp;lt;" does not become "<"
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  let m: RegExpExecArray | null
  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(raw))) out[m[1]] = decodeEntities(m[2])
  return out
}

/** Parse a well-formed OOXML part into a node tree. */
export function parseXml(xml: string): Node {
  const root: Node = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: Node[] = [root]
  let last = 0
  let m: RegExpExecArray | null
  TAG_RE.lastIndex = 0

  while ((m = TAG_RE.exec(xml))) {
    const [full, closing, tag, attrRaw, selfClose] = m
    if (tag.startsWith('?') || tag.startsWith('!')) { last = m.index + full.length; continue }

    const between = xml.slice(last, m.index)
    if (between) stack[stack.length - 1].text += decodeEntities(between)
    last = m.index + full.length

    if (closing) {
      if (stack.length > 1) stack.pop()
    } else {
      const node: Node = { tag, attrs: attrRaw.trim() ? parseAttrs(attrRaw) : {}, children: [], text: '' }
      stack[stack.length - 1].children.push(node)
      if (!selfClose) stack.push(node)
    }
  }
  return root
}

/** Local name, ignoring the namespace prefix (a:t, p:sp, w:tbl → t, sp, tbl). */
export function local(tag: string): string {
  const i = tag.indexOf(':')
  return i === -1 ? tag : tag.slice(i + 1)
}

export function findAll(node: Node, name: string, out: Node[] = []): Node[] {
  for (const c of node.children) {
    if (local(c.tag) === name) out.push(c)
    findAll(c, name, out)
  }
  return out
}

export function firstChild(node: Node, name: string): Node | undefined {
  return node.children.find((c) => local(c.tag) === name)
}

/**
 * Concatenated text of a paragraph node — its <t> runs plus break/tab spacing.
 *
 * Namespace-agnostic on purpose: DrawingML (<a:p>/<a:t>, PowerPoint) and
 * WordprocessingML (<w:p>/<w:t>, Word) use the same local names, so one walker
 * serves both. <pPr> is skipped because Word puts <w:tabs> definitions there —
 * walking in would inject phantom spacing from the paragraph's *style* rather
 * than its content.
 */
export function paragraphText(p: Node): string {
  let out = ''
  const walk = (n: Node) => {
    for (const c of n.children) {
      const name = local(c.tag)
      if (name === 'pPr') continue
      if (name === 't') out += c.text
      else if (name === 'br' || name === 'tab') out += ' '
      else walk(c)
    }
  }
  walk(p)
  return out.replace(/\s+/g, ' ').trim()
}
