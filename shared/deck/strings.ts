// The human-readable strings of a deck spec, collected and put back.
//
// WHY: language correction already exists for chat (electron `correct-language`,
// a single flash-lite call that rewrites a reply into the user's language). It
// cannot help a deck, because its prompt deliberately preserves code blocks —
// and a deck IS a code block. So a spec shipped with 兄弟 / "stratégiques" /
// "engajament" mixed into Korean copy while the chat bubble around it came out
// clean.
//
// Correcting the raw JSON with a model risks getting back something that no
// longer parses. Instead we hand the model ONLY a flat array of strings and
// require an array of the same length back: it never sees the JSON, so it
// cannot break it, and a length mismatch is a cheap, total rejection.
//
// collect() and apply() MUST walk in the same order — they share one traversal
// so they cannot drift.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import type { WritePptxPayload } from './spec'

/**
 * Keys whose string value is machinery, not prose: enums, ids and paths. A
 * "corrected" `variant` or icon `name` is a broken deck, and `imagePath` is a
 * filesystem path that must survive verbatim.
 */
const MACHINE_KEYS = new Set([
  'kind', 'variant', 'type', 'chartType', 'imagePath', 'theme', 'style', 'purpose', 'accent', 'brand',
])

/** `name` is a chart SERIES name (prose) except on an icon block, where it is
 *  an id from the curated roster and must not be touched. */
function isMachineKey(key: string, parent: Record<string, unknown>): boolean {
  if (MACHINE_KEYS.has(key)) return true
  return key === 'name' && parent.type === 'icon'
}

type Visit = (value: string, set: (next: string) => void) => void

function walk(node: unknown, key: string, parent: Record<string, unknown> | null, visit: Visit): void {
  if (typeof node === 'string') {
    if (!parent || isMachineKey(key, parent)) return
    if (!node.trim()) return
    visit(node, (next) => { parent[key] = next })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      if (typeof child === 'string') {
        if (!child.trim()) return
        // Arrays of prose (bullets, takeaways, chips, sections) inherit the
        // array's own key for the machine-key test.
        if (parent && isMachineKey(key, parent)) return
        visit(child, (next) => { (node as unknown[])[i] = next })
      } else {
        walk(child, key, parent, visit)
      }
    })
    return
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const k of Object.keys(obj)) walk(obj[k], k, obj, visit)
  }
}

/** Every prose string in the payload, in traversal order. */
export function collectStrings(payload: WritePptxPayload): string[] {
  const out: string[] = []
  walk(payload as unknown as Record<string, unknown>, '', null, (v) => { out.push(v) })
  return out
}

/**
 * A copy of the payload with each prose string replaced by `next[i]`.
 *
 * Returns null when the counts disagree — that means the model added, dropped
 * or reordered entries, and writing a shifted array back would scramble the
 * deck. Failing whole is the only safe answer.
 */
export function applyStrings(payload: WritePptxPayload, next: string[]): WritePptxPayload | null {
  const clone = JSON.parse(JSON.stringify(payload)) as WritePptxPayload
  let i = 0
  let overrun = false
  walk(clone as unknown as Record<string, unknown>, '', null, (_v, set) => {
    if (i >= next.length) { overrun = true; return }
    const replacement = next[i++]
    if (typeof replacement === 'string' && replacement.trim()) set(replacement)
  })
  if (overrun || i !== next.length) return null
  return clone
}

/**
 * Em dash and friends out of the deck copy.
 *
 * The user's rule: a plain hyphen is fine (terms and ranges legitimately carry
 * one), the long dashes are not. Models reach for `—` constantly — including
 * in the prose of THIS repo's prompt files, which is exactly the style they
 * learn from — so a prompt rule alone would leak. This runs inside buildDeck,
 * which both the SVG preview and the pptx exporter go through, so there is one
 * place to enforce it and no way for a path to miss it.
 *
 * Prose strings only: it reuses the same walk as language correction, so a
 * `variant`, an icon id or a file path can never be touched. Idempotent, and
 * returns the SAME object when there is nothing to strip (buildDeck runs on
 * every keystroke of a preview tile; an untouched deck must not allocate a
 * fresh clone each time).
 */
const LONG_DASH = /[—–―]/g

export function stripLongDashes(payload: WritePptxPayload): WritePptxPayload {
  const items = collectStrings(payload)
  let hit = false
  // NOTE: only `replace` touches LONG_DASH. `regex.test()` on a /g/ regex
  // advances lastIndex and would skip every other string.
  const fixed = items.map((s) => {
    // ' - ' keeps the author's spacing; 'A-B' keeps the word shape.
    // Collapsing to one hyphen is the whole transform.
    const out = s.replace(LONG_DASH, '-')
    if (out !== s) hit = true
    return out
  })
  if (!hit) return payload
  return applyStrings(payload, fixed) ?? payload
}
