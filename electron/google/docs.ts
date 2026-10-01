import { google } from 'googleapis'
import type { docs_v1 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

/**
 * Google Docs read/write. Same philosophy as the Excel module: writes take
 * a structured block payload (no raw markdown wrangling on the LLM side),
 * reads return a normalized JSON shape so callers don't have to walk the
 * Google Docs `body.content` tree themselves.
 */

export type GdocBlock =
  | { type: 'h1' | 'h2' | 'h3' | 'p'; text: string }
  | { type: 'bullet'; items: string[] }
  | { type: 'spacer' }

export type WriteGdocPayload = {
  title:  string
  blocks: GdocBlock[]
}

export type WriteGdocResult = {
  documentId: string
  url:        string
  title:      string
}

export type ReadGdocResult = {
  documentId: string
  title:      string
  /** Plain-text rendering, paragraphs joined with `\n\n`. */
  text:       string
  /** Lightweight structural breakdown — heading levels + bullet markers preserved. */
  blocks:     GdocBlock[]
}

const HEADING_FOR: Record<'h1' | 'h2' | 'h3' | 'p', 'TITLE' | 'HEADING_1' | 'HEADING_2' | 'HEADING_3' | 'NORMAL_TEXT'> = {
  h1: 'HEADING_1',
  h2: 'HEADING_2',
  h3: 'HEADING_3',
  p:  'NORMAL_TEXT',
}

export async function writeGdoc(auth: OAuth2Client, payload: WriteGdocPayload): Promise<WriteGdocResult> {
  const docs = google.docs({ version: 'v1', auth })
  const created = await docs.documents.create({ requestBody: { title: payload.title } })
  const documentId = created.data.documentId
  if (!documentId) throw new Error('gdoc_create_failed_no_id')

  // Build the body in one batchUpdate. We append paragraph by paragraph,
  // tracking the running insertion index. Each insertText is followed by a
  // paragraph-style update so the new paragraph picks up the right heading.
  const requests: docs_v1.Schema$Request[] = []
  let cursor = 1 // documents always start with an implicit empty paragraph at index 1

  function appendParagraph(text: string, namedStyleType: 'TITLE' | 'HEADING_1' | 'HEADING_2' | 'HEADING_3' | 'NORMAL_TEXT', bullet?: boolean): void {
    const body = (text.length === 0 ? ' ' : text) + '\n'
    requests.push({ insertText: { location: { index: cursor }, text: body } })
    const start = cursor
    const end   = cursor + body.length - 1 // exclude trailing newline char in style range
    requests.push({
      updateParagraphStyle: {
        range:           { startIndex: start, endIndex: end },
        paragraphStyle:  { namedStyleType },
        fields:          'namedStyleType',
      },
    })
    if (bullet) {
      requests.push({
        createParagraphBullets: {
          range:        { startIndex: start, endIndex: end },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      })
    }
    cursor += body.length
  }

  for (const block of payload.blocks) {
    if (block.type === 'spacer') {
      appendParagraph('', 'NORMAL_TEXT')
      continue
    }
    if (block.type === 'bullet') {
      for (const item of block.items) appendParagraph(item, 'NORMAL_TEXT', true)
      continue
    }
    appendParagraph(block.text, HEADING_FOR[block.type])
  }

  if (requests.length > 0) {
    await docs.documents.batchUpdate({ documentId, requestBody: { requests } })
  }

  return {
    documentId,
    url:   `https://docs.google.com/document/d/${documentId}/edit`,
    title: payload.title,
  }
}

export async function readGdoc(auth: OAuth2Client, documentId: string): Promise<ReadGdocResult> {
  const docs = google.docs({ version: 'v1', auth })
  const res  = await docs.documents.get({ documentId })
  const doc  = res.data
  const title = doc.title ?? ''
  const elements = doc.body?.content ?? []

  const blocks: GdocBlock[] = []
  const textParts: string[] = []

  for (const el of elements) {
    if (!el.paragraph) continue
    const style = el.paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT'
    const isBullet = !!el.paragraph.bullet
    const text = (el.paragraph.elements ?? [])
      .map((e) => e.textRun?.content ?? '')
      .join('')
      .replace(/\n+$/, '')

    if (text.length === 0 && !isBullet) {
      blocks.push({ type: 'spacer' })
      textParts.push('')
      continue
    }

    if (isBullet) {
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'bullet') last.items.push(text)
      else blocks.push({ type: 'bullet', items: [text] })
      textParts.push(`• ${text}`)
      continue
    }

    let kind: 'h1' | 'h2' | 'h3' | 'p' = 'p'
    if (style === 'TITLE' || style === 'HEADING_1') kind = 'h1'
    else if (style === 'HEADING_2') kind = 'h2'
    else if (style === 'HEADING_3') kind = 'h3'
    blocks.push({ type: kind, text })
    textParts.push(text)
  }

  return {
    documentId,
    title,
    text:   textParts.join('\n\n'),
    blocks,
  }
}
