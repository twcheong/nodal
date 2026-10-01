// Generates the deck-schema blocks that live inside the prompts, from the
// typed tables in shared/deck/spec.ts.
//
//   npx tsx scripts/deck/gen-prompt-block.ts            # print both blocks
//   npx tsx scripts/deck/gen-prompt-block.ts --write    # splice into the files
//
// WHY: the schema is described to a model in several hand copies, and a hand
// copy is where the field-name drift started (CONTENT_SOUL.md once elided the
// fields entirely; the model invented its own and every deck failed). The two
// largest copies — CONTENT_SOUL.md and skills/pptx/pptx.tskill — now carry
// marker pairs, and the text between the markers is GENERATED, never edited:
//
//   CONTENT_SOUL.md      <!-- deck-schema:begin --> … <!-- deck-schema:end -->
//   skills/pptx/*.tskill // deck-schema:begin      … // deck-schema:end
//
// check-prompt-schema.ts diffs the marked regions against this generator's
// output, so an edit to spec.ts without a regen fails `npm run check:deck`.
// (The tool description inside patches/openclaw+*.patch is a diff file and
// cannot carry markers — it keeps the regex-based check.)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIELD_SIGS, LEGACY_KINDS, SLIDE_FIELDS, SLIDE_KINDS, type SlideKind } from '../../shared/deck/spec'
import { DECK_PURPOSES } from '../../shared/deck/purpose'
import { ICON_NAMES } from '../../shared/deck/icons'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ── schema lines (shared by both blocks) ─────────────────────────────────────

function fieldSig(kind: SlideKind, field: string, optional: boolean): string {
  const sig = (FIELD_SIGS[kind] as Record<string, string>)[field]
  return `${field}${optional ? '?' : ''}${sig ? `: ${sig}` : ''}`
}

/** One `kind  { … }` line per kind, wrapped at ~86 chars with continuation
 *  indent — the same shape the prompts have always used. */
/** Kinds the prompts teach = everything except the legacy/withdrawn ones. */
export function taughtKinds(): SlideKind[] {
  return SLIDE_KINDS.filter((k) => !LEGACY_KINDS.includes(k))
}

export function schemaLines(): string[] {
  const lines: string[] = []
  for (const kind of taughtKinds()) {
    const { required, optional } = SLIDE_FIELDS[kind]
    const parts = [
      'kind',
      ...(required as string[]).map((f) => fieldSig(kind, f, false)),
      ...(optional as string[]).map((f) => fieldSig(kind, f, true)),
    ]
    const head = kind.padEnd(9) + '{ '
    const indent = ' '.repeat(head.length)
    let line = head
    const out: string[] = []
    parts.forEach((p, i) => {
      const piece = p + (i < parts.length - 1 ? ', ' : ' }')
      if (line !== head && line !== indent && (line + piece).length > 86) {
        out.push(line.trimEnd())
        line = indent
      }
      line += piece
    })
    out.push(line)
    if (kind === 'layout') {
      out[out.length - 1] += '   // 12-col grid, body: heading|paragraph|bullets|stat|quote|chart|image|kv|icon|step|chips|funnel|spacer'
      out.push("          // step { type:'step', number?, icon?, title, desc? } — agenda/process row; span-12 stack = dense agenda page. `icon` instead of `number` = the icon+text-rows page type")
      out.push("          // chips { type:'chips', items: string[] } — outlined meta badges · funnel { type:'funnel', stages: [{ label, desc? }] } — 2-6 narrowing bands")
      out.push(`          // icon body: { type:'icon', name, label?, sublabel? } — names: ${ICON_NAMES.join(', ')}`)
    }
    lines.push(...out)
  }
  return lines
}

/** All kinds on one line — the "these are the only valid names" sentence. */
export function kindListLine(): string {
  return taughtKinds().join(', ')
}

// ── purpose page tables ──────────────────────────────────────────────────────

/**
 * One block per purpose: header line + one line per slot.
 * ⚠ Slot roles and kind lists use ` → ` and ` / ` separators, never `a|b|c` —
 * the checker's stripEnums() erases pipe-runs, and a purpose table written
 * with pipes would vanish from the regex path entirely.
 */
export function purposeLines(): string[] {
  const lines: string[] = []
  for (const p of Object.values(DECK_PURPOSES)) {
    lines.push(`${p.id} — ${p.objective}. Audience: ${p.audience}. Success: ${p.success}. Budget: ~${p.slideBudget} slides.`)
    for (const s of p.slots) {
      const req = s.repeat[0] === 0 ? 'optional' : s.repeat[0] === s.repeat[1] ? `x${s.repeat[0]}` : `x${s.repeat[0]}-${s.repeat[1]}`
      lines.push(`  ${s.role} (${req}, ${s.kinds.join(' / ')}) — ${s.guide}`)
    }
    lines.push('')
  }
  lines.pop()
  return lines
}

