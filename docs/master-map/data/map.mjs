// Twixy Master Map — single source of truth.
// 모든 문서(웹, docx EN/KO)는 이 파일에서 생성된다. 수정은 여기서만 하고 커밋한다.
// 규칙: 모든 사람이 읽는 문자열은 L(en, ko) 병기. 상태는 statuses 키로만 쓴다.

export const L = (en, ko) => ({ en, ko });

export const meta = {
  title: 'Twixy',
  subtitle: L('Product Vision & Development Plan', '제품 비전 & 개발 계획'),
  stamp: L('Updated August 2026 · v0.1.0 · Development-only edition', '2026년 8월 업데이트 · v0.1.0 · 개발 전용 판'),
  salesNote: L(
    'Sales goals and materials are intentionally excluded and will be rewritten separately.',
    'Sales 목표와 자료는 의도적으로 제외했으며, 추후 별도로 재작성합니다.',
  ),
};

// 갱신일 표기 규칙: 초기 전수조사(2026-08)로 들어온 항목은 개별 날짜 대신 BASELINE 하나로 통일.
// 이후 추가/수정되는 항목에만 updated: 'YYYY-MM-DD' 를 개별로 찍는다.
export const BASELINE = '2026-08';

// 브랜치 표기 규칙: 그 작업이 실제로 이뤄진 git 브랜치를 backlog/epics 의 branch 에 적는다.
// 진행 중이거나 앞으로 추가되는 항목은 필수. 초기 전수조사분 중 브랜치를 확정할 수 없는 과거
// 작업은 비워둔다 (추측해서 적지 않는다). 병합돼 사라진 브랜치도 이름은 그대로 남긴다.

// Adaptive Process 단계 정의 — Course 1860 Module 6 (+PMBOK) 기준, 이 문서의 장에 대응.
export const adaptiveProcess = {
  intro: L(
    'The granularity ladder this map follows. Each stage has a fixed unit of work; content flows left to right.',
    '이 맵이 따르는 단위 사다리. 단계마다 작업 단위가 정해져 있고, 내용은 왼쪽에서 오른쪽으로 흐른다.',
  ),
  stages: [
    { stage: 'Product Roadmap', unit: L('Objective', '목표(Objective)'),
      def: L('Objectives arrayed over quarters - the picture of where the product is headed.', '분기 위에 목표를 진열한 그림 - 제품이 어디로 가는지의 큰 방향.'),
      section: L('§3 - business goals placed on Q1-Q4', '3장 - 비즈니스 목표의 분기 배치') },
    { stage: 'Product Backlog', unit: L('Feature', '기능(Feature)'),
      def: L('Every feature of the product, prioritized, each tied to a roadmap objective.', '제품의 모든 기능을 우선순위와 함께 나열하고, 각각을 로드맵 목표에 귀속.'),
      section: L('§4 - 27+ features linked to goals', '4장 - 목표에 귀속된 Feature 목록') },
    { stage: 'Release Backlog', unit: L('Epic', '에픽(Epic)'),
      def: L('The subset of the product backlog chosen for one release, broken into epics. A release sets expectations for dates, features, and outcomes (MVP / MBI).', 'Product Backlog에서 그 릴리스에 만들 것만 뽑아 에픽 단위로 쪼갠 부분집합. 릴리스는 날짜·기능·기대 성과를 가진다 (MVP / MBI).'),
      section: L('§5 - release plan matrix + per-release epics', '5장 - 릴리스 매트릭스 + 릴리스별 에픽') },
    { stage: 'Sprint Backlog', unit: L('User Story', '유저 스토리'),
      def: L('User stories pulled from the release backlog at sprint planning by customer value and fit; only the dev team modifies it during the sprint.', '스프린트 계획 때 Release Backlog에서 고객 가치·수행 가능성 기준으로 뽑은 스토리. 스프린트 중에는 개발팀만 수정.'),
      section: L('§6 - Jira sprint items (TWIX-xx)', '6장 - Jira 스프린트 항목 (TWIX-xx)') },
    { stage: 'Sprint Board', unit: L('Task', '태스크'),
      def: L('The sprint stories decomposed into tasks moving To Do → In Progress → Done; unfinished tasks return to the release backlog.', '스토리를 태스크로 분해해 할 일 → 진행 → 완료로 이동. 못 끝낸 태스크는 Release Backlog로 반환.'),
      section: L('§7 - Jira board columns', '7장 - Jira 보드 컬럼') },
    { stage: 'Product Increment', unit: L('Customer Value', '고객 가치'),
      def: L('Value actually delivered: the sum of items completed this sprint plus all previous increments, all meeting the definition of Done.', '실제로 전달된 가치: 이번 스프린트 완료분 + 이전 증분의 누적. 전부 Done의 정의(DoD) 충족.'),
      section: L('§8 + Appendix A - shipped inventory & DoD debt', '8장 + 부록 A - 출시 인벤토리와 DoD 부채') },
  ],
};

export const statuses = {
  done:     { label: L('Done', '완료'), color: 'DDF0E4' },
  shipped:  { label: L('Shipped', '완료'), color: 'DDF0E4' },
  hidden:   { label: L('Built (hidden)', '구현됨(숨김)'), color: 'DEE9F7' },
  shelved:  { label: L('Built (shelved)', '구현됨(보류)'), color: 'DEE9F7' },
  beta:     { label: L('Beta', '베타'), color: 'FBF0D5' },
  partial:  { label: L('Partial', '부분'), color: 'FBF0D5' },
  todo:     { label: L('To Do', '예정'), color: 'EEEEEE' },
  planned:  { label: L('Planned', '예정'), color: 'EEEEEE' },
  q4:       { label: L('Q4', 'Q4'), color: 'EEEEEE' },
  jiraTodo: { label: L('To Do', '할 일'), color: 'EEEEEE' },
  jiraDone: { label: L('Done', '완료'), color: 'DDF0E4' },
};

// ───────────────────────── 1. Vision ─────────────────────────
export const vision = {
  headline: [
    { t: L('For small and medium marketing agency owners (2–10 person teams) who need AI automation within their workspace, ', '워크스페이스 안에서 AI 자동화가 필요한 2–10인 규모의 중소 마케팅 에이전시 대표를 위해, ') },
    { t: L('Twixy is an AI-native marketing IDE', 'Twixy는 AI 네이티브 마케팅 IDE'), bold: true },
    { t: L(' that provides marketing-specialized agentic AI: dedicated Chrome-based browser automation, repeatable workflow node systems, and a deliverable-generation engine (decks, reports, spreadsheets). Unlike Claude Co-work, Twixy provides a synchronized, scalable environment for the whole marketing team — shared workflows, run visibility, and per-member credit management — with zero technical exposure for non-coding marketers.', '로서 마케팅에 특화된 에이전틱 AI를 제공합니다: 전용 Chrome 기반 브라우저 자동화, 반복 가능한 워크플로 노드 시스템, 그리고 산출물 생성 엔진(덱·리포트·스프레드시트). Claude Co-work와 달리, Twixy는 마케팅 팀 전체를 위한 동기화되고 확장 가능한 환경 — 워크플로 공유, 실행 가시성, 멤버별 크레딧 관리 — 을 코딩을 모르는 마케터에게 기술 노출 없이 제공합니다.') },
  ],
  framing: [
    L('Explain a process once, and Twixy executes it from then on — research, organize, and turn it into a document in a single run ("collect → analyze → deliver").', '과정을 한 번만 설명해두면, 다음부터는 Twixy가 대신 실행합니다 — 조사하고, 정리하고, 문서로 만드는 일을 한 번의 실행으로 ("모으고 → 분석하고 → 문서로").'),
    L('We do not replace the tools an agency already uses; we take over the work between tools (e.g., Search Console → Excel → report).', '에이전시가 이미 쓰는 툴을 대체하지 않습니다. 툴과 툴 사이의 일을 대신합니다 (예: Search Console → Excel → 리포트).'),
    L('A good employee’s way of working stops living only inside their head — processes become shared, reusable team assets.', '일 잘하는 직원의 일하는 방식이 그 사람 머릿속에만 머무르지 않게 됩니다 — 프로세스가 공유 가능하고 재사용 가능한 팀 자산이 됩니다.'),
    L('The real competitor is not another product; it is the founder’s memory, a pile of open tabs, and copy-paste.', '진짜 경쟁자는 다른 제품이 아니라, 대표의 기억력, 열려 있는 탭 더미, 그리고 복사-붙여넣기입니다.'),
    L('Radical honesty: the product and its documents keep a strict "works today / in preparation" split. This document follows the same rule.', '철저한 정직함: 제품과 문서는 "지금 됩니다 / 준비 중입니다" 구분을 엄격히 유지합니다. 이 문서도 같은 원칙을 따릅니다.'),
  ],
  today: L(
    'Twixy is a signed, notarized desktop app (macOS and Windows) with a chat-first Copilot as the main surface. Three Copilot modes cover the product’s three jobs: one-off tasks (Simple), repeatable automation (Workflow), and deliverable production (Content — the PPTX deck engine). A bundled local agent runtime executes work in a dedicated headless Chrome profile, files stay on the user’s machine, and team features (sharing, run dashboards, credits) run on a hosted backend.',
    'Twixy는 서명·공증된 데스크톱 앱(macOS·Windows)이며, 채팅 중심의 Copilot이 메인 화면입니다. 세 가지 Copilot 모드가 제품의 세 가지 역할을 담당합니다: 일회성 작업(Simple), 반복 자동화(Workflow), 산출물 제작(Content — PPTX 덱 엔진). 앱에 내장된 로컬 에이전트 런타임이 전용 헤드리스 Chrome 프로필에서 작업을 실행하고, 파일은 사용자 기기에 남으며, 팀 기능(공유·실행 대시보드·크레딧)은 호스팅 백엔드에서 동작합니다.',
  ),
};

