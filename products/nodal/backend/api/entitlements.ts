// GET /api/entitlements — 요금제·한도·오늘 사용량 (계약 §4). 렌더러가 직접 부르므로 CORS.
import { json, preflight } from '../lib/http'
import { loadEntitlements } from '../lib/subscription'
import { getAuthedUser } from '../lib/supabase'

export const OPTIONS = preflight

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await getAuthedUser(req)
    if (!user) return json(req, { ok: false, error: 'unauthorized' }, 401)
    return json(req, await loadEntitlements(user))
  } catch (err) {
    return json(req, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
  }
}
