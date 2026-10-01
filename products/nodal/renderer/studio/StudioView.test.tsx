import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StudioView } from './StudioView'

type Reply = { ok: true; data: unknown } | { ok: false; error: string }
function mockApp(handlers: Record<string, (payload: unknown) => unknown>) {
  const productInvoke = vi.fn(async (name: string, payload?: unknown): Promise<Reply> => {
    const fn = handlers[name]
    if (!fn) return { ok: false, error: `unknown ${name}` }
    return { ok: true, data: fn(payload) }
  })
  ;(window as unknown as { twixy: unknown }).twixy = { productInvoke }
  return productInvoke
}

afterEach(() => { delete (window as unknown as { twixy?: unknown }).twixy; localStorage.clear() })

const ready = () => ({ state: 'ready', url: 'http://127.0.0.1:8188', dataDir: '/d', running: true })
const setup = () => ({ packs: [{ id: 'image-base', installed: true }, { id: 'flux2-klein', installed: true }, { id: 'video-h3', installed: false }] })

describe('StudioView', () => {
  it('creates a project, gates stage 2 on an approved character reference, and approves by clicking a result', async () => {
    let saved: Record<string, unknown> | null = null
    let runs = 0
    const invoke = mockApp({
      'nodal-engine-status': ready,
      'nodal-setup-status': setup,
      'studio-list': () => [],
      'studio-create': (p) => ({ ...(p as { project: object }).project, id: 'mv-1', createdAt: 1, updatedAt: 1 }),
      'studio-load': () => saved ?? { version: 1, id: 'mv-1', name: '옥상의 밤', aspect: '16:9', quality: 'standard', synopsis: '', style: '', stage: 1, references: [], shots: [], exports: [], createdAt: 1, updatedAt: 1 },
      'studio-save': (p) => { saved = (p as { project: Record<string, unknown> }).project; return { updatedAt: 2 } },
      'studio-run': () => ({ runId: `run-${++runs}` }),
      'nodal-run': () => ({ run: { status: 'succeeded' }, assets: [{ hash: 'abcdef12', media_type: 'image/png', size_bytes: 1 }] }),
      'studio-keep': () => ({ hash: 'abcdef12', path: 'projects/mv-1/references/x.png', mediaType: 'image/png' }),
    })
    render(<StudioView active navigate={() => {}} />)

    fireEvent.change(await screen.findByPlaceholderText(/프로젝트 이름/), { target: { value: '옥상의 밤' } })
    fireEvent.click(screen.getByText('만들기'))
    expect(await screen.findByText('옥상의 밤')).toBeInTheDocument()
    // 인물 기준이 없으면 다음 단계가 막혀 있다.
    expect(screen.getByText('승인한 인물 기준 이미지가 한 장 이상 필요합니다')).toBeInTheDocument()
    expect(screen.getByText(/승인하고 스토리보드/).closest('button')).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('민준'), { target: { value: '민준' } })
    fireEvent.change(screen.getByPlaceholderText(/korean man/), { target: { value: 'a korean man' } })
    fireEvent.click(screen.getByText('추가'))
    expect(await screen.findByText('얼굴')).toBeInTheDocument()
    expect(screen.getByText('전신 정면')).toBeInTheDocument()

    // 얼굴 칸에서 생성 → 결과가 들어오면 눌러서 승인 → 다음 단계가 열린다.
    fireEvent.click(screen.getAllByText('생성')[0])
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('studio-run', expect.objectContaining({ template: 'zimage_txt2img' })))
    const thumb = await screen.findByTitle(/character reference sheet of a korean man, close-up/, undefined, { timeout: 5000 })
    await waitFor(() => expect(thumb).toHaveAttribute('aria-disabled', 'false'), { timeout: 5000 })
    fireEvent.click(thumb)
    await waitFor(() => expect(screen.getByText(/승인하고 스토리보드/).closest('button')).not.toBeDisabled())
    fireEvent.click(screen.getByText(/승인하고 스토리보드/))
    expect(await screen.findByText('AI 로 샷 초안 쓰기')).toBeInTheDocument()
    await waitFor(() => expect(saved?.stage).toBe(2))
  })
  it('starts a filled demo project from the list', async () => {
    let created: Record<string, unknown> | null = null
    mockApp({
      'nodal-engine-status': ready,
      'nodal-setup-status': setup,
      'studio-list': () => [],
      'studio-create': (p) => { created = { ...(p as { project: object }).project, id: 'demo-1', createdAt: 1, updatedAt: 1 }; return created },
      'studio-load': () => created,
      'studio-save': () => ({ updatedAt: 2 }),
    })
    render(<StudioView active navigate={() => {}} />)
    fireEvent.click(await screen.findByText('데모로 시작'))
    expect(await screen.findByText('데모 — 옥상의 밤')).toBeInTheDocument()
    expect(screen.getByText('민준')).toBeInTheDocument()        // 인물 그룹
    expect(screen.getByText('서울 옥상')).toBeInTheDocument()   // 장소
    expect((created as unknown as { shots: unknown[] }).shots).toHaveLength(5)
  })
})
