// 열린 프로젝트 하나의 상태 — 읽기·저장·생성 제출·기다리기.
//
// 저장: 바꿀 때마다 곧바로(짧게 모아서) project.json 에 쓴다. 생성 결과가 들어오는 것도 바꿈이다.
// 기다리기: running 후보마다 엔진 실행을 물어, 끝나면 결과 에셋을 프로젝트 폴더로 가져와(studio-keep)
// 후보에 붙인다. 앱을 껐다 켜도 running 으로 남은 후보는 다시 물어 이어받는다 (엔진이 살아 있으면).
import { useCallback, useEffect, useRef, useState } from 'react'
import { engineApi } from '../engineApi'
import { studioApi } from './api'
import { candidateFrom, patchCandidate, pendingCandidates, type Candidate, type RunRequest, type StudioProject } from './model'

const SAVE_DEBOUNCE_MS = 400
const POLL_MS = 3000

export interface Packs { flux2: boolean; h3: boolean; imageBase: boolean }

export function useStudio(projectId: string) {
  const [project, setProject] = useState<StudioProject | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [packs, setPacks] = useState<Packs>({ flux2: false, h3: false, imageBase: false })
  const latest = useRef<StudioProject | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflight = useRef(new Set<string>())   // 가져오는 중인 후보 — 같은 결과를 두 번 저장하지 않게

  useEffect(() => {
    let cancelled = false
    setProject(null)
    studioApi.load(projectId)
      .then((p) => { if (!cancelled) { latest.current = p; setProject(p) } })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    engineApi.setup.status()
      .then((s) => {
        const on = (id: string) => !!s.packs.find((p) => p.id === id)?.installed
        if (!cancelled) setPacks({ flux2: on('flux2-klein'), h3: on('video-h3'), imageBase: on('image-base') })
      })
      .catch(() => { /* 앱 밖 */ })
    return () => { cancelled = true }
  }, [projectId])

  const flush = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    const p = latest.current
    if (p) void studioApi.save(p).catch((err: unknown) => setError(`저장 실패: ${err instanceof Error ? err.message : String(err)}`))
  }, [])

  /** 프로젝트를 바꾼다 (불변 갱신). 저장은 잠깐 모았다가. */
  const update = useCallback((fn: (p: StudioProject) => StudioProject) => {
    const cur = latest.current
    if (!cur) return
    const next = fn(cur)
    latest.current = next
    setProject(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }, [flush])

  useEffect(() => () => flush(), [flush])   // 탭을 떠날 때 남은 저장

  /**
   * 생성 하나를 제출하고, 후보를 `attach` 가 정한 목록에 넣는다. 실패하면 화면에 알리고 아무것도 넣지 않는다.
   */
  const submit = useCallback(async (req: RunRequest | null, attach: (p: StudioProject, c: ReturnType<typeof candidateFrom>) => StudioProject) => {
    if (!req) return
    setError(null)
    try {
      const { runId } = await studioApi.run(req.template, req.args)
      update((p) => attach(p, candidateFrom(req, runId)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [update])

  /** 실패한 후보를 같은 설정으로 다시 — 그 자리(같은 후보)에서 다시 생성 중이 된다. */
  const retry = useCallback(async (candidate: Candidate) => {
    if (!candidate.request) return
    setError(null)
    try {
      const { runId } = await studioApi.run(candidate.request.template, candidate.request.args)
      update((p) => patchCandidate(p, candidate.id, { status: 'running', runId, error: undefined, asset: undefined }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [update])

  // 기다리는 후보 폴링.
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const p = latest.current
      if (p) {
        for (const { candidate, subdir, name } of pendingCandidates(p)) {
          if (inflight.current.has(candidate.id) || !candidate.runId) continue
          inflight.current.add(candidate.id)
          try {
            const { run, assets } = await engineApi.run(candidate.runId)
            if (run.status === 'succeeded') {
              const asset = assets[0]
              if (!asset) update((q) => patchCandidate(q, candidate.id, { status: 'failed', error: '결과 파일이 없습니다' }))
              else {
                const kept = await studioApi.keep(p.id, asset.hash, subdir, name)
                update((q) => patchCandidate(q, candidate.id, { status: 'done', asset: kept }))
              }
            } else if (run.status === 'failed' || run.status === 'cancelled') {
              const message = run.error?.message?.replace(/^nodes\.\S+?:\s/, '') ?? (run.status === 'cancelled' ? '취소됨' : '실패')
              update((q) => patchCandidate(q, candidate.id, { status: 'failed', error: message }))
            }
          } catch (err) {
            // 엔진이 재시작돼 실행 기록이 없으면 더 기다려도 오지 않는다.
            const message = err instanceof Error ? err.message : String(err)
            if (/404|run_not_found|그런 실행이 없다/.test(message)) update((q) => patchCandidate(q, candidate.id, { status: 'failed', error: '엔진이 작업 중 종료돼 이 실행을 잃었습니다 — 다시 시도해 주세요' }))
          } finally {
            inflight.current.delete(candidate.id)
          }
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [update])

  return { project, error, setError, packs, update, submit, retry }
}
