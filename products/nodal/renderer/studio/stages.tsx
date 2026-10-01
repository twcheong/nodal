// 스튜디오의 다섯 단계 화면. 상태는 useStudio 가 갖고, 여기는 그리기와 사용자 입력만.
import { useEffect, useState } from 'react'
import { Button } from '../../../../src/components/ui/Button'
import { Input } from '../../../../src/components/ui/Input'
import { Textarea } from '../../../../src/components/ui/Textarea'
import { ENGINE_URL } from '../../engineConfig'
import { assetUrl } from '../engineApi'
import { askModel, studioApi } from './api'
import { DEMO_STYLE, DEMO_SYNOPSIS, demoReferences, demoShots } from './demo'
import {
  boardRun, characterReferences, chosen, locationReference, newShot, parseStoryboard, referenceRun, shotImageRun,
  storyboardPrompt, takeRun, totalDuration, type Candidate, type Reference, type RunRequest, type Shot, type StudioProject,
} from './model'
import { AssetView, CandidateGrid, Field, card, label, muted } from './ui'
import type { Packs } from './useStudio'

export interface StageProps {
  project: StudioProject
  packs: Packs
  update: (fn: (p: StudioProject) => StudioProject) => void
  submit: (req: RunRequest | null, attach: (p: StudioProject, c: Candidate) => StudioProject) => Promise<void>
  setError: (message: string | null) => void
  retry: (candidate: Candidate) => Promise<void>
}

const mapRef = (p: StudioProject, id: string, fn: (r: Reference) => Reference): StudioProject =>
  ({ ...p, references: p.references.map((r) => (r.id === id ? fn(r) : r)) })
const mapShot = (p: StudioProject, id: string, fn: (s: Shot) => Shot): StudioProject =>
  ({ ...p, shots: p.shots.map((s) => (s.id === id ? fn(s) : s)) })

// ── ① 기준 이미지 ───────────────────────────────────────────────────────────

