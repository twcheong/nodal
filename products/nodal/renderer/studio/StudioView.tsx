// 스튜디오 탭 — 영상 제작 워크플로 1번(기준 이미지 → 스토리보드 → 샷 이미지 → 영상 → 편집)을 단계형으로.
// 채팅·노드 탭은 무엇이든 할 수 있는 도구이고, 여기는 정해진 한 흐름을 편하게 밟는 화면이다.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../src/components/ui/Button'
import { Input } from '../../../../src/components/ui/Input'
import { SegmentedControl } from '../../../../src/components/ui/SegmentedControl'
import { Spinner } from '../../../../src/components/ui/Spinner'
import type { ProductViewProps } from '../../../../src/lib/productShell'
import { EngineNotice, useEngineStatus } from '../useEngineStatus'
import { studioApi, type ProjectSummary } from './api'
import { STAGES, newProject, stageReady, type Aspect, type StageNo } from './model'
import { demoProject } from './demo'
import { StageEdit, StageReferences, StageShots, StageStoryboard, StageVideo } from './stages'
import { card, muted } from './ui'
import { useStudio } from './useStudio'

const LAST_KEY = 'nodal.studio.lastProject'

export function StudioView({ active }: ProductViewProps) {
  const { status, refresh } = useEngineStatus(active)
  const [openId, setOpenId] = useState<string | null>(() => { try { return localStorage.getItem(LAST_KEY) } catch { return null } })
  const open = useCallback((id: string | null) => {
    setOpenId(id)
    try { if (id) localStorage.setItem(LAST_KEY, id); else localStorage.removeItem(LAST_KEY) } catch { /* 막힘 */ }
  }, [])

  if (!status?.running) return <EngineNotice status={status} onRetry={() => void refresh()} />
  return openId ? <ProjectScreen key={openId} id={openId} onClose={() => open(null)} /> : <ProjectList onOpen={open} />
}

