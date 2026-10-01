// ── 렌더러 → main 신뢰 경계 헬퍼 (순수 모듈: electron import 없음) ──────────────
//
// 렌더러가 넘긴 경로·URL 은 "믿을 수 없는 입력" 이다. 예전 검사는 전부
// `abs.startsWith(getWorkspace())` 같은 문자열 prefix 매칭이었는데, 그건 세 가지를 놓친다:
//   1. 형제 폴더 — `…\users\abc` 의 prefix 는 `…\users\abc-evil` 에도 맞는다.
//   2. 심볼릭 링크·junction — 워크스페이스 안의 링크가 밖을 가리키면 문자열은 "안" 인데
//      실제 읽기/쓰기는 밖에서 일어난다.
//   3. 루트 자체 — `delete-file('.')` 은 prefix 검사를 통과해 워크스페이스를 통째로 지운다.
// 그래서 판정을 한 곳에 모은다. 새 파일 IPC 를 만들 때는 startsWith 를 다시 쓰지 말고 이걸 쓸 것.

import fs from 'node:fs'
import path from 'node:path'

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw err
    // native(Windows: GetFinalPathNameByHandle)는 일부 RAM 디스크·가상 볼륨에서 멀쩡한 경로에도
    // 실패한다. 그대로 두면 그런 볼륨에 프로젝트를 둔 사용자는 파일 IPC 가 전부 거부된다 —
    // 링크를 똑같이 풀어 주는 JS 구현으로 한 번 더 시도한다 (여기서도 실패하면 거부).
    return fs.realpathSync(p)
  }
}

/**
 * 실제로 존재하는 가장 깊은 조상까지 realpath 로 풀고, 아직 없는 꼬리는 그대로 붙인다.
 *
 * 왜 "가장 깊은 조상" 인가: 쓰기 대상은 대개 아직 없는 파일이라 realpath 가 ENOENT 다.
 * 그렇다고 검사를 건너뛰면 `<ws>/link-to-outside/new.txt` 가 통과한다 — 새 파일은
 * 그 부모가 **실제로** 어디 있느냐로 판정해야 한다.
 *
 * 판정 불가(권한 오류, 링크 루프, 대상이 없는 dangling 링크)면 throw — 호출부는 거부로 처리한다.
 * dangling 링크를 "아직 없는 파일" 로 취급하면 안 되는 이유: writeFileSync 는 링크를 따라가
 * 링크가 가리키는 (워크스페이스 밖) 경로에 파일을 만들어 버린다.
 */
