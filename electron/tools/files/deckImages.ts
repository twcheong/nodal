// 덱 스펙 안의 사진 경로를 실제 파일로 확정한다 (main 프로세스 전용).
//
// 왜 별도 레이어인가: 레이아웃 코어(shared/deck)는 순수해서 fs 를 못 만지고,
// 스펙에 적히는 경로는 대부분 워크스페이스 상대경로(`data/raw/…png`)다. 반면
// 두 소비처는 절대경로가 필요하다 —
//   · pptxgenjs `addImage({ path })` 는 상대경로를 **프로세스 cwd** 기준으로
//     푼다. Electron 의 cwd 는 워크스페이스가 아니라 앱 디렉토리라서, 상대
//     경로는 조용히 빗나간다.
//   · 시각 QA 시트의 SVG 페인터는 파일을 읽어 data: URI 로 박아야 한다.
//
// 그래서 "경로를 확정하는 일"을 한 곳에 모으고, 쓰기/굽기 양쪽이 이걸 지난다.
//
// 워크스페이스 밖은 거부한다(resolveInsideWorkspace 와 같은 규칙). 사용자가
// 드래그한 사진은 import 단계에서 이미 data/raw 로 복사되므로 정상 흐름은
// 전부 워크스페이스 안에 있다.

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { IMAGE_EXTS } from '../../../shared/fileTypes'
import type { WritePptxPayload } from '../../../shared/deck/spec'
import { isInside } from '../../trustBoundary'

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
}

/** 너무 큰 사진은 data: URI 로 만들지 않는다 — 시트 한 장에 수십 MB 가 박힌다. */
const DATA_URI_CAP = 12 * 1024 * 1024

/**
 * 한 경로를 절대경로로. 못 쓰는 경로면 null.
 *
 * `workspace` 가 없으면(스크립트/픽스처) 절대경로만 통과시킨다 — 예전 동작
 * (상대경로를 cwd 로 푸는 pptxgenjs 기본값)을 그대로 남긴다.
 */
export function resolveImagePath(p: string, workspace?: string): string | null {
  if (!p || typeof p !== 'string') return null
  const abs = path.isAbsolute(p) ? p : (workspace ? path.resolve(workspace, p) : null)
  if (!abs) return null
  if (workspace && !isInside(workspace, abs)) return null
  try { if (!fs.statSync(abs).isFile()) return null } catch { return null }
  return abs
}

/** 스펙을 깊이 순회하며 `imagePath` 를 전부 절대경로로 바꾼 사본. */
export function resolveDeckImages(
  payload: WritePptxPayload,
  workspace?: string,
): { payload: WritePptxPayload; missing: string[] } {
  const missing: string[] = []
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== 'object') return node
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'imagePath' && typeof v === 'string') {
        const abs = resolveImagePath(v, workspace)
        if (abs) { out[k] = abs } else { out[k] = v; missing.push(v) }
        continue
      }
      out[k] = walk(v)
    }
    return out
  }
  return { payload: walk(payload) as WritePptxPayload, missing: [...new Set(missing)] }
}

/** 파일 → data: URI. SVG 페인터의 `<image href>` 에 그대로 들어간다. */
export function imageDataUri(abs: string): string | undefined {
  const mime = MIME[path.extname(abs).toLowerCase()]
  if (!mime) return undefined
  try {
    const stat = fs.statSync(abs)
    if (!stat.isFile() || stat.size > DATA_URI_CAP) return undefined
    return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`
  } catch { return undefined }
}

/** 확장자만 보고 "사진"인지 — 인제스트 목록과 같은 소스에서 파생. */
export function isImageFile(p: string): boolean {
  return IMAGE_EXTS.some((e) => p.toLowerCase().endsWith(e))
}

/**
 * 절대경로 → 가로/세로 비율. 레이아웃 코어가 사진의 '모양' 을 알아야 액자를
 * 거기에 맞출 수 있다(shared/deck/layout/common.ts LayoutCtx.aspect).
 *
 * 못 읽는 파일은 **그냥 빠진다** — 비율을 모르면 코어가 예전 기하로 그리고,
 * 그건 정상 동작이지 실패가 아니다.
 */
export async function deckImageAspects(
  payload: WritePptxPayload,
  workspace?: string,
): Promise<Record<string, number>> {
  const paths = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'imagePath' && typeof v === 'string') paths.add(v)
      else walk(v)
    }
  }
  walk(payload)

  const out: Record<string, number> = {}
  for (const p of paths) {
    const abs = resolveImagePath(p, workspace)
    if (!abs) continue
    try {
      const { width, height, orientation } = await sharp(abs).metadata()
      if (!width || !height) continue
      // EXIF 회전을 적용한 뒤의 모양이어야 한다. 브라우저는 orientation 을
      // 적용해서 naturalWidth/Height 를 주는데 sharp 의 metadata 는 원본
      // 픽셀이라, 세로로 찍은 사진 하나가 프리뷰와 파일의 액자 비율을
      // 서로 다르게 만든다 — 두 호스트가 같은 숫자를 줘야 한다.
      const turned = typeof orientation === 'number' && orientation >= 5
      out[p] = turned ? height / width : width / height
    } catch { /* 모양을 모르면 코어가 알아서 예전 기하로 */ }
  }
  return out
}