function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [name, setName] = useState('')
  const [aspect, setAspect] = useState<Aspect>('16:9')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { studioApi.list().then(setProjects).catch((err: unknown) => setError(String(err))) }, [])

  const create = async () => {
    if (!name.trim()) return
    try { onOpen((await studioApi.create(newProject(name, aspect))).id) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  const createDemo = async () => {
    try { onOpen((await studioApi.create(demoProject())).id) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px', maxWidth: 900 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600 }}>스튜디오</h2>
      <p style={{ ...muted, margin: '0 0 24px', fontSize: 13 }}>
        캐릭터·장소 기준 이미지 → 스토리보드 → 샷별 완성 이미지 → 영상 → 편집. 같은 인물이 반복 등장하는 단편·뮤직비디오를 단계별로 만듭니다.
        단계마다 승인해야 다음으로 넘어가고, 승인한 자료는 워크스페이스의 projects 폴더에 보관됩니다.
      </p>
      {error && <div style={{ ...muted, color: 'var(--danger, #b42318)', marginBottom: 12 }}>{error}</div>}
      <div style={{ ...card, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 14, borderColor: 'var(--accent)' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>처음이라면 데모로 시작해 보세요</div>
          <div style={muted}>인물(민준)·장소(서울 옥상)·줄거리·화풍·5개 샷이 채워진 짧은 뮤직비디오 프로젝트입니다. 단계마다 "생성" 과 승인만 누르며 끝까지 가 볼 수 있습니다.</div>
        </div>
        <Button size="sm" variant="primary" onClick={() => void createDemo()}>데모로 시작</Button>
      </div>
      <div style={{ ...card, marginBottom: 24 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>새 프로젝트</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} placeholder="프로젝트 이름 (예: 옥상의 밤 MV)" style={{ flex: 1 }} />
          <SegmentedControl<Aspect> value={aspect} onChange={setAspect} options={[{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }]} />
          <Button size="sm" variant="primary" disabled={!name.trim()} onClick={() => void create()}>만들기</Button>
        </div>
      </div>
      {!projects ? <Spinner size={16} /> : projects.length === 0 ? <div style={muted}>아직 프로젝트가 없습니다.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projects.map((p) => (
            <button key={p.id} type="button" onClick={() => onOpen(p.id)} style={{ ...card, flexDirection: 'row', alignItems: 'center', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)', color: 'var(--text-primary)' }}>
              <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{p.name}</span>
              <span style={muted}>{STAGES[Math.min(4, Math.max(0, p.stage - 1))].title} 단계</span>
              <span style={muted}>{new Date(p.updatedAt).toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectScreen({ id, onClose }: { id: string; onClose: () => void }) {
  const { project, error, setError, packs, update, submit, retry } = useStudio(id)
  const [view, setView] = useState<StageNo | null>(null)   // 지금 보는 단계 — 기본은 프로젝트가 도달한 단계

  if (error && !project) return <div style={{ padding: 40, ...muted, color: 'var(--danger, #b42318)' }}>{error} <Button size="sm" variant="ghost" onClick={onClose}>목록으로</Button></div>
  if (!project) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={16} /></div>

  const current = view ?? project.stage
  const ready = stageReady(project, current)
  const props = { project, packs, update, submit, setError, retry }
  const running = [project.references.flatMap((r) => r.candidates), project.shots.flatMap((s) => [...s.board, ...s.images, ...s.takes]), project.exports]
    .flat(2).filter((c) => c.status === 'running').length

  const advance = () => {
    if (!ready.ok || current >= 5) return
    const next = (current + 1) as StageNo
    update((p) => ({ ...p, stage: Math.max(p.stage, next) as StageNo }))
    setView(next)
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 24px', borderBottom: '1px solid var(--border-subtle)' }}>
        <Button size="sm" variant="ghost" onClick={onClose}>← 프로젝트</Button>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{project.name}</span>
        <span style={muted}>{project.aspect}</span>
        <span style={{ flex: 1 }} />
        {running > 0 && <span style={{ ...muted, display: 'flex', alignItems: 'center', gap: 6 }}><Spinner size={12} />생성 중 {running}개</span>}
        <span style={muted}>영상 화질</span>
        <SegmentedControl<'standard' | 'high'> value={project.quality} onChange={(q) => update((p) => ({ ...p, quality: q }))}
          options={[{ value: 'standard', label: '표준' }, { value: 'high', label: '고화질' }]} />
        <Button size="sm" variant="ghost" onClick={() => void studioApi.reveal(project.id)}>폴더 열기</Button>
      </div>

      {/* 단계 막대 — 도달한 단계까지만 누를 수 있다 */}
      <div style={{ display: 'flex', gap: 4, padding: '12px 24px', borderBottom: '1px solid var(--border-subtle)' }}>
        {STAGES.map((s) => {
          const reached = s.no <= project.stage
          const done = s.no < project.stage
          const on = s.no === current
          return (
            <button key={s.no} type="button" disabled={!reached} onClick={() => setView(s.no)} style={{
              flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 'var(--radius-md)',
              border: on ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
              background: on ? 'var(--accent-dim)' : 'transparent', cursor: reached ? 'pointer' : 'not-allowed',
              opacity: reached ? 1 : 0.45, fontFamily: 'var(--font-sans)', color: 'var(--text-primary)', textAlign: 'left',
            }}>
              <span style={{
                width: 22, height: 22, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                background: done ? 'var(--success, #1f9d55)' : on ? 'var(--accent)' : 'var(--bg-hover)', color: done || on ? '#fff' : 'var(--text-muted)',
              }}>{done ? '✓' : s.no}</span>
              <span style={{ fontSize: 12, fontWeight: on ? 600 : 400 }}>{s.title}</span>
            </button>
          )
        })}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        <p style={{ ...muted, margin: '0 0 16px', fontSize: 13 }}>{STAGES[current - 1].hint}</p>
        {error && (
          <div style={{ ...card, borderColor: 'var(--danger, #b42318)', color: 'var(--danger, #b42318)', fontSize: 12, marginBottom: 16, flexDirection: 'row', alignItems: 'center' }}>
            <span style={{ flex: 1 }}>{error}</span><Button size="sm" variant="ghost" onClick={() => setError(null)}>닫기</Button>
          </div>
        )}
        {current === 1 && <StageReferences {...props} />}
        {current === 2 && <StageStoryboard {...props} />}
        {current === 3 && <StageShots {...props} />}
        {current === 4 && <StageVideo {...props} />}
        {current === 5 && <StageEdit {...props} />}
      </div>

      {current < 5 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 24px', borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ ...muted, flex: 1, color: ready.ok ? 'var(--text-muted)' : 'var(--warning, #c47f00)' }}>{ready.reason ?? '준비됐습니다.'}</span>
          <Button size="sm" variant="primary" disabled={!ready.ok} onClick={advance}>승인하고 {STAGES[current].title}(으)로 →</Button>
        </div>
      )}
    </div>
  )
}