export function realpathDeepest(p: string): string {
  let cur = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpath(cur)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      // realpath 는 실패했는데 항목 자체는 있다 = 대상이 없는 링크.
      if (fs.lstatSync(cur, { throwIfNoEntry: false })) throw new Error(`dangling link: ${cur}`)
      const parent = path.dirname(cur)
      if (parent === cur) return path.join(cur, ...tail.reverse())   // 드라이브/루트까지 없음
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

/**
 * `candidate` 가 `root` **안**에 있는가.
 *
 * - `path.relative` 로 판정한다 (prefix 매칭 아님). win32 에서는 대소문자를 무시하고,
 *   드라이브가 다르면 relative 가 절대경로를 돌려주므로 그것도 걸러진다.
 * - 양쪽 다 realpathDeepest 로 푼 뒤 비교 — 프로젝트 폴더 자체가 링크 아래 있어도
 *   (macOS 의 /tmp → /private/tmp 등) 같은 기준으로 풀리므로 오탐이 없다.
 * - 루트 자체는 기본적으로 **거부**. 삭제·이동 같은 파괴적 연산이 루트를 받으면 안 되기
 *   때문에 안전한 쪽을 기본값으로 두고, 목록/열람처럼 루트가 정당한 대상인 곳만
 *   `{ allowRoot: true }` 를 명시한다.
 * - 판정할 수 없으면 false (fail-closed).
 */
export function isInside(root: string, candidate: string, opts: { allowRoot?: boolean } = {}): boolean {
  if (typeof root !== 'string' || typeof candidate !== 'string' || !root || !candidate) return false
  if (root.includes('\0') || candidate.includes('\0')) return false
  try {
    const rel = path.relative(realpathDeepest(root), realpathDeepest(candidate))
    if (rel === '') return opts.allowRoot === true
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
  } catch {
    return false
  }
}

/**
 * id·이름을 경로 조각으로 쓰기 전에 지나는 관문 — **정확히 한 세그먼트**여야 한다. 아니면 throw.
 *
 * plan/workflow/orchestration/agent/MR 의 id 는 main 이 generateId() 로 만든 `wf_…` 꼴이지만,
 * IPC 로 되돌아오는 id 는 렌더러 입력이다. `path.join(root, id)` 에 `'..'` 가 들어가면 root 의
 * 부모가 되고, 그 뒤가 `rmSync(dir, { recursive: true })` 면 워크스페이스가 통째로 지워진다.
 * isInside 로 사후 검사하는 대신 조립 시점에 막는다 — 경로를 만드는 함수 몇 개만 고치면
 * 그걸 거치는 채널 수십 개가 한 번에 덮인다.
 *
 * 콜론은 막지 않는다: 세션 id(`agent:main:…`) 같은 기존 값이 있고, 경계 밖으로 나가지도 않는다.
 *
 * 끝이 점·공백인 조각(`'.. '`, `'x.'`)도 거부한다. Win32 경로 정규화는 구성요소 끝의 점·공백을
 * 떼어 내므로 `'.. '` 는 `'..'` 가 된다. Node 의 fs 는 `\\?\` 네임스페이스 경로를 써서 이 정규화를
 * 건너뛰지만, 같은 문자열이 shell.openPath / showItemInFolder / 자식 프로세스 / 게이트웨이로
 * 넘어가면 거기서는 정규화된다 — 검사한 경로와 실제 열리는 경로가 달라진다. main 이 만드는
 * id 와 스킬 이름(UI 가 `[a-z0-9-]` 만 남긴다)은 그렇게 끝나지 않는다.
 */
export function safeSegment(seg: unknown): string {
  if (typeof seg !== 'string' || !seg || seg === '.' || seg === '..' || /[\\/\0]/.test(seg) || /[. ]$/.test(seg)) {
    throw new Error('invalid id: must be a single path segment')
  }
  return seg
}

/**
 * 두 경로가 **같은 곳**을 가리키는가. 문자열 비교가 아니라 realpath 로 본다 —
 * 한쪽이 junction/symlink 여도, win32 에서 대소문자나 구분자가 달라도 같으면 같다고 봐야 한다.
 * 판정 불가는 false (fail-closed).
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  if (a.includes('\0') || b.includes('\0')) return false
  try {
    const ra = realpathDeepest(a)
    const rb = realpathDeepest(b)
    return platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
  } catch {
    return false
  }
}

/**
 * `candidate` 가 허용 목록 중 하나와 같은 경로인가.
 *
 * "이 경로를 받아들여도 되는가" 를 **출처**로 판정하는 자리다 (set-project-dir). 목록에는
 * 우리가 띄운 다이얼로그가 돌려준 경로와 현재 값만 들어간다 — 렌더러가 만들어 낸 문자열은
 * 아무리 그럴듯해도 목록에 없으므로 거부된다.
 */
export function isSamePathAsAny(
  candidate: string,
  authorized: Iterable<string | null | undefined>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  for (const a of authorized) {
    if (a && samePath(candidate, a, platform)) return true
  }
  return false
}

/**
 * 렌더러가 고른 CDP 포트를 제품이 실제로 쓰는 포트로 좁힌다.
 *
 * browser-preview:* 는 포트를 payload 로 받아 `127.0.0.1:<port>` 의 CDP 에 붙는다. 제한이 없으면
 * 렌더러가 아무 로컬 포트나 찍어 볼 수 있다 — CDP 는 인증이 없어서, 사용자가 디버그 포트로 띄워
 * 둔 **개인 브라우저**에 붙으면 거기서 화면을 긁고 입력을 넣을 수 있다(browser-preview:input).
 *
 * 허용 목록은 제품 프로필의 채팅용 포트 + 워크플로 슬롯 포트. 값이 없으면 기존처럼 기본 포트.
 * 허용 밖이면 null → 호출부가 거부한다.
 */
export function resolveCdpPort(requested: unknown, fallback: number, allowed: readonly number[]): number | null {
  if (requested === undefined || requested === null) return fallback
  return typeof requested === 'number' && allowed.includes(requested) ? requested : null
}

/**
 * `shell.openExternal` 에 넘겨도 되는 URL 인가 — http(s) 와 mailto 만.
 *
 * openExternal 은 OS 의 프로토콜 핸들러에 그대로 위임한다. `file:` 은 로컬 실행 파일을,
 * `ms-msdt:` · `search-ms:` 같은 스킴은 과거 실제 RCE 에 쓰인 핸들러를 부른다. 채팅
 * 마크다운의 링크는 LLM/웹 페이지가 쓴 텍스트라 스킴을 믿을 수 없다.
 * (main 이 직접 여는 `x-apple.systempreferences:` 는 IPC 를 안 거치므로 여기와 무관.)
 */
export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
