import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { status as googleStatus, getAuthorizedClient } from './oauth'

/**
 * Gmail send (users.messages.send). Same philosophy as docs.ts / sheets.ts:
 * a pure function that takes an authorized OAuth2Client + a typed payload.
 *
 * MIME notes:
 * - Subject is RFC 2047 B-encoded (=?UTF-8?B?...?=) whenever it contains
 *   non-ASCII characters, so Korean subjects survive every mail client.
 * - Body is sent as UTF-8 with Content-Transfer-Encoding: base64 (wrapped
 *   at 76 chars per RFC 2045), so Korean bodies are byte-exact.
 * - The full RFC 822 message is base64url-encoded into `raw` as the Gmail
 *   API requires.
 */

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export type SendEmailPayload = {
  /** Single address or list. Required. */
  to:       string | string[]
  cc?:      string | string[]
  bcc?:     string | string[]
  subject:  string
  /** Plain text by default; simple HTML when `html: true`. */
  body:     string
  html?:    boolean
}

export type SendEmailResult = {
  messageId: string
  threadId:  string | null
  to:        string[]
  subject:   string
}

function toList(v: string | string[] | undefined): string[] {
  if (!v) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr.map(s => String(s).trim()).filter(Boolean)
}

// Loose sanity check — catches obviously broken addresses without
// rejecting valid exotic ones. Real validation is Gmail's job.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function assertAddresses(label: string, addrs: string[]): void {
  for (const a of addrs) {
    if (!EMAIL_RE.test(a)) throw new Error(`invalid_${label}_address: "${a}"`)
    // Header injection guard: an address must never contain CR/LF.
    if (/[\r\n]/.test(a)) throw new Error(`invalid_${label}_address: "${a}"`)
  }
}

/** RFC 2047 B-encoding for non-ASCII header values (e.g. Korean subjects). */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value
  // Encoded-words should stay short; split on UTF-8 character boundaries so
  // no multi-byte char is cut in half (limit ~45 bytes per word → well under
  // the 75-char encoded-word cap).
  const words: string[] = []
  let chunk = ''
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
  return words.join('\r\n ') // folded continuation lines
}

/** base64 with 76-char line wrapping (RFC 2045) for the message body. */
function base64Wrapped(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  return b64.replace(/(.{76})/g, '$1\r\n')
}

export function buildMimeMessage(payload: SendEmailPayload): { mime: string; to: string[] } {
  const to  = toList(payload.to)
  const cc  = toList(payload.cc)
  const bcc = toList(payload.bcc)
  if (to.length === 0) throw new Error('missing_to: at least one recipient is required')
  if (!payload.subject?.trim()) throw new Error('missing_subject')
  if (!payload.body?.trim()) throw new Error('missing_body')
  assertAddresses('to', to)
  assertAddresses('cc', cc)
  assertAddresses('bcc', bcc)

  const headers: string[] = [
    `To: ${to.join(', ')}`,
    ...(cc.length  ? [`Cc: ${cc.join(', ')}`]   : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${encodeHeaderValue(payload.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: ${payload.html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
  ]
  const mime = headers.join('\r\n') + '\r\n\r\n' + base64Wrapped(payload.body)
  return { mime, to }
}

export async function sendEmail(auth: OAuth2Client, payload: SendEmailPayload): Promise<SendEmailResult> {
  const { mime, to } = buildMimeMessage(payload)
  const gmail = google.gmail({ version: 'v1', auth })
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(mime, 'utf8').toString('base64url') },
  })
  const messageId = res.data.id
  if (!messageId) throw new Error('gmail_send_failed_no_id')
  return { messageId, threadId: res.data.threadId ?? null, to, subject: payload.subject }
}

/**
 * Scope-checked wrapper shared by the IPC handler (electron/main.ts) and
 * the agent tool bridge (agent-tool-bridge.ts). Throws a user-actionable
 * error when the stored token predates the gmail.send scope — existing
 * users who connected before this feature must re-consent once.
 */
export async function sendEmailWithScopeCheck(metaDir: string, payload: SendEmailPayload): Promise<SendEmailResult> {
  const s = googleStatus(metaDir)
  if (!s.connected) {
    throw new Error('google_not_connected: 설정 > 연동에서 Google을 먼저 연결하세요.')
  }
  if (!(s.scopes ?? []).includes(GMAIL_SEND_SCOPE)) {
    throw new Error('gmail_scope_missing: Gmail 전송 권한(gmail.send)이 없는 토큰입니다. 설정 > 연동에서 Google 권한을 갱신하세요.')
  }
  const auth = getAuthorizedClient(metaDir)
  return await sendEmail(auth, payload)
}

// ── Gmail read (users.messages.list + users.messages.get) ───────────────
// Read-only counterpart to sendEmail. Same philosophy: pure functions that
// take an authorized OAuth2Client. Two entry points:
//   - listMessages: search/list with metadata + snippet (the inbox view)
//   - readMessage:  full single message (subject/from/date + decoded body)
//
// RFC 822 / MIME notes:
// - Gmail returns header values pre-decoded (RFC 2047 encoded-words already
//   resolved to UTF-8), so Korean subjects/senders come through intact.
// - Body parts are base64url-encoded raw bytes. We decode with
//   Buffer.from(data, 'base64url').toString('utf8'); the vast majority of
//   mail today is UTF-8, so Korean bodies are byte-exact. (Legacy EUC-KR
//   parts would mojibake — acceptable for a context-gathering read tool.)
// - For multipart messages we prefer the text/plain part, falling back to a
//   tag-stripped text/html part so the LLM always gets readable text.

export type GmailListItem = {
  id:       string
  threadId: string | null
  subject:  string
  from:     string
  date:     string
  snippet:  string
}

export type ListMessagesResult = {
  query:    string | null
  messages: GmailListItem[]
}

export type ReadMessageResult = {
  id:       string
  threadId: string | null
  subject:  string
  from:     string
  to:       string
  date:     string
  snippet:  string
  /** Decoded plain-text body (text/plain preferred, html stripped as fallback). */
  body:     string
}

type GmailHeader = { name?: string | null; value?: string | null }

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const lc = name.toLowerCase()
  const h = (headers ?? []).find((x) => (x.name ?? '').toLowerCase() === lc)
  return (h?.value ?? '').trim()
}

