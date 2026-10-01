// Fixture matrix for the deck snapshot oracle (scripts/deck/snapshot.ts).
//
// Every kind × variant × theme × style that the tool can render, plus the edge
// cases that have bitten us (legacy payloads, clamped collections, the 15-row
// table cut, the 9+ bullets fallback). Must stay DETERMINISTIC — no dates, no
// randomness — or the baseline is worthless.

import fs from 'node:fs'
import type { WritePptxPayload, SlideSpec } from '../../electron/tools/files/pptx'

/**
 * 픽스처가 쓰는 진짜 PNG.
 *
 * 경로는 **상수**다 — 베이스라인 JSON 에 그대로 박혀 있어서 바꾸면 스냅샷이
 * 통째로 흔들린다. 바뀐 건 "누가 만드느냐" 뿐이다: 예전엔 아무도 안 만들어서
 * /tmp 가 비워진 기계에서는 이미지 픽스처가 그냥 깨졌다(그리고 그 깨짐이
 * "이미지 경로가 안 풀린다" 는 진짜 버그와 구분되지 않았다).
 *
 * import 시점에 만들지 않는다 — fixtures.ts 는 순수한 데이터 모듈이고,
 * 스냅샷은 파일 없이도 돌아야 한다(좌표만 본다). 파일이 실제로 필요한 쪽
 * (roundtrip · edit-roundtrip)이 ensureFixtureImage() 를 부른다.
 */
export const FIXTURE_IMAGE = '/tmp/twixy-fixture-image.png'

/** 8×8 빨강 PNG 를 FIXTURE_IMAGE 에 만들어 둔다 (이미 있으면 그대로). */
export function ensureFixtureImage(): string {
  if (!fs.existsSync(FIXTURE_IMAGE)) {
    fs.writeFileSync(FIXTURE_IMAGE, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAG0lEQVR42mP8z8BQz0AEYBxVSF+FAAoTABEXIQoAAAAASUVORK5CYII=',
      'base64'))
  }
  return FIXTURE_IMAGE
}

