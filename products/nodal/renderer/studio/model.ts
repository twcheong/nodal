// 스튜디오 탭의 데이터 모델과 규칙 — 영상 제작 워크플로 1번을 단계(스테이지)로:
//   ① 기준 이미지(캐릭터 얼굴·전신·측면·의상, 장소) → ② 스토리보드(샷 목록·길이·콘티) →
//   ③ 샷 이미지(최종 비율, 얼굴·구도·조명 확정) → ④ 영상(샷 이미지를 첫 프레임으로 테이크 여러 개) →
//   ⑤ 편집(샷마다 테이크 고르기 → 이어 붙여 내보내기)
// 각 단계는 승인해야 다음 단계가 열린다 — "캐릭터·미술 승인 → 스토리보드 승인 → 샷 기준 이미지 승인 →
// 영상 생성 → 테이크 선택·편집" 순서를 화면이 강제한다.
//
// 여기는 순수 함수만 둔다 (React·IPC 없음). 엔진 템플릿 인자도 여기서 만든다 — 크기 규칙(H3 는 32 배수,
// 이미지는 16 배수)을 한 곳에 모아 테스트한다.

export type Aspect = '16:9' | '9:16' | '1:1'
export type StageNo = 1 | 2 | 3 | 4 | 5
export type Quality = 'standard' | 'high'

/** 프로젝트 폴더 안의 파일 + 엔진 에셋 해시 (템플릿 입력에는 asset:<hash> 로 넘긴다). */
export interface Asset { hash: string; path: string; mediaType: string }

/** 생성 결과 후보 하나 — 엔진 실행 하나와 1:1. running 이면 아직 기다리는 중. */
export interface Candidate {
  id: string
  status: 'running' | 'done' | 'failed'
  runId?: string
  asset?: Asset
  error?: string
  template: string
  prompt: string
  seed: number
  createdAt: number
  /** 이 후보를 만든 요청 — 실패하면 같은 설정으로 다시 돌린다. 가져온 사진·내보내기에는 없다. */
  request?: { template: string; args: Record<string, unknown> }
}

export interface Reference {
  id: string
  kind: 'character' | 'location'
  /** 무엇의 어느 면인가 — "민준 · 얼굴", "옥상 · 밤" */
  label: string
  /** 생성 프롬프트 (영어가 잘 듣는다). 사진을 가져온 기준이면 비어 있어도 된다. */
  prompt: string
  candidates: Candidate[]
  approvedId: string | null
}

export interface Shot {
  id: string
  title: string
  /** 무슨 일이 일어나는가 (사람이 읽는 설명). */
  description: string
  durationSec: number
  camera: string
  /** 샷 이미지(③) 프롬프트 — 인물·구도·조명. */
  imagePrompt: string
  /** 영상(④) 프롬프트 — 움직임·카메라 이동. */
  motionPrompt: string
  board: Candidate[]
  boardId: string | null
  images: Candidate[]
  imageId: string | null
  takes: Candidate[]
  takeId: string | null
}

export interface StudioProject {
  version: 1
  id: string
  name: string
  createdAt: number
  updatedAt: number
  aspect: Aspect
  quality: Quality
  /** 줄거리·분위기 — 스토리보드 초안의 재료. */
  synopsis: string
  /** 모든 이미지 프롬프트에 붙는 화풍 ("cinematic film still, 35mm, soft light" 등). */
  style: string
  stage: StageNo
  references: Reference[]
  shots: Shot[]
  exports: Candidate[]
}

export const STAGES: ReadonlyArray<{ no: StageNo; title: string; hint: string }> = [
  { no: 1, title: '기준 이미지', hint: '인물의 얼굴·전신·측면·의상과 주요 장소를 정하고 승인합니다.' },
  { no: 2, title: '스토리보드', hint: '샷을 나누고 길이를 정한 뒤, 콘티를 이어 보며 이야기와 길이를 확인합니다.' },
  { no: 3, title: '샷 이미지', hint: '각 샷을 최종 비율의 완성 이미지로 만들고 얼굴·구도·조명을 확정합니다.' },
  { no: 4, title: '영상', hint: '승인한 샷 이미지를 첫 프레임으로 움직임을 만듭니다. 테이크를 여러 개 뽑아 둡니다.' },
  { no: 5, title: '편집', hint: '샷마다 쓸 테이크를 고르고 순서대로 이어 한 편으로 내보냅니다.' },
]