// ───────────────────────── 2. Business Goals ─────────────────────────
// matrixQuarter: 로드맵 매트릭스에서 배치되는 열 (Q3-Q4 걸친 목표는 완료 예정 분기)
export const goals = [
  { id: 'ide',          name: L('Build an AI-Native Marketing IDE', 'AI 네이티브 마케팅 IDE 구축'), desc: L('A dedicated workspace where agency teams design, run, and manage AI-powered marketing workflows.', '에이전시 팀이 AI 기반 마케팅 워크플로를 설계·실행·관리하는 전용 워크스페이스.'), status: 'done', quarter: 'Q2', matrixQuarter: 'Q2' },
  { id: 'agentic',      name: L('Enable Agentic AI Workflow Creation', '에이전틱 AI 워크플로 작성'), desc: L('Users create repeatable AI workflows from natural language with minimal manual input.', '자연어로 반복 가능한 AI 워크플로를 최소한의 수작업으로 생성.'), status: 'done', quarter: 'Q2', matrixQuarter: 'Q2' },
  { id: 'chrome',       name: L('Support Chrome-Based Task Automation', 'Chrome 기반 작업 자동화'), desc: L('Browser automation in a dedicated managed Chrome profile so agents execute real marketing tasks across web tools.', '전용 관리 Chrome 프로필에서의 브라우저 자동화 - 에이전트가 웹 툴 전반에서 실제 마케팅 작업을 실행.'), status: 'done', quarter: 'Q2', matrixQuarter: 'Q2' },
  { id: 'nodes',        name: L('Create Reusable Workflow Node Systems', '재사용 가능한 워크플로 노드 시스템'), desc: L('Build, save, modify, and reuse workflow nodes for repetitive marketing operations.', '반복적인 마케팅 작업을 위한 워크플로 노드의 생성·저장·수정·재사용.'), status: 'done', quarter: 'Q2', matrixQuarter: 'Q2' },
  { id: 'teamsync',     name: L('Provide Team Synchronization Features', '팀 동기화 기능 제공'), desc: L('Shared workspaces: workflow sharing and copying, team run visibility, presence and DMs.', '공유 워크스페이스: 워크플로 공유와 복사, 팀 실행 가시성, 프레즌스와 DM.'), status: 'done', quarter: 'Q3', matrixQuarter: 'Q3' },
  { id: 'visibility',   name: L('Improve Workflow Visibility and Control', '워크플로 가시성과 통제 개선'), desc: L('Runs dashboard, per-node execution logs, failure classification, resume-from-failure.', 'Runs 대시보드, 노드별 실행 로그, 실패 분류, 실패 지점부터 재개.'), status: 'done', quarter: 'Q3', matrixQuarter: 'Q3' },
  { id: 'deliverable',  name: L('Build a Deliverable Generation Engine', '산출물 생성 엔진 구축'), desc: L('NEW. Client-ready deliverables (decks first) with design quality the user controls: themes, brand color, visual QA, import/edit.', '신규. 사용자가 디자인 품질을 통제하는 고객 납품 수준의 산출물(덱 우선): 테마, 브랜드 색, 시각 QA, 임포트/편집.'), status: 'done', quarter: 'Q3', matrixQuarter: 'Q3' },
  { id: 'data',         name: L('Enable Large-Scale Data Collection & Analysis', '대규모 데이터 수집·분석'), desc: L('NEW. Bulk collection and SQL analysis that keep the model off the data path (fetch-to-file + query-data).', '신규. 모델을 데이터 경로에서 배제한 대량 수집과 SQL 분석 (fetch-to-file + query-data).'), status: 'done', quarter: 'Q3', matrixQuarter: 'Q3' },
  { id: 'guardrails',   name: L('Ship Guardrails and Execution Safety', '가드레일과 실행 안전성'), desc: L('NEW. Approval modes, file-write sandboxing, read/write action split, fail-closed quotas.', '신규. 승인 모드, 파일 쓰기 샌드박스, 읽기/쓰기 액션 구분, fail-closed 쿼터.'), status: 'done', quarter: 'Q3', matrixQuarter: 'Q3' },
  { id: 'monetize',     name: L('Build Monetization Infrastructure', '수익화 인프라 구축'), desc: L('NEW. Free/Pro entitlements, hosted proxy, usage sync, org credit pools with per-member allocation.', '신규. Free/Pro 사용량 체계, 호스팅 프록시, 사용량 동기화, 멤버별 배분이 가능한 조직 크레딧 풀.'), status: 'done', quarter: 'Q3', matrixQuarter: 'Q3' },
  { id: 'uiux',         name: L('Deliver a Cohesive UI/UX System', '일관된 UI/UX 시스템 구축'), desc: L('NEW. Design tokens, atom components, Storybook, and the Paper/Petrol rebrand with dual theme (covers Jira TWIX-42/43).', '신규. 디자인 토큰, 아톰 컴포넌트, Storybook, Paper/Petrol 리브랜딩과 듀얼 테마 (Jira TWIX-42/43 포함).'), status: 'done', quarter: 'Q3', matrixQuarter: 'Q3' },
  { id: 'distribution', name: L('Ship a Distributable, Operable Desktop Product', '배포·운영 가능한 데스크톱 제품'), desc: L('NEW. Code signing and notarization, installers, bundled runtime, update rollout, and server-migration groundwork (Jira TWIX-27-32, 29, 45).', '신규. 코드 서명·공증, 인스톨러, 내장 런타임, 업데이트 배포, 서버 이관 기반 작업 (Jira TWIX-27-32, 29, 45).'), status: 'partial', quarter: 'Q3-Q4', matrixQuarter: 'Q4' },
  { id: 'cowork',       name: L('Match the Claude Co-work Capability Baseline', 'Claude Co-work 기능 기준선 충족'), desc: L('NEW. Keep pace with Claude Co-work: full feature list-up and gap analysis done (TWIX-33/34); gap closure ongoing.', '신규. Co-work와 보조 맞추기: 기능 전수 리스트업과 갭 분석 완료 (TWIX-33/34), 갭 해소는 진행 중.'), status: 'partial', quarter: 'Q3-Q4', matrixQuarter: 'Q4' },
  { id: 'orchestration',name: L('Enable Multi-Workflow Orchestration', '멀티 워크플로 오케스트레이션'), desc: L('NEW. Coordinate multiple workflows and AI agents (pipeline / parallel / research / relay). Built; release decision pending.', '신규. 여러 워크플로와 AI 에이전트의 조율 (pipeline / parallel / research / relay). 구현 완료, 공개 결정 대기.'), status: 'hidden', quarter: 'Q4', matrixQuarter: 'Q4' },
  { id: 'workspace',    name: L('Ensure Scalable Workspace Management', '확장 가능한 워크스페이스 관리'), desc: L('Multiple users and reusable assets shipped; granular roles/permissions beyond admin-member still open.', '다중 사용자와 재사용 자산은 출시됨. admin/member를 넘는 세분화 권한은 미해결.'), status: 'partial', quarter: 'Q3-Q4', matrixQuarter: 'Q4' },
  { id: 'quality',      name: L('Maintain Reliable AI Output Quality', '신뢰할 수 있는 AI 산출물 품질'), desc: L('Human Review nodes and deck visual QA shipped; automated run review is weak and a formal approval flow is missing.', 'Human Review 노드와 덱 시각 QA는 출시됨. 자동 실행 리뷰가 약하고 공식 승인 플로가 없음.'), status: 'partial', quarter: 'Q3-Q4', matrixQuarter: 'Q4' },
  { id: 'onboarding',   name: L('Support Customer Onboarding and Activation', '고객 온보딩과 활성화 지원'), desc: L('Founder-led onboarding today (about 3 hours in week one) plus written manuals; in-app guided onboarding and a template gallery are not built.', '현재: 창업자 직접 온보딩(첫 주 약 3시간) + 문서. 인앱 가이드 온보딩과 템플릿 갤러리는 미구축.'), status: 'todo', quarter: 'Q4', matrixQuarter: 'Q4' },
  { id: 'integration',  name: L('Prepare for Future Integration Expansion', '향후 연동 확장 준비'), desc: L('Google Workspace live; MCP entry exists; broader marketing/CRM/analytics integrations still to design.', 'Google Workspace 운영 중, MCP 엔트리 존재. 마케팅/CRM/분석 툴 연동 확대는 설계 필요.'), status: 'partial', quarter: 'Q4', matrixQuarter: 'Q4' },
  { id: 'funnel',       name: L('Connect Marketing Work to Funnel Outcomes', '마케팅 업무-퍼널 성과 연결'), desc: L('NEW. Define and track the sales/marketing funnel inside the product, and show immediately how marketing actions executed with Twixy (workflow runs) move funnel metrics - merging "marketing work" and "business outcomes" into one view.', '신규. 세일즈/마케팅 퍼널을 제품 안에서 정의·트래킹하고, Twixy로 실행한 마케팅 행동(워크플로 run)이 퍼널 지표에 미치는 영향을 즉시 보여준다 - 분리돼 있던 "마케팅 업무"와 "비즈니스 성과"를 한 화면으로.'), status: 'partial', quarter: 'Q4', matrixQuarter: 'Q4', updated: '2026-08-21' },
];