/** One slide of every kind, with the non-default variants spelled out. */
const ALL_KINDS: SlideSpec[] = [
  { kind: 'cover', variant: 'block', title: '2026 상반기 마케팅 리뷰', subtitle: '채널 성과와 하반기 전략', date: '2026-08-12', badge: 'Twixy', notes: '목적을 한 문장으로.' },
  { kind: 'cover', variant: 'split', title: 'Split 커버', subtitle: '좌 텍스트 + 우 패널' },
  { kind: 'cover', variant: 'center', title: 'Center 커버', subtitle: '중앙 정렬' },
  { kind: 'title', title: '레거시 타이틀', subtitle: 'cover block alias' },
  { kind: 'toc', variant: 'list', sections: ['성과 요약', '채널 분석', '고객 인사이트', '하반기 전략'], notes: '네 파트.' },
  { kind: 'toc', variant: 'sidebar', title: '목차 (sidebar)', sections: ['하나', '둘', '셋'] },
  { kind: 'toc', variant: 'cards', sections: ['A', 'B', 'C', 'D', 'E', 'F'] },
  { kind: 'toc', variant: 'list', sections: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'] }, // >6 → 2 columns
  { kind: 'section', variant: 'number', number: 1, title: '성과 요약', intro: '상반기 KPI를 한눈에.' },
  { kind: 'section', variant: 'accentBlock', number: 2, title: '채널 분석' },
  { kind: 'section', variant: 'split', number: 12, title: '두 자리 번호' },
  { kind: 'stats', variant: 'cards', title: '핵심 지표', items: [{ value: '+34%', label: '매출 성장', sublabel: 'YoY' }, { value: '2.8x', label: 'ROAS' }] },
  { kind: 'stats', variant: 'bare', items: [{ value: '41만', label: '신규 팔로워' }, { value: '12.4%', label: '전환율' }, { value: '8,200원', label: 'CPA' }] },
  { kind: 'stats', variant: 'cards', title: '클램프(5 → 4)', items: [1, 2, 3, 4, 5].map((n) => ({ value: `${n}0%`, label: `지표 ${n}` })) },
  { kind: 'compare', variant: 'cards', title: '퍼포먼스 vs 브랜드', left: { title: '퍼포먼스', bullets: ['ROAS 3.2x', 'CPA 8,200원'] }, right: { title: '브랜드', bullets: ['도달 320만', '검색량 +48%'] } },
  { kind: 'quote', text: '고객은 제품이 아니라 달라진 자신을 산다', attribution: 'VOC 분석 요약' },
  { kind: 'timeline', variant: 'rail', title: '로드맵', steps: [{ label: '7월', desc: '티저' }, { label: '8월', desc: '시딩' }, { label: '9월', desc: '론칭' }] },
  { kind: 'timeline', variant: 'rail', title: '클램프(8 → 6)', steps: Array.from({ length: 8 }, (_, i) => ({ label: `S${i + 1}` })) },
  { kind: 'chart', variant: 'full', title: '월별 매출', chartType: 'line', categories: ['1월', '2월', '3월'], series: [{ name: '2026', values: [120, 135, 160] }, { name: '2025', values: [100, 110, 120] }], takeaway: '4월 이후 격차 확대.', source: 'GA4' },
  { kind: 'chart', variant: 'full', title: '비중', chartType: 'doughnut', categories: ['자사몰', '스토어', '쿠팡'], series: [{ name: '비중', values: [42, 28, 30] }] },
  { kind: 'chart', variant: 'full', title: 'bar', chartType: 'bar', categories: ['A', 'B'], series: [{ name: 's', values: [1, 2] }] },
  { kind: 'chart', variant: 'full', title: 'pie', chartType: 'pie', categories: ['A', 'B'], series: [{ name: 's', values: [1, 2] }] },
  { kind: 'chart', variant: 'full', title: 'area', chartType: 'area', categories: ['A', 'B'], series: [{ name: 's', values: [1, 2] }] },
  { kind: 'summary', variant: 'takeaways', takeaways: ['숏폼 유지', '퍼널 보강'], closing: '목표: 매출 +40%' },
  { kind: 'summary', variant: 'split', title: '정리', takeaways: ['A', 'B'], nextSteps: ['킥오프', '재설계'], contact: 'marketing@twixy.ai', closing: '끝' },
  { kind: 'summary', variant: 'thanks', takeaways: ['숏폼', '퍼널'], closing: '감사합니다', contact: 'marketing@twixy.ai' },
  { kind: 'summary', variant: 'takeaways', title: '클램프(7 → 5)', takeaways: Array.from({ length: 7 }, (_, i) => `요점 ${i + 1}`) },
  { kind: 'bullets', variant: 'rows', title: '불릿 ≤8 (도트 행)', bullets: ['재구매의 62%가 SNS 유입', '리뷰 키워드 1위 발색', '20대 비중 +9%p'] },
  { kind: 'bullets', variant: 'rows', title: '불릿 9+ (컴팩트 폴백)', bullets: Array.from({ length: 10 }, (_, i) => `항목 ${i + 1}`) },
  { kind: 'text', variant: 'rail', title: '전략 배경', body: '상반기 성장의 핵심 동력은 숏폼 중심의 콘텐츠 전환이었습니다. 하반기에는 검증된 포맷을 유지하면서 전환 퍼널 하단을 보강합니다.' },
  { kind: 'table', variant: 'grid', title: '채널별 상세', headers: ['채널', '지출', 'ROAS'], rows: [['메타', '1.2억', '3.2x'], ['구글', '0.8억', '2.6x'], ['틱톡', '0.5억', '2.8x']] },
  { kind: 'table', variant: 'grid', title: '표 잘라내기(30 → 15)', headers: ['#', 'v'], rows: Array.from({ length: 30 }, (_, i) => [i + 1, `row-${i + 1}`]) },
  { kind: 'table', variant: 'grid', title: '표 9행 (폰트 축소)', headers: ['a', 'b'], rows: Array.from({ length: 9 }, (_, i) => [i, null]) },
  { kind: 'image', title: '이미지', imagePath: FIXTURE_IMAGE, caption: '캡션' },
]

/**
 * Every NEW variant (Phase 2) plus its fallback triggers, PINNED explicitly.
 * Pinning matters: the baseline should test "does the painter draw this face
 * right", separately from "does the rotation policy pick this face" — mixing
 * the two means a policy tweak can bury a painter regression.
 */
const ALL_VARIANTS: SlideSpec[] = [
  // chart
  { kind: 'chart', variant: 'split', title: '차트 split', chartType: 'bar', categories: ['메타', '구글', '틱톡'], series: [{ name: '지출', values: [1.2, 0.8, 0.5] }], takeaway: '메타 집중이 유효했다', source: 'GA4' },
  { kind: 'chart', variant: 'banner', title: '차트 banner', chartType: 'line', categories: ['1월', '2월', '3월'], series: [{ name: '2026', values: [120, 135, 160] }], takeaway: '4월 이후 격차 확대', source: 'GA4' },
  { kind: 'chart', variant: 'split', title: 'split 폴백(takeaway 없음 → full)', chartType: 'bar', categories: ['A', 'B'], series: [{ name: 's', values: [1, 2] }] },
  // bullets
  { kind: 'bullets', variant: 'cards', title: '불릿 cards', bullets: ['재구매 62% SNS 유입', '리뷰 1위 발색', '20대 +9%p', '숏폼 완주율 41%'] },
  { kind: 'bullets', variant: 'numbered', title: '불릿 numbered', bullets: ['첫 번째 원칙', '두 번째 원칙', '세 번째 원칙'] },
  { kind: 'bullets', variant: 'twoCol', title: '불릿 twoCol', bullets: ['하나', '둘', '셋', '넷', '다섯', '여섯'] },
  { kind: 'bullets', variant: 'cards', title: 'cards 폴백(7개 → rows)', bullets: Array.from({ length: 7 }, (_, i) => `항목 ${i + 1}`) },
  { kind: 'bullets', variant: 'twoCol', title: 'twoCol 폴백(3개 → rows)', bullets: ['하나', '둘', '셋'] },
  // compare
  { kind: 'compare', variant: 'vs', title: '비교 vs', left: { title: '퍼포먼스', bullets: ['ROAS 3.2x', 'CPA 8,200원'] }, right: { title: '브랜드', bullets: ['도달 320만', '검색량 +48%'] } },
  { kind: 'compare', variant: 'stacked', title: '비교 stacked', left: { title: 'Before', bullets: ['수작업 리포트', '주 4시간'] }, right: { title: 'After', bullets: ['자동 생성', '주 10분'] } },
  { kind: 'compare', variant: 'stacked', title: 'stacked 폴백(4개 → cards)', left: { title: 'A', bullets: ['1', '2', '3', '4'] }, right: { title: 'B', bullets: ['x'] } },
  // table
  { kind: 'table', variant: 'zebra', title: '표 zebra', headers: ['채널', '지출', 'ROAS'], rows: [['메타', '1.2억', '3.2x'], ['구글', '0.8억', '2.6x'], ['틱톡', '0.5억', '2.8x'], ['네이버', '0.3억', '2.1x']] },
  { kind: 'table', variant: 'kv', title: '표 kv', headers: ['항목', '값'], rows: [['총 지출', '2.5억'], ['총 매출', '7.3억'], ['ROAS', '2.9x'], ['CPA', '8,200원']] },
  { kind: 'table', variant: 'kv', title: 'kv 폴백(3열 → grid)', headers: ['a', 'b', 'c'], rows: [['1', '2', '3']] },
  // timeline
  { kind: 'timeline', variant: 'vertical', title: '타임라인 vertical', steps: [{ label: '7월', desc: '티저 오픈과 크리에이터 시딩 시작' }, { label: '8월', desc: '본편 공개, 리테일 미디어 온' }, { label: '9월', desc: '론칭 주간, 라이브 커머스' }] },
  { kind: 'timeline', variant: 'bars', title: '타임라인 bars', steps: [{ label: '리서치', desc: '경쟁사 훑기' }, { label: '기획', desc: '캘린더 확정' }, { label: '제작', desc: '촬영/편집' }, { label: '배포', desc: '채널별 발행' }] },
  { kind: 'timeline', variant: 'chevron', title: '타임라인 chevron', steps: [{ label: '인지', desc: '릴스 도달 확장' }, { label: '고려', desc: '후기·검증 콘텐츠' }, { label: '전환', desc: 'DM/링크 라우팅' }, { label: '충성', desc: '재구매 넛지' }] },
  // maxLines 회귀 — 실제 출하 덱에서 라벨이 단어 중간에서 쪼개졌다("팔로/워").
  // 높이는 박스 안이라 autofit 이 넘침으로 안 봤고 아무 경고도 없었다. 이 4개는
  // 폭이 박스를 넘는 한글+라틴 혼합 라벨이라, maxLines 가 빠지면 즉시 2줄이 된다.
  { kind: 'stats', variant: 'cards', title: '긴 라벨(줄바꿈 금지)', items: [
    { value: '4', label: '형제 계정 운영' },
    { value: '206', label: '@edis_agency_ 팔로워' },
    { value: '1,069', label: '@82_party_ (최대 계정)' },
    { value: '0.14', label: '최고 engagements (캐러셀)', sublabel: '캐러셀 포맷 기준 상위 게시물' },
  ] },
  // toc with descriptions — the described-agenda faces (mixed string/object on purpose)
  { kind: 'toc', variant: 'list', title: '아젠다(설명형 list)', sections: [{ label: '현황 진단', desc: '지금 계정은 무엇으로 채워져 있나' }, { label: '문제 정의', desc: '계정 간 중첩과 잠식' }, '역할 정의', { label: '퍼널 설계', desc: '인지→고려→전환·라우팅→충성' }] },
  { kind: 'toc', variant: 'cards', title: '아젠다(설명형 cards)', sections: [{ label: '진단', desc: '현재 상태와 숫자' }, { label: '전략', desc: '방향과 원칙' }, { label: '실행', desc: '캘린더와 가드레일' }] },
  // half-bleed image — the picture owns one side edge-to-edge
  { kind: 'image', variant: 'bleed', title: '현장 스냅숏', imagePath: FIXTURE_IMAGE, caption: '팝업 테이스팅 현장 — 파트너 레스토랑 3곳' },
  // hero — 사진이 페이지 전체, 글은 그 위에. 스크림(primary 반투명) + onPrimary 대비쌍.
  { kind: 'image', variant: 'hero', title: '사진 한 장이 페이지', imagePath: FIXTURE_IMAGE, caption: '스크림 위의 캡션' },
  // icon + text rows (step with icon instead of a number)
  {
    kind: 'layout', title: '아이콘 행', blocks: [
      { span: 12, body: { type: 'step', icon: 'target', title: '포지셔닝', desc: '포트폴리오 부모로 좁힌다' } },
      { span: 12, body: { type: 'step', icon: 'users', title: '오디언스', desc: 'B2B 파트너 + 문화 소비자' } },
      { span: 12, body: { type: 'step', icon: 'rocket', title: '실행', desc: '월 1회 포트폴리오 발표' } },
    ],
  },
  // stat progress ring (layout pct)
  {
    kind: 'layout', title: '스탯 링(pct)', blocks: [
      { span: 4, card: true, body: { type: 'stat', value: '64%', label: '숏폼 비중', pct: 64 } },
      { span: 4, card: true, body: { type: 'stat', value: '31%', label: '전환 기여', sublabel: '라스트터치 기준', pct: 31 } },
      { span: 4, card: true, body: { type: 'stat', value: '2.9x', label: 'ROAS' } },
    ],
  },
  // text
  { kind: 'text', variant: 'panel', title: '텍스트 panel', body: '상반기 성장의 핵심 동력은 숏폼 중심의 콘텐츠 전환이었습니다. 하반기에는 검증된 포맷을 유지하면서 전환 퍼널 하단을 보강합니다.' },
  { kind: 'text', variant: 'twoCol', title: '텍스트 twoCol', body: '상반기 성장의 핵심 동력은 숏폼 중심의 콘텐츠 전환이었습니다. 검증된 훅 포맷이 조회수를 끌었습니다.\n\n하반기에는 검증된 포맷을 유지하면서 전환 퍼널 하단을 보강합니다. 리타게팅 시나리오를 세분화합니다.' },
]

export const THEMES = ['twixy', 'petrol', 'navy', 'vivid', 'earth', 'charts', 'night', 'terra', 'berry', 'slate'] as const
export const STYLES = ['sharp', 'soft', 'rounded', 'pill'] as const

export type Fixture = { name: string; payload: WritePptxPayload }

export const FIXTURES: Fixture[] = [
  // every theme at its own default style
  ...THEMES.map((theme) => ({ name: `theme-${theme}`, payload: { title: `Theme ${theme}`, theme, slides: ALL_KINDS } })),
  // Phase-2 faces: every new variant + every fallback trigger, on a light and
  // the dark theme (new painters read colour ROLES — dark is where a missed
  // role shows).
  { name: 'variants-twixy', payload: { title: 'Variants', theme: 'twixy', slides: ALL_VARIANTS } },
  { name: 'variants-night', payload: { title: 'Variants dark', theme: 'night', slides: ALL_VARIANTS } },
  // one theme across every style recipe
  ...STYLES.map((style) => ({ name: `style-${style}`, payload: { title: `Style ${style}`, theme: 'twixy', style, slides: ALL_KINDS } })),
  // backwards compatibility: the pre-upgrade payload shape (no theme, bare accent)
  {
    name: 'legacy-payload',
    payload: {
      title: 'Legacy', accent: '#FF5A5F',
      slides: [
        { kind: 'title', title: '레거시 타이틀', subtitle: '구형 payload' },
        { kind: 'bullets', title: '불릿', bullets: ['하나', '둘'] },
        { kind: 'text', title: '본문', body: '텍스트' },
        { kind: 'table', title: '표', headers: ['a', 'b'], rows: [[1, 2], [3, null]] },
        { kind: 'image', title: '이미지', imagePath: FIXTURE_IMAGE },
      ],
    },
  },
  // Autofit stress — text that does NOT fit its box, so the shrink path stays
  // covered. Without this the oracle would let autofit regress silently.
  {
    name: 'autofit-overflow',
    payload: {
      theme: 'navy',
      slides: [
        { kind: 'bullets', variant: 'rows', title: '2026 상반기 마케팅 성과 리뷰와 하반기 채널 전략 제안 그리고 예산 재배분 계획', bullets: ['짧은 항목', '이것은 상당히 긴 불릿 항목이라서 한 줄에 절대 들어가지 않고 여러 줄로 넘어갈 것입니다 정말로 깁니다'] },
        { kind: 'cover', variant: 'block', title: 'A cover title so long that it cannot possibly fit on two lines at the authored size no matter how you slice it', subtitle: 'sub' },
        { kind: 'stats', variant: 'cards', title: '지표', items: [{ value: '이건 숫자가 아니라 아주 긴 문장입니다', label: '라벨도 마찬가지로 굉장히 길어서 넘칩니다', sublabel: '보조 라벨' }] },
        { kind: 'summary', variant: 'takeaways', takeaways: ['요점 하나가 한 줄에 들어가지 않을 만큼 길어지면 어떻게 되는지 확인하기 위한 항목입니다'], closing: '닫는 문장도 아주 길게 만들어서 축소가 일어나는지 봅니다 정말로 길게' },
        { kind: 'timeline', variant: 'rail', title: '로드맵', steps: [{ label: '아주 긴 단계 이름입니다', desc: '설명' }, { label: '두번째', desc: '설명' }] },
      ],
    },
  },
  // Auto-variety — repeated kinds with NO explicit variant must come out with
  // different faces. Guards layout/variety.ts against silent regression.
  {
    name: 'auto-variety',
    payload: {
      theme: 'vivid',
      slides: [
        { kind: 'cover', title: '커버 1' },
        { kind: 'cover', title: '커버 2' },
        { kind: 'cover', title: '커버 3' },
        { kind: 'toc', sections: ['가', '나'] },
        { kind: 'toc', sections: ['다', '라'] },
        { kind: 'toc', sections: ['마', '바'] },
        { kind: 'stats', items: [{ value: '1', label: 'a' }] },
        { kind: 'stats', items: [{ value: '2', label: 'b' }] },
        { kind: 'summary', takeaways: ['x'] },
        { kind: 'summary', takeaways: ['y'] },
        // section is deliberately NOT rotated — dividers keep one rhythm
        { kind: 'section', number: 1, title: '섹션 A' },
        { kind: 'section', number: 2, title: '섹션 B' },
      ],
    },
  },
  // The `layout` kind — 12-column grid composition
  {
    name: 'layout-grid',
    payload: {
      theme: 'charts',
      slides: [
        {
          kind: 'layout', title: '2열 + 스탯 행',
          blocks: [
            { span: 7, body: { type: 'paragraph', text: '상반기 성장의 핵심 동력은 숏폼 중심의 콘텐츠 전환이었습니다. 하반기에는 검증된 포맷을 유지하면서 전환 퍼널 하단을 보강합니다.' } },
            { span: 5, card: true, body: { type: 'bullets', items: ['재구매 62% SNS 유입', '리뷰 1위 발색', '20대 +9%p'] } },
            { span: 4, card: true, body: { type: 'stat', value: '+34%', label: '매출 성장', sublabel: 'YoY' } },
            { span: 4, card: true, body: { type: 'stat', value: '2.8x', label: 'ROAS' } },
            { span: 4, card: true, body: { type: 'stat', value: '41만', label: '신규 팔로워' } },
          ],
        },
        {
          kind: 'layout', title: '차트 + 사이드',
          blocks: [
            { span: 8, body: { type: 'chart', chartType: 'bar', categories: ['메타', '구글', '틱톡'], series: [{ name: '지출', values: [1.2, 0.8, 0.5] }] } },
            { span: 4, card: true, align: 'middle', body: { type: 'kv', rows: [{ k: '총 지출', v: '2.5억' }, { k: '총 매출', v: '7.3억' }, { k: 'ROAS', v: '2.9x' }] } },
            { span: 12, body: { type: 'quote', text: '고객은 제품이 아니라 달라진 자신을 산다', attribution: 'VOC 분석' } },
          ],
        },
        {
          kind: 'layout',
          blocks: [
            { span: 6, body: { type: 'heading', text: '제목 없는 레이아웃', level: 1 } },
            { span: 6, body: { type: 'heading', text: '오른쪽', level: 3 } },
            { break: true, span: 12, body: { type: 'image', imagePath: FIXTURE_IMAGE, caption: '캡션' } },
          ],
        },
      ],
    },
  },
  // Composite blocks + rich cover — the Claude-density recipes: kicker+chips
  // cover, step-stack agenda, funnel bands, on light + dark.
  ...(['composite-navy', 'composite-night'] as const).map((name) => ({
    name,
    payload: {
      title: name, theme: name === 'composite-night' ? 'night' : 'navy',
      slides: [
        {
          kind: 'cover' as const, variant: 'block' as const,
          kicker: 'Korea ⇄ Canada · Portfolio Strategy',
          title: 'EDIS Agency 채널 전략 & 퍼널 설계',
          subtitle: '종합 브랜드 계정 포지셔닝 · 콘텐츠 타입 → 퍼널 매핑',
          chips: ['내부 전략 정렬용', '메인 + 형제계정', '인벤토리 44개 분석'],
          date: '2026-08',
        },
        {
          kind: 'layout' as const, title: 'Agenda',
          blocks: [
            { body: { type: 'step' as const, number: 1, title: '문제', desc: '같은 콘텐츠가 여러 계정에 겹친다' } },
            { body: { type: 'step' as const, number: 2, title: '역할 재정의', desc: '종합 브랜드 계정으로 포지셔닝' } },
            { body: { type: 'step' as const, number: 3, title: '위임', desc: 'consumer-direct 는 형제계정으로' } },
            { body: { type: 'step' as const, number: 4, title: '퍼널 설계', desc: '4단계 퍼널 + 콘텐츠 타입 매핑' } },
            { body: { type: 'chips' as const, items: ['internal', 'v2 draft', '44 posts'] } },
          ],
        },
        {
          kind: 'layout' as const, title: '콘텐츠 퍼널',
          blocks: [
            { span: 7, body: { type: 'funnel' as const, stages: [
              { label: 'AWARENESS', desc: '브랜드 존재 알림' },
              { label: 'AUTHORITY', desc: '증거와 신뢰 축적' },
              { label: 'ACTION', desc: '비즈니스 대화 유도' },
            ] } },
            { span: 5, card: true, body: { type: 'bullets' as const, items: ['상단은 브로드하게', '하단은 CTA 로', '레이어별 콘텐츠 매핑'] } },
          ],
        },
      ] as SlideSpec[],
    },
  })),
  // Icon blocks — an icon row (the Anthropic "icon rows" recipe) light + dark.
  ...(['icons-twixy', 'icons-night'] as const).map((name) => ({
    name,
    payload: {
      title: name, theme: name === 'icons-night' ? 'night' : 'twixy',
      slides: [{
        kind: 'layout' as const, title: '아이콘 행',
        blocks: [
          { span: 4, card: true, body: { type: 'icon' as const, name: 'trending-up', label: '성장', sublabel: '+34% YoY' } },
          { span: 4, card: true, body: { type: 'icon' as const, name: 'users', label: '신규 고객', sublabel: '41만' } },
          { span: 4, card: true, body: { type: 'icon' as const, name: 'rocket', label: '론칭', sublabel: '9월' } },
          { span: 6, body: { type: 'icon' as const, name: 'megaphone', label: '카드 없는 아이콘' } },
          { span: 6, body: { type: 'icon' as const, name: 'target' } },
        ],
      }],
    },
  })),
  // Brand derivation — one hex re-skins the palette; the named theme keeps
  // fonts/style/dark. Four fixtures prove the four composition rules.
  { name: 'brand-derived', payload: { title: 'Brand', theme: 'twixy', brand: '#FF5A5F', slides: ALL_KINDS } },
  { name: 'brand-derived-navy', payload: { title: 'Brand navy', theme: 'navy', brand: '#FF5A5F', slides: ALL_KINDS } },   // font/style inheritance
  { name: 'brand-derived-dark', payload: { title: 'Brand dark', theme: 'night', brand: '#FF5A5F', slides: ALL_KINDS } },  // dark is opt-in via theme
  { name: 'brand-plus-accent', payload: { title: 'Brand+accent', theme: 'twixy', brand: '#FF5A5F', accent: '#00B894', slides: ALL_KINDS } }, // override order
  // Seeded rotation — identical slide lists, different titles, NO explicit
  // variants. The baseline pins BOTH properties the seed exists for: (a) the
  // two decks come out with different faces, (b) each is stable run to run.
  ...(['seed-a', 'seed-b'] as const).map((name) => ({
    name,
    payload: {
      title: name === 'seed-a' ? 'Q3 Review' : 'Q4 Plan',
      theme: 'petrol',
      slides: [
        { kind: 'cover', title: '시드 테스트' },
        { kind: 'bullets', title: '불릿', bullets: ['하나', '둘', '셋', '넷'] },
        { kind: 'chart', title: '차트', chartType: 'bar', categories: ['A', 'B'], series: [{ name: 's', values: [1, 2] }], takeaway: '요점' },
        { kind: 'compare', title: '비교', left: { title: 'L', bullets: ['a'] }, right: { title: 'R', bullets: ['b'] } },
        { kind: 'table', title: '표', headers: ['k', 'v'], rows: [['a', '1'], ['b', '2']] },
        { kind: 'timeline', title: '타임라인', steps: [{ label: 's1', desc: 'd1' }, { label: 's2', desc: 'd2' }] },
        { kind: 'text', title: '텍스트', body: '첫 문단입니다. 내용이 이어집니다.\n\n둘째 문단입니다. 여기도 내용이 있습니다.' },
        { kind: 'section', number: 1, title: '섹션 A' },
        { kind: 'section', number: 2, title: '섹션 B' },
        { kind: 'summary', takeaways: ['정리'] },
      ] as SlideSpec[],
    },
  })),
  // untitled slides — the addHeader no-op path
  {
    name: 'no-titles',
    payload: {
      theme: 'charts',
      slides: [
        { kind: 'stats', variant: 'cards', items: [{ value: '1', label: 'a' }] },
        { kind: 'bullets', variant: 'rows', bullets: ['x'] },
        { kind: 'text', variant: 'rail', body: 'y' },
        { kind: 'chart', variant: 'full', chartType: 'bar', categories: ['A'], series: [{ name: 's', values: [1] }] },
        { kind: 'table', variant: 'grid', headers: ['h'], rows: [['v']] },
        { kind: 'timeline', variant: 'rail', steps: [{ label: 'one' }] },
        { kind: 'toc', variant: 'list', sections: ['only'] },
        { kind: 'summary', variant: 'takeaways', takeaways: ['t'] },
      ],
    },
  },
]
