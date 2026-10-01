// ── 언어 교정 (main.ts 에서 이동) ───────────────────────────────────────────
//
// 어시스턴트 최종 응답과 덱 안의 문자열을 사용자 언어에 맞게 다듬는다. 둘 다 서브모델
// (flash-lite)을 1회 호출하고, 그 호출 배관(키·모델·에러 처리)은 subModelChat 하나에 모여 있다.
// (Stage 4 슬라이스 2b)
//
// ⚠ **OpenRouter 핸드아웃 캐시는 이 모듈이 갖지 않는다.** main.ts 가 계속 소유하고,
// 여기서는 부를 때마다 deps.getApiKey() 로 물어본다. 캐시 사본을 여기 두면 키가 갱신된
// 뒤에도 옛 키를 계속 쓰는 상황이 생기고, 증상이 "가끔 401" 이라 추적이 지독하게 어렵다.
// 같은 이유로 모드·설정 경로도 들고 있지 않는다 — 전부 호출 시점에 묻는다.
import { ipcMain } from 'electron'
import fs from 'node:fs'

export interface LanguageCorrectionDeps {
  /** 호스팅 LLM 프록시 모드인가. 아니면 교정 자체를 하지 않는다. */
  isTwixyMode: () => boolean
  /** 지금 유효한 호스팅 키. 캐시는 main 소유 — 매 호출 새로 묻는다. */
  getApiKey: () => Promise<string | undefined>
  /** openclaw.json 경로 (서브모델 id 를 읽는다). */
  getConfigPath: () => string
}