// ───────────────────────── 4. Product Backlog ─────────────────────────
// release: 'R0'..'R4' | null(Unassigned). goal: goals[].id
export const backlog = [
  { id: 'ide-workspace',   name: L('AI-Native Marketing IDE Workspace', 'AI 네이티브 마케팅 IDE 워크스페이스'), goal: 'ide', release: 'R0', status: 'done', notes: L('3-mode chat-first Copilot is the main surface.', '3모드 채팅 중심 Copilot이 메인 화면.') },
  { id: 'design-system',   name: L('Design System & Rebrand', '디자인 시스템 & 리브랜딩'), goal: 'uiux', branch: 'feature/paper-petrol-theme', release: 'R1', status: 'done', notes: L('Paper/Petrol dual theme, tokens + atoms, Storybook. Jira TWIX-42/43 still say To Do - shipped Aug.', 'Paper/Petrol 듀얼 테마, 토큰+아톰, Storybook. Jira TWIX-42/43은 아직 할 일이지만 8월 출시됨.') },
  { id: 'wf-builder',      name: L('Agentic AI Workflow Builder', '에이전틱 AI 워크플로 빌더'), goal: 'agentic', release: 'R0', status: 'done', notes: L('NL-to-spec builder chat + node canvas.', '자연어→스펙 빌더 챗 + 노드 캔버스.') },
  { id: 'chrome-module',   name: L('Chrome-Based Task Automation Module', 'Chrome 기반 작업 자동화 모듈'), goal: 'chrome', release: 'R0', status: 'done', notes: L('Managed profile, live interactive preview, parallel slots.', '관리 프로필, 라이브 인터랙티브 프리뷰, 병렬 슬롯.') },
  { id: 'node-system',     name: L('Reusable Workflow Node System', '재사용 워크플로 노드 시스템'), goal: 'nodes', release: 'R0', status: 'done', notes: L('3 node types, 9-tool catalog, tags, versions.', '노드 3종, 9종 툴 카탈로그, 태그, 버전.') },
  { id: 'team-workspace',  name: L('Shared Team Workspace', '공유 팀 워크스페이스'), goal: 'teamsync', branch: 'feature/team-dashboard', release: 'R1', status: 'done', notes: L('Sharing, copy, archive, presence, DM. Covers Jira TWIX-40.', '공유·복사·아카이브·프레즌스·DM. Jira TWIX-40 포함.') },
  { id: 'runs-dashboard',  name: L('Workflow Status Dashboard', '워크플로 상태 대시보드'), goal: 'visibility', branch: 'feature/team-dashboard', release: 'R1', status: 'done', notes: L('Runs dashboard incl. team runs.', '팀 실행 포함 Runs 대시보드.') },
  { id: 'exec-logs',       name: L('Workflow Execution Logs', '워크플로 실행 로그'), goal: 'visibility', branch: 'feature/team-dashboard', release: 'R1', status: 'done', notes: L('Per-node logs with cost/token deltas; failure log upload.', '비용·토큰 포함 노드별 로그, 실패 로그 업로드.') },
  { id: 'session-reports', name: L('Session Issue Reporting', '세션 이슈 리포트'), goal: 'visibility', branch: 'feature/team-dashboard', release: 'R1', status: 'done', notes: L('Redacted log upload + ticket code.', '민감정보 제거 로그 업로드 + 티켓 코드.') },
  { id: 'deck-engine',     name: L('PPTX Deck Generation Engine', 'PPTX 덱 생성 엔진'), goal: 'deliverable', branch: 'feature/pptx-skill-upgrade', release: 'R1', status: 'done', notes: L('Incl. Deck Designer, visual QA, import and design-preserving edit.', 'Deck Designer, 시각 QA, 임포트와 디자인 보존 편집 포함.') },
  { id: 'data-pipeline',   name: L('Data Pipeline Tools', '데이터 파이프라인 툴'), goal: 'data', release: 'R1', status: 'done', notes: L('fetch-to-file + query-data (DuckDB SQL).', 'fetch-to-file + query-data (DuckDB SQL).') },
  { id: 'file-ingest',     name: L('File Ingest & Truncation Contract', '파일 인제스트 & 잘림 계약'), goal: 'data', release: 'R1', status: 'done', notes: L('xlsx/docx/pptx/pdf extraction.', 'xlsx/docx/pptx/pdf 추출.') },
  { id: 'guardrail-sys',   name: L('Guardrail & Approval System', '가드레일 & 승인 시스템'), goal: 'guardrails', release: 'R1', status: 'done', notes: L('3 modes + designated-path sandbox.', '3모드 + 지정 경로 샌드박스.') },
  { id: 'member-credits',  name: L('Per-Member Credit Allocation', '멤버별 크레딧 배분'), goal: 'monetize', branch: 'feature/team-dashboard', release: 'R1', status: 'done', notes: L('Org credit pool, live 2026-08-11. Covers Jira TWIX-41.', '조직 크레딧 풀, 2026-08-11부터 운영. Jira TWIX-41 포함.') },
  { id: 'google-ws',       name: L('Google Workspace Integration', 'Google Workspace 연동'), goal: 'integration', release: 'R1', status: 'done', notes: L('OAuth; Docs/Sheets read-write.', 'OAuth, Docs/Sheets 읽기·쓰기.') },
  { id: 'distribution-pkg',name: L('Desktop Distribution & Code Signing', '데스크톱 배포 & 코드 서명'), goal: 'distribution', release: 'R1', status: 'done', notes: L('macOS signed and notarized, Windows installer. Covers TWIX-30/31/32.', 'macOS 서명·공증, Windows 인스톨러. TWIX-30/31/32 포함.') },
  { id: 'server-migration',name: L('Server Migration Infrastructure', '서버 이관 인프라'), goal: 'distribution', release: 'R4', status: 'partial', updated: '2026-09-17', notes: L('Diagram and quotes done (TWIX-27/28); speed analysis (TWIX-29) and migration itself to do. Thin-client design added 2026-09: Twixy is intentionally local-first (tools run on the user machine), so only IP assets + pure compute move server-side. Existing beachhead = twixy.dev/api/* (Supabase-token auth + proxy, e.g. /api/tavily-proxy). Phased plan — P1 serve harness/SOUL/workflow prompts from server (fetch at runtime, so the asar no longer ships the secret prompts) [recommended start]; P2 offload heavy pptx/xlsx render to /api/render/*; P3 orchestration stays local (conflicts with local-first). Server side lives in the separate twixy.dev repo.', '구조도·견적 완료 (TWIX-27/28), 속도 분석(TWIX-29)과 이관 자체는 예정. 2026-09 thin-client 설계 추가: Twixy 는 의도적 로컬-우선(툴이 사용자 PC 에서 실행)이라 IP 자산 + 순수 연산만 서버로 이전. 발판 이미 존재 = twixy.dev/api/*(Supabase 토큰 인증+프록시, 예 /api/tavily-proxy). 단계안 — P1 하네스/SOUL/워크플로 프롬프트를 서버에서 런타임 fetch(asar 에 비밀 프롬프트 미포함)[권장 시작], P2 무거운 pptx/xlsx 렌더를 /api/render/* 로, P3 오케스트레이션은 로컬 유지(로컬-우선과 충돌). 서버측 코드는 별도 twixy.dev 레포.') },
  { id: 'update-rollout',  name: L('Update Notification Rollout', '업데이트 알림 배포'), goal: 'distribution', release: 'R2', status: 'todo', notes: L('Supabase app_release + download_url (TWIX-45).', 'Supabase app_release + download_url (TWIX-45).') },
  { id: 'cowork-gap',      name: L('Co-work Benchmark & Gap Closure', 'Co-work 벤치마크 & 갭 해소'), goal: 'cowork', release: 'R3', status: 'partial', notes: L('List-up and gap analysis done (TWIX-33/34); closure work to do.', '리스트업·갭 분석 완료 (TWIX-33/34), 해소 작업은 예정.') },
  { id: 'orchestration-f', name: L('Orchestration & AI Agents', '오케스트레이션 & AI Agents'), goal: 'orchestration', branch: 'feature/orchestration-tab', release: 'R3', status: 'hidden', notes: L('Complete but hidden in MVP; release decision pending.', '완성됐으나 MVP에서 숨김, 공개 결정 대기.') },
  { id: 'scheduling',      name: L('Scheduled Workflow Execution', '워크플로 예약 실행'), goal: 'visibility', release: 'R2', status: 'todo', notes: L('No scheduler exists today.', '현재 스케줄러 없음.') },
  { id: 'onboarding-flow', name: L('Agency User Onboarding Flow', '에이전시 사용자 온보딩 플로'), goal: 'onboarding', release: 'R2', status: 'todo', notes: L('In-app guided first-run; today onboarding is founder-led.', '인앱 가이드 첫 실행 경험. 현재는 창업자 직접 온보딩.') },
  { id: 'template-lib',    name: L('Starter Workflow Template Library', '스타터 워크플로 템플릿 라이브러리'), goal: 'onboarding', release: 'R2', status: 'todo', notes: L('200 designed / 21 specs built; no in-app gallery yet.', '설계 200개 / 스펙 21개 구축. 인앱 갤러리는 아직 없음.') },
  { id: 'roles-perms',     name: L('Workspace Roles and Permissions System', '워크스페이스 역할·권한 시스템'), goal: 'workspace', release: 'R3', status: 'partial', notes: L('admin/member shipped; granular roles to do.', 'admin/member는 출시. 세분화 역할은 예정.') },
  { id: 'output-approval', name: L('AI Output Review and Approval System', 'AI 산출물 검토·승인 시스템'), goal: 'quality', release: 'R3', status: 'partial', notes: L('Human Review node + deck QA shipped; formal approval flow to do.', 'Human Review 노드 + 덱 QA는 출시. 공식 승인 플로는 예정.') },
  { id: 'verification',    name: L('Verification Debt Closure', '검증 부채 해소'), goal: 'quality', release: 'R3', status: 'todo', notes: L('Deck-path E2E, 2-account share/archive E2E, skill-sync staleness.', '덱 경로 E2E, 2계정 공유/아카이브 E2E, 스킬 동기화 staleness.') },
  { id: 'integration-plan',name: L('Future Integration Architecture Plan', '향후 연동 아키텍처 계획'), goal: 'integration', release: 'R4', status: 'q4', notes: L('MCP-based connector strategy.', 'MCP 기반 커넥터 전략.') },
  { id: 'funnel-tracking', name: L('Funnel Design & Tracking', '퍼널 설계·트래킹'), goal: 'funnel', branch: 'feature/funnel-tracking', release: 'R2', status: 'partial', updated: '2026-08-25', notes: L('E1/E2 shipped 2026-08-21, then promoted to a dedicated chat-first Funnel tab (2026-08-24) and extended with a Funnel↔Copilot action channel (E5, 2026-08-25). Now: content items per stage under the 3-layer Master Content Document concept (org_funnel_items), document/conversation/AI input converging on one model, a per-funnel document library with 2-pass selection, browser-driven KPI collection, archive plus admin-only permanent delete, and handed-off Copilot runs whose deliverables return to the requesting funnel. E3 (run-event overlay) → R3, E4 (connectors) → R4 remain.', 'E1/E2 를 2026-08-21 출시한 뒤 전용 채팅 Funnel 탭으로 승격(2026-08-24)하고, Funnel↔Copilot 액션 채널(E5, 2026-08-25)까지 확장. 현재: 3-Layer 마스터 콘텐츠 문서 개념에 따른 단계별 콘텐츠 아이템(org_funnel_items), 문서/대화/AI 입력의 단일 모델 수렴, 2-pass 선별이 붙은 퍼널별 문서 보관함, 브라우저 KPI 자동 수집, 아카이브 + admin 전용 영구 삭제, 그리고 핸드오프한 Copilot run 의 산출물이 요청한 퍼널로 회귀. E3(run 이벤트 오버레이) → R3, E4(커넥터) → R4 잔존.') },
  { id: 'harness-ab',     name: L('Execution-Harness A/B & Quality Eval', '실행 하네스 A/B & 품질 평가'), goal: 'quality', branch: 'main', release: 'R3', status: 'done', updated: '2026-09-17', notes: L('Per-run runner harness (v2 tool-economy / v3 reasoning-thoroughness) + a headless eval (scripts/wf-eval.mjs) that drives the gateway directly (no GUI) and scores each run with a cross-provider LLM judge (Claude via OpenRouter). Surfaced that status:done hides empty runs — judged quality is the real metric. Measured on the SEO action plan (MiniMax, n=5): the v3 reasoning harness raised judged quality ~19% over baseline at lower average cost. Shipped to main 2026-09: v3 is the DEFAULT-ON harness (disable via localStorage twixy.runnerHarness=off); the harmful v2 tool-economy harness was retired; the eval runner is formalized as scripts/wf-eval.mjs for re-checking future harness/model changes.', 'run 별 러너 하네스(v2 tool-economy / v3 추론-철저) + 게이트웨이를 직접 구동하는 헤드리스 eval(scripts/wf-eval.mjs, GUI 없음), 교차검증 LLM judge(Claude via OpenRouter)로 run 별 품질 채점. status:done 이 빈 run 을 숨긴다는 걸 드러냄 — 판정 품질이 진짜 지표. SEO 액션플랜 실측(MiniMax, n=5): v3 추론 하네스가 baseline 대비 판정 품질 ~19%↑, 평균 비용은 오히려 낮음. 2026-09 main 반영: v3 를 기본 ON(끄기 localStorage twixy.runnerHarness=off), 품질을 해치던 v2 tool-economy 하네스는 폐기, eval 러너는 scripts/wf-eval.mjs 로 정식화해 향후 하네스/모델 변경 재검증에 사용.') },
  { id: 'prod-hardening', name: L('Production Security Hardening', '프로덕션 보안 하드닝'), goal: 'guardrails', branch: 'main', release: 'R2', status: 'partial', updated: '2026-08-25', notes: L('Packaged-build hardening: gateway token auth enforced in prod (allowInsecureAuth off), DevTools disabled, renderer sandbox on. Untrusted-HTML sanitization shipped 2026-09 (DOMPurify across 15 render sites - the real XSS surface via marked-rendered LLM/scraped content). CSP still to do.', '패키징 빌드 하드닝: 프로덕션 토큰 인증 강제(allowInsecureAuth off), DevTools 비활성, 렌더러 sandbox on. 신뢰불가 HTML sanitize 는 2026-09 출시(DOMPurify, 렌더 사이트 15곳 - marked 렌더 LLM/스크랩 콘텐츠의 실제 XSS 표면). CSP 는 미완.') },
  { id: 'model-m3',       name: L('Main Model Migration → MiniMax M3', '메인 모델 마이그레이션 → MiniMax M3'), goal: 'distribution', branch: 'main', release: 'R2', status: 'done', updated: '2026-08-25', notes: L('Fireworks deprecates MiniMax M2.7 serverless (2026-08-27); migrated the pinned main model to minimax/minimax-m3 with OpenRouter auto-routing (Fireworks no longer serves it), same pricing, larger context. Existing users auto-migrate on next launch.', 'Fireworks 가 MiniMax M2.7 serverless 를 deprecate(2026-08-27) → 핀 메인 모델을 minimax/minimax-m3 로, OpenRouter 자동 라우팅(Fireworks 미서빙), 가격 동일·컨텍스트 확대. 기존 사용자는 다음 실행에서 자동 전환.') },
  { id: 'model-cot-off',  name: L('Disable MiniMax Native Chain-of-Thought', 'MiniMax 네이티브 CoT 끄기'), goal: 'distribution', branch: 'main', release: 'R2', status: 'done', updated: '2026-09-15', notes: L('The catalog flag `reasoning: false` reads as a capability declaration ("this model cannot reason"), not a switch: OpenClaw only emits a reasoning field when the model declares reasoning, so it sent nothing and MiniMax’s default thinking stayed on. It never worked - across 671 MiniMax sessions (2026-04 to 08, M2.7 and M2.7:highspeed) thinkingLevel was `off` in every one, yet 98.2% of assistant messages (10,300 of 10,492) carried thinking blocks. The reported 2m49s / 45,333-token turn was the M3-era tail, not a regression: median thinking is comparable across the two models but the maximum grew 27.6k to 97.6k chars. Fixed by declaring `reasoning: true` (M3 is in fact a reasoning model) plus per-model `params.thinking: off`, which makes OpenClaw emit `reasoning: { effort: none }` - OpenRouter’s documented full disable - with `reasoningDefault: off` on all three agents so no reasoning text can reach chat. Measured on OpenRouter with one multi-step deck-edit prompt: output 791 to 261 tokens (-67%), 12.5s to 7.5s, thinking 2,409 to 0 chars, answer not degraded. Caveat: the v3 runner-harness A/B (+19%) under `harness-ab` was measured with native thinking on, so workflow-run quality needs re-measuring against this baseline. `maxTokens: 196608` is untouched.', '카탈로그의 `reasoning: false` 는 끄는 스위치가 아니라 "이 모델은 추론 기능이 없다" 는 능력 선언으로 읽힌다. OpenClaw 는 모델이 추론 가능하다고 선언한 경우에만 reasoning 필드를 싣기 때문에 아무것도 안 보냈고, MiniMax 기본값(thinking ON)이 그대로 적용됐다. 처음부터 한 번도 작동한 적이 없다 - MiniMax 세션 671개(2026-04~08, M2.7 및 M2.7:highspeed) 전부 thinkingLevel 이 `off` 인데도 assistant 메시지의 98.2%(10,492개 중 10,300개)가 thinking 블록을 달고 있었다. 제보된 2분49초 / 45,333토큰 턴은 M3 회귀가 아니라 꼬리다: 중앙값은 두 모델이 비슷하고 최대값만 27.6k → 97.6k자로 늘었다. 수정: `reasoning: true` 선언(M3 는 실제로 추론 모델이다) + per-model `params.thinking: off` → OpenClaw 가 `reasoning: { effort: none }`(OpenRouter 문서상 완전 비활성화)을 보내게 된다. 에이전트 3종에 `reasoningDefault: off` 를 박아 추론 텍스트가 채팅에 새지 않게 막았다. OpenRouter 실측(다단계 덱 수정 프롬프트 1회): 출력 791 → 261토큰(-67%), 12.5초 → 7.5초, thinking 2,409 → 0자, 답변 품질 저하 없음. 단서: `harness-ab` 의 v3 러너 하네스 A/B(+19%)는 네이티브 thinking 이 켜진 상태에서 잰 값이라, 워크플로 실행 품질은 이 기준선에서 재측정해야 한다. `maxTokens: 196608` 은 건드리지 않았다.') },
  { id: 'run-report-email', name: L('Run Result Email Reports', '실행 결과 이메일 리포트'), goal: 'visibility', branch: 'main', release: 'R2', status: 'partial', updated: '2026-08-25', notes: L('Emails each workflow run result/error to the executor via a Supabase Edge Function (send-report). Runs-dashboard toggle (off / failures-only / all). Non-blocking add-on; Resend/template polish pending.', '워크플로 run 결과/오류를 실행자 본인에게 Supabase Edge Function(send-report)으로 발송. Runs 대시보드 토글(off / 실패만 / 전부). run 흐름 방해 없는 부가기능. Resend/템플릿 다듬기 잔여.') },
  { id: 'worklog-jira',     name: L('Worklog → Jira Automation (MVP)', '업무일지 → Jira 자동화 (MVP)'), goal: 'integration', branch: 'main', release: 'R3', status: 'partial', updated: '2026-08-25', notes: L('"Read the worklog and automate it": the copilot reads a worklog (WORKLOG_GUIDE in copilotSoul) and drafts Jira issues; SettingsPanel carries a Jira preset. MVP / WIP.', '"업무 읽고 자동화": copilot 이 업무일지를 읽어(copilotSoul WORKLOG_GUIDE) Jira 이슈 초안 생성, SettingsPanel Jira 프리셋. MVP / WIP.') },
  { id: 'bundle-slim',    name: L('Installer Bundle Slimming', '설치 번들 슬림화'), goal: 'distribution', branch: 'main', release: 'R2', status: 'done', updated: '2026-09-17', notes: L('Install time (the #1 user complaint) is dominated by file count + antivirus scanning. Removed the redundant openclaw copy shipped via extraResources (resources/node_modules ~626MB — the gateway actually runs from app.asar.unpacked, so it was dead weight) and excluded unused openclaw extensions (diffs/feishu/amazon-bedrock/docs ~112MB; loader is lazy so safe). x64 installer 427MB → 295MB (-31%), file count roughly halved. Gateway startup verified on the slimmed build. Code signing (the other big install lever) still pending.', '설치 시간(사용자 최다 불만)은 파일 수 + 백신 스캔이 좌우. extraResources 로 중복 싣던 openclaw 사본(resources/node_modules ~626MB — 게이트웨이는 app.asar.unpacked 에서 실행되어 죽은 무게) 제거 + 미사용 openclaw 확장(diffs/feishu/amazon-bedrock/docs ~112MB, 로더가 lazy 라 안전) 제외. x64 설치본 427MB → 295MB(-31%), 파일 수 약 절반. 슬림 빌드에서 게이트웨이 정상 기동 검증. 코드서명(또 다른 큰 레버)은 예정.') },
  { id: 'gateway-connect',name: L('Packaged Gateway Connect & Login Fix', '패키지 게이트웨이 연결·로그인 수정'), goal: 'distribution', branch: 'main', release: 'R2', status: 'done', updated: '2026-09-17', notes: L('The packaged app could not connect to its own gateway and re-login hung/destabilized the app. Two root causes fixed: (1) the prod control-UI handshake was rejected 1008 "device identity required" because the packaged renderer (file://) sends only a token, no device identity — set gateway.controlUi.allowInsecureAuth=true (loopback-only + token; openclaw audit rates it warn). (2) ensureWorkspace rewrote openclaw.json with a fresh gateway literal that dropped gateway.auth.token every time, so each login regenerated the token → gateway restart loop → instability; fixed by preserving the existing gateway block. Also confirmed browser workflows (GBP/SEO crawl) connect and run in the packaged file:// condition (no separate browser device-identity gate). Verified end-to-end: login works, browser workflow produces crawl output.', '패키지 앱이 자기 게이트웨이에 연결되지 않고 재로그인 시 앱이 멈추거나 흔들렸다. 근본 원인 2개 수정: (1) 패키지 렌더러(file://)가 토큰만 보내고 device identity 를 안 보내 prod control-UI 핸드셰이크가 1008 "device identity required" 로 거절 → gateway.controlUi.allowInsecureAuth=true(루프백 전용+토큰, openclaw audit warn 등급). (2) ensureWorkspace 가 openclaw.json 재작성 시 gateway 리터럴이 gateway.auth.token 을 매번 떨궈 로그인마다 토큰 재생성 → 게이트웨이 재시작 루프 → 불안정; 기존 gateway 블록 보존으로 수정. 브라우저 워크플로(GBP/SEO 크롤)도 패키지 file:// 조건에서 연결·실행 확인(별도 브라우저 device-identity 게이트 없음). end-to-end 검증: 로그인 정상, 브라우저 워크플로 크롤 산출.') },
];