export function StageReferences({ project, update, submit, setError, retry }: StageProps) {
  const [kind, setKind] = useState<'character' | 'location'>('character')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')

  const add = () => {
    if (!name.trim() || !desc.trim()) return
    const refs = kind === 'character' ? characterReferences(name.trim(), desc) : [locationReference(name.trim(), desc)]
    update((p) => ({ ...p, references: [...p.references, ...refs] }))
    setName(''); setDesc('')
  }
  const generate = (ref: Reference, count = 1) => {
    for (let i = 0; i < count; i++) void submit(referenceRun(project, ref), (p, c) => mapRef(p, ref.id, (r) => ({ ...r, candidates: [...r.candidates, c] })))
  }
  const importPhotos = async (ref: Reference) => {
    try {
      const assets = await studioApi.importImages(project.id, 'references')
      if (!assets.length) return
      const cands: Candidate[] = assets.map((a) => ({ id: Math.random().toString(36).slice(2, 10), status: 'done', asset: a, template: 'import', prompt: '가져온 사진', seed: 0, createdAt: Date.now() }))
      update((p) => mapRef(p, ref.id, (r) => ({ ...r, candidates: [...r.candidates, ...cands], approvedId: r.approvedId ?? cands[0].id })))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  const groups = new Map<string, Reference[]>()
  for (const r of project.references) {
    const key = r.kind === 'character' ? r.label.split(' · ')[0] : r.label
    groups.set(key, [...(groups.get(key) ?? []), r])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant={kind === 'character' ? 'primary' : 'ghost'} onClick={() => setKind('character')}>인물 추가</Button>
          <Button size="sm" variant={kind === 'location' ? 'primary' : 'ghost'} onClick={() => setKind('location')}>장소 추가</Button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: 8, alignItems: 'end' }}>
          <Field title="이름"><Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'character' ? '민준' : '옥상'} /></Field>
          <Field title={kind === 'character' ? '외모·의상 (영어가 잘 듣습니다)' : '장소 설명'}>
            <Input size="sm" value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder={kind === 'character' ? 'a korean man in his twenties, short black hair, black leather jacket' : 'a seoul rooftop at night with neon signs'} />
          </Field>
          <Button size="sm" variant="primary" disabled={!name.trim() || !desc.trim()} onClick={add}>추가</Button>
        </div>
        <div style={muted}>인물은 얼굴 · 전신 정면 · 측면 · 의상 네 장을 기준으로 만듭니다. 각 칸에서 마음에 드는 후보를 눌러 승인하세요. 가진 사진을 쓰려면 "사진 가져오기".</div>
      </div>

      {[...groups.entries()].map(([group, refs]) => (
        <div key={group} style={card}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{group}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
            {refs.map((ref) => (
              <div key={ref.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{ref.kind === 'character' ? ref.label.split(' · ')[1] : '장소'}</span>
                  {ref.approvedId && <span style={{ fontSize: 11, color: 'var(--success, #1f9d55)' }}>✓ 승인</span>}
                  <span style={{ flex: 1 }} />
                  <button type="button" onClick={() => update((p) => ({ ...p, references: p.references.filter((r) => r.id !== ref.id) }))}
                    style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>삭제</button>
                </div>
                <Textarea size="sm" rows={2} value={ref.prompt} onChange={(e) => update((p) => mapRef(p, ref.id, (r) => ({ ...r, prompt: e.target.value })))} />
                <CandidateGrid onRetry={(c) => void retry(c)} items={ref.candidates} selectedId={ref.approvedId} size={96}
                  onPick={(c) => update((p) => mapRef(p, ref.id, (r) => ({ ...r, approvedId: r.approvedId === c.id ? null : c.id })))} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button size="sm" onClick={() => generate(ref)}>생성</Button>
                  <Button size="sm" variant="ghost" onClick={() => generate(ref, 3)}>후보 3장</Button>
                  <Button size="sm" variant="ghost" onClick={() => void importPhotos(ref)}>사진 가져오기</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!project.references.length && (
        <div style={{ ...card, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <span style={{ ...muted, flex: 1 }}>아직 기준이 없습니다. 위에서 인물부터 추가하거나, 예시로 채워 바로 "생성" 을 눌러 보세요.</span>
          <Button size="sm" variant="primary" onClick={() => update((p) => ({ ...p, references: demoReferences() }))}>예시 인물·장소 넣기</Button>
        </div>
      )}
    </div>
  )
}

// ── ② 스토리보드 ────────────────────────────────────────────────────────────

export function StageStoryboard({ project, update, submit, setError, retry }: StageProps) {
  const [count, setCount] = useState(6)
  const [drafting, setDrafting] = useState(false)
  const [playing, setPlaying] = useState(false)

  const draft = async () => {
    if (project.shots.length && !confirm('지금 샷 목록을 AI 초안으로 바꿀까요?')) return
    setDrafting(true); setError(null)
    try {
      const shots = parseStoryboard(await askModel(storyboardPrompt(project, count)))
      update((p) => ({ ...p, shots }))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setDrafting(false) }
  }
  const move = (i: number, d: -1 | 1) => update((p) => {
    const shots = [...p.shots]
    const j = i + d
    if (j < 0 || j >= shots.length) return p
    ;[shots[i], shots[j]] = [shots[j], shots[i]]
    return { ...p, shots }
  })
  const board = (shot: Shot) => void submit(boardRun(project, shot), (p, c) => mapShot(p, shot.id, (s) => ({ ...s, board: [...s.board, c], boardId: c.id })))
  const boardAll = () => project.shots.filter((s) => s.imagePrompt.trim()).forEach(board)
  const set = (id: string, patch: Partial<Shot>) => update((p) => mapShot(p, id, (s) => ({ ...s, ...patch })))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 12 }}>
          <Field title="줄거리 · 분위기"><Textarea size="sm" rows={4} value={project.synopsis} onChange={(e) => update((p) => ({ ...p, synopsis: e.target.value }))} placeholder="비 오는 밤, 옥상에서 헤어진 연인을 기다리는 남자. 마지막에 전화가 온다." /></Field>
          <Field title="화풍 (모든 이미지에 붙습니다)"><Textarea size="sm" rows={4} value={project.style} onChange={(e) => update((p) => ({ ...p, style: e.target.value }))} placeholder="cinematic film still, 35mm, moody lighting" /></Field>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button size="sm" variant="primary" disabled={drafting} onClick={() => void draft()}>{drafting ? 'AI 가 쓰는 중…' : 'AI 로 샷 초안 쓰기'}</Button>
          <span style={muted}>샷</span>
          <Input size="sm" type="number" min={2} max={20} value={count} onChange={(e) => setCount(Math.max(2, Math.min(20, Number(e.target.value) || 6)))} style={{ width: 64 }} />
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={() => update((p) => ({ ...p, shots: [...p.shots, newShot()] }))}>샷 추가</Button>
          <Button size="sm" disabled={!project.shots.length} onClick={boardAll}>콘티 전부 그리기</Button>
          <Button size="sm" disabled={!project.shots.some((s) => chosen(s.board, s.boardId))} onClick={() => setPlaying(true)}>이어 보기 ({totalDuration(project)}초)</Button>
        </div>
      </div>

      {!project.shots.length && (
        <div style={{ ...card, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <span style={{ ...muted, flex: 1 }}>
            줄거리를 적고 "AI 로 샷 초안 쓰기" 를 누르거나, 예시 줄거리와 5개 샷으로 바로 시작해 보세요.
          </span>
          <Button size="sm" variant="primary" onClick={() => update((p) => ({
            ...p,
            synopsis: p.synopsis.trim() ? p.synopsis : DEMO_SYNOPSIS,
            style: p.style.trim() ? p.style : DEMO_STYLE,
            shots: demoShots(),
          }))}>예시 샷 넣기</Button>
        </div>
      )}
      {playing && <BoardPlayer project={project} onClose={() => setPlaying(false)} />}
      <Timeline project={project} />

      {project.shots.map((shot, i) => {
        const frame = chosen(shot.board, shot.boardId)
        return (
          <div key={shot.id} style={{ ...card, flexDirection: 'row', gap: 14 }}>
            <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>샷 {i + 1}</div>
              <div style={{ aspectRatio: project.aspect.replace(':', ' / '), background: 'var(--bg-base)', borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {frame?.asset ? <img src={assetUrl(ENGINE_URL, frame.asset.hash)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : shot.board.some((c) => c.status === 'running') ? <span style={muted}>그리는 중…</span> : <span style={muted}>콘티 없음</span>}
              </div>
              <CandidateGrid onRetry={(c) => void retry(c)} items={shot.board} selectedId={shot.boardId} size={44} onPick={(c) => set(shot.id, { boardId: c.id })} />
              <div style={{ display: 'flex', gap: 4 }}>
                <Button size="sm" disabled={!shot.imagePrompt.trim()} onClick={() => board(shot)}>콘티</Button>
                <Button size="sm" variant="ghost" onClick={() => move(i, -1)}>↑</Button>
                <Button size="sm" variant="ghost" onClick={() => move(i, 1)}>↓</Button>
                <Button size="sm" variant="ghost" onClick={() => update((p) => ({ ...p, shots: p.shots.filter((s) => s.id !== shot.id) }))}>삭제</Button>
              </div>
            </div>
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 90px', gap: 8, minWidth: 0 }}>
              <Field title="제목"><Input size="sm" value={shot.title} onChange={(e) => set(shot.id, { title: e.target.value })} /></Field>
              <Field title="길이(초)"><Input size="sm" type="number" min={2} max={10} value={shot.durationSec} onChange={(e) => set(shot.id, { durationSec: Math.max(2, Math.min(10, Number(e.target.value) || 4)) })} /></Field>
              <Field title="무슨 일이 일어나나" style={{ gridColumn: '1 / -1' }}><Input size="sm" value={shot.description} onChange={(e) => set(shot.id, { description: e.target.value })} /></Field>
              <Field title="카메라" style={{ gridColumn: '1 / -1' }}><Input size="sm" value={shot.camera} onChange={(e) => set(shot.id, { camera: e.target.value })} placeholder="medium shot, slow push in" /></Field>
              <Field title="장면 (샷 이미지 프롬프트)" style={{ gridColumn: '1 / -1' }}><Textarea size="sm" rows={2} value={shot.imagePrompt} onChange={(e) => set(shot.id, { imagePrompt: e.target.value })} /></Field>
              <Field title="움직임 (영상 프롬프트)" style={{ gridColumn: '1 / -1' }}><Textarea size="sm" rows={2} value={shot.motionPrompt} onChange={(e) => set(shot.id, { motionPrompt: e.target.value })} /></Field>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 샷 길이 비율대로 콘티를 늘어놓은 임시 편집 막대. */
function Timeline({ project }: { project: StudioProject }) {
  const total = totalDuration(project)
  if (!project.shots.length || !total) return null
  return (
    <div style={{ display: 'flex', height: 54, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
      {project.shots.map((s, i) => {
        const frame = chosen(s.board, s.boardId)
        return (
          <div key={s.id} title={`샷 ${i + 1} · ${s.durationSec}초 · ${s.title}`} style={{
            flex: s.durationSec, position: 'relative', borderRight: '1px solid var(--border-subtle)', minWidth: 0,
            background: frame?.asset ? `center / cover no-repeat url(${assetUrl(ENGINE_URL, frame.asset.hash)})` : 'var(--bg-hover)',
          }}>
            <span style={{ position: 'absolute', left: 4, bottom: 3, fontSize: 10, color: '#fff', textShadow: '0 0 3px #000' }}>{i + 1} · {s.durationSec}s</span>
          </div>
        )
      })}
    </div>
  )
}

/** 콘티를 샷 길이만큼씩 넘겨 보는 임시 편집 재생. */
function BoardPlayer({ project, onClose }: { project: StudioProject; onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const shot = project.shots[index]
  useEffect(() => {
    if (!shot) { onClose(); return }
    const t = setTimeout(() => setIndex((i) => i + 1), (shot.durationSec || 4) * 1000)
    return () => clearTimeout(t)
  }, [shot, onClose])
  if (!shot) return null
  const frame = chosen(shot.board, shot.boardId)
  return (
    <div style={{ ...card, alignItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 720, aspectRatio: project.aspect.replace(':', ' / '), background: '#000', borderRadius: 8, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {frame?.asset ? <img src={assetUrl(ENGINE_URL, frame.asset.hash)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ color: '#aaa', fontSize: 13 }}>{shot.imagePrompt}</span>}
      </div>
      <div style={{ fontSize: 13 }}>샷 {index + 1} / {project.shots.length} · {shot.title} · {shot.durationSec}초 — {shot.description}</div>
      <Button size="sm" variant="ghost" onClick={onClose}>닫기</Button>
    </div>
  )
}

// ── ③ 샷 이미지 ─────────────────────────────────────────────────────────────

export function StageShots({ project, packs, update, submit, retry }: StageProps) {
  const generate = (shot: Shot, count = 1) => {
    for (let i = 0; i < count; i++) void submit(shotImageRun(project, shot, { flux2: packs.flux2 }), (p, c) => mapShot(p, shot.id, (s) => ({ ...s, images: [...s.images, c] })))
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...card, ...muted }}>
        {packs.flux2
          ? '승인한 인물 기준 이미지를 FLUX.2 Klein 레퍼런스로 넣어 얼굴·의상을 유지합니다. 샷마다 후보를 뽑고 하나를 눌러 승인하세요.'
          : '멀티 레퍼런스 팩(FLUX.2 Klein)이 없어 글만으로 만듭니다 — 인물이 샷마다 달라질 수 있습니다. 엔진 · 모델 탭에서 설치하면 기준 이미지를 그대로 씁니다.'}
      </div>
      {project.shots.map((shot, i) => (
        <div key={shot.id} style={{ ...card, flexDirection: 'row', gap: 14 }}>
          <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>샷 {i + 1} · {shot.title}</div>
            <div style={muted}>{shot.description}</div>
            <Textarea size="sm" rows={4} value={shot.imagePrompt} onChange={(e) => update((p) => mapShot(p, shot.id, (s) => ({ ...s, imagePrompt: e.target.value })))} />
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" onClick={() => generate(shot)}>생성</Button>
              <Button size="sm" variant="ghost" onClick={() => generate(shot, 3)}>후보 3장</Button>
            </div>
          </div>
          <CandidateGrid onRetry={(c) => void retry(c)} items={shot.images} selectedId={shot.imageId} size={200} empty="아직 후보가 없습니다."
            onPick={(c) => update((p) => mapShot(p, shot.id, (s) => ({ ...s, imageId: s.imageId === c.id ? null : c.id })))} />
        </div>
      ))}
    </div>
  )
}

// ── ④ 영상 ─────────────────────────────────────────────────────────────────

export function StageVideo({ project, packs, update, submit, retry }: StageProps) {
  const generate = (shot: Shot) => void submit(takeRun(project, shot), (p, c) => mapShot(p, shot.id, (s) => ({ ...s, takes: [...s.takes, c] })))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...card, ...muted }}>
        {packs.h3
          ? `승인한 샷 이미지를 첫 프레임으로 MiniMax H3 가 약 5초 영상을 만듭니다 (${project.quality === 'high' ? '고화질' : '표준'} 화질). 한 테이크에 몇 분 걸립니다 — 여러 개 걸어 두고 다른 일을 하셔도 됩니다.`
          : '영상 팩(MiniMax H3)이 설치되어 있지 않습니다. 엔진 · 모델 탭에서 설치해 주세요 (NVIDIA GPU 필요).'}
      </div>
      {project.shots.map((shot, i) => {
        const image = chosen(shot.images, shot.imageId)
        return (
          <div key={shot.id} style={{ ...card, flexDirection: 'row', gap: 14 }}>
            <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>샷 {i + 1} · {shot.title}</div>
              {image?.asset && <AssetView hash={image.asset.hash} mediaType={image.asset.mediaType} />}
              <Textarea size="sm" rows={3} value={shot.motionPrompt} onChange={(e) => update((p) => mapShot(p, shot.id, (s) => ({ ...s, motionPrompt: e.target.value })))} placeholder="움직임: he slowly turns toward the camera" />
              <Button size="sm" variant="primary" disabled={!packs.h3 || !image} onClick={() => generate(shot)}>테이크 생성</Button>
            </div>
            <CandidateGrid onRetry={(c) => void retry(c)} items={shot.takes} selectedId={shot.takeId} size={220} empty="아직 테이크가 없습니다. 마우스를 올리면 재생됩니다."
              onPick={(c) => update((p) => mapShot(p, shot.id, (s) => ({ ...s, takeId: s.takeId === c.id ? null : c.id })))} />
          </div>
        )
      })}
    </div>
  )
}

// ── ⑤ 편집 ─────────────────────────────────────────────────────────────────

export function StageEdit({ project, update, setError }: StageProps) {
  const takes = project.shots.map((s) => chosen(s.takes, s.takeId)).filter((c): c is Candidate => !!c?.asset)
  const [picked, setPlaying] = useState(0)
  const playing = takes.length ? Math.min(picked, takes.length - 1) : 0
  const latestExport = [...project.exports].reverse()[0]

  const exportAll = async () => {
    setError(null)
    try {
      const hashes = takes.map((t) => t.asset!.hash)
      const { runId } = await studioApi.concat(hashes)
      const c: Candidate = { id: Math.random().toString(36).slice(2, 10), status: 'running', runId, template: 'concat', prompt: `${hashes.length}개 샷`, seed: 0, createdAt: Date.now() }
      update((p) => ({ ...p, exports: [...p.exports, c] }))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={label}>이어 보기 — 고른 테이크를 순서대로</div>
        {takes.length ? (
          <>
            <video key={takes[playing]?.id} src={assetUrl(ENGINE_URL, takes[playing]?.asset!.hash ?? '')} autoPlay controls
              onEnded={() => setPlaying((i) => (i + 1 < takes.length ? i + 1 : 0))}
              style={{ width: '100%', maxHeight: 460, background: '#000', borderRadius: 8 }} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {takes.map((t, i) => (
                <Button key={t.id} size="sm" variant={i === playing ? 'primary' : 'ghost'} onClick={() => setPlaying(i)}>샷 {i + 1}</Button>
              ))}
            </div>
          </>
        ) : <div style={muted}>고른 테이크가 없습니다. ④ 영상 단계에서 샷마다 하나씩 골라 주세요.</div>}
      </div>
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button size="sm" variant="primary" disabled={takes.length !== project.shots.length || project.exports.some((e) => e.status === 'running')} onClick={() => void exportAll()}>
            한 편으로 내보내기
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void studioApi.reveal(project.id)}>프로젝트 폴더 열기</Button>
          <span style={muted}>고른 테이크 {takes.length}/{project.shots.length} · 결과는 projects/{project.id}/export 에 저장됩니다</span>
        </div>
        {latestExport?.status === 'running' && <div style={muted}>이어 붙이는 중…</div>}
        {latestExport?.status === 'failed' && <div style={{ ...muted, color: 'var(--danger, #b42318)' }}>내보내기 실패 — {latestExport.error}</div>}
        {latestExport?.status === 'done' && latestExport.asset && (
          <>
            <AssetView hash={latestExport.asset.hash} mediaType={latestExport.asset.mediaType} style={{ maxHeight: 460 }} />
            <div style={muted}>{latestExport.asset.path}</div>
          </>
        )}
      </div>
    </div>
  )
}
