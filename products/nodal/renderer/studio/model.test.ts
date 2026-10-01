// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  approvedReferenceAssets, characterReferences, newProject, newShot, parseStoryboard, patchCandidate, pendingCandidates,
  shotImageRun, stageReady, takeRun, videoSize, boardSize, shotImageSize, type Candidate, type StudioProject,
} from './model'

const done = (hash: string): Candidate => ({ id: `c-${hash}`, status: 'done', asset: { hash, path: `p/${hash}.png`, mediaType: 'image/png' }, template: 't', prompt: '', seed: 1, createdAt: 0 })
const project = (): StudioProject => ({ ...newProject('테스트', '16:9', '옥상의 밤', 'cinematic'), id: 'p', createdAt: 0, updatedAt: 0 })

describe('stage gating', () => {
  it('needs an approved character reference before the storyboard', () => {
    const p = project()
    p.references = characterReferences('민준', 'a korean man in his twenties')
    expect(stageReady(p, 1).ok).toBe(false)
    p.references[0] = { ...p.references[0], candidates: [done('a1')], approvedId: 'c-a1' }
    expect(stageReady(p, 1)).toMatchObject({ ok: true })
    expect(approvedReferenceAssets(p, 'character').map((a) => a.hash)).toEqual(['a1'])
  })

  it('needs every shot to have an image prompt, then an approved image, then a chosen take', () => {
    const p = project()
    expect(stageReady(p, 2).ok).toBe(false)
    p.shots = [newShot({ imagePrompt: 'x' }), newShot()]
    expect(stageReady(p, 2).reason).toContain('샷 2')
    p.shots[1].imagePrompt = 'y'
    expect(stageReady(p, 2).ok).toBe(true)
    expect(stageReady(p, 3).ok).toBe(false)
    p.shots = p.shots.map((s, i) => ({ ...s, images: [done(`i${i}`)], imageId: `c-i${i}` }))
    expect(stageReady(p, 3).ok).toBe(true)
    expect(stageReady(p, 4).reason).toContain('샷 1')
  })
})

describe('sizes follow the engine rules', () => {
  it('images are multiples of 16 and H3 video multiples of 32 within 256..1920', () => {
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      for (const s of [shotImageSize(aspect), boardSize(aspect)]) {
        expect(s.width % 16).toBe(0)
        expect(s.height % 16).toBe(0)
      }
      for (const q of ['standard', 'high'] as const) {
        const v = videoSize(aspect, q)
        for (const d of [v.width, v.height]) {
          expect(d % 32).toBe(0)
          expect(d).toBeGreaterThanOrEqual(256)
          expect(d).toBeLessThanOrEqual(1920)
        }
      }
    }
  })
})

describe('run arguments', () => {
  it('uses FLUX.2 multi-reference with the approved character images (cycled to four)', () => {
    const p = project()
    p.references = characterReferences('민준', 'a man').map((r, i) => (i < 2 ? { ...r, candidates: [done(`r${i}`)], approvedId: `c-r${i}` } : r))
    const shot = newShot({ imagePrompt: 'on a rooftop at night', camera: 'medium shot' })
    const run = shotImageRun(p, shot, { flux2: true }, 5)
    expect(run.template).toBe('flux2_klein_multi_reference')
    expect([1, 2, 3, 4].map((i) => run.args[`reference_${i}`])).toEqual(['asset:r0', 'asset:r1', 'asset:r0', 'asset:r1'])
    expect(run.args).toMatchObject({ width: 1280, height: 720, seed: 5 })
    expect(String(run.args.prompt)).toContain('on a rooftop at night, medium shot, cinematic')
    // FLUX.2 가 없으면 글만으로.
    expect(shotImageRun(p, shot, { flux2: false }).template).toBe('zimage_txt2img')
  })

  it('starts a take from the approved shot image and refuses without one', () => {
    const p = project()
    const shot = newShot({ imagePrompt: 'x', motionPrompt: 'he turns and walks away' })
    expect(takeRun(p, shot)).toBeNull()
    const run = takeRun(p, { ...shot, images: [done('img')], imageId: 'c-img' }, 3)!
    expect(run.template).toBe('h3_image_video')
    expect(run.args).toMatchObject({ source: 'asset:img', width: 512, height: 288, steps: 16, seed: 3 })
  })
})

describe('candidates', () => {
  it('finds pending runs across stages and patches them in place', () => {
    const p = project()
    const running: Candidate = { id: 'k', status: 'running', runId: 'run1', template: 't', prompt: '', seed: 0, createdAt: 0 }
    p.shots = [newShot({ takes: [running] })]
    expect(pendingCandidates(p)).toEqual([{ candidate: running, subdir: 'takes', name: 'shot01' }])
    const next = patchCandidate(p, 'k', { status: 'done', asset: { hash: 'h', path: 'x', mediaType: 'video/webm' } })
    expect(next.shots[0].takes[0].status).toBe('done')
    expect(p.shots[0].takes[0].status).toBe('running')   // 원본은 그대로
    expect(pendingCandidates(next)).toEqual([])
  })
})

describe('parseStoryboard', () => {
  it('reads a JSON array even with prose or fences around it, and drops shots without an image prompt', () => {
    const text = '여기 초안입니다:\n```json\n[{"title":"도착","description":"그가 옥상에 온다","durationSec":5,"camera":"wide","imagePrompt":"a man on a rooftop","motionPrompt":"walks in"},{"title":"빈 샷"}]\n```'
    const shots = parseStoryboard(text)
    expect(shots).toHaveLength(1)
    expect(shots[0]).toMatchObject({ title: '도착', durationSec: 5, imagePrompt: 'a man on a rooftop' })
    expect(() => parseStoryboard('no json here')).toThrow()
  })
})

describe('demo project', () => {
  it('is ready to generate: a character (four views) and a location, and a storyboard that passes stage 2', async () => {
    const { demoProject } = await import('./demo')
    const p = { ...demoProject(), id: 'd', createdAt: 0, updatedAt: 0 }
    expect(p.references.filter((r) => r.kind === 'character')).toHaveLength(4)
    expect(p.references.filter((r) => r.kind === 'location')).toHaveLength(1)
    expect(p.references.every((r) => r.prompt.length > 20)).toBe(true)
    expect(p.shots).toHaveLength(5)
    expect(stageReady(p, 2).ok).toBe(true)
    expect(p.shots.every((s) => s.motionPrompt && s.camera && s.description)).toBe(true)
  })
})

describe('retry', () => {
  it('keeps the exact request on a candidate so a failed one can be rerun with the same settings', async () => {
    const { candidateFrom } = await import('./model')
    const c = candidateFrom({ template: 'h3_image_video', args: { source: 'asset:img', seed: 3 }, prompt: 'walk', seed: 3 }, 'run-1')
    expect(c.request).toEqual({ template: 'h3_image_video', args: { source: 'asset:img', seed: 3 } })
  })
})