// ───────────────────────── Release Backlog — Epics ─────────────────────────
// feature: backlog[].id. stories: 스프린트 계획 때 Jira 티켓으로 가져다 쓰는 초안.
export const epics = [
  { id: 'E1', feature: 'funnel-tracking', branch: 'feature/funnel-tracking', release: 'R2', updated: '2026-08-25',
    name: L('E1 - Define the funnel and put metrics in', 'E1 - 퍼널을 정의하고 지표를 넣을 수 있다'),
    scope: L('Stage templates + custom stages, multiple named funnels (your own company or a client - the name says which; no separate client entity), standard 3-stage structure (Awareness→Consideration→Conversion) with a traceable KPI, value type and target per stage. Content items follow the 3-layer Master Content Document concept (fixed product concept): L1 common types carry no funnel and are never duplicated (item_config.master_types), L2 funnel types pick exactly one stage (item_config.types), L3 is the actual uploaded content (org_funnel_items) and is the only layer drawn on the board; code naming is free-form and follows whatever the source document uses. A dedicated chat-first Funnel tab (CT-style builder session, FUNNEL_SOUL) drives all of it: funnel-spec / metric-set / item-ops / collect-plan / copilot-handoff blocks, 3-state parser (conversation | ok | invalid) with one silent auto-fix retry (the invalid turn is removed and the fix request hidden, so thinking simply continues) and an Apply gate - funnel data is Supabase-canonical, so nothing auto-applies. Input converges from attached documents (docx/xlsx extraction), plain conversation, or AI drafting; inventory tables ignore any Funnel Stage column in the file and are reclassified by caption intent through the L2 types. Uploads persist per funnel in a document library (org_funnel_documents) with FM-style 2-pass selection - a cheap model briefs each upload and picks which documents enter the context of the next turn (48k budget). collect-plan runs a workflow-runner Chrome session to fetch KPI numbers (source "collect"). The right panel is split into internal tabs (Board / Items / Docs / Trends / Setup) with Content(L3) and Type-system(L1·L2) board views; archive plus admin-only permanent delete via a security-definer RPC (archived items only). Dashboard keeps read-only cards; card click opens the tab. Shipped 2026-08-21, tab promoted 2026-08-24, 3-layer model and document library 2026-08-25; org-team only.', '3단계 표준 구조(Awareness→Consideration→Conversion) + 단계별 traceable KPI·단위·목표. 콘텐츠 아이템은 3-Layer 마스터 콘텐츠 문서 개념(제품 공식 개념)을 따른다: L1 공통 타입은 퍼널을 갖지 않고 복제하지 않으며(item_config.master_types), L2 퍼널 타입은 단계를 정확히 하나 고르고(item_config.types), L3 가 실제 업로드된 콘텐츠(org_funnel_items)이자 보드에 그려지는 유일한 레이어다. 코드명 표기는 정해진 게 아니라 원본 문서를 따른다. 전용 채팅 Funnel 탭(CT식 builder 세션, FUNNEL_SOUL)이 전부를 굴린다: funnel-spec / metric-set / item-ops / collect-plan / copilot-handoff 블록, 3-상태 파서(대화 | 정상 | 무효) + 조용한 자동 재요청 1회(무효 턴은 제거하고 수정 요청은 숨겨서 thinking 이 그대로 이어진다), 그리고 Apply 게이트 - 퍼널 데이터는 Supabase 정본이라 자동 반영이 없다. 입력은 문서 첨부(docx/xlsx 추출)·대화·AI 생성이 한 모델로 수렴하고, 인벤토리 표는 파일의 Funnel Stage 열을 무시하고 캡션 의도로 L2 타입을 거쳐 재분류한다. 업로드는 퍼널별 문서 보관함(org_funnel_documents)에 반영구 저장되며 FM식 2-pass 선별이 붙는다 - 싼 모델이 업로드를 브리핑하고 다음 턴 컨텍스트에 들어갈 문서를 고른다(예산 48k). collect-plan 은 workflow-runner 크롬 실행으로 KPI 수치를 기록한다(source "collect"). 우측 패널은 내부 탭(Board / Items / Docs / Trends / Setup)으로 나뉘고 보드는 Content(L3)·Type system(L1·L2) 두 뷰를 가진다. 아카이브 + admin 전용 영구 삭제(security-definer RPC, 아카이브 항목만). 대시보드는 읽기 전용 카드만 - 카드 클릭이 탭 진입. 2026-08-21 출시, 2026-08-24 탭 승격, 2026-08-25 3-Layer 모델·문서 보관함 반영. org 팀 전용.'),
    stories: [
      L('As an agency owner, I want a separate funnel per client, because the agency runs several clients at once.', '대표로서, 고객사별 퍼널을 따로 보고 싶다 - 에이전시는 여러 고객을 동시에 굴리기 때문이다.'),
      L('As an operations manager, I want to define funnel stages to match how we actually sell - stages differ per client.', '운영 매니저로서, 퍼널 단계를 우리 영업 방식에 맞게 직접 정의하고 싶다 - 고객사마다 단계가 다르다.'),
      L('As a specialist, I want to connect a metrics sheet once so I stop copying numbers by hand every week.', '스페셜리스트로서, 지표 시트를 한 번 연결해두면 매주 손으로 옮기지 않았으면 한다.'),
    ] },
  { id: 'E2', feature: 'funnel-tracking', branch: 'feature/funnel-tracking', release: 'R2', updated: '2026-08-21',
    name: L('E2 - See the funnel on the dashboard and export it', 'E2 - 대시보드에서 퍼널을 보고 내보낸다'),
    scope: L('Dashboard overview: value-proportional funnel chart (forced taper, auto log scale past 25x spread, per-unit link where units change), stage conversion, period comparison; full-page funnel board with per-stage sparkline + conversion trends (geometry/trend design ported from the personal Funnel Management project); PPTX report export via the deck engine (shared/deck untouched - values ride the funnel block desc). Spike verdict: DashboardPanel not reusable wholesale - SVG helpers extracted only. PDF export deferred. Shipped 2026-08-21.', 'Dashboard 오버뷰: 값 비례 퍼널 차트(강제 테이퍼, 25배 초과 시 로그 스케일, 단위 바뀌는 구간은 객단가), 단계 전환율, 기간 비교. 전용 풀페이지 보드 + 단계별 스파크라인·전환율 추이(지오메트리/추이 설계는 개인 Funnel Management 프로젝트에서 이식). 덱 엔진 PPTX 리포트(shared/deck 무수정 - 값은 funnel 블록 desc). 스파이크 결론: DashboardPanel 통재활용 불가 - SVG 헬퍼만 발췌. PDF 는 보류. 2026-08-21 출시.'),
    stories: [
      L('As an agency owner, I want the funnel and the team’s Twixy activity on one dashboard screen.', '대표로서, 퍼널 현황과 팀의 Twixy 활동을 대시보드 한 화면에서 보고 싶다.'),
      L('As a specialist, I want to export funnel changes as a report (deck/PDF) to send to the client.', '스페셜리스트로서, 퍼널 변화를 리포트(덱/PDF)로 뽑아 고객사에 보내고 싶다.'),
    ] },
  { id: 'E3', feature: 'funnel-tracking', release: 'R3', updated: '2026-08-21',
    name: L('E3 - Overlay team actions on the funnel', 'E3 - 팀 행동과 겹쳐 본다'),
    scope: L('Overlay team workflow-run events (org_workflow_runs) on the funnel metric timeline. Defined as a correlation timeline - no causal claims.', '팀 워크플로 run 이벤트(org_workflow_runs)를 퍼널 지표 타임라인에 겹쳐 표시. 상관 타임라인으로 정의 - 인과 주장 없음.'),
    stories: [
      L('As a team leader, I want to see which team actions preceded metric moves, to decide what to repeat next sprint.', '팀 리더로서, 어떤 팀 행동 뒤에 지표가 움직였는지 타임라인으로 보고 싶다 - 다음에 뭘 반복할지 정하기 위해.'),
      L('As a specialist, I want my runs shown against the funnel stage they touched, so reporting gets easier.', '스페셜리스트로서, 내가 돌린 워크플로가 퍼널 어느 단계에 기여했는지 보이면 보고가 쉬워진다.'),
    ] },
  { id: 'E4', feature: 'funnel-tracking', release: 'R4', updated: '2026-08-21',
    name: L('E4 - Metrics flow in automatically', 'E4 - 지표가 자동으로 들어온다'),
    scope: L('GA4, Search Console, ad platforms, CRM connectors replacing/augmenting manual ingestion; shared with the integration-expansion goal. Follow-up: funnel metrics as workflow inputs.', 'GA4·Search Console·광고 플랫폼·CRM 커넥터로 수동 수집을 대체/보강. 연동 확장 목표와 공유. 후속: 퍼널 지표를 워크플로 입력으로.'),
    stories: [
      L('As an operations manager, I want GA4/Search Console metrics to flow in automatically, so I maintain no collection workflows.', '운영 매니저로서, GA4·Search Console 지표가 자동으로 들어왔으면 한다 - 수집 워크플로를 유지보수하고 싶지 않다.'),
      L('As a workflow builder, I want funnel metrics as workflow inputs, to build automations like "metric drops → generate report".', '빌더로서, 퍼널 지표를 워크플로 입력으로 써서 "지표가 떨어지면 리포트 생성" 같은 자동화를 만들고 싶다.'),
    ] },
  { id: 'E5', feature: 'funnel-tracking', branch: 'feature/funnel-tracking', release: 'R2', updated: '2026-08-25',
    name: L('E5 - Hand real work to Copilot, get the result back in the funnel', 'E5 - 실제 작업은 Copilot 에 맡기고 결과를 퍼널로 돌려받는다'),
    scope: L('A general action channel between the Funnel tab and the Copilot tab (CT), built around the builder/executor split: the funnel builder has no tools, so anything real (account audits, bulk collection, file-producing work) is handed off instead of claimed. Flow: a ```copilot-handoff``` block (goal / context / expects) → Apply "Send to Copilot" → a new CT conversation stamped with deliverTo (persisted in the conversation index, so it survives restarts) → the normal CT flow, run gate included → run completion is detected across every candidate workflow of that conversation (latest finished run wins; failed runs are delivered too, so the funnel never waits forever) → the result returns to the requesting funnel automatically. A status banner on the handoff conversation shows waiting / running / ready / delivered, with a manual "Deliver to funnel" ("Deliver again" after the first) button that also switches to that funnel. What travels back: files produced under data/ (only per-tab scratch data/raw/tab-* is excluded) ingested into the funnel document library with their full content injected, plus the last node output and a step breadcrumb - never the CT chat transcript, agent tool logs, or node prompts. The payload was tuned against real run logs (a 3.3KB rich JSON under data/raw versus a 206B lossy summary, and node narration that merely re-describes the delivered file). The returned document lands on the same import path as a manual attachment: item-ops proposals behind the Apply gate. Shipped 2026-08-25.', 'Funnel 탭과 Copilot 탭(CT) 사이의 범용 액션 채널. builder/executor 역할 분리를 전제로 한다 - 퍼널 builder 는 툴이 없으므로 본격 작업(계정 audit, 대량 수집, 파일 산출)은 자기가 했다고 말하는 대신 넘긴다. 흐름: ```copilot-handoff``` 블록(goal / context / expects) → Apply "Send to Copilot" → deliverTo 가 스탬프된 새 CT 대화(대화 인덱스에 영속 - 재시작에도 유지) → run 게이트 포함 기존 CT 흐름 → 그 대화의 후보 워크플로 전체에서 run 종료를 감지(가장 최근 종료 run 채택, 실패 run 도 배달해 퍼널이 무한 대기하지 않는다) → 결과가 요청한 퍼널로 자동 회귀. 핸드오프 대화 상단 배너가 대기 / 실행 중 / 준비됨 / 전달됨 상태를 보여주고, 수동 "Deliver to funnel"(재전달은 "Deliver again") 버튼이 전달과 동시에 그 퍼널 탭으로 이동시킨다. 돌아가는 것: data/ 아래 산출 파일(제외는 탭 스크래치 data/raw/tab-* 뿐)을 퍼널 문서 보관함에 인제스트하고 본문을 주입, 여기에 마지막 노드 output 과 단계 브레드크럼. CT 채팅 기록·에이전트 툴 로그·노드 프롬프트는 넘기지 않는다. 페이로드는 실제 run 로그로 조정했다(data/raw 의 3.3KB 리치 JSON 대 206B 열화 요약, 그리고 배달된 파일을 재설명할 뿐인 노드 서술). 회귀한 문서는 수동 첨부와 같은 임포트 경로를 탄다 - Apply 게이트 뒤의 item-ops 제안. 2026-08-25 출시.'),
    stories: [
      L('As a specialist, I want to ask the funnel assistant for an account audit and have the resulting inventory land in this funnel, so I stop shuttling files between tabs.', '스페셜리스트로서, 퍼널 어시스턴트에게 계정 audit 을 요청하면 그 결과 인벤토리가 이 퍼널에 그대로 들어왔으면 한다 - 탭 사이로 파일을 나르고 싶지 않다.'),
      L('As an operations manager, I want to see whether a handed-off job is waiting, running, or already delivered, and to deliver it again myself when I need to.', '운영 매니저로서, 넘긴 작업이 대기 중인지·실행 중인지·이미 전달됐는지 보이고, 필요하면 내가 직접 다시 전달할 수 있었으면 한다.'),
      L('As an agency owner, I do not want the assistant claiming work it has no tools to do.', '대표로서, 어시스턴트가 툴도 없으면서 자기가 했다고 말하지 않았으면 한다.'),
    ] },
];