// ── the marked blocks ────────────────────────────────────────────────────────

/** Content of the CONTENT_SOUL.md marked region (a fenced code block). */
export function contentSoulBlock(): string {
  return ['```', ...schemaLines(), '```'].join('\n')
}

/** Content of the pptx.tskill marked region (2-space stage indent, no fence). */
export function tskillBlock(): string {
  return [
    '  ── SCHEMA: use these field names exactly (generated — do not hand-edit) ─',
    ...schemaLines().map((l) => '  ' + l),
    `  🚨 Valid kinds are ONLY: ${kindListLine()}. An unknown kind or field name is a hard error — the deck does not render.`,
  ].join('\n')
}

// ── splice / verify ──────────────────────────────────────────────────────────

/** Content of the CONTENT_SOUL.md purposes region (a fenced code block). */
export function contentSoulPurposeBlock(): string {
  return ['```', ...purposeLines(), '```'].join('\n')
}

/** Content of the pptx.tskill purposes region (2-space stage indent). */
export function tskillPurposeBlock(): string {
  return [
    '  ── PURPOSES: pick one, follow its page table (generated — do not hand-edit) ─',
    ...purposeLines().map((l) => ('  ' + l).trimEnd()),
    '  Set payload.purpose to the chosen id. Optional slots may be dropped; required ones may not.',
  ].join('\n')
}

export type MarkedFile = { file: string; begin: string; end: string; block: () => string }

export const MARKED_FILES: MarkedFile[] = [
  { file: 'CONTENT_SOUL.md', begin: '<!-- deck-schema:begin', end: '<!-- deck-schema:end -->', block: contentSoulBlock },
  { file: 'CONTENT_SOUL.md', begin: '<!-- deck-purposes:begin', end: '<!-- deck-purposes:end -->', block: contentSoulPurposeBlock },
  { file: 'skills/pptx/pptx.tskill', begin: '// deck-schema:begin', end: '// deck-schema:end', block: tskillBlock },
  { file: 'skills/pptx/pptx.tskill', begin: '// deck-purposes:begin', end: '// deck-purposes:end', block: tskillPurposeBlock },
]

/**
 * The region between the marker lines (exclusive), or null if markers are missing.
 *
 * 줄끝 주의: Windows(core.autocrlf=true) 체크아웃은 CRLF 라 split('\n') 뒤에도 각
 * 줄 끝에 \r 이 남는다. 생성기는 LF 만 내므로 그대로 비교하면 내용이 같아도 항상
 * "stale" — 눈으로는 expected/found 가 똑같아 보이는 실패였다 (그리고 `npm run lint`
 * 의 && 체인이 여기서 끊겨 eslint 가 아예 안 돌았다). 개발자마다 git 설정이 다르니
 * .gitattributes 로 강제하지 않고, body 는 LF 로 정규화해 비교하고 --write 는 그
 * 파일이 쓰던 줄끝(eol)을 그대로 따른다 — 한 파일에 줄끝이 섞이지 않게.
 */
export function markedRegion(text: string, m: MarkedFile): { body: string; before: string; after: string; eol: string } | null {
  const lines = text.split('\n')
  const b = lines.findIndex((l) => l.includes(m.begin))
  const e = lines.findIndex((l) => l.includes(m.end))
  if (b === -1 || e === -1 || e <= b) return null
  return {
    // before/after 는 원문 그대로 (CRLF 파일이면 각 줄의 \r 포함) — 다시 쓸 때 보존된다.
    before: lines.slice(0, b + 1).join('\n'),
    body: lines.slice(b + 1, e).map((l) => l.replace(/\r$/, '')).join('\n'),
    after: lines.slice(e).join('\n'),
    eol: lines[b].endsWith('\r') ? '\r\n' : '\n',
  }
}

function main() {
  const write = process.argv.includes('--write')
  for (const m of MARKED_FILES) {
    const abs = path.join(ROOT, m.file)
    const text = fs.readFileSync(abs, 'utf8')
    const region = markedRegion(text, m)
    if (!region) {
      console.error(`${m.file}: markers not found (${m.begin} … ${m.end})`)
      process.exitCode = 1
      continue
    }
    const expected = m.block()
    if (region.body === expected) {
      console.log(`${m.file}: up to date`)
    } else if (write) {
      // region.before 의 마지막 줄은 (CRLF 파일이면) 이미 \r 로 끝나므로 '\n' 만 붙인다.
      fs.writeFileSync(abs, `${region.before}\n${expected.split('\n').join(region.eol)}${region.eol}${region.after}`, 'utf8')
      console.log(`${m.file}: rewritten`)
    } else {
      console.log(`${m.file}: STALE — run with --write, or:\n`)
      console.log(expected)
    }
  }
}

// tsx runs this file directly; the checker imports it without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
