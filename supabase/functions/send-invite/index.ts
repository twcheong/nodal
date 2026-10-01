// send-invite — 팀 초대 이메일 발송 (Supabase Edge Function, Deno).
// 클라(로그인 유저)가 supabase.functions.invoke('send-invite', {body:{to, code}}) 로 호출.
// verify_jwt 기본 on → 로그인 유저만 호출 가능(무단 스팸 방지). Resend API 로 발송.
//
// 배포 전 필요한 시크릿(대시보드 또는 CLI):
//   supabase secrets set RESEND_API_KEY=re_xxx
//   supabase secrets set INVITE_FROM="Twixy <noreply@your-domain>"
//   supabase secrets set APP_JOIN_URL="https://your-domain/join"   (선택: 링크 표기용)
// 배포: supabase functions deploy send-invite

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const { to, code, orgName, inviterName } = await req.json()
    // 최소 검증 — 이메일 형식 + 코드.
    if (typeof to !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || typeof code !== 'string' || !code) {
      return json({ ok: false, error: 'bad_input' }, 400)
    }
    const KEY = Deno.env.get('RESEND_API_KEY')
    const FROM = Deno.env.get('INVITE_FROM') ?? 'Twixy <onboarding@resend.dev>'
    const JOIN = Deno.env.get('APP_JOIN_URL') ?? ''
    if (!KEY) return json({ ok: false, error: 'not_configured' }, 500)

    const who = inviterName ? `${inviterName}님이` : '누군가'
    const team = orgName ? `“${orgName}” 팀에` : '팀에'
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2>Twixy 팀 초대</h2>
        <p>${escapeHtml(who)} ${escapeHtml(team)} 초대했습니다.</p>
        <p>Twixy 앱을 열고 <b>Join a team</b> 에 아래 코드를 붙여넣으세요:</p>
        <p style="font-size:22px;font-weight:700;letter-spacing:2px;background:#f2f4f7;padding:12px 16px;border-radius:8px;text-align:center">${escapeHtml(code)}</p>
        ${JOIN ? `<p><a href="${JOIN}">${JOIN}</a></p>` : ''}
        <p style="color:#888;font-size:12px">이 초대를 요청하지 않았다면 무시하세요.</p>
      </div>`

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject: 'Twixy 팀 초대', html }),
    })
    if (!res.ok) return json({ ok: false, error: `resend_${res.status}`, detail: await res.text() }, 502)
    return json({ ok: true })
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