// ───────────────────────── 5. Release Plan ─────────────────────────
export const releases = [
  { id: null, label: L('Unassigned', 'Unassigned'), criteria: L('Items not yet assigned to a release (currently none).', '아직 릴리스에 배정되지 않은 항목 (현재 없음).') },
  { id: 'R0', label: L('Release 0 – MVP (Q2)', 'Release 0 – MVP (Q2)'), criteria: L('Completed core MVP features (shipped, Q2).', '완료된 코어 MVP 기능 (출시됨, Q2).') },
  { id: 'R1', label: L('Release 1 – MBI (Q3)', 'Release 1 – MBI (Q3)'), criteria: L('Team collaboration, visibility, deliverables, data, trust, UI/UX, and distribution (shipped, Q3 / Aug 2026).', '팀 협업, 가시성, 산출물, 데이터, 신뢰, UI/UX, 배포 (출시됨, Q3 / 2026년 8월).') },
  { id: 'R2', label: L('Release 2 – MBI (Q4)', 'Release 2 – MBI (Q4)'), criteria: L('Customer onboarding, activation, and operations rollout (next).', '고객 온보딩, 활성화, 운영 배포 (다음).') },
  { id: 'R3', label: L('Release 3 – MBI (Q4)', 'Release 3 – MBI (Q4)'), criteria: L('Scalable workspace management, quality control, Co-work gap closure, and hidden-feature release decisions.', '확장 가능한 워크스페이스 관리, 품질 통제, Co-work 갭 해소, 숨김 기능 공개 결정.') },
  { id: 'R4', label: L('Release 4 – MBI (Q4~)', 'Release 4 – MBI (Q4~)'), criteria: L('Q4 expansion: integration architecture and server migration.', 'Q4 확장: 연동 아키텍처와 서버 이관.') },
];

// ───────────────────────── 6-7. Sprint (Jira) ─────────────────────────
// link: backlog[].id | 'chore' | 'sales'. 스프린트 보드(7장)는 items의 status에서 파생된다.
export const sprint = {
  fetchedAt: '2026-08-21',
  name: L('TWIX 1 Sprint 3 (Jul 20-25, 12 items)', 'TWIX 1 스프린트 3 (7/20-7/25, 12개)'),
  boardNote: L(
    'The sprint window (Jul 20-25) has passed but the sprint has not been completed in Jira; story points are not in use.',
    '스프린트 기간(7/20-7/25)은 지났지만 Jira에서 스프린트 완료 처리가 되지 않았고, 스토리 포인트는 사용하지 않는 상태입니다.',
  ),
  modelNote: L(
    'Model note: a sprint backlog should be a task-level subset of the current release backlog; this sprint actually mixes items from Releases 1-4, so the linkage column makes each item traceable to its feature and release. The board also lags the codebase - several To Do items shipped in August per the Product Increment section.',
    '모델 관점 주석: 스프린트 백로그는 원칙적으로 현재 릴리스 백로그의 태스크 수준 부분집합이어야 하는데, 이 스프린트는 실제로 Release 1-4의 항목이 섞여 있어 연결 열로 각 항목이 어느 Feature·릴리스에 속하는지 추적하게 했습니다. 보드는 코드베이스보다 뒤처져 있습니다 - "할 일" 중 여럿이 Product Increment 기준 8월에 이미 출시됐습니다.',
  ),
  items: [
    { key: 'TWIX-27', title: L('[INFRA] Draw infrastructure diagram (local-to-server migration architecture)', '[INFRA] 인프라 구조도 그리기 (로컬→서버 이관 아키텍처)'), tag: 'INFRA', status: 'jiraDone', link: 'server-migration' },
    { key: 'TWIX-28', title: L('[INFRA] Server quote research and documentation', '[INFRA] 서버 견적 조사 및 문서화'), tag: 'INFRA', status: 'jiraDone', link: 'server-migration' },
    { key: 'TWIX-30', title: L('[INFRA] Research code-signing certificate types and requirements', '[INFRA] 코드 서명 인증서 종류/요건 조사'), tag: 'INFRA', status: 'jiraDone', link: 'distribution-pkg' },
    { key: 'TWIX-31', title: L('[INFRA] Research certificate issuance process, cost, and timeline', '[INFRA] 코드 서명 인증서 발급 절차/비용/기간 조사'), tag: 'INFRA', status: 'jiraDone', link: 'distribution-pkg' },
    { key: 'TWIX-32', title: L('[INFRA] Plan main server setup after certificate acquisition', '[INFRA] 인증서 확보 후 메인 서버 개설 계획 수립'), tag: 'INFRA', status: 'jiraDone', link: 'distribution-pkg' },
    { key: 'TWIX-33', title: L('[DOCS] Full list-up of Claude Co-work features', '[DOCS] Claude Co-work 제공 기능 전수 리스트업'), tag: 'DOCS', status: 'jiraDone', link: 'cowork-gap' },
    { key: 'TWIX-34', title: L('[DOCS] Gap analysis: our product vs Co-work features', '[DOCS] Co-work 기능 대비 자사 제품 갭 분석'), tag: 'DOCS', status: 'jiraDone', link: 'cowork-gap' },
    { key: 'TWIX-38', title: L('[BE][FE] Branch merge: feature/mvp-prep + Sangin work branch', '[BE][FE] 브랜치 병합: feature/mvp-prep + 상인 작업 브랜치'), tag: 'BE·FE', status: 'jiraDone', link: 'chore' },
    { key: 'TWIX-39', title: L('[BE][FE] Conflict/test check before merge', '[BE][FE] 병합 전 충돌/테스트 점검'), tag: 'BE·FE', status: 'jiraDone', link: 'chore' },
    { key: 'TWIX-13', title: L('[FE] Clean up unused items in the client app (shared Supabase DB cleanup)', '[FE] 클라이언트(앱)에서 미사용 항목 정리 (공용 Supabase DB 정리)'), tag: 'FE', status: 'jiraTodo', link: 'chore' },
    { key: 'TWIX-24', title: L('Complete all features by the weekend + finish tab & workflow sharing', '주말까지 전체 기능 완료 + 탭·workflow 공유 마무리'), tag: L('Sched', '일정'), status: 'jiraTodo', link: 'team-workspace' },
    { key: 'TWIX-46', title: L('Org invite feature on twixy.dev/admin', 'org 기존 초대 기능 (twixy.dev/admin)'), tag: '-', status: 'jiraTodo', link: 'team-workspace' },
  ],
  backlogItems: [
    { key: 'TWIX-29', title: L('[INFRA] Analyze speed impact of server migration', '[INFRA] 서버 이관 시 속도 영향 분석'), status: 'jiraTodo', link: 'server-migration', reality: null },
    { key: 'TWIX-36', title: L('[DOCS] Sales kickoff prep (target/message/channel)', '[DOCS] 세일즈 킥오프 준비 (타겟/메시지/채널 확정)'), status: 'jiraTodo', link: 'sales', reality: null },
    { key: 'TWIX-37', title: L('[DOCS] Review sales materials (deck/demo)', '[DOCS] 세일즈 자료(데크/데모) 점검'), status: 'jiraTodo', link: 'sales', reality: null },
    { key: 'TWIX-40', title: L('[BE] Design workflow (WF) sharing system', '[BE] 워크플로우(WF) 공유 시스템 설계'), status: 'jiraTodo', link: 'team-workspace', reality: L('Shipped Aug', '8월 출시') },
    { key: 'TWIX-41', title: L('[BE] Design/build org credit admin management', '[BE] org 계정 크레딧 admin 관리 체계 설계/구현'), status: 'jiraTodo', link: 'member-credits', reality: L('Shipped Aug', '8월 출시') },
    { key: 'TWIX-42', title: L('[FE] Define UI redesign scope', '[FE] UI 개편 범위 정의'), status: 'jiraTodo', link: 'design-system', reality: L('Shipped Aug', '8월 출시') },
    { key: 'TWIX-43', title: L('[FE] UI redesign work (after merge)', '[FE] UI 개편 작업 (병합 이후 착수)'), status: 'jiraTodo', link: 'design-system', reality: L('Shipped Aug', '8월 출시') },
    { key: 'TWIX-45', title: L('Update notification rollout: Supabase app_release + download_url', '업데이트 알림 배포: Supabase app_release 설정 + download_url'), status: 'jiraTodo', link: 'update-rollout', reality: null },
  ],
};

// ───────────────────────── 8. Product Increment ─────────────────────────
export const incrementIntro = {
  scrum: L(
    'Scrum definition: the increment is the cumulative sum of backlog items completed across all sprints to date, and every item must meet the definition of Done. Items counted Done below that still miss full verification are listed in the appendix as definition-of-Done debt.',
    '스크럼 정의: increment는 지금까지의 모든 스프린트에서 완료된 백로그 항목의 누적 합이며, 모든 항목은 Done의 정의(DoD)를 충족해야 합니다. 아래에서 완료로 집계했지만 검증이 남은 항목은 부록에 DoD 부채로 정리했습니다.',
  ),
  audit: L('A code-and-docs audit of what actually exists as of August 2026.', '2026년 8월 기준, 코드와 문서를 전수 조사해 실제로 존재하는 것만 기록했습니다.'),
};

