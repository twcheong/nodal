// 로그인 핸드오프 페이지 — 서버가 없는 정적 페이지라 브라우저 동작을 jsdom 으로 확인한다.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { profile } from '../profile'

const DIR = path.join(__dirname, 'public', 'auth')
const HTML = fs.readFileSync(path.join(DIR, 'desktop-callback.html'), 'utf8')
const JS   = fs.readFileSync(path.join(DIR, 'desktop-callback.js'), 'utf8')

const SESSION = { access_token: 'AT', refresh_token: 'RT', expires_at: 1790000000 }

function load(search: string, session: typeof SESSION | null) {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(HTML)![1].replace(/<script[\s\S]*?<\/script>/g, '')
  history.replaceState(null, '', '/auth/desktop-callback' + search)
  const auth = {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(),
  }
  const createClient = vi.fn(() => ({ auth }))
  ;(window as unknown as { supabase: unknown }).supabase = { createClient }
  new Function(JS)()
  return { auth, createClient }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })  // jsdom: "navigation not implemented"
afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

describe('desktop-callback page', () => {
  it('uses the same Supabase project and deep-link scheme as the app profile', () => {
    expect(JS).toContain(`'${profile.supabase.url}'`)
    expect(JS).toContain(`'${profile.supabase.anonKey}'`)
    expect(JS).toContain(`APP_SCHEME   = '${profile.protocolScheme}'`)
  })

  it('never auto-refreshes — a rotated refresh token would invalidate the one handed to the app', () => {
    const { createClient } = load('', null)
    const opts = (createClient.mock.calls[0] as unknown[])[2] as { auth: Record<string, unknown> }
    expect(opts.auth).toMatchObject({ flowType: 'pkce', autoRefreshToken: false })
  })

  it('starts Google sign-in and comes back to this same page', async () => {
    const { auth } = load('', null)
    await settle()
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: location.origin + '/auth/desktop-callback' },
    })
  })

  it('hands the session to the app in the hash fragment and keeps no copy', async () => {
    localStorage.setItem('sb-x-auth-token', 'leftover')
    const { auth } = load('?code=abc', SESSION)
    await settle()
    const link = (document.getElementById('open') as HTMLAnchorElement).getAttribute('href')!
    expect(link).toBe('nodal://auth#access_token=AT&refresh_token=RT&expires_at=1790000000')
    expect(document.getElementById('open')!.hidden).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(location.search).toBe('')                 // ?code 가 주소창·기록에 남지 않는다
    expect(auth.signOut).not.toHaveBeenCalled()      // signOut 은 앱에 넘긴 세션까지 폐기한다
    expect(auth.signInWithOAuth).not.toHaveBeenCalled()
  })

  it('stops instead of looping when the code could not be exchanged', async () => {
    const { auth } = load('?code=expired', null)
    await settle()
    expect(auth.signInWithOAuth).not.toHaveBeenCalled()
    expect(document.getElementById('status')!.className).toBe('error')
    expect(document.getElementById('retry')!.hidden).toBe(false)
  })

  it('shows the provider error instead of retrying', async () => {
    const { auth } = load('?error=access_denied&error_description=User+cancelled', null)
    await settle()
    expect(document.getElementById('status')!.textContent).toBe('User cancelled')
    expect(auth.getSession).not.toHaveBeenCalled()
  })
})
