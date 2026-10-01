// send-report — 워크플로 run 결과/오류를 실행자 본인에게 이메일로 발송 (Supabase Edge Function, Deno).
// 클라(로그인 유저)가 supabase.functions.invoke('send-report', {body:{...}}) 로 호출.
// verify_jwt 기본 on → 로그인 유저만 호출 가능. send-invite 와 동일한 Resend 경로.
//
// 배포 전 필요한 시크릿(send-invite 와 공유 — 이미 설정했으면 재설정 불필요):
//   supabase secrets set RESEND_API_KEY=re_xxx
//   supabase secrets set REPORT_FROM="Twixy <noreply@your-domain>"   (없으면 INVITE_FROM 재사용)
// 배포: supabase functions deploy send-report

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface ReportBody {
  to:          string
  wfTitle:     string
  status:      'done' | 'failed' | 'aborted'
  durationMs?: number | null
  costUsd?:    number | null
  failReason?: string | null
  startedAt?:  number | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const b = (await req.json()) as ReportBody
    if (typeof b.to !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.to)) {
      return json({ ok: false, error: 'bad_input' }, 400)
    }
    if (!b.wfTitle || !['done', 'failed', 'aborted'].includes(b.status)) {
      return json({ ok: false, error: 'bad_input' }, 400)
    }
    const KEY = Deno.env.get('RESEND_API_KEY')
    const FROM = Deno.env.get('REPORT_FROM') ?? Deno.env.get('INVITE_FROM') ?? 'Twixy <onboarding@resend.dev>'
    if (!KEY) return json({ ok: false, error: 'not_configured' }, 500)

    const label = b.status === 'done' ? '✅ 완료' : b.status === 'failed' ? '❌ 실패' : '⏹️ 중단'
    const dur = b.durationMs != null ? `${(b.durationMs / 1000).toFixed(1)}초` : '—'
    const cost = b.costUsd != null ? `$${b.costUsd.toFixed(4)}` : '—'
    const when = b.startedAt ? new Date(b.startedAt).toLocaleString('ko-KR') : '—'
    const subject = `[Twixy] ${b.wfTitle} — ${label}`

    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <h2 style="margin-bottom:4px">${label} — ${escapeHtml(b.wfTitle)}</h2>
        <table style="border-collapse:collapse;font-size:14px;margin-top:12px">
          <tr><td style="padding:4px 12px 4px 0;color:#888">시작</td><td>${escapeHtml(when)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888">소요</td><td>${escapeHtml(dur)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888">비용</td><td>${escapeHtml(cost)}</td></tr>
        </table>
        ${b.failReason ? `<div style="margin-top:16px;padding:12px 16px;background:#fef2f2;border-radius:8px;color:#991b1b;font-size:13px"><b>오류</b><br>${escapeHtml(b.failReason)}</div>` : ''}
        <p style="color:#888;font-size:12px;margin-top:20px">Twixy 데스크톱 앱에서 자동 발송된 리포트입니다. 설정 &gt; Runs 에서 끌 수 있습니다.</p>
      </div>`

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: b.to, subject, html }),
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