/** 언어 교정 IPC 2개를 등록한다. import 시점 부작용 없음. */
export function registerLanguageCorrectionIpc(deps: LanguageCorrectionDeps): void {

  // Shared plumbing for the sub-model (flash-lite) calls below: hosted key,
  // model resolution, one POST, usage passthrough. Both the prose corrector and
  // the deck-string corrector go through here so the key/model/error handling
  // exists once.
  async function subModelChat(
    messages: { role: 'system' | 'user'; content: string }[],
    maxTokens = 4096,
  ): Promise<{ ok: true; content: string; tokensIn: number; tokensOut: number } | { ok: false; error: string }> {
    if (!deps.isTwixyMode()) return { ok: false, error: 'twixy mode only' }
    const apiKey = await deps.getApiKey()
    if (!apiKey) return { ok: false, error: 'no api key available' }

    const model = (() => {
      try {
        const cfg = JSON.parse(fs.readFileSync(deps.getConfigPath(), 'utf8'))
        const m = cfg?.agents?.defaults?.subagents?.model ?? 'google/gemini-2.5-flash-lite'
        // Strip openclaw's "openrouter/" prefix — OpenRouter expects "provider/model"
        return m.startsWith('openrouter/') ? m.slice('openrouter/'.length) : m
      } catch { return 'google/gemini-2.5-flash-lite' }
    })()

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.warn('[sub-model] API error:', res.status, err.slice(0, 200))
      return { ok: false, error: `API ${res.status}` }
    }
    const body = await res.json() as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const content = body.choices?.[0]?.message?.content?.trim()
    if (!content) return { ok: false, error: 'empty response' }
    return {
      ok: true, content,
      tokensIn: body.usage?.prompt_tokens ?? 0,
      tokensOut: body.usage?.completion_tokens ?? 0,
    }
  }

  // ── Language correction — 어시스턴트 언어 자동 교정 ──────────────
  // 최종 어시스턴트 응답을 사용자가 쓰는 언어에 맞춰 재작성한다.
  // 고유명사/URL/브랜드/코드블록은 원문 유지. 서브에이전트 LLM 을 1회 추가 호출.
  // Passes the final assistant message through gpt-4o-mini to correct any
  // language mismatch (e.g. Chinese/Japanese leaking into a Korean response).
  // Target language is inferred from the user's own message sample — no
  // hardcoded language assumption. Proper nouns, brand names, URLs, and
  // code blocks are preserved as-is.
  ipcMain.handle('correct-language', async (_e, payload: { text: string; userSample: string }) => {
    const { text, userSample } = payload
    if (!text?.trim()) return { ok: false, error: 'empty text' }
    try {
      const r = await subModelChat([
        {
          role: 'system',
          content: `You are a language correction assistant. Your job is to fix language hallucinations — where a model accidentally mixes in characters from the wrong language (e.g. Chinese/Japanese leaking into a Korean response).

  Rules:
  - If a user sample is provided, detect the target language from it; otherwise infer the primary intended language from the text itself (use the dominant language)
  - Rewrite the text so it is entirely in that one language
  - Preserve proper nouns, brand names, product names, URLs, code blocks, and technical terms in English exactly as-is
  - Do NOT alter any whitespace, line breaks, indentation, or markdown formatting — only replace the incorrect language characters
  - Do NOT add any explanation or commentary — output only the corrected text

  CRITICAL: You must output ONLY the corrected version of the "Assistant message to correct". Never output the user's language sample. Never output anything other than the corrected assistant message.`,
        },
        {
          role: 'user',
          content: `User's language sample (for language detection only — do NOT output this): """${userSample}"""

  Assistant message to correct (output ONLY this, corrected): """${text}"""`,
        },
      ])
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, text: r.content, tokensIn: r.tokensIn, tokensOut: r.tokensOut }
    } catch (err) {
      console.warn('[correct-language] error:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── Deck string correction — 덱 안의 언어 혼입 교정 ────────────────
  // The prose corrector above cannot touch a deck: its prompt preserves code
  // blocks, and a deck-spec IS a code block. So the model sees ONLY a flat array
  // of the deck's prose strings and must return the same array corrected — it
  // never sees the JSON, so it cannot break it, and a length mismatch is
  // rejected whole by the caller (shared/deck/strings.ts).
  ipcMain.handle('correct-language-batch', async (_e, payload: { items: string[]; userSample: string }) => {
    const { items, userSample } = payload
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'empty items' }
    try {
      const r = await subModelChat([
        {
          role: 'system',
          content: `You fix language hallucinations in presentation slide text — where a model mixed characters from the wrong language into the copy (e.g. Chinese 兄弟, Japanese へ, French/Portuguese words leaking into Korean).

  You receive a JSON array of strings. Return a JSON array of strings.

  Rules:
  - Return EXACTLY the same number of items, in the same order. This is critical: the array is mapped back onto slide fields by index.
  - Detect the target language from the user sample; if no sample is given, use the DOMINANT language of the items themselves.
  - You are fixing contamination, NOT translating. If the items are mostly Korean, the output is Korean; mostly Chinese, the output is Chinese. Never switch the deck to English (or any other language) because the instructions you are reading are in English.
  - Rewrite each item so it is entirely in that one language.
  - Keep proper nouns, brand names, account handles (@name), product names, URLs, numbers, units and established English technical terms EXACTLY as they are.
  - Keep each item's length and tone close to the original — this is slide copy laid out in fixed boxes, not prose to expand.
  - If an item is already correct, return it unchanged.
  - Output ONLY the JSON array. No markdown fence, no commentary.`,
        },
        {
          role: 'user',
          content: `Language sample (detection only, do NOT output): """${userSample.slice(0, 500)}"""

  Items (return this array, corrected, same length):
  ${JSON.stringify(items, null, 0)}`,
        },
      ], 8192)
      if (!r.ok) return { ok: false, error: r.error }

      // The model may still wrap the array in a fence despite the instruction.
      const raw = r.content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { return { ok: false, error: 'not JSON' } }
      if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
        return { ok: false, error: 'not a string array' }
      }
      if (parsed.length !== items.length) {
        return { ok: false, error: `length ${parsed.length} != ${items.length}` }
      }
      return { ok: true, items: parsed as string[], tokensIn: r.tokensIn, tokensOut: r.tokensOut }
    } catch (err) {
      console.warn('[correct-language-batch] error:', err)
      return { ok: false, error: String(err) }
    }
  })

}
