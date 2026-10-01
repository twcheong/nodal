// ─────────────────────────────────────────────────────────────────────────────
// teamRuns.ts — 팀 run 요약 레지스트리(Supabase `org_workflow_runs`) 접근 레이어.
//
// run 은 각 멤버의 로컬 머신에서 실행된다. 데스크톱이 시작 시 'running' 행을
// insert, 종료 시 결과를 update — 팀원들은 대시보드에서 팀 전체 현황을 본다.
// RLS: org 멤버 SELECT / 자기 행만 INSERT·UPDATE. 모든 report* 는 부가 기능이라
// 호출부에서 실패를 무시한다 (오프라인이어도 run 자체는 정상 동작).
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase'

export type OrgRunStatus = 'running' | 'done' | 'failed' | 'aborted'

export interface OrgRunRow {
  id:             string
  org_id:         string
  runner_user_id: string
  runner_name:    string | null
  wf_id:          string
  wf_title:       string
  status:         OrgRunStatus
  started_at:     string
  ended_at:       string | null
  duration_ms:    number | null
  cost_usd:       number | null
  fail_reason:    string | null
  // 실패 run 의 클립된 노드별 상세 (runLogs.buildFailLog 산출물). 성공 run 은 null.
  fail_log:       unknown | null
  node_total:     number | null
  node_done:      number | null
  current_node:   string | null
  updated_at:     string
}

export async function reportRunStart(
  orgId: string,
  user: { id: string; name?: string | null },
  run: { wfId: string; wfTitle: string; startedAt: number; nodeTotal: number },
): Promise<string> {
  const id = crypto.randomUUID()
  const { error } = await supabase.from('org_workflow_runs').insert({
    id,
    org_id:         orgId,
    runner_user_id: user.id,
    runner_name:    user.name ?? null,
    wf_id:          run.wfId,
    wf_title:       run.wfTitle,
    status:         'running',
    started_at:     new Date(run.startedAt).toISOString(),
    node_total:     run.nodeTotal,
    node_done:      0,
  })
  if (error) throw new Error(error.message)
  return id
}

export async function reportRunEnd(
  id: string,
  patch: {
    status:      Exclude<OrgRunStatus, 'running'>
    endedAt:     number
    durationMs:  number
    costUsd:     number
    failReason?: string | null
    failLog?:    unknown | null
    nodeDone?:   number
  },
): Promise<void> {
  const { error } = await supabase
    .from('org_workflow_runs')
    .update({
      status:      patch.status,
      ended_at:    new Date(patch.endedAt).toISOString(),
      duration_ms: Math.round(patch.durationMs),
      cost_usd:    patch.costUsd,
      fail_reason: patch.failReason ?? null,
      fail_log:    patch.failLog ?? null,
      node_done:   patch.nodeDone,
      updated_at:  new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function listTeamRuns(orgIds: string[], limit = 100): Promise<OrgRunRow[]> {
  if (!orgIds.length) return []
  const { data, error } = await supabase
    .from('org_workflow_runs')
    .select('*')
    .in('org_id', orgIds)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as OrgRunRow[]
}
