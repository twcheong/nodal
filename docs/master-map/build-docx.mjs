// Master Map → docx (EN + KO). 데이터는 data/map.mjs 하나에서 온다.
// 사용: node docs/master-map/build-docx.mjs   → out/ 아래 두 파일 생성
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, WidthType, ShadingType, AlignmentType,
  TableOfContents, PageBreak, LevelFormat, convertInchesToTwip,
} from 'docx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from './data/map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const INK = '1F2A2E', MUTED = '5A6B70', ACCENT = '0E6E6E', HEAD_FILL = '0E6E6E', ROW_ALT = 'F3F7F7';
const FONT = 'Apple SD Gothic Neo';
const CONTENT_W = 9026;

function buildFor(lang) {
  const t = v => (v && typeof v === 'object' && ('en' in v)) ? v[lang] : v;
  const S = (en, ko) => (lang === 'en' ? en : ko);
  const statusLabel = key => t(M.statuses[key].label);
  const statusColor = key => M.statuses[key].color;

  const run = (text, o = {}) => new TextRun({ text, bold: o.bold, italics: o.italics, color: o.color ?? INK, size: o.size ?? 21, font: FONT });
  const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after ?? 120 }, alignment: o.align, children: Array.isArray(text) ? text : [run(text, o)] });
  const h1 = s => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 }, children: [run(s)] });
  const h2 = s => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 120 }, children: [run(s)] });
  const note = s => p(s, { italics: true, color: MUTED, size: 19, after: 160 });
  const bullet = s => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60 }, children: [run(s)] });
  const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

  const cell = (text, { width, fill, bold, color } = {}) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: fill ? { type: ShadingType.CLEAR, fill } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ spacing: { after: 0 }, children: [run(String(text), { bold, color, size: 19 })] })],
  });
  // rows: [{ cells: [...], statusKey? per-cell via objects {v, status} }]
  const table = (headers, rows, { statusCol = -1 } = {}) => new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: headers.map(h => h.width),
    rows: [
      new TableRow({ tableHeader: true, children: headers.map(h => cell(h.label, { width: h.width, fill: HEAD_FILL, bold: true, color: 'FFFFFF' })) }),
      ...rows.map((r, i) => new TableRow({
        children: r.map((v, ci) => {
          let text = v, fill = i % 2 ? ROW_ALT : undefined;
          if (v && typeof v === 'object' && 'statusKey' in v) { text = statusLabel(v.statusKey); if (ci === statusCol) fill = statusColor(v.statusKey); }
          return cell(text, { width: headers[ci].width, fill, bold: ci === 0 });
        }),
      })),
    ],
  });
  const st = key => ({ statusKey: key });

  const goalName = id => t(M.goals.find(g => g.id === id).name);
  const backlogById = id => M.backlog.find(b => b.id === id);
  const linkLabel = link => link === 'chore' ? S('- (engineering chore)', '- (엔지니어링 작업)')
    : link === 'sales' ? S('Sales scope - excluded', 'Sales 범위 - 제외')
    : (() => { const b = backlogById(link); return b ? `${t(b.name)} (${b.release})` : '-'; })();

  const children = [];

  // Title page
  children.push(new Paragraph({ spacing: { before: 2400, after: 200 }, alignment: AlignmentType.CENTER, children: [run(M.meta.title, { bold: true, size: 72, color: ACCENT })] }));
  children.push(p([run(t(M.meta.subtitle), { size: 36 })], { align: AlignmentType.CENTER }));
  children.push(p([run(t(M.meta.stamp), { size: 22, color: MUTED })], { align: AlignmentType.CENTER, after: 60 }));
  children.push(p([run(t(M.meta.salesNote), { italics: true, size: 19, color: MUTED })], { align: AlignmentType.CENTER, after: 0 }));
  children.push(pageBreak());

  // TOC
  children.push(h1(S('Contents', '목차')));
  children.push(new TableOfContents(S('Table of Contents', '목차'), { hyperlink: true, headingStyleRange: '1-2' }));
  children.push(pageBreak());

  // 1. Vision
  children.push(h1(S('1. Product Vision', '1. 제품 비전')));
  children.push(p(M.vision.headline.map(seg => run(t(seg.t), { bold: seg.bold }))));
  children.push(h2(S('1.1 Core framing', '1.1 핵심 프레이밍')));
  M.vision.framing.forEach(b => children.push(bullet(t(b))));
  children.push(h2(S('1.2 What the product is today', '1.2 오늘의 제품')));
  children.push(p(t(M.vision.today)));
  children.push(h2(S('1.3 The Adaptive Process ladder', '1.3 Adaptive Process 단위 사다리')));
  children.push(note(t(M.adaptiveProcess.intro)));
  children.push(table(
    [{ label: S('Stage', '단계'), width: 1700 }, { label: S('Unit', '단위'), width: 1300 }, { label: S('Definition', '정의'), width: 3826 }, { label: S('In this map', '이 맵에서'), width: 2200 }],
    M.adaptiveProcess.stages.map(s => [s.stage, t(s.unit), t(s.def), t(s.section)]),
  ));
  children.push(pageBreak());

  // 2. Goals
  children.push(h1(S('2. Business Goals (Development)', '2. 비즈니스 목표 (개발)')));
  children.push(note(S(`Sales goals are excluded and will be redefined separately. Statuses reflect the August 2026 audit; new goals were rolled up bottom-up from shipped work and the Jira board. Updated column: '${M.BASELINE}' marks the initial audit baseline; later changes carry their own date.`, `Sales 목표는 제외했으며 별도로 재정의합니다. 상태는 2026년 8월 전수 조사 기준이며, 신규 목표는 출시된 작업과 Jira 보드에서 역방향으로 그루핑해 올린 것입니다. 갱신 열: '${M.BASELINE}'은 초기 전수조사 기준선이며, 이후 변경분에만 개별 날짜를 찍습니다.`)));
  children.push(table(
    [{ label: '#', width: 500 }, { label: S('Business Goal', '비즈니스 목표'), width: 2250 }, { label: S('Description', '설명'), width: 3800 }, { label: S('Status', '상태'), width: 950 }, { label: S('Quarter', '분기'), width: 726 }, { label: S('Updated', '갱신'), width: 800 }],
    M.goals.map((g, i) => [String(i + 1), t(g.name), t(g.desc), st(g.status), g.quarter, g.updated ?? M.BASELINE]),
    { statusCol: 3 },
  ));
  children.push(pageBreak());

  // 3. Roadmap matrix
  const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
  const byQ = Object.fromEntries(quarters.map(q => [q, M.goals.filter(g => g.matrixQuarter === q)]));
  const maxRows = Math.max(...quarters.map(q => byQ[q].length), 1);
  children.push(h1(S('3. Product Roadmap', '3. 제품 로드맵')));
  children.push(note(S('Business goals arrayed by target quarter (Dev track only). Q2-Q3 columns are shipped; goals spanning Q3-Q4 sit in their completion quarter.', '비즈니스 목표를 목표 분기별로 진열했습니다 (Dev 트랙만). Q2·Q3 열은 출시 완료, Q3-Q4에 걸친 목표는 완료 예정 분기에 배치했습니다.')));
  children.push(table(
    quarters.map((q, i) => ({ label: `Quarter ${i + 1}`, width: i === 3 ? 2258 : 2256 })),
    Array.from({ length: maxRows }, (_, r) => quarters.map(q => byQ[q][r] ? t(byQ[q][r].name) : (r === 0 && !byQ[q].length ? '-' : ''))),
  ));
  children.push(pageBreak());

  // 4. Backlog
  children.push(h1(S('4. Product Backlog', '4. 제품 백로그')));
  children.push(note(S('Development items only; statuses corrected against the code audit. Sprint-level chores (TWIX-13, 38, 39) stay in section 6.', '개발 항목만 수록. 상태는 코드 전수 조사로 정정. 스프린트 수준의 일회성 작업(TWIX-13, 38, 39)은 6장에만 남깁니다.')));
  children.push(table(
    [{ label: S('Feature / Work Package', '기능 / 워크 패키지'), width: 2250 }, { label: S('Pri', '순위'), width: 450 }, { label: S('Business Goal', '비즈니스 목표'), width: 2000 }, { label: S('Rel', '릴리스'), width: 550 }, { label: S('Status', '상태'), width: 1000 }, { label: S('Notes', '비고'), width: 1526 }, { label: S('Branch', '브랜치'), width: 1250 }, { label: S('Updated', '갱신'), width: 700 }],
    M.backlog.map((b, i) => [t(b.name), String(i + 1), goalName(b.goal), b.release ?? 'U', st(b.status), t(b.notes), b.branch ?? '-', b.updated ?? M.BASELINE]),
    { statusCol: 4 },
  ));
  children.push(pageBreak());

  // 5. Release plan (derived)
  const relCols = M.releases;
  const relItems = relCols.map(r => M.backlog.filter(b => (b.release ?? null) === r.id));
  const relMax = Math.max(...relItems.map(a => a.length), 1);
  children.push(h1(S('5. Release Plan', '5. 릴리스 계획')));
  children.push(note(S('All backlog items arrayed by release, derived from each item’s release field. Releases 0-1 are shipped; 2-4 are planned.', '백로그의 모든 항목을 릴리스별로 진열했습니다(각 항목의 release 필드에서 파생). Release 0-1은 출시 완료, 2-4는 예정입니다.')));
  children.push(table(
    relCols.map((r, i) => ({ label: t(r.label), width: i === relCols.length - 1 ? 1506 : 1504 })),
    Array.from({ length: relMax }, (_, i) => relItems.map((items, c) => items[i] ? t(items[i].name) : (i === 0 && !items.length ? '-' : ''))),
  ));
  children.push(p('', { after: 120 }));
  children.push(table(
    [{ label: S('Release', '릴리스'), width: 1800 }, { label: S('Criteria', '기준'), width: 7226 }],
    relCols.map(r => [t(r.label), t(r.criteria)]),
  ));
  children.push(h2(S('5.1 Release Backlog — Epics', '5.1 Release Backlog — 에픽')));
  children.push(note(S('Features assigned to a release, decomposed into epics. Story drafts feed sprint planning (Jira).', '릴리스에 배정된 Feature를 에픽으로 분해한 것. 스토리 초안은 스프린트 계획(Jira) 때 가져다 씁니다.')));
  children.push(table(
    [{ label: S('Epic', '에픽'), width: 2100 }, { label: S('Rel', '릴리스'), width: 550 }, { label: S('Scope', '범위'), width: 3100 }, { label: S('Story drafts', '스토리 초안'), width: 2076 }, { label: S('Branch', '브랜치'), width: 1200 }],
    M.epics.map(e => [t(e.name), e.release, t(e.scope), e.stories.map(s => '• ' + t(s)).join('  '), e.branch ?? '-']),
  ));
  children.push(pageBreak());

  // 6. Sprint backlog
  children.push(h1(S('6. Sprint Backlog', '6. 스프린트 백로그')));
  children.push(note(`${S(`Pulled from the Jira TWIX board on ${M.sprint.fetchedAt}. `, `${M.sprint.fetchedAt} Jira TWIX 보드 기준. `)}${t(M.sprint.modelNote)}`));
  children.push(h2(`6.1 ${S('Active sprint', '활성 스프린트')} — ${t(M.sprint.name)}`));
  children.push(table(
    [{ label: S('Key', '키'), width: 900 }, { label: S('Work item', '작업 항목'), width: 3300 }, { label: S('Tag', '태그'), width: 800 }, { label: S('Status', '상태'), width: 800 }, { label: S('Linked feature (release)', '연결 Feature (릴리스)'), width: 3226 }],
    M.sprint.items.map(it => [it.key, t(it.title), t(it.tag), st(it.status), linkLabel(it.link)]),
    { statusCol: 3 },
  ));
  children.push(h2(`6.2 ${S('Jira product backlog', 'Jira 제품 백로그')} (${M.sprint.backlogItems.length})`));
  children.push(table(
    [{ label: S('Key', '키'), width: 900 }, { label: S('Work item', '작업 항목'), width: 3300 }, { label: S('Status', '상태'), width: 800 }, { label: S('Linked feature (release)', '연결 Feature (릴리스)'), width: 2400 }, { label: S('Code reality', '코드 현실'), width: 1626 }],
    M.sprint.backlogItems.map(it => [it.key, t(it.title), st(it.status), linkLabel(it.link), it.reality ? t(it.reality) : '-']),
    { statusCol: 2 },
  ));
  children.push(pageBreak());

  // 7. Sprint board (derived)
  const todo = M.sprint.items.filter(i => i.status === 'jiraTodo');
  const done = M.sprint.items.filter(i => i.status === 'jiraDone');
  children.push(h1(S('7. Sprint Board', '7. 스프린트 보드')));
  children.push(note(t(M.sprint.boardNote)));
  children.push(table(
    [{ label: S('Column', '컬럼'), width: 1800 }, { label: S('Count', '개수'), width: 900 }, { label: S('Items', '항목'), width: 6326 }],
    [
      [S('To Do', '할 일'), String(todo.length), todo.map(i => i.key).join(', ') || '-'],
      [S('In Progress', '진행 중'), '0', '-'],
      [S('Done', '완료'), String(done.length), done.map(i => i.key).join(', ') || '-'],
    ],
  ));
  children.push(pageBreak());

  // 8. Increment
  children.push(h1(S('8. Product Increment — Current Feature Inventory', '8. Product Increment — 현재 기능 인벤토리')));
  children.push(note(t(M.incrementIntro.scrum)));
  children.push(p(t(M.incrementIntro.audit)));
  M.increment.forEach((a, i) => {
    children.push(h2(`8.${i + 1} ${t(a.area)}`));
    if (a.note) children.push(note(t(a.note)));
    children.push(table(
      [{ label: S('Feature', '기능'), width: 2900 }, { label: S('Status', '상태'), width: 1400 }, { label: S('Notes', '비고'), width: 4726 }],
      a.rows.map(([f, s, n]) => [t(f), st(s), t(n)]),
      { statusCol: 1 },
    ));
  });
  children.push(pageBreak());

  // 9. Personas
  children.push(h1(S('9. User Personas', '9. 사용자 페르소나')));
  M.personas.forEach((per, i) => {
    children.push(h2(`9.${i + 1} ${t(per.title)}`));
    children.push(table(
      [{ label: S('Field', '항목'), width: 1800 }, { label: S('Description', '내용'), width: 7226 }],
      per.fields.map(([k, v]) => [t(k), t(v)]),
    ));
  });
  children.push(pageBreak());

  // Appendix
  children.push(h1(S('Appendix A. Known Gaps & DoD Debt', '부록 A. 알려진 격차 & DoD 부채')));
  children.push(note(t(M.appendix.intro)));
  M.appendix.groups.forEach(g => {
    children.push(h2(t(g.title)));
    g.bullets.forEach(b => children.push(bullet(t(b))));
  });

  return new Document({
    styles: {
      default: { document: { run: { font: FONT, size: 21, color: INK } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, color: ACCENT, font: FONT }, paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 25, bold: true, color: INK, font: FONT }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
      ],
    },
    numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.15) } } } }] }] },
    features: { updateFields: true },
    sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }],
  });
}

for (const lang of ['en', 'ko']) {
  const doc = buildFor(lang);
  const name = lang === 'en' ? 'Twixy Product Vision and Dev Plan.docx' : 'Twixy 제품 비전 및 개발 계획.docx';
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log('written', path.join('docs/master-map/out', name), buf.length, 'bytes');
}