export const newId = (): string => Math.random().toString(36).slice(2, 10)
export const randomSeed = (): number => Math.floor(Math.random() * 2_147_483_647)

export function newProject(name: string, aspect: Aspect, synopsis = '', style = ''): Omit<StudioProject, 'id' | 'createdAt' | 'updatedAt'> {
  return { version: 1, name: name.trim(), aspect, quality: 'standard', synopsis, style, stage: 1, references: [], shots: [], exports: [] }
}

/** 캐릭터 하나 = 기준 이미지 네 장 (워크플로 문서 ①: 얼굴·전신·측면과 의상). */
export const CHARACTER_VIEWS: ReadonlyArray<{ key: string; label: string; prompt: string }> = [
  { key: 'face', label: '얼굴', prompt: 'close-up portrait, facing camera, neutral expression' },
  { key: 'front', label: '전신 정면', prompt: 'full body, standing, front view' },
  { key: 'side', label: '측면', prompt: 'full body, side profile view' },
  { key: 'outfit', label: '의상', prompt: 'outfit detail, three-quarter view, clothing clearly visible' },
]

export function characterReferences(name: string, description: string): Reference[] {
  return CHARACTER_VIEWS.map((v) => ({
    id: newId(),
    kind: 'character' as const,
    label: `${name} · ${v.label}`,
    prompt: `character reference sheet of ${description.trim()}, ${v.prompt}, plain light grey studio background, even soft lighting, photorealistic`,
    candidates: [],
    approvedId: null,
  }))
}

export function locationReference(name: string, description: string): Reference {
  return {
    id: newId(), kind: 'location', label: name,
    prompt: `establishing shot of ${description.trim()}, no people, cinematic, detailed environment`,
    candidates: [], approvedId: null,
  }
}

export function newShot(partial: Partial<Shot> = {}): Shot {
  return {
    id: newId(), title: '', description: '', durationSec: 4, camera: '', imagePrompt: '', motionPrompt: '',
    board: [], boardId: null, images: [], imageId: null, takes: [], takeId: null,
    ...partial,
  }
}

export const chosen = (list: Candidate[], id: string | null): Candidate | undefined =>
  id ? list.find((c) => c.id === id && c.status === 'done' && c.asset) : undefined

export const approvedReferenceAssets = (p: StudioProject, kind?: Reference['kind']): Asset[] =>
  p.references
    .filter((r) => !kind || r.kind === kind)
    .map((r) => chosen(r.candidates, r.approvedId)?.asset)
    .filter((a): a is Asset => !!a)

export const totalDuration = (p: StudioProject): number => p.shots.reduce((n, s) => n + (s.durationSec || 0), 0)

/** 다음 단계로 넘어갈 수 있는가 — 안 되면 무엇이 모자란지 한 줄로. */
export function stageReady(p: StudioProject, stage: StageNo): { ok: boolean; reason?: string } {
  switch (stage) {
    case 1: {
      if (!approvedReferenceAssets(p, 'character').length) return { ok: false, reason: '승인한 인물 기준 이미지가 한 장 이상 필요합니다' }
      const pending = p.references.filter((r) => !r.approvedId).length
      return pending ? { ok: true, reason: `승인하지 않은 기준 ${pending}개는 빼고 진행합니다` } : { ok: true }
    }
    case 2: {
      if (!p.shots.length) return { ok: false, reason: '샷이 하나 이상 필요합니다' }
      const empty = p.shots.findIndex((s) => !s.imagePrompt.trim())
      if (empty >= 0) return { ok: false, reason: `샷 ${empty + 1} 의 장면(이미지 프롬프트)이 비어 있습니다` }
      return { ok: true }
    }
    case 3: {
      const missing = p.shots.findIndex((s) => !chosen(s.images, s.imageId))
      return missing >= 0 ? { ok: false, reason: `샷 ${missing + 1} 의 이미지를 승인해 주세요` } : { ok: true }
    }
    case 4: {
      const missing = p.shots.findIndex((s) => !chosen(s.takes, s.takeId))
      return missing >= 0 ? { ok: false, reason: `샷 ${missing + 1} 의 테이크를 골라 주세요` } : { ok: true }
    }
    case 5:
      return { ok: true }
  }
}