export const increment = [
  { area: L('Product Surface & Copilot', '제품 화면 & Copilot'), rows: [
    [L('Chat-first Copilot, 3 modes', '채팅 중심 Copilot, 3개 모드'), 'shipped', L('Simple (one-off tasks), Workflow (route to existing workflows or build new ones), Content (deck production). Default landing view.', 'Simple(일회성 작업), Workflow(기존 워크플로 라우팅 또는 신규 작성), Content(덱 제작). 기본 랜딩 화면.')],
    [L('Multi-tab conversations', '멀티탭 대화'), 'shipped', L('Parallel conversations per mode; closing a tab archives it (nothing is deleted).', '모드별로 여러 대화를 동시에 유지. 탭을 닫으면 삭제가 아니라 보관(archive).')],
    [L('Live activity stream + browser pane', '라이브 활동 스트림 + 브라우저 페인'), 'shipped', L('Right-side pane shows agent activity and the live headless-Chrome view during runs.', '실행 중 우측 페인에 에이전트 활동과 헤드리스 Chrome 실시간 화면 표시.')],
    [L('Mid-run steering', '실행 중 방향 조정'), 'shipped', L('Users can correct the agent by chat while it works; incremental correction instead of redo.', '작업 도중 채팅으로 교정 가능. 전체 재실행이 아닌 부분 수정.')],
    [L('File attach', '파일 첨부'), 'shipped', L('Drag-and-drop, @ recent-file picker, or plain filename mention.', '드래그앤드롭, @ 최근 파일 선택, 파일명 언급.')],
    [L('Silent turns', '침묵 턴'), 'shipped', L('App-to-model plumbing (specs, QA rounds) is hidden from the visible transcript.', '앱-모델 간 내부 통신(스펙, QA 라운드)은 대화창에서 숨김.')],
    [L('Session issue reporting', '세션 이슈 리포트'), 'shipped', L('Report button uploads a redacted session log bundle and returns a ticket code.', 'Report 버튼으로 민감정보 제거된 세션 로그 번들 업로드 + 티켓 코드 발급.')],
    [L('Overlay windows', '오버레이 창'), 'shipped', L('Always-on-top Sidetab overlay, detached Composer input, dedicated approval popup above fullscreen apps.', '항상 위 Sidetab 오버레이, 분리형 Composer 입력창, 풀스크린 위에도 뜨는 승인 팝업.')],
    [L('MVP sidebar', 'MVP 사이드바'), 'shipped', L('Copilot, Workflow, Dashboard, Data Management, Settings. Orchestration / Skills / MR / Admin / legacy Chat built but hidden.', 'Copilot, Workflow, Dashboard, Data Management, Settings. Orchestration / Skills / MR / Admin / 레거시 Chat은 구현됐으나 숨김.')],
  ]},
  { area: L('Workflow Builder & Node System', '워크플로 빌더 & 노드 시스템'), rows: [
    [L('Natural-language workflow builder', '자연어 워크플로 빌더'), 'shipped', L('Builder chat drafts a complete workflow spec on the first reply, then refines through conversation.', '빌더 챗이 첫 답변에서 완전한 워크플로 초안을 만들고, 이후 대화로 다듬음.')],
    [L('Visual node canvas', '비주얼 노드 캔버스'), 'shipped', L('Three node types: Action, Human Review, Validation.', '노드 3종: Action(실행), Human Review(사람 검토), Validation(검증).')],
    [L('Closed tool catalog (9 tools)', '닫힌 툴 카탈로그 (9종)'), 'shipped', L('chrome, web-fetch, read, write, edit, api, app, mcp, data - each with sub tool-skills. One node = one tool.', 'chrome, web-fetch, read, write, edit, api, app, mcp, data - 각각 하위 툴스킬 보유. 노드 하나 = 툴 하나.')],
    [L('Typed inputs + Ready-to-run card', '타입 있는 입력 + Ready-to-run 카드'), 'shipped', L('Inputs confirmed before execution; values edited by chatting.', '실행 전 입력값 확인. 값 수정은 폼이 아니라 채팅으로.')],
    [L('Real-LLM test runs, 3 in parallel', '실제 LLM 테스트 실행, 병렬 3개'), 'shipped', L('Not simulated. Per-run isolation: own abort, session, and Chrome profile slot.', '시뮬레이션이 아님. 실행마다 독립된 중단·세션·Chrome 프로필 슬롯.')],
    [L('Human Review node', 'Human Review 노드'), 'shipped', L('Execution pauses for a real decision: approve / send note / skip.', '실행이 실제 사람의 결정을 기다림: 승인 / 메모 전달 / 건너뛰기.')],
    [L('Per-node run logs', '노드별 실행 로그'), 'shipped', L('Status, output, duration, cost, and token deltas per node; full run history on disk.', '노드마다 상태·출력·소요시간·비용·토큰 기록. 전체 실행 이력 디스크 보관.')],
    [L('Failure recovery', '실패 복구'), 'shipped', L('Resume from the failed step, run from a chosen node, stop/resume controls.', '실패한 스텝부터 재개, 특정 노드부터 실행, 중지/재개.')],
    [L('Versioning & diff', '버전 관리 & diff'), 'shipped', L('Workflow diff view; shared workflows carry version history.', '워크플로 diff 뷰. 공유 워크플로는 버전 이력 보유.')],
    [L('Tags & types', '태그 & 타입'), 'shipped', L('Local tags (max 8) with filter chips; research vs execution types with output directories.', '로컬 태그(최대 8개)와 필터 칩. research/execution 타입 구분과 출력 폴더.')],
    [L('Automated run review', '자동 실행 리뷰'), 'partial', L('LLM critique of finished runs exists but is documented as weak; model upgrade proposed, not yet applied.', '완료된 실행에 대한 LLM 평가가 있으나 품질이 약하다고 문서화됨. 모델 업그레이드 제안됨, 미적용.')],
    [L('Scheduled / cron execution', '예약 / 크론 실행'), 'planned', L('Not implemented. Users press Run themselves.', '미구현. 실행 버튼은 사용자가 직접 누름.')],
  ]},
  { area: L('Chrome-Based Task Automation', 'Chrome 기반 작업 자동화'), rows: [
    [L('Dedicated managed Chrome profile', '전용 관리 Chrome 프로필'), 'shipped', L('Separate from the user’s own browser; core differentiator.', '사용자 본인의 브라우저와 분리. 핵심 차별점.')],
    [L('Headless + interactive live preview', '헤드리스 + 인터랙티브 라이브 프리뷰'), 'shipped', L('Headless by default; the in-app preview streams frames and accepts clicks/typing.', '기본은 헤드리스. 인앱 프리뷰가 프레임을 스트리밍하고 클릭·입력을 받음.')],
    [L('Local credential model', '로컬 자격증명 모델'), 'shipped', L('User logs in once per site inside the app’s browser; credentials stay in the local Chrome profile.', '사이트별 로그인은 앱 안의 브라우저에서 한 번만. 자격증명은 로컬 Chrome 프로필에만 저장.')],
    [L('Read/write action split', '읽기/쓰기 액션 구분'), 'shipped', L('Read-only actions run without confirmation; write actions stop and confirm. Human Review node advised before irreversible sends.', '읽기 전용은 무확인 실행. 쓰기는 멈추고 확인. 되돌릴 수 없는 전송 앞에는 Human Review 노드 권장.')],
    [L('Real execution, verified', '실제 실행, 검증됨'), 'shipped', L('Documented completed runs: Instagram DM sends, Google Sheets/Docs writes, Analytics downloads, KakaoTalk sends.', '문서화된 완료 실행: Instagram DM 발송, Google Sheets/Docs 작성, Analytics 다운로드, 카카오톡 발송.')],
    [L('Parallel Chrome slots', '병렬 Chrome 슬롯'), 'shipped', L('3 workflow-test slots + chat slot, slot leasing with cleanup and orphan reclaim.', '워크플로 테스트 슬롯 3개 + 채팅 슬롯. 슬롯 임대와 유령 임대 정리, 고아 프로세스 회수.')],
    [L('Honest failure mode', '정직한 실패 모드'), 'partial', L('Site layout changes can break workflows; execution logs show exactly where a run stopped.', '사이트 레이아웃이 바뀌면 워크플로가 깨질 수 있음. 실행 로그가 정확히 어디서 멈췄는지 보여줌.')],
  ]},
  { area: L('Deck & Document Generation', '덱 & 문서 생성'), note: L('The largest development investment of Q3 2026 (5 upgrade cycles); effectively the product’s second core alongside workflows.', '2026년 3분기 최대 개발 투자 영역(고도화 5차). 워크플로와 함께 사실상 제품의 제2핵심.'), rows: [
    [L('PPTX deck engine, shared layout core', 'PPTX 덱 엔진, 공유 레이아웃 코어'), 'shipped', L('One pure-TS layout core feeds both the exported .pptx and the in-app SVG preview - they cannot diverge.', '순수 TS 레이아웃 코어 하나가 내보내는 .pptx와 인앱 SVG 프리뷰를 모두 생성 - 어긋날 수 없음.')],
    [L('Themes & brand derivation', '테마 & 브랜드 파생'), 'shipped', L('7 themes (incl. night dark) + curated palettes + 4 style recipes; a single brand hex derives the full palette with contrast correction.', '테마 7종(다크 night 포함) + 큐레이션 팔레트 + 스타일 레시피 4종. 브랜드 색 hex 하나로 전체 팔레트 파생(대비 보정).')],
    [L('Layout vocabulary', '레이아웃 어휘'), 'shipped', L('14 page kinds / 38 fixed faces, free 12-column layout with 10 block types, 68 curated icons; seeded variant rotation.', '페이지 kind 14종 / 고정 얼굴 38종, 블록 10종의 12칼럼 자유 레이아웃, 큐레이션 아이콘 68종. 시드 기반 변형 로테이션.')],
    [L('Visual QA loop', '시각 QA 루프'), 'shipped', L('The model reviews rendered images of its own deck and self-corrects; the first deck is shown only after silent validation.', '모델이 자기 덱의 렌더 이미지를 보고 스스로 교정. 첫 덱은 침묵 검증이 끝난 뒤에 처음 노출.')],
    [L('Deck Designer panel', 'Deck Designer 패널'), 'shipped', L('Design options rendered as real slide tiles; all local recompute, zero model round-trips.', '디자인 옵션을 실제로 그린 슬라이드 타일로 보여줌. 전부 로컬 재계산, 모델 왕복 0회.')],
    [L('Editing & export', '편집 & 내보내기'), 'shipped', L('Per-slide fix, undo (depth 20, session-only), PPTX export with self-verification, then Open / Show in folder.', '슬라이드 단위 수정, 되돌리기(깊이 20, 세션 한정), 자가검증 포함 PPTX 내보내기, 바로 열기/폴더 표시.')],
    [L('PPTX import & design-preserving edit', 'PPTX 임포트 & 디자인 보존 편집'), 'shipped', L('Read outside decks and re-typeset them, or edit the original in place (text swap, slide ops, .potx fill).', '외부 덱을 읽어 재조판하거나, 원본 디자인을 유지한 채 직접 편집(텍스트 교체, 슬라이드 조작, .potx 채우기).')],
    [L('Language quality', '언어 품질'), 'shipped', L('Deck language correction pipeline; long dashes banished at both prompt and code level.', '덱 언어 교정 파이프라인. 롱 대시는 프롬프트와 코드 양쪽에서 추방.')],
    [L('Other document writers', '기타 문서 생성'), 'shipped', L('PDF, XLSX, CSV, MD, JSON writers; deliverables render in-app.', 'PDF, XLSX, CSV, MD, JSON 생성. 산출물은 앱 안에서 렌더링.')],
    [L('Google Docs / Sheets output', 'Google Docs / Sheets 출력'), 'shipped', L('OAuth-connected read and write (gdoc-report, sheet-sync).', 'OAuth 연결로 읽기·쓰기 (gdoc-report, sheet-sync).')],
    [L('Known limits', '알려진 한계'), 'planned', L('No auto logo insertion, no custom fonts, no arbitrary shapes beyond the icon set, no visual preview for design-preserving edits.', '자동 로고 삽입 없음, 커스텀 폰트 없음, 아이콘 외 임의 도형 없음, 디자인 보존 편집은 화면 프리뷰 없음.')],
  ]},
  { area: L('Data Tools & File Ingest', '데이터 도구 & 파일 인제스트'), rows: [
    [L('fetch-to-file', 'fetch-to-file'), 'shipped', L('Paginated HTTP collection straight to workspace files (4 modes); the model sees counts, never the data.', '페이지네이션 HTTP 수집을 워크스페이스 파일로 직행(4모드). 모델은 데이터가 아니라 건수만 봄.')],
    [L('query-data (SQL)', 'query-data (SQL)'), 'shipped', L('Read-only DuckDB SQL over workspace files incl. sheet refs; writes results to files. Sandboxed.', '워크스페이스 파일에 read-only DuckDB SQL(시트 지정 포함). 결과는 파일로 저장. 샌드박스.')],
    [L('Measured result', '실측 결과'), 'shipped', L('4,724 products from 3 shops in 172 s at $0.146 - vs est. ~$175 / ~16 h chat-based.', '3개 쇼핑몰에서 4,724개 상품을 172초 / $0.146에 수집 - 채팅 기반 추정치 약 $175 / 약 16시간 대비.')],
    [L('"Model off the data path" rule', '"모델을 데이터 경로에서 배제" 규칙'), 'shipped', L('Builder-level rule: bulk data moves through tools, not the model context.', '빌더 레벨 규칙: 대량 데이터는 모델 컨텍스트가 아니라 툴을 통해 이동.')],
    [L('File ingest', '파일 인제스트'), 'shipped', L('Extraction from xlsx/xlsm, docx, pptx, pdf, csv/tsv/json/md/html with a truncation contract.', 'xlsx/xlsm, docx, pptx, pdf, csv/tsv/json/md/html 추출 + 잘림 계약.')],
    [L('Data Management tab', 'Data Management 탭'), 'shipped', L('Workspace file browser, table and image viewers, editable text docs, "Ask about this", export to Excel.', '워크스페이스 파일 브라우저, 표·이미지 뷰어, 텍스트 문서 편집, "Ask about this", Excel 내보내기.')],
    [L('Not supported', '미지원'), 'planned', L('Legacy .xls (re-save as .xlsx), OCR for scanned PDFs.', '구형 .xls(.xlsx로 재저장 안내), 스캔 PDF의 OCR.')],
  ]},
  { area: L('Funnel Tracking', '퍼널 트래킹'), note: L('Added Aug 2026 on feature/funnel-tracking (backlog: funnel-tracking, epics E1/E2/E5). Org-team only.', '2026년 8월 feature/funnel-tracking 에서 추가 (백로그: funnel-tracking, 에픽 E1/E2/E5). org 팀 전용.'), rows: [
    [L('Dedicated Funnel tab (chat-first)', '전용 Funnel 탭 (채팅 중심)'), 'shipped', L('Chat on the left drives the funnel; the right panel holds internal tabs (Board / Items / Docs / Trends / Setup). Same builder session shape as the Copilot tab.', '왼쪽 채팅이 퍼널을 굴리고, 우측 패널은 내부 탭(Board / Items / Docs / Trends / Setup). Copilot 탭과 같은 builder 세션 조형.')],
    [L('Multiple named funnels with traceable KPIs', '이름 있는 다중 퍼널 + traceable KPI'), 'shipped', L('Standard Awareness→Consideration→Conversion stages, each with a named KPI source, value type and target. Own company or a client - the funnel name says which; no separate client entity.', '표준 Awareness→Consideration→Conversion 단계마다 KPI 출처·단위·목표. 자사든 고객사든 퍼널 이름으로 구분 - 별도 고객사 엔티티 없음.')],
    [L('3-layer Master Content Document', '3-Layer 마스터 콘텐츠 문서'), 'shipped', L('L1 common types (no funnel, never duplicated), L2 funnel types (exactly one stage), L3 actual uploaded content - only L3 is drawn on the board. Fixed product concept; code naming follows the source document.', 'L1 공통 타입(퍼널 없음, 복제 없음), L2 퍼널 타입(단계 정확히 1개), L3 실제 업로드 콘텐츠 - 보드에는 L3 만. 제품 공식 개념이며 코드명 표기는 원본 문서를 따름.')],
    [L('Block contract + Apply gate', '블록 계약 + Apply 게이트'), 'shipped', L('Five blocks (funnel-spec / metric-set / item-ops / collect-plan / copilot-handoff) validated by a 3-state parser; invalid replies get one silent auto-fix retry. Nothing is written without the user pressing Apply - funnel data is Supabase-canonical.', '5개 블록(funnel-spec / metric-set / item-ops / collect-plan / copilot-handoff)을 3-상태 파서가 검증하고, 무효 응답은 조용한 자동 재요청 1회. Apply 를 누르기 전에는 아무것도 쓰지 않음 - 퍼널 데이터는 Supabase 정본.')],
    [L('Per-funnel document library (2-pass)', '퍼널별 문서 보관함 (2-pass)'), 'shipped', L('Attachments are stored per funnel; a cheap model briefs each upload on arrival and selects which documents enter the context of each turn (48k budget), so old uploads stay usable without bloating every prompt.', '첨부는 퍼널별로 보관. 싼 모델이 업로드 시 브리핑하고 턴마다 컨텍스트에 넣을 문서를 선별(예산 48k) - 예전 업로드를 매 프롬프트를 부풀리지 않고 계속 쓸 수 있다.')],
    [L('Browser-driven KPI collection', '브라우저 KPI 자동 수집'), 'shipped', L('A collect-plan proposal becomes an ephemeral all-Chrome workflow run by the workflow-runner; the numbers come back as a metric-set confirmation card and are recorded with source "collect".', 'collect-plan 제안이 전 노드 크롬인 임시 워크플로가 되어 workflow-runner 로 실행되고, 수치는 metric-set 확인 카드로 돌아와 source "collect" 로 기록된다.')],
    [L('Funnel↔Copilot action handoff', 'Funnel↔Copilot 액션 핸드오프'), 'shipped', L('Real work is handed to the Copilot tab (the funnel builder has no tools) and the run deliverables return to the requesting funnel as documents - automatically, or by the manual Deliver button on the handoff status banner.', '본격 작업은 Copilot 탭으로 넘기고(퍼널 builder 는 툴이 없다) run 산출물은 문서로 요청한 퍼널에 회귀 - 자동 또는 핸드오프 상태 배너의 수동 Deliver 버튼으로.')],
    [L('Dashboard cards + PPTX export', '대시보드 카드 + PPTX 내보내기'), 'shipped', L('Read-only funnel cards with a mini silhouette and overall conversion on the dashboard (card click opens the tab); report export rides the existing deck engine untouched.', '대시보드에 미니 실루엣·전체 전환율의 읽기 전용 카드(클릭이 탭 진입). 리포트 내보내기는 기존 덱 엔진 무수정 재사용.')],
    [L('Archive & permanent delete', '아카이브 & 영구 삭제'), 'shipped', L('Any member archives and restores; permanent delete is admin-only, archived funnels only, through a security-definer RPC.', '아카이브·복구는 모든 멤버. 영구 삭제는 admin 전용이며 아카이브된 퍼널만, security-definer RPC 경유.')],
    [L('Run events overlaid on metrics', 'run 이벤트와 지표 겹쳐 보기'), 'planned', L('Epic E3 (R3) - team workflow-run events on the funnel metric timeline as a correlation view.', '에픽 E3 (R3) - 팀 워크플로 run 이벤트를 퍼널 지표 타임라인에 상관 뷰로 표시.')],
    [L('Metric connectors', '지표 커넥터'), 'planned', L('Epic E4 (R4) - GA4, Search Console, ad platforms and CRM replacing manual ingestion; partly preempted by collect-plan.', '에픽 E4 (R4) - GA4·Search Console·광고 플랫폼·CRM 으로 수동 수집 대체. collect-plan 이 일부 선행.')],
  ]},
  { area: L('Team & Collaboration', '팀 & 협업'), rows: [
    [L('Organization model', '조직 모델'), 'shipped', L('Hosted backend (Supabase); roles are admin / member.', '호스팅 백엔드(Supabase). 역할은 admin / member 2단.')],
    [L('Workflow sharing', '워크플로 공유'), 'shipped', L('Share to a team gallery; colleagues copy into their own workflows. Ranked by team usage.', '팀 갤러리에 공유 → 동료가 자기 워크플로로 복사. 팀 사용량 순 정렬.')],
    [L('Versions & stale detection', '버전 & 구버전 감지'), 'shipped', L('Shared versions with a stale-copy banner on forks, plus diff view.', '공유본 버전 관리. 원본 업데이트 시 복사본에 stale 배너, diff 뷰 제공.')],
    [L('Archive & delete', '아카이브 & 삭제'), 'shipped', L('Archive/restore by any member; permanent delete is admin-only, archived items only. Migration applied 2026-08-06.', '아카이브/복구는 모든 멤버. 영구 삭제는 admin 전용, 아카이브 항목만. 마이그레이션 2026-08-06 적용.')],
    [L('Runs dashboard', 'Runs 대시보드'), 'shipped', L('Local live runs + history + team runs in one view; failed runs upload clipped logs with error classification.', '로컬 라이브 실행 + 이력 + 팀 실행을 한 화면에. 실패 실행은 에러 분류와 함께 로그 업로드.')],
    [L('Presence & DM', '프레즌스 & DM'), 'shipped', L('Friends rail with realtime presence and 1:1 DMs with read receipts.', 'Friends 레일: 실시간 상태 + 읽음 표시 있는 1:1 DM.')],
    [L('Per-member credits', '멤버별 크레딧'), 'shipped', L('Admin allocates monthly limits from the org balance (allocated <= cash); exhaustion blocks sending. Live since 2026-08-11.', 'admin이 조직 잔액에서 월 한도 배분(배분 합계 <= 잔액). 소진 시 전송 차단. 2026-08-11부터 운영.')],
    [L('Merge Requests', 'Merge Requests'), 'hidden', L('Git-style review of shared assets. Enterprise-flavored; hidden in the MVP.', '공유 자산에 대한 git 스타일 리뷰. 엔터프라이즈 성격이라 MVP에서 숨김.')],
    [L('Local collab modes', '로컬 협업 모드'), 'shipped', L('Project layout supports solo, shared-folder, and server modes.', '프로젝트 레이아웃이 solo / shared-folder / server 모드 지원.')],
    [L('Granular role permissions', '세분화된 역할 권한'), 'planned', L('Currently designed for a small, trusting team; fine-grained roles are future work.', '현재는 서로 신뢰하는 소규모 팀 전제. 세밀한 역할 체계는 향후 과제.')],
  ]},
  { area: L('Guardrails, Security & Reliability', '가드레일, 보안 & 안정성'), rows: [
    [L('3-mode guardrail', '3모드 가드레일'), 'shipped', L('bypass / standard / strict approval modes; approve once, session, allowlist (with dir scope), deny.', 'bypass / standard / strict 승인 모드. 1회 승인, 세션 기억, 영구 허용(디렉터리 범위), 거부.')],
    [L('Approval popup window', '승인 팝업 창'), 'shipped', L('Dedicated always-on-top window; appears even when the app is in the background.', '전용 항상-위 창. 앱이 백그라운드여도 즉시 표시.')],
    [L('Original-design PPTX editing', '원본 디자인 유지 PPTX 편집'), 'shipped', L('Drop a .pptx into Content mode and pick "Keep the original design": the deck is edited in place through 7 OOXML ops (replace/rewrite text, notes, duplicate/insert-from-layout/delete/reorder) with masters, theme, media and animations untouched. The model proposes a ```pptx-edit``` block; nothing is written until the user presses Apply, and the first Apply writes a COPY under data/reports so the uploaded original is never modified. Orphaned parts are swept after structural ops.', 'Content 모드에 .pptx 를 떨어뜨리고 "원본 디자인 유지" 를 고르면 7개 OOXML op(텍스트 교체·재작성, 노트, 복제·레이아웃에서 삽입·삭제·순서)로 제자리 편집한다. 마스터·테마·미디어·애니메이션 무손상. 모델이 ```pptx-edit``` 블록을 제안하고 사용자가 Apply 를 눌러야 쓰인다. 첫 Apply 는 data/reports 에 복사본을 만들어 올린 원본은 절대 수정하지 않는다. 구조 op 뒤 고아 파트는 자동 정리.')],
    [L('Deck rendering — exact or wireframe', '덱 렌더 — 실물 또는 와이어프레임'), 'shipped', L('The installer carries a slimmed LibreOffice (361MB→119MB, plus Noto Sans KR because LibreOffice ships no CJK glyphs and renders Korean blank headless), so a foreign deck is rendered exactly: .pptx → PDF → pdfjs in an offscreen window → contact sheet. Where no renderer is available the app falls back to a wireframe drawn from the OOXML itself (real fills, theme colours, alignment, hyperlinks). Both the panel and the model see the same sheet, and the panel says which it is; slides can be viewed as a sheet or one at a time.', '설치본이 슬림화한 LibreOffice 를 동봉한다(361MB→119MB, 그리고 Noto Sans KR — LibreOffice 는 CJK 글리프가 없어 headless 에서 한글이 통째로 빈다). 남의 덱도 정확히 렌더: .pptx → PDF → 오프스크린 pdfjs → 컨택트시트. 렌더러가 없으면 OOXML 에서 직접 그린 와이어프레임으로 폴백(실제 채움·테마색·정렬·하이퍼링크 반영). 패널과 모델이 같은 시트를 보고, 패널은 둘 중 무엇인지 밝힌다. 전체 시트 보기와 한 장씩 보기 지원.')],
    [L('Overwrite gate + Save as…', '덮어쓰기 게이트 + 다른 이름으로 저장'), 'shipped', L('Overwriting an existing file always asks, even in bypass mode; "Save as…" keeps the old file and redirects the write to a name the user picks.', '기존 파일 덮어쓰기는 bypass 모드에서도 항상 물어봄. "Save as…" 를 고르면 기존 파일은 그대로 두고 새 산출물만 사용자가 정한 이름으로 저장.')],
    [L('File write sandbox', '파일 쓰기 샌드박스'), 'shipped', L('Designated Paths - agent writes hard-limited to approved folders; all file IPC passes a workspace jail.', 'Designated Paths - 에이전트 쓰기를 승인 폴더로 하드 제한. 모든 파일 IPC가 워크스페이스 감옥을 통과.')],
    [L('Fail-closed entitlements', 'Fail-closed 사용량 정책'), 'shipped', L('Network or API errors block sending rather than bypassing quota checks.', '네트워크·API 오류 시 쿼터 검사를 우회하지 않고 전송을 차단.')],
    [L('Local tool bridge', '로컬 툴 브릿지'), 'shipped', L('Custom tools injected over loopback HTTP with a random bearer token; external link guard.', '커스텀 툴을 루프백 HTTP + 랜덤 Bearer 토큰으로 주입. 외부 링크 가드.')],
    [L('Compliance', '컴플라이언스'), 'planned', L('No SOC 2 / ISO certification - stated openly in the product guide.', 'SOC 2 / ISO 인증 없음 - 제품 가이드에 공개적으로 명시.')],
  ]},
  { area: L('Pricing & Accounts', '요금 & 계정'), rows: [
    [L('Web sign-in', '웹 로그인'), 'shipped', L('Browser-based login handed to the app via deep link; no password typed into the app.', '브라우저에서 로그인 후 딥링크로 앱에 전달. 앱 안에 비밀번호 입력 없음.')],
    [L('Free / Pro tiers', 'Free / Pro 티어'), 'shipped', L('Daily limits (25 vs 2,000 messages/day, 25 vs 500 searches/day, token caps); resets 09:00 KST.', '일일 한도(메시지 25 vs 2,000/일, 검색 25 vs 500/일, 토큰 캡). 매일 09:00 KST 리셋.')],
    [L('Hosted LLM proxy', '호스팅 LLM 프록시'), 'shipped', L('No API key required; usage synced; org members see org credits instead of personal quota badges.', 'API 키 불필요. 사용량 동기화. 조직 멤버에게는 개인 쿼터 배지 대신 조직 크레딧 표시.')],
    [L('Display markup isolation', '마크업 격리'), 'shipped', L('Pricing multipliers cached only in the main process, never exposed to the renderer.', '가격 배수는 메인 프로세스에만 캐시, 렌더러에 노출 안 함.')],
    [L('BYOK', 'BYOK'), 'hidden', L('Bring-your-own-key mode fully implemented behind a single flag.', '자체 키 모드가 플래그 하나 뒤에 완전 구현되어 있음.')],
    [L('Plan switching / team purchase', '플랜 전환 / 팀 구매'), 'planned', L('Manual sales only for now.', '현재는 수동 영업으로만 안내.')],
  ]},
  { area: L('Platform & Distribution', '플랫폼 & 배포'), rows: [
    [L('Desktop app, macOS + Windows', '데스크톱 앱, macOS + Windows'), 'shipped', L('Electron; macOS signed and notarized (.dmg), Windows installer (.exe) with admin-free provisioning.', 'Electron. macOS 서명·공증(.dmg), Windows는 관리자 권한 없는 자동 설치(.exe).')],
    [L('Bundled agent runtime', '내장 에이전트 런타임'), 'shipped', L('Local OpenClaw gateway packaged with the app; orphan reclaim; Node 22 auto-install.', '로컬 OpenClaw 게이트웨이 동봉. 고아 프로세스 회수, Node 22 자동 설치.')],
    [L('Design system', '디자인 시스템'), 'shipped', L('Dual theme (Paper/Petrol light + dark), token + atom library, Storybook, token lint.', '듀얼 테마(Paper/Petrol 라이트 + 다크), 토큰 + 아톰 라이브러리, Storybook, 토큰 린트.')],
    [L('UI language', 'UI 언어'), 'shipped', L('English UI; agent replies in the user’s language. Korean manual and product guide shipped.', 'UI는 영어, 에이전트는 사용자 언어로 응답. 한국어 사용 설명서와 제품 가이드 발행.')],
    [L('Twixy Enterprise', 'Twixy Enterprise'), 'shelved', L('Separate build target (own app id, admin dashboard default); shelved as a possible B2B separation.', '별도 빌드 타깃(별도 앱 ID, 관리자 대시보드 기본). B2B 분리 후보로 보류.')],
    [L('Offline use', '오프라인 사용'), 'planned', L('Not supported - intentional.', '미지원 - 의도된 결정.')],
  ]},
  { area: L('Hidden & Experimental', '숨김 & 실험 기능'), rows: [
    [L('Orchestration tab', 'Orchestration 탭'), 'hidden', L('Multi-workflow canvas: pipeline / parallel / research / relay active (roundtable, conductor disabled); nested groups, manager node, I/O checks.', '멀티 워크플로 캔버스: pipeline / parallel / research / relay 활성(roundtable, conductor 비활성). 중첩 그룹, 매니저 노드, 입출력 검사.')],
    [L('AI Agents', 'AI Agents'), 'hidden', L('Reusable saved agents that pick and run the right workflow for an input; usable across orchestrations.', '재사용 가능한 저장형 에이전트 - 입력에 맞는 워크플로를 골라 실행. 여러 오케스트레이션에서 재사용.')],
    [L('Skills panel (TSL)', 'Skills 패널 (TSL)'), 'hidden', L('.tskill DSL compiler, form-based writer, stats, 8 built-in skills. Known defect: three one-way sync valves can leave copies stale.', '.tskill DSL 컴파일러, 폼 기반 작성기, 통계, 빌트인 스킬 8종. 알려진 결함: 단방향 동기화 밸브 3개.')],
    [L('Planning Mode / Execution Plan API', 'Planning Mode / Execution Plan API'), 'hidden', L('Plan-approve-run flow plus a loopback API for external programs. Legacy-leaning; superseded by the Workflow flow.', '계획-승인-실행 플로 + 외부 프로그램용 루프백 API. 레거시 성격, 대부분 Workflow 플로로 대체됨.')],
    [L('Mobile channels', '모바일 채널'), 'beta', L('Telegram / Discord / Signal / iMessage relay - labeled experimental.', 'Telegram / Discord / Signal / iMessage 릴레이 - 실험적 기능으로 표기.')],
    [L('KakaoTalk app tool, Notion MCP', '카카오톡 app 툴, Notion MCP'), 'partial', L('Catalog entries exist; KakaoTalk sends verified in real runs, Notion is early.', '카탈로그 엔트리 존재. 카카오톡 발송은 실제 실행으로 검증, Notion은 초기 단계.')],
  ]},
];

