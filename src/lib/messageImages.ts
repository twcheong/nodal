// 대화에 붙은 사진 목록을 모델에게 알리는 규칙.
//
// 별도 파일인 이유: 훅 안에 두면 React·WebSocket·소울 문서까지 끌고 와야 해서
// 검사할 수가 없다. 이 규칙이 틀리면 사용자가 올린 사진이 덱에서 조용히
// 사라진다(실제로 그랬다) — 검사 가능한 자리에 둔다.

import { fileRefRegex, IMAGE_EXTS } from '../../shared/fileTypes'

/** 대화에서 사진을 찾을 때 쓰는 최소 메시지 모양. */
export type ImageSourceMessage = { role: 'user' | 'assistant'; content: string }

const MSG_IMAGE_RE = fileRefRegex(IMAGE_EXTS)

/** 한 텍스트에서 사진 경로만 (중복 제거, 등장 순서). */
export function imagePathsIn(text: string): string[] {
  MSG_IMAGE_RE.lastIndex = 0        // /g 정규식은 상태를 갖는다
  return [...new Set((text.match(MSG_IMAGE_RE) ?? []).map(p => p.replace(/^[`'"@]+|[`'"]+$/g, '')))]
}

/**
 * 이 대화에서 쓸 수 있는 사진 목록.
 *
 * `prior` 가 있는 이유(2026-09-16 실사고): 사용자가 사진 일곱 장을 붙여 덱을
 * 만들고, 다음 턴에 "살 붙이지 말고 그대로 다시" 라고만 했다. 그 메시지에는
 * 경로가 없으니 목록이 비었고, 모델은 기억에 남은 경로만으로 덱을 다시 써서
 * **마이크 소품 사진이 빠진 버전**이 나왔다. 첨부는 메시지가 아니라 대화에
 * 속한다 — 한 번 올린 사진은 그 대화 내내 쓸 수 있어야 한다.
 *
 * 지금 붙인 것과 예전에 붙인 것을 나눠 적는다: "이번에 새로 준 것" 과 "쓸 수
 * 있는 것" 은 다른 정보고, 섞으면 모델이 매번 전부를 다시 배치한다.
 */
const CARRIED_IMAGE_CAP = 20
export function buildMessageImageNote(text: string, prior: readonly ImageSourceMessage[] = []): string {
  const now = imagePathsIn(text)
  const carried: string[] = []
  for (const m of prior) {
    if (m.role !== 'user') continue
    for (const p of imagePathsIn(m.content)) {
      if (!now.includes(p) && !carried.includes(p)) carried.push(p)
    }
  }
  const older = carried.slice(-CARRIED_IMAGE_CAP)
  const paths = [...now, ...older]
  if (paths.length === 0) return ''
  const lines = [
    '',
    '[Image file(s) available in this conversation. You CANNOT see them — never describe their contents. ' +
    'To put one on a slide, use the path EXACTLY as written below as `imagePath` ' +
    '(an `image` slide, or an `image` block inside a `layout` slide).]',
  ]
  if (now.length) {
    lines.push(...(older.length ? ['Attached with this message:'] : []), ...now.map(p => `- ${p}`))
  }
  if (older.length) {
    lines.push('Attached earlier in this conversation (still usable — reuse these paths rather than dropping the picture):')
    lines.push(...older.map(p => `- ${p}`))
  }
  lines.push('')
  return lines.join('\n')
}