// ── 크기 ────────────────────────────────────────────────────────────────────
// 이미지 템플릿은 16 의 배수, H3 영상은 32 의 배수(256~1920)를 요구한다.

export function shotImageSize(aspect: Aspect): { width: number; height: number } {
  return aspect === '16:9' ? { width: 1280, height: 720 } : aspect === '9:16' ? { width: 720, height: 1280 } : { width: 1024, height: 1024 }
}

export function boardSize(aspect: Aspect): { width: number; height: number } {
  return aspect === '16:9' ? { width: 640, height: 368 } : aspect === '9:16' ? { width: 368, height: 640 } : { width: 512, height: 512 }
}

export function videoSize(aspect: Aspect, quality: Quality): { width: number; height: number } {
  const hi = quality === 'high'
  if (aspect === '16:9') return hi ? { width: 960, height: 544 } : { width: 512, height: 288 }
  if (aspect === '9:16') return hi ? { width: 544, height: 960 } : { width: 288, height: 512 }
  return hi ? { width: 768, height: 768 } : { width: 384, height: 384 }
}

// ── 템플릿 인자 ──────────────────────────────────────────────────────────────

export interface RunRequest { template: string; args: Record<string, unknown>; prompt: string; seed: number }

const withStyle = (p: StudioProject, prompt: string) => [prompt.trim(), p.style.trim()].filter(Boolean).join(', ')

export function referenceRun(p: StudioProject, ref: Reference, seed = randomSeed()): RunRequest {
  const size = ref.kind === 'character' ? { width: 768, height: 1024 } : shotImageSize(p.aspect)
  const prompt = withStyle(p, ref.prompt)
  return { template: 'zimage_txt2img', prompt, seed, args: { prompt, ...size, steps: 30, seed } }
}

export function boardRun(p: StudioProject, shot: Shot, seed = randomSeed()): RunRequest {
  const prompt = `storyboard frame, rough cinematic sketch, ${shot.imagePrompt.trim()}${shot.camera.trim() ? `, ${shot.camera.trim()}` : ''}`
  return { template: 'zimage_txt2img', prompt, seed, args: { prompt, ...boardSize(p.aspect), steps: 12, seed } }
}

/**
 * 샷 이미지 — FLUX.2 Klein 이 있으면 승인한 인물 기준 네 장을 레퍼런스로(정체성·의상 유지), 없으면
 * Z-Image 로 글만. 기준이 네 장보다 적으면 돌려 가며 채운다 (템플릿이 정확히 네 장을 받는다).
 */
export function shotImageRun(p: StudioProject, shot: Shot, opts: { flux2: boolean }, seed = randomSeed()): RunRequest {
  const size = shotImageSize(p.aspect)
  const prompt = withStyle(p, [shot.imagePrompt, shot.camera].filter((s) => s.trim()).join(', '))
  const refs = approvedReferenceAssets(p, 'character')
  if (opts.flux2 && refs.length) {
    const args: Record<string, unknown> = {
      prompt: `Use the exact same character, face and outfit from the reference images. ${prompt}`,
      transformer: 'FLUX.2-klein-4B-transformer',
      text_encoder: 'qwen_3_4b.safetensors',
      vae: 'FLUX.2-klein-4B-vae',
      ...size, steps: 4, seed,
    }
    for (let i = 0; i < 4; i++) args[`reference_${i + 1}`] = `asset:${refs[i % refs.length].hash}`
    return { template: 'flux2_klein_multi_reference', prompt, seed, args }
  }
  return { template: 'zimage_txt2img', prompt, seed, args: { prompt, ...size, steps: 30, seed } }
}

export function takeRun(p: StudioProject, shot: Shot, seed = randomSeed()): RunRequest | null {
  const image = chosen(shot.images, shot.imageId)?.asset
  if (!image) return null
  const prompt = [shot.motionPrompt, shot.camera].filter((s) => s.trim()).join(', ') || shot.description
  return {
    template: 'h3_image_video', prompt, seed,
    args: { source: `asset:${image.hash}`, prompt, ...videoSize(p.aspect, p.quality), steps: 16, seed },
  }
}