// ───────────────────────── 9. Personas ─────────────────────────
export const personas = [
  { title: L('Marketing Agency Owner — P1 (buyer, sponsor)', '마케팅 에이전시 대표 — P1 (구매자, 스폰서)'), fields: [
    [L('Type / Size', '유형 / 규모'), L('Primary user & decision maker · 2–30 employees', '핵심 사용자이자 의사결정권자 · 직원 2–30명')],
    [L('Goals', '목표'), L('Increase productivity, standardize operations, scale the agency without proportional hiring.', '생산성 향상, 운영 표준화, 인원 비례 증가 없이 에이전시 확장.')],
    [L('Pain Points', '페인 포인트'), L('Repeated manual tasks; workflows live in individual heads; AI used individually; no visibility into how AI work is produced.', '반복 수작업, 개인 머릿속에만 있는 워크플로, 개인 단위의 AI 사용, AI 작업 과정 가시성 부재.')],
    [L('Needs (today’s features)', '필요 (현재 기능)'), L('Shared workflow gallery · team runs dashboard · per-member credit allocation · guardrail modes · archive/delete governance.', '공유 워크플로 갤러리 · 팀 Runs 대시보드 · 멤버별 크레딧 배분 · 가드레일 승인 모드 · 아카이브/삭제 거버넌스.')],
    [L('Success Criteria', '성공 기준'), L('Reduced manual workload, standardized operations, consistent delivery, controlled spend per member.', '수작업 감소, 운영 표준화, 일관된 납품 품질, 멤버별 지출 통제.')],
    [L('Related Goals', '관련 목표'), L('AI-Native IDE · Team Synchronization · Scalable Workspace · Output Quality · Monetization Infrastructure.', 'AI 네이티브 IDE · 팀 동기화 · 확장 가능한 워크스페이스 · 산출물 품질 · 수익화 인프라.')],
  ]},
  { title: L('Marketing Operations Manager — P1 (workflow designer)', '마케팅 운영 매니저 — P1 (워크플로 설계자)'), fields: [
    [L('Type / Size', '유형 / 규모'), L('Primary operational user · 5–50 employees', '핵심 운영 사용자 · 직원 5–50명')],
    [L('Goals', '목표'), L('Build repeatable execution systems; standardize marketing operations.', '반복 가능한 실행 체계 구축, 마케팅 운영 표준화.')],
    [L('Pain Points', '페인 포인트'), L('Process knowledge trapped in experienced employees; manual inconsistency; hard to reuse successful processes.', '숙련 직원에게 갇힌 프로세스 지식, 수작업 비일관성, 성공 프로세스 재사용 어려움.')],
    [L('Needs (today’s features)', '필요 (현재 기능)'), L('NL workflow builder · Human Review gates · sharing & versions with stale detection · run history & diff · tags.', '자연어 워크플로 빌더 · Human Review 게이트 · 구버전 감지 있는 공유·버전 · 실행 이력과 diff · 태그.')],
    [L('Success Criteria', '성공 기준'), L('Standardized execution, faster setup, reduced dependency on individuals, easy maintenance.', '표준화된 실행, 빠른 셋업, 개인 의존도 감소, 쉬운 유지보수.')],
    [L('Related Goals', '관련 목표'), L('Agentic Workflow Creation · Reusable Nodes · Visibility & Control · Team Synchronization · Onboarding.', '에이전틱 워크플로 작성 · 재사용 노드 · 가시성과 통제 · 팀 동기화 · 온보딩.')],
  ]},
  { title: L('Marketing Specialist — P1 (daily user)', '마케팅 스페셜리스트 — P1 (일상 사용자)'), fields: [
    [L('Type / Size', '유형 / 규모'), L('Primary daily user · 5–50 employees', '핵심 일상 사용자 · 직원 5–50명')],
    [L('Goals', '목표'), L('Finish repetitive tasks faster with higher quality and less manual work.', '반복 작업을 더 빨리, 더 높은 품질로, 수작업은 줄여서.')],
    [L('Pain Points', '페인 포인트'), L('Repetitive browser work, copy-paste between tools, manual report building, tool switching.', '반복적인 브라우저 작업, 툴 간 복사-붙여넣기, 수작업 리포트 작성, 잦은 툴 전환.')],
    [L('Needs (today’s features)', '필요 (현재 기능)'), L('Copilot Simple mode · one-click workflow runs · deck generation (Content mode) · mid-run steering · data collection tools · clear run status.', 'Copilot Simple 모드 · 원클릭 워크플로 실행 · 덱 생성(Content 모드) · 실행 중 방향 조정 · 데이터 수집 툴 · 명확한 실행 상태.')],
    [L('Success Criteria', '성공 기준'), L('Less repetitive work, faster delivery, fewer errors, client-ready deliverables without design work.', '반복 작업 감소, 빠른 납품, 오류 감소, 디자인 작업 없이 납품 수준의 산출물.')],
    [L('Related Goals', '관련 목표'), L('Chrome Automation · Deliverable Generation · Data Collection · Visibility & Control.', 'Chrome 자동화 · 산출물 생성 · 데이터 수집 · 가시성과 통제.')],
  ]},
  { title: L('Agency Team Leader — P2 (supervision & quality)', '에이전시 팀 리더 — P2 (감독 & 품질)'), fields: [
    [L('Type / Size', '유형 / 규모'), L('Supervisory user · 10–50 employees', '감독 사용자 · 직원 10–50명')],
    [L('Goals', '목표'), L('Monitor team output, maintain quality, ensure workflows complete correctly and on time.', '팀 산출물 모니터링, 품질 유지, 워크플로의 정확한 정시 완료 보장.')],
    [L('Pain Points', '페인 포인트'), L('Limited progress visibility; hard to review how AI outputs were produced; failures found too late.', '제한된 진행 가시성, AI 산출물 생성 과정 검토 어려움, 늦게 발견되는 실패.')],
    [L('Needs (today’s features)', '필요 (현재 기능)'), L('Team runs dashboard · per-node logs with error classification · Human Review before irreversible sends · presence & DM · (future) formal approval and granular roles.', '팀 Runs 대시보드 · 에러 분류 있는 노드별 로그 · 되돌릴 수 없는 전송 앞의 Human Review · 프레즌스와 DM · (향후) 공식 승인과 세분화 역할.')],
    [L('Success Criteria', '성공 기준'), L('Project visibility, consistent quality, controlled AI execution, clear accountability.', '프로젝트 가시성, 일관된 품질, 통제된 AI 실행, 명확한 책임 소재.')],
    [L('Related Goals', '관련 목표'), L('Visibility & Control · Output Quality · Team Synchronization · Scalable Workspace.', '가시성과 통제 · 산출물 품질 · 팀 동기화 · 확장 가능한 워크스페이스.')],
  ]},
  { title: L('AI Workflow Builder — P2 (power user)', 'AI 워크플로 빌더 — P2 (파워 유저)'), fields: [
    [L('Type / Size', '유형 / 규모'), L('Power user · 10–100 employees', '파워 유저 · 직원 10–100명')],
    [L('Goals', '목표'), L('Build, maintain, and scale reusable AI workflows across the agency.', '에이전시 전반에서 재사용 가능한 AI 워크플로를 구축·유지·확장.')],
    [L('Pain Points', '페인 포인트'), L('Limited customization in generic AI tools; hard-to-share automations; unpredictable browser automation; limited debugging.', '범용 AI 툴의 제한된 커스터마이징, 공유하기 어려운 자동화, 예측 불가한 브라우저 자동화, 제한된 디버깅.')],
    [L('Needs (today’s features)', '필요 (현재 기능)'), L('Tool catalog & tool-skills · parallel test runs with live preview · per-node cost/token logs · diff & versions · (hidden today) Orchestration, AI Agents, TSL skills, BYOK.', '툴 카탈로그와 툴스킬 · 라이브 프리뷰 있는 병렬 테스트 실행 · 노드별 비용/토큰 로그 · diff와 버전 · (현재 숨김) Orchestration, AI Agents, TSL 스킬, BYOK.')],
    [L('Success Criteria', '성공 기준'), L('Faster workflow development, stable automation, clear debugging, reusable building blocks.', '빠른 워크플로 개발, 안정적인 자동화, 명확한 디버깅, 재사용 가능한 빌딩 블록.')],
    [L('Related Goals', '관련 목표'), L('Agentic Workflow Creation · Reusable Nodes · Chrome Automation · Visibility & Control · Integration Expansion.', '에이전틱 워크플로 작성 · 재사용 노드 · Chrome 자동화 · 가시성과 통제 · 연동 확장.')],
  ]},
];

