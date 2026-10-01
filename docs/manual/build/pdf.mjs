/**
 * 생성된 웹페이지(USER_MANUAL.html / PRODUCT_GUIDE.html)를 A4 PDF 로 굽는다.
 *
 *   node docs/manual/build/make.mjs   # 먼저 HTML 생성
 *   node docs/manual/build/pdf.mjs    # 그다음 PDF
 *
 * 화면용 CSS 를 그대로 쓰되 인쇄에서만 깨지는 것들을 아래에서 덮어쓴다.
 * 가장 중요한 건 표 — 화면에서는 가로 스크롤로 처리하지만 종이에는
 * 스크롤이 없어서, 넘치면 그냥 잘린다(실제로 비교표 마지막 열이 날아갔다).
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const DOCS = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const TMP = fs.mkdtempSync(path.join(DOCS, '.pdfbuild-'))

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(p => fs.existsSync(p))
if (!CHROME) {
  console.error('Chrome 을 찾지 못했습니다. 경로를 CHROME 목록에 추가하세요.')
  process.exit(1)
}

const PRINT_CSS = `
<style>
@page { size: A4; margin: 13mm 12mm; }
html, body { overflow: visible; }

/* 화면용 2단(목차+본문) 그리드를 인쇄에서는 한 단으로 편다 */
.wrap { display: block; max-width: 100%; padding: 0 2mm; }
.mast { padding: 6mm 0; margin-bottom: 8mm; }
.mast h1 { font-size: 30px; }

/* 목차는 첫 장에 2단으로 눕힌다 */
nav.toc { position: static; max-height: none; overflow: visible; margin-bottom: 10mm;
  border: 1px solid var(--hair); border-radius: 10px; padding: 5mm 6mm; background: var(--card);
  column-count: 2; column-gap: 10mm; break-inside: avoid; }
nav.toc .tlabel { column-span: all; }
nav.toc a { break-inside: avoid; }

article { padding-bottom: 0; }
article h2 { break-after: avoid; margin-top: 34px; padding-top: 16px; }
article h3, article h4 { break-after: avoid; }

/* ── 표: 종이에는 가로 스크롤이 없다 ──
   th 의 nowrap 을 풀어 머리글을 접고, 글자를 줄여 폭 안에 넣는다.
   keep-all 은 한국어가 단어 중간에서 쪼개지는 걸 막는다. */
.tw { overflow: visible; }
table { font-size: 11.5px; table-layout: auto; }
th, td { padding: 8px 10px; word-break: keep-all; overflow-wrap: break-word; }
th { white-space: normal; }
tr { break-inside: avoid; }

/* 스크린샷·코드·인용은 페이지 경계에서 쪼개지지 않게 */
figure.shot-fig, pre, blockquote { break-inside: avoid; }
figure.shot-fig img { max-width: 100%; box-shadow: none; }
pre { max-width: 100%; }
pre code { white-space: pre-wrap; word-break: break-word; }

footer { border-top: 1px solid var(--hair); }
</style>
`

// 변형본: node pdf.mjs emdash  →  *.emdash.html 을 "... (엠대시).pdf" 로
const V = process.argv[2] ? `.${process.argv[2]}` : ''
const TAG = process.argv[2] === 'emdash' ? ' (엠대시)' : ''

const JOBS = [
  [`USER_MANUAL${V}`, `트윅시 사용 설명서${TAG}`],
  [`PRODUCT_GUIDE${V}`, `트윅시 제품 소개${TAG}`],
  [`CATALOG_VIRTUAL_IDOL${V}`, `버추얼 아이돌 조사 카탈로그${TAG}`],
  [`CATALOG_VIRTUAL_IDOL_SPEC${V}`, `버추얼 아이돌 조사 카탈로그 (구축 스펙)${TAG}`],
]

for (const [src, out] of JOBS) {
  const html = path.join(DOCS, `${src}.html`)
  if (!fs.existsSync(html)) { console.log(`(건너뜀) ${src}.html 없음`); continue }
  const staged = path.join(TMP, `${src}.html`)
  fs.writeFileSync(staged, fs.readFileSync(html, 'utf8') + PRINT_CSS)

  const dest = path.join(DOCS, `${out}.pdf`)
  execFileSync(CHROME, [
    '--headless=new',
    `--print-to-pdf=${dest}`,
    '--no-pdf-header-footer',
    `file://${staged}`,
  ], { stdio: 'ignore' })

  const mb = (fs.statSync(dest).size / 1048576).toFixed(1)
  console.log(`${out}.pdf — ${mb}MB`)
}

fs.rmSync(TMP, { recursive: true, force: true })