export function candidateFrom(req: RunRequest, runId: string): Candidate {
  return { id: newId(), status: 'running', runId, template: req.template, prompt: req.prompt, seed: req.seed, createdAt: Date.now(), request: { template: req.template, args: req.args } }
}

// ── 변경 (불변) ───────────────────────────────────────────────────────────────

/** 어느 목록에 있든 id 로 후보를 찾아 바꾼다. 프로젝트 전체를 새 객체로 돌려준다. */
export function patchCandidate(p: StudioProject, candidateId: string, patch: Partial<Candidate>): StudioProject {
  const fix = (list: Candidate[]) => (list.some((c) => c.id === candidateId) ? list.map((c) => (c.id === candidateId ? { ...c, ...patch } : c)) : list)
  return {
    ...p,
    references: p.references.map((r) => ({ ...r, candidates: fix(r.candidates) })),
    shots: p.shots.map((s) => ({ ...s, board: fix(s.board), images: fix(s.images), takes: fix(s.takes) })),
    exports: fix(p.exports),
  }
}

/** 기다리는 후보 전부 — 어디 있는지(프로젝트 폴더의 하위 폴더 이름)와 함께. */
export function pendingCandidates(p: StudioProject): Array<{ candidate: Candidate; subdir: string; name: string }> {
  const out: Array<{ candidate: Candidate; subdir: string; name: string }> = []
  const add = (list: Candidate[], subdir: string, name: string) => {
    for (const c of list) if (c.status === 'running' && c.runId) out.push({ candidate: c, subdir, name })
  }
  p.references.forEach((r) => add(r.candidates, 'references', r.label))
  p.shots.forEach((s, i) => {
    const n = `shot${String(i + 1).padStart(2, '0')}`
    add(s.board, 'storyboard', n)
    add(s.images, 'shots', n)
    add(s.takes, 'takes', n)
  })
  add(p.exports, 'export', p.name)
  return out
}

/** 첫 번째로 끝난 후보를 자동 선택 — 한 장만 뽑았을 때 사용자가 따로 고르지 않아도 되게 (승인은 따로). */
export function autoPick(list: Candidate[], current: string | null): string | null {
  if (current && list.some((c) => c.id === current)) return current
  return list.find((c) => c.status === 'done' && c.asset)?.id ?? null
}

// ── 스토리보드 초안 (LLM) ─────────────────────────────────────────────────────

export function storyboardPrompt(p: StudioProject, shotCount: number): string {
  const refs = p.references.map((r) => `- ${r.label}`).join('\n') || '- (없음)'
  return [
    'You are a film director writing a shot list for a short AI-generated video.',
    `Aspect ratio: ${p.aspect}. Visual style: ${p.style || 'cinematic'}.`,
    `Story / mood (from the user, may be Korean):\n${p.synopsis || '(not given)'}`,
    `Approved references:\n${refs}`,
    `Write about ${shotCount} shots. Each shot is one continuous 3–6 second clip that starts from a single still image.`,
    'Return ONLY a JSON array, no prose, no code fences. Each item:',
    '{"title": short Korean title, "description": what happens (Korean, one sentence), "durationSec": number 3-6,',
    ' "camera": camera framing and movement in English (e.g. "medium shot, slow push in"),',
    ' "imagePrompt": English prompt for the first frame — who, where, pose, composition, lighting,',
    ' "motionPrompt": English prompt for the motion during the clip}',
  ].join('\n')
}

/** LLM 답에서 샷 배열을 꺼낸다 — 앞뒤 말·코드 펜스가 붙어도. 형식이 틀린 항목은 버린다. */
export function parseStoryboard(text: string): Shot[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('스토리보드 초안을 읽지 못했습니다 (JSON 배열이 없음)')
  const raw = JSON.parse(text.slice(start, end + 1)) as unknown
  if (!Array.isArray(raw)) throw new Error('스토리보드 초안이 배열이 아닙니다')
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const shots = raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => newShot({
      title: str(x.title),
      description: str(x.description),
      durationSec: Math.min(10, Math.max(2, Number(x.durationSec) || 4)),
      camera: str(x.camera),
      imagePrompt: str(x.imagePrompt),
      motionPrompt: str(x.motionPrompt),
    }))
    .filter((s) => s.imagePrompt)
  if (!shots.length) throw new Error('스토리보드 초안에 쓸 만한 샷이 없습니다')
  return shots
}
