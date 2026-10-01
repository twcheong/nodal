// ─────────────────────────────────────────────────────────────────────────────
// fileTypes.ts — 파일 인제스트의 단일 진실 공급원.
//
// 왜 shared/ 인가: 같은 목록이 네 군데에 하드코딩돼 있었고 전부 서로 달랐다.
//   - extractText.ts REGISTRY            (.pptx O, .docx X)
//   - useCopilotChat MSG_FILE_RE         (.pptx O, .docx X)
//   - useWorkflowTest DOC_PATH_RE        (.xlsx/.xls/.pdf 만 — .pptx 도 없음)
//   - useCopilotChat 워크스페이스 walk    (또 다른 목록)
// 결과: .docx 는 어디서도 안 읽혔고, .pptx 는 채팅에선 붙고 노드에선 안 붙었다.
// 확장자 목록은 main 과 renderer 양쪽이 쓰므로 여기(양쪽 tsconfig 에 포함된
// shared/)에 두고, 각 소비처는 파생 정규식만 만든다.
// ─────────────────────────────────────────────────────────────────────────────

/** 러너의 read 툴이 열 수 없는 바이너리 문서 — 첨부 추출이 반드시 필요하다. */
export const BINARY_DOC_EXTS = ['.xlsx', '.xlsm', '.xls', '.docx', '.pptx', '.pdf'] as const

/** 러너가 read 툴로 직접 읽는 텍스트류 — 추출은 가능하지만 보통 불필요. */
export const TEXT_EXTS = ['.csv', '.tsv', '.json', '.md', '.txt', '.log', '.yaml', '.yml', '.html', '.xml'] as const

/** 인제스트 레지스트리가 다루는 전체 집합. */
export const INGEST_EXTS: readonly string[] = [...BINARY_DOC_EXTS, ...TEXT_EXTS]

/**
 * 슬라이드에 **얹을** 수 있는 그림.
 *
 * INGEST_EXTS 와 일부러 분리한다: 저건 "읽어서 프롬프트에 넣는" 파일이고
 * 이건 "경로째로 배치하는" 파일이다. 한 목록에 섞으면 추출기가 PNG 를 열려다
 * '읽을 수 없음' 안내를 프롬프트에 흘리고, 모델은 그걸 "이 파일은 못 쓴다"로
 * 읽는다 — 정확히 반대 결론이다.
 *
 * 목록의 근거는 두 소비처의 교집합이다: pptxgenjs 의 addImage(파일 경로)와
 * 프리뷰의 <image> 태그. 둘 다 png/jpeg/gif/webp 를 그린다. svg 는 뺐다 —
 * Office 2019+ 만 렌더하고 Keynote 는 불안정해서, 아이콘도 PNG 로 굽는다
 * (electron/tools/files/pptx.ts rasterizeIcons 주석 참고).
 */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const

/** 컴포저가 받아주는 전체 — 읽을 수 있는 것 + 얹을 수 있는 것. */
export const ATTACHABLE_EXTS: readonly string[] = [...BINARY_DOC_EXTS, ...TEXT_EXTS, ...IMAGE_EXTS]

export function isImage(p: string): boolean {
  return IMAGE_EXTS.some((e) => p.toLowerCase().endsWith(e))
}

/**
 * query-data(DuckDB)가 테이블로 적재할 수 있는 것들.
 * 표 데이터는 프롬프트가 아니라 여기로 가야 한다 — 잘림이 품질 저하가 아니라
 * 사실 오류가 되는 유일한 부류이기 때문. (.xlsx 는 CSV 로 변환 후 적재)
 */
export const TABULAR_EXTS = ['.xlsx', '.xlsm', '.csv', '.tsv', '.json', '.parquet'] as const

export function isTabular(p: string): boolean {
  return TABULAR_EXTS.some((e) => p.toLowerCase().endsWith(e))
}
export function isBinaryDoc(p: string): boolean {
  return BINARY_DOC_EXTS.some((e) => p.toLowerCase().endsWith(e))
}