// ───────────────────────── Appendix A ─────────────────────────
export const appendix = {
  intro: L(
    'This is a development document; the honest list matters. Nothing here should be presented externally as existing or verified. In Scrum terms, this appendix is the definition-of-Done debt for the Product Increment section.',
    '개발 문서이므로 정직한 목록이 중요합니다. 여기 있는 항목을 외부에 "존재하거나 검증된 것"으로 소개해서는 안 됩니다. 스크럼 관점에서 이 부록은 Product Increment 섹션의 Done의 정의(DoD) 부채 목록입니다.',
  ),
  groups: [
    { title: L('A.1 Verification debt', 'A.1 검증 부채'), bullets: [
      L('Deck path: no app-running end-to-end test of the full generation flow (flagged in all five PPTX upgrade documents).', '덱 경로: 전체 생성 플로의 앱 실행 엔드투엔드 테스트가 없음 (PPTX 고도화 문서 5편 모두에서 미해결로 표기).'),
      L('Shared workflow archive/permissions: real two-account E2E (8 defined cases) not yet executed; only type-check/lint/build passed.', '공유 워크플로 아카이브/권한: 실제 2계정 E2E(정의된 8개 케이스) 미실행. 타입체크/린트/빌드만 통과.'),
      L('Funnel↔Copilot handoff: the round trip is verified from real run logs and unit tests of the parser/extractor, but the full in-app E2E (handoff → run → delivery → item-ops → Apply) has not been executed end to end.', 'Funnel↔Copilot 핸드오프: 실제 run 로그와 파서/추출기 단위 테스트로 검증했으나, 앱 안에서의 전체 E2E(핸드오프 → 실행 → 배달 → item-ops → Apply)는 아직 통과 실행하지 않음.'),
      L('Funnel documents and items ship without an automated regression suite - type-check, lint, build and targeted unit tests only.', '퍼널 문서·아이템 경로에 자동 회귀 스위트가 없음 - 타입체크/린트/빌드와 표적 단위 테스트만.'),
      L('fetch-to-file verified in Node-level tests; not yet exercised in a live app run.', 'fetch-to-file은 Node 레벨 테스트로 검증됨. 실제 앱 실행에서는 아직 미검증.'),
    ]},
    { title: L('A.2 Known weak spots', 'A.2 알려진 약점'), bullets: [
      L('Automated run review returns "clean" on runs with real cost waste and arithmetic errors; a stronger model is proposed but not applied.', '자동 실행 리뷰가 실제 비용 낭비와 계산 오류가 있는 실행에도 "이상 없음"을 반환. 더 강한 모델 제안됐으나 미적용.'),
      L('Skill propagation has three one-way sync valves that can leave copies silently stale.', '스킬 전파에 단방향 동기화 밸브 3개가 있어 복사본이 조용히 구버전이 될 수 있음.'),
      L('Older field builds silently no-op on "Unshare" - needs a release note.', '구버전 필드 빌드는 "공유 해제"가 조용히 무시됨 - 릴리스 노트 필요.'),
      L('Bundled agent runtime (OpenClaw 2026.4.2) is drifting behind upstream 2026.6.x.', '내장 에이전트 런타임(OpenClaw 2026.4.2)이 업스트림 2026.6.x 대비 뒤처지는 중.'),
      L('DuckDB-WASM bundle exclusion not configured (~79 MB of dead weight ships in the installer).', 'DuckDB-WASM 번들 제외 설정 없음 (설치본에 약 79MB의 불필요한 무게).'),
    ]},
    { title: L('A.3 Removed or dead - do not document as features', 'A.3 제거됐거나 죽은 것 - 기능으로 문서화 금지'), bullets: [
      L('Natural-language chart dashboard (DashboardPanel): implemented but disconnected - no view renders it. Reuse candidate for funnel epic E2.', '자연어 차트 대시보드(DashboardPanel): 구현됐으나 연결 끊김 - 어떤 뷰도 렌더링하지 않음. 퍼널 에픽 E2의 재활용 후보.'),
      L('Scheduler/cron, heartbeat, and watchtower monitoring infrastructure: deleted; only quota placeholders remain.', '스케줄러/크론, 하트비트, watchtower 모니터링 인프라: 삭제됨. 쿼터 자리표시자만 남음.'),
      L('The "automatic marketing execution" pivot (campaign auto-generation, hypothesis A/B, auto-posting) was reversed and removed.', '"자동 마케팅 실행" 피벗(캠페인 자동 생성, 가설 A/B, 자동 게시)은 되돌려져 제거됨.'),
      L('Monorepo split: a plan document only, not implemented.', '모노레포 분리: 계획 문서만 존재, 미구현.'),
    ]},
  ],
};
