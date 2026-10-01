// 응답 헬퍼 + CORS.
//
// /api/entitlements* 는 렌더러(브라우저 컨텍스트)가 직접 부른다 — 패키징된 앱의 오리진은
// file:// 라 Origin 헤더가 "null" 로 온다. 나머지(/api/openrouter-*)는 메인 프로세스가
// 부르므로 CORS 와 무관하다. 모든 엔드포인트가 Bearer 토큰으로 인증하고 쿠키를 쓰지
// 않으므로 오리진을 넓게 허용해도 CSRF 표면이 없다.
const ALLOWED_ORIGINS = new Set(['null', 'http://localhost:5173', 'http://127.0.0.1:5173'])

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...corsHeaders(req) },
  })
}

export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) })
}
