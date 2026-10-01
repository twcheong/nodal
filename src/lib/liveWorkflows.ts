// ─────────────────────────────────────────────────────────────────────────────
// liveWorkflows.ts — 팀 실시간 공동편집 문서. (US-R1-04, 가벼운 버전)
//
// "함께 편집" 켠 워크플로는 Supabase live_workflows 행이 진실. org 멤버 누구나
// read/write, Realtime UPDATE 로 변경 전파. 충돌 = LWW(마지막 저장 이김).
// 렌더러-직접(orgMembers/sharedWorkflows 와 동일). 백엔드 = supabase/live_workflows.sql
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase'

export interface LiveWorkflowRow {
  id:            string
  org_id:        string
  title:         string | null
  workflow_json: TwixyWorkflow
  updated_at:    string
  updated_by:    string | null
  created_by:    string | null
}

// 로컬 워크플로를 라이브(공동편집) 문서로 승격.
export async function createLiveWorkflow(orgId: string, wf: TwixyWorkflow, userId: string): Promise<LiveWorkflowRow> {
  const { data, error } = await supabase.from('live_workflows')
    .insert({ org_id: orgId, title: wf.title, workflow_json: wf, created_by: userId, updated_by: userId })
    .select().single()
  if (error) throw new Error(error.message)
  return data as LiveWorkflowRow
}

export async function getLiveWorkflow(id: string): Promise<LiveWorkflowRow | null> {
  const { data, error } = await supabase.from('live_workflows').select('*').eq('id', id).maybeSingle()
  if (error || !data) return null
  return data as LiveWorkflowRow
}

// 전체 json 저장(LWW). updated_by 로 자기 에코 구분.
export async function pushLiveWorkflow(id: string, wf: TwixyWorkflow, userId: string): Promise<void> {
  const { error } = await supabase.from('live_workflows')
    .update({ workflow_json: wf, title: wf.title, updated_by: userId, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

// org 의 라이브 문서 목록("함께 편집 중").
export async function listLiveWorkflows(orgIds: string[]): Promise<LiveWorkflowRow[]> {
  if (!orgIds.length) return []
  const { data, error } = await supabase.from('live_workflows')
    .select('*').in('org_id', orgIds).order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as LiveWorkflowRow[]
}

// 라이브 종료(생성자/admin) — 서버 문서 삭제. 각자 로컬 사본은 남음.
export async function deleteLiveWorkflow(id: string): Promise<void> {
  const { error } = await supabase.from('live_workflows').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// 팀원이 라이브 문서에 참여 — 현재 스냅샷을 로컬 사본으로 만들고 liveId 를 걸어
// 그때부터 편집기가 같은 라이브 문서를 구독/동기화하게 한다. 반환 = 새 로컬 wf id.
export async function joinLiveWorkflow(row: LiveWorkflowRow): Promise<string | null> {
  const wf = row.workflow_json
  const created = await window.twixy.workflowCreate({
    title: wf.title, description: wf.description, prompt: wf.prompt,
    inputs: wf.inputs, type: wf.type, outputDir: wf.outputDir, nodes: wf.nodes,
  })
  if (created?.id) await window.twixy.workflowUpdate(created.id, { liveId: row.id })
  return created?.id ?? null
}