// ── 첨부 예산 ────────────────────────────────────────────────────────────────
// 이전 값(파일당 8,000자)은 60행짜리 인스타 포스트 인벤토리를 43행에서 잘랐고,
// 모델은 그걸 "44번부터는 존재하지 않는다"로 읽었다. 표에서 조용한 잘림은
// 품질 문제가 아니라 오답 문제라, 상한을 올리고 + 잘린 사실을 끝에 명시한다.
// 30k 자 ≈ 8k 토큰 — 200행 × 9열 스프레드시트가 통째로 들어간다.
export const ATTACH_PER_FILE_CAP = 30_000
export const ATTACH_TOTAL_BUDGET = 60_000

/**
 * 텍스트에서 파일 경로를 찾는 정규식. 목록에서 파생시켜, 새 타입을 추가해도
 * 소비처가 드리프트하지 않게 한다.
 */
export function fileRefRegex(exts: readonly string[] = INGEST_EXTS): RegExp {
  const alt = exts.map((e) => e.slice(1)).join('|')
  // \p{L}\p{N} — ASCII 만 받으면 한국어 파일명을 통째로 놓친다.
  // '@data/raw/2026-…-지난번.png' 가 매칭 0건이 되어 첨부 추출도, 이미지 안내도
  // 그 파일을 못 본다(파일명을 밑줄로 뭉개던 시절엔 드러나지 않던 짝 버그다).
  return new RegExp(String.raw`[\p{L}\p{N}_./~-]*\.(?:${alt})\b`, 'giu')
}

/** 워크스페이스 스캔용 확장자 매칭 (앵커드, non-global). */
export function fileExtRegex(exts: readonly string[] = INGEST_EXTS): RegExp {
  const alt = exts.map((e) => e.slice(1)).join('|')
  return new RegExp(String.raw`\.(?:${alt})$`, 'i')
}

// ── OS 기본 앱으로 열어도 되는 확장자 (allowlist) ────────────────────────────
//
// `shell.openPath` 는 OS 의 파일 연결을 그대로 탄다 — Windows 에서 .lnk/.bat/.js 는
// **실행**되고, .url 은 임의 스킴의 핸들러를 부른다. 그런데 워크스페이스의 내용물은
// 에이전트가 쓴 것이고(designated-paths 가드는 셸 경유 쓰기를 못 막는다), "Open" 버튼의
// 경로 하나는 LLM 출력에서 정규식으로 뽑아 온다. 즉 "경로가 워크스페이스 안" 이라는
// 검사만으로는 클릭 한 번에 코드가 도는 것을 못 막는다.
//
// 그래서 deny-list 가 아니라 allowlist 다 — 목록에 없는 확장자(그리고 앞으로 생길 것
// 전부)는 열리지 않는다. 담은 기준은 "이 앱이 만들거나 읽어들이는 것".
//
// .html·.svg 를 넣은 이유: 기본 앱이 브라우저라 네이티브 실행이 아니고(샌드박스),
// 에이전트가 크롤한 페이지와 우리가 굽는 리포트가 실제로 .html 이다. 네이티브로
// 실행되는 부류(.exe .bat .cmd .com .scr .msi .ps1 .vbs .js .jar .hta .lnk .url .reg .app
// .command .pkg …)는 목록에 없으므로 자동으로 거부된다.
export const OPENABLE_EXTS: readonly string[] = [
  // 이 앱이 워크스페이스에 쓰는 것들
  '.md', '.txt', '.log', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.xml', '.html', '.pdf',
  // 오피스 — 산출물(.pptx/.xlsx)과 사용자가 넣어 둔 원본
  '.docx', '.doc', '.xlsx', '.xlsm', '.xls', '.pptx', '.ppt', '.potx', '.rtf',
  '.odt', '.ods', '.odp',   // 번들된 LibreOffice 가 다루는 포맷
  // 이미지
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif',
]

/**
 * `p` 를 OS 기본 앱으로 열어도 되는가.
 *
 * 파일명(basename)의 **마지막 점 뒤**가 목록과 정확히 일치해야 한다. endsWith 로 보면
 * 확장자 없는 파일이 상위 폴더 이름의 점에 걸려 통과할 수 있다. 끝에 점·공백이 붙은
 * 이름(`evil.exe `)은 일치하지 않아 거부된다 — Win32 는 그걸 떼고 .exe 로 실행한다.
 */
export function isOpenable(p: string): boolean {
  if (typeof p !== 'string') return false
  const base = p.toLowerCase().split(/[\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 && OPENABLE_EXTS.includes(base.slice(dot))
}
