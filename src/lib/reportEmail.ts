// reportEmail.ts — 워크플로 run 결과/오류를 실행자 본인에게 이메일로 발송.
// Edge Function send-report 호출. orgInvites.sendInviteEmail 과 동일 형태:
// 미설정/실패해도 throw 하지 않고 성공 여부만 반환(부가 기능이라 run 흐름 방해 금지).

import { supabase } from './supabase'

export interface RunReportPayload {
  wfTitle:     string
  status:      'done' | 'failed' | 'aborted'
  durationMs?: number | null
  costUsd?:    number | null
  failReason?: string | null
  startedAt?:  number | null
}

export async function sendRunReportEmail(to: string, payload: RunReportPayload): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('send-report', {
      body: { to, ...payload },
    })
    if (error) return { ok: false, error: error.message }
    return (data as { ok: boolean; error?: string }) ?? { ok: false, error: 'no_response' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
