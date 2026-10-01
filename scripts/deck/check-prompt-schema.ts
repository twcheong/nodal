// Verifies that the prompts which teach the deck schema actually match the
// schema.
//
//   npx tsx scripts/deck/check-prompt-schema.ts
//
// WHY THIS EXISTS: the deck spec is authored by a language model reading a
// prompt, so the field names ARE the contract. They live in a TS union, which
// no prompt can import — every prompt describing them is a hand copy, and one
// of those copies drifted to nothing. CONTENT_SOUL.md documented the kinds but
// not their fields, so the model invented `bullets.items`, `summary.points`,
// `table.header`, `chart.segments` … and every deck it produced failed to
// render, with the failure invisible to it.
//
// Adding fields to shared/deck/spec.ts without teaching them here is now a
// build failure rather than a class of broken decks.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEGACY_KINDS, SLIDE_FIELDS, SLIDE_KINDS, type SlideKind } from '../../shared/deck/spec'
import { MARKED_FILES, markedRegion } from './gen-prompt-block'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Prompts checked by REGEX (per-kind declaration extraction). Only the patch
 * remains here: it is a diff file, so it cannot carry the generator's marker
 * pair. CONTENT_SOUL.md and pptx.tskill graduated to exact marker diffs below —
 * strictly stronger, since the marked region must equal the generated text.
 */
const TARGETS = [
  // Anchor on the registration line, not the bare name — tool_edit_pptx's
  // description MENTIONS tool_write_pptx and sits earlier in the file, which
  // once put the scan window over the wrong tool entirely.
  { file: 'patches/openclaw+2026.4.2.patch', label: 'tool_write_pptx description', section: 'name: "tool_write_pptx"' },
]

type Problem = { file: string; kind: string; what: string }

/**
 * Per-kind declarations, extracted from a prompt.
 *
 * Checking that the FILE contains a word is not enough — `takeaways` also
 * appears in the variant list, so deleting it from the summary signature still
 * passed. The declaration for each kind has to be isolated and checked on its
 * own, or the guard silently approves the very drift it exists to catch.
 */
function declarations(text: string): Map<string, string> {
  const out = new Map<string, string>()

  // CONTENT_SOUL: a fenced block of `kind  { … }` lines, continuation lines
  // indented. Patch description: one string of `{ kind:'x', … }` segments.
  const lineForm = /^([a-z]+)\s+\{([^\n]*)$/
  let current: string | null = null

  for (const raw of text.split('\n')) {
    const m = lineForm.exec(raw)
    if (m && SLIDE_KINDS.includes(m[1] as SlideKind)) {
      current = m[1]
      out.set(current, m[2])
    } else if (current && /^\s+\S/.test(raw) && !raw.trimStart().startsWith('//')) {
      out.set(current, (out.get(current) ?? '') + ' ' + raw.trim())
    } else if (raw.trim() === '' || raw.trim() === '```') {
      current = null
    }
  }

  for (const seg of text.split(/\{\s*kind\s*:\s*'/).slice(1)) {
    const kind = /^([a-z]+)'/.exec(seg)?.[1]
    if (!kind || !SLIDE_KINDS.includes(kind as SlideKind)) continue
    // Kinds are separated by `} | {` in the tool description. Cutting at the
    // first `}` instead would stop inside a nested shape (`left:{…}`) and lose
    // every field after it.
    const end = seg.indexOf('} |')
    out.set(kind, (out.get(kind) ?? '') + ' ' + seg.slice(0, end === -1 ? 400 : end + 1))
  }
  return out
}

/**
 * Enum values must not count as field declarations. `variant?:
 * takeaways|split|thanks` contains the word "takeaways", which let a summary
 * signature that had renamed the field to `points` pass the check.
 */
function stripEnums(decl: string): string {
  return decl.replace(/\b[A-Za-z]+(\|[A-Za-z]+)+/g, ' ')
}

function check(file: string, section?: string): Problem[] {
  const abs = path.join(ROOT, file)
  let text = fs.readFileSync(abs, 'utf8')

  // For the patch, only the tool description matters — the rest of the diff
  // mentions plenty of unrelated words.
  if (section) {
    const i = text.indexOf(section)
    if (i === -1) return [{ file, kind: '-', what: `section "${section}" not found` }]
    text = text.slice(i, i + 6000)
  }

  const decls = declarations(text)
  const problems: Problem[] = []

  for (const kind of SLIDE_KINDS) {
    // Legacy/withdrawn kinds are deliberately absent from the prompts.
    if (LEGACY_KINDS.includes(kind)) continue
    const decl = decls.get(kind)
    if (!decl) { problems.push({ file, kind, what: 'no field declaration found' }); continue }
    const fields = stripEnums(decl)
    for (const field of SLIDE_FIELDS[kind].required as string[]) {
      if (!new RegExp(`\\b${field}\\b`).test(fields)) {
        problems.push({ file, kind, what: `declaration omits required field \`${field}\`` })
      }
    }
  }
  return problems
}

/** Marker-diff check: the marked region must EQUAL the generated block. */
function checkMarked(): Problem[] {
  const problems: Problem[] = []
  for (const m of MARKED_FILES) {
    const text = fs.readFileSync(path.join(ROOT, m.file), 'utf8')
    const region = markedRegion(text, m)
    if (!region) {
      problems.push({ file: m.file, kind: '-', what: `markers missing (${m.begin} … ${m.end})` })
      continue
    }
    const expected = m.block()
    if (region.body !== expected) {
      const got = region.body.split('\n')
      const want = expected.split('\n')
      const i = want.findIndex((l, k) => got[k] !== l)
      problems.push({
        file: m.file, kind: '-',
        what: `marked region is stale at line ${i + 1} — run \`npm run gen:deck-prompt -- --write\`\n    expected: ${want[i] ?? '(end)'}\n    found:    ${got[i] ?? '(end)'}`,
      })
    }
  }
  return problems
}

const all = [...TARGETS.flatMap((t) => check(t.file, t.section)), ...checkMarked()]

if (all.length) {
  console.error(`${all.length} schema/prompt mismatch(es):\n`)
  for (const p of all) console.error(`  ${p.file} — ${p.kind}: ${p.what}`)
  console.error('\nA field the prompt never names is a field the model will invent.')
  process.exit(1)
}
console.log(`prompt schema OK — ${SLIDE_KINDS.length - LEGACY_KINDS.length} kinds: regex×${TARGETS.length} (patch) + marker-diff×${MARKED_FILES.length} (soul, tskill)`)
