import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { render, page, inlineImages } from './build-doc.mjs'

const DOCS = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

// 변형본 빌드: node make.mjs emdash  →  *.emdash.ko.md 를 읽어 *.emdash.html 로
const V = process.argv[2] ? `.${process.argv[2]}` : ''

// strip the leading H1 + its metadata paragraph — the masthead carries them
const strip = (md) => md.replace(/^#\s.*\n(?:(?!\n---)[\s\S])*?\n---\n/, '')

// ── 1. beta tester manual ──
{
  const md = strip(fs.readFileSync(`${DOCS}/USER_MANUAL${V}.ko.md`, 'utf8'))
  const { html: rawHtml, toc } = render(md)
  const html = inlineImages(rawHtml, DOCS)
  fs.writeFileSync(`${DOCS}/USER_MANUAL${V}.html`, page({
    title: '트윅시 사용 설명서',
    eyebrow: 'Twixy',
    h1: '트윅시 사용 설명서',
    lede: '무엇을 어디서 어떻게 시키는지. 실제로 조작하는 방법만 담았습니다.',
    meta: ['조작 안내서', '버전 0.1.0', '2026년 8월'],
    html, toc,
  }))
  console.log('manual:', toc.length, 'chapters')
}

// ── 2. customer / homepage guide ──
{
  const md = strip(fs.readFileSync(`${DOCS}/PRODUCT_GUIDE${V}.ko.md`, 'utf8'))
  const { html: rawHtml, toc } = render(md)
  const html = inlineImages(rawHtml, DOCS)
  fs.writeFileSync(`${DOCS}/PRODUCT_GUIDE${V}.html`, page({
    title: '트윅시 제품 소개',
    eyebrow: 'Twixy',
    h1: '반복되는 마케팅 실무를,<br>한 번만 설명하면 됩니다',
    lede: 'Twixy는 조사·정리·문서화를 대신 실행하는 데스크탑 어시스턴트입니다. 2~10명 규모 마케팅 에이전시를 위해 만들었습니다.',
    meta: ['제품 소개', '도입 안내', '보안 FAQ'],
    html, toc, single: true,
  }))
  console.log('guide:', toc.length, 'sections')
}

// ── 3. 버추얼 아이돌 시장조사 워크플로 카탈로그 (고객용) ──
{
  const src = `${DOCS}/CATALOG_VIRTUAL_IDOL${V}.ko.md`
  if (fs.existsSync(src)) {
    const md = strip(fs.readFileSync(src, 'utf8'))
    const { html: rawHtml, toc } = render(md)
    const html = inlineImages(rawHtml, DOCS)
    fs.writeFileSync(`${DOCS}/CATALOG_VIRTUAL_IDOL${V}.html`, page({
      title: '버추얼 아이돌 조사 카탈로그',
      eyebrow: 'Twixy',
      h1: '버추얼 아이돌 시장조사<br>워크플로 100개',
      lede: '손으로 반복하던 조사 100가지를 워크플로로 정리했습니다. 킥오프에서 팀에 필요한 30개를 함께 고릅니다.',
      meta: ['워크플로 100개', '11개 분야', '킥오프에서 30개 선정'],
      html, toc,
    }))
    console.log('catalog:', toc.length, 'sections')
  }
}

// ── 4. 카탈로그 구축 스펙본 (킥오프 진행용) ──
{
  const src = `${DOCS}/CATALOG_VIRTUAL_IDOL_SPEC${V}.ko.md`
  if (fs.existsSync(src)) {
    const md = strip(fs.readFileSync(src, 'utf8'))
    const { html: rawHtml, toc } = render(md)
    const html = inlineImages(rawHtml, DOCS)
    fs.writeFileSync(`${DOCS}/CATALOG_VIRTUAL_IDOL_SPEC${V}.html`, page({
      title: '조사 카탈로그 구축 스펙',
      eyebrow: 'Twixy',
      h1: '버추얼 아이돌 조사 카탈로그<br>구축 스펙',
      lede: '같은 100개를, 실제로 짤 수 있는 수준까지 적었습니다. 킥오프에서 범위를 확정하는 데 씁니다.',
      meta: ['워크플로 100개', '출처·필드·기준', '정해야 할 것'],
      html, toc,
    }))
    console.log('spec:', toc.length, 'sections')
  }
}

