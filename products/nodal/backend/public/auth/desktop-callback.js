// Nodal 데스크톱 로그인 핸드오프 (docs/BACKEND_CONTRACT.md §1).
//
//   앱 → 브라우저로 이 페이지를 연다 → Google 로그인 → 이 페이지로 돌아옴(?code=…)
//   → 세션으로 교환 → nodal://auth#access_token=…&refresh_token=…&expires_at=… 로 앱에 넘긴다.
//
// 서버 코드가 없다. 전부 브라우저에서 일어나고, 여기 적힌 키는 publishable(공개 안전) 키다.
//
// SYNC: 아래 세 값은 products/nodal/profile.ts 의 supabase.url · supabase.anonKey ·
// protocolScheme 과 같아야 한다 — desktop-callback.test.ts 가 검사한다.
var SUPABASE_URL = 'https://vbwempftdyuuegcoqizl.supabase.co'
var SUPABASE_KEY = 'sb_publishable_-QLkuxg6Ub5ivWyUTggaOg_CNT2oynV'
var APP_SCHEME   = 'nodal'

;(function () {
  var statusEl = document.getElementById('status')
  var openEl   = document.getElementById('open')
  var retryEl  = document.getElementById('retry')
  var hintEl   = document.getElementById('hint')
  var here     = location.origin + location.pathname

  function fail(message) {
    statusEl.textContent = message
    statusEl.className = 'error'
    retryEl.hidden = false
  }

  // 새로 시작 — 쿼리(?code, ?error)를 떼고 다시 연다.
  retryEl.addEventListener('click', function () { location.replace(here) })

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      // PKCE: 돌아올 때 URL 에 토큰이 아니라 1회용 code 만 실린다 (브라우저 기록·Referer 에
      // 토큰이 남지 않는다). code verifier 를 리디렉트 너머로 들고 가야 해서 storage 는 켠다.
      flowType: 'pkce',
      persistSession: true,
      detectSessionInUrl: true,
      // 이 페이지는 세션을 "쓰지" 않고 앱에 넘기기만 한다. 여기서 refresh 가 돌면 refresh
      // token 이 회전해 앱이 받은 토큰이 무효가 된다 (Supabase 의 재사용 감지).
      autoRefreshToken: false,
    },
  })

  function handOff(session) {
    var link = APP_SCHEME + '://auth#' + new URLSearchParams({
      access_token:  session.access_token,
      refresh_token: session.refresh_token,
      expires_at:    String(session.expires_at || ''),
    }).toString()

    // 세션은 이제 앱의 것이다. 브라우저에 사본을 남기지 않는다 — signOut() 은 쓰지 않는다:
    // 서버에서 이 세션을 폐기해서 방금 앱에 넘긴 토큰까지 죽인다.
    try { localStorage.clear() } catch (e) { /* storage 차단 환경 — 무시 */ }
    history.replaceState(null, '', here)

    statusEl.textContent = 'Signed in. Opening Nodal…'
    openEl.href = link
    openEl.hidden = false
    hintEl.hidden = false
    // 일부 브라우저는 사용자 동작 없는 커스텀 스킴 이동을 막는다 — 그때는 위 버튼이 길이다.
    location.href = link
  }

  var params = new URLSearchParams(location.search)
  if (params.get('error')) {
    fail(params.get('error_description') || params.get('error'))
    return
  }

  // getSession() 은 초기화(= URL 의 ?code 교환)가 끝난 뒤에 답한다.
  client.auth.getSession().then(function (res) {
    if (res.error) { fail(res.error.message); return }
    if (res.data.session) { handOff(res.data.session); return }

    // code 가 있었는데 세션이 없다 = 교환 실패 (만료된 code, 다른 브라우저에서 시작 등).
    // 여기서 다시 로그인을 걸면 무한 리디렉트가 될 수 있으므로 멈추고 알린다.
    if (params.get('code')) { fail('Sign-in could not be completed. Please try again.'); return }

    return client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: here },
    }).then(function (r) { if (r.error) fail(r.error.message) })
  }).catch(function (err) { fail(err && err.message ? err.message : String(err)) })
})()