/** Decode a base64url body part to a UTF-8 string. */
function decodeBodyData(data: string | null | undefined): string {
  if (!data) return ''
  try { return Buffer.from(data, 'base64url').toString('utf8') }
  catch { return '' }
}

/** Very small HTML→text fallback: drop tags, decode a few common entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

type GmailPart = {
  mimeType?: string | null
  body?:     { data?: string | null } | null
  parts?:    GmailPart[] | null
}

/**
 * Walk the MIME tree and extract readable text. Collects text/plain parts
 * first; if none exist, falls back to the first text/html part (stripped).
 */
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return ''
  const plains: string[] = []
  const htmls:  string[] = []

  const walk = (part: GmailPart): void => {
    const mime = (part.mimeType ?? '').toLowerCase()
    if (mime === 'text/plain') {
      const t = decodeBodyData(part.body?.data)
      if (t) plains.push(t)
    } else if (mime === 'text/html') {
      const t = decodeBodyData(part.body?.data)
      if (t) htmls.push(t)
    }
    for (const child of part.parts ?? []) walk(child)
  }
  walk(payload)

  if (plains.length > 0) return plains.join('\n').trim()
  if (htmls.length  > 0) return stripHtml(htmls.join('\n'))
  // Single-part message with the body directly on the payload.
  const direct = decodeBodyData(payload.body?.data)
  if (direct) {
    return (payload.mimeType ?? '').toLowerCase() === 'text/html' ? stripHtml(direct) : direct.trim()
  }
  return ''
}

const DEFAULT_MAX_RESULTS = 10
const HARD_MAX_RESULTS    = 50

/**
 * List/search inbox messages. Returns lightweight items (subject/from/date +
 * snippet) so the LLM can scan a thread without pulling every full body.
 * `query` uses Gmail search syntax (e.g. "from:foo@bar.com newer_than:7d").
 */
export async function listMessages(
  auth: OAuth2Client,
  opts?: { query?: string; maxResults?: number },
): Promise<ListMessagesResult> {
  const gmail = google.gmail({ version: 'v1', auth })
  const query = opts?.query?.trim() || undefined
  const max = Math.min(
    Math.max(1, Math.floor(opts?.maxResults ?? DEFAULT_MAX_RESULTS)),
    HARD_MAX_RESULTS,
  )

  const list = await gmail.users.messages.list({
    userId:     'me',
    q:          query,
    maxResults: max,
  })
  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id)

  // Fetch metadata + snippet for each id. Sequential keeps it simple and well
  // under Gmail's per-user rate limits for the small page sizes we use.
  const messages: GmailListItem[] = []
  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId:         'me',
      id,
      format:         'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    })
    const headers = msg.data.payload?.headers as GmailHeader[] | undefined
    messages.push({
      id,
      threadId: msg.data.threadId ?? null,
      subject:  headerValue(headers, 'Subject'),
      from:     headerValue(headers, 'From'),
      date:     headerValue(headers, 'Date'),
      snippet:  msg.data.snippet ?? '',
    })
  }

  return { query: query ?? null, messages }
}

/** Read a single message in full: headers + decoded text body. */
export async function readMessage(auth: OAuth2Client, id: string): Promise<ReadMessageResult> {
  if (!id?.trim()) throw new Error('missing_message_id')
  const gmail = google.gmail({ version: 'v1', auth })
  const msg = await gmail.users.messages.get({ userId: 'me', id: id.trim(), format: 'full' })
  const payload = msg.data.payload as GmailPart | undefined
  const hdrs = msg.data.payload?.headers as GmailHeader[] | undefined
  return {
    id:       msg.data.id ?? id.trim(),
    threadId: msg.data.threadId ?? null,
    subject:  headerValue(hdrs, 'Subject'),
    from:     headerValue(hdrs, 'From'),
    to:       headerValue(hdrs, 'To'),
    date:     headerValue(hdrs, 'Date'),
    snippet:  msg.data.snippet ?? '',
    body:     extractBody(payload),
  }
}

/**
 * Scope-checked wrapper shared by the agent tool bridge. Mirrors
 * sendEmailWithScopeCheck: throws a user-actionable error when the stored
 * token predates the gmail.readonly scope — existing users who connected
 * before this feature must re-consent once.
 *
 * If `id` is provided, reads that message in full; otherwise lists/searches.
 */
export async function readGmailWithScopeCheck(
  metaDir: string,
  opts: { query?: string; maxResults?: number; id?: string },
): Promise<ListMessagesResult | ReadMessageResult> {
  const s = googleStatus(metaDir)
  if (!s.connected) {
    throw new Error('google_not_connected: 설정 > 연동에서 Google을 먼저 연결하세요.')
  }
  if (!(s.scopes ?? []).includes(GMAIL_READONLY_SCOPE)) {
    throw new Error('gmail_scope_missing: Gmail 읽기 권한(gmail.readonly)이 없는 토큰입니다. 설정 > 연동에서 Google 권한을 갱신하세요.')
  }
  const auth = getAuthorizedClient(metaDir)
  if (opts.id?.trim()) {
    return await readMessage(auth, opts.id)
  }
  return await listMessages(auth, { query: opts.query, maxResults: opts.maxResults })
}
