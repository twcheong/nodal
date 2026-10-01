# 덱 생성 — 공유 레이아웃 코어 · Content 모드 · PPTX 입출력

> ⚠️ **이 문서는 1차 업그레이드 기준이다.** 2차(목적 레이어 · 페이지 얼굴 37 · 시드 회전 · 브랜드 색 파생 · 시각 QA 루프 · 자가검증 · OOXML 편집 · 아이콘)는 **[PPTX_UPGRADE_2.md](PPTX_UPGRADE_2.md)** 를 본다. 여기 적힌 공유 코어 구조(§1–§5)는 그대로 유효하고, 수치(kind/variant 개수 등)와 §9 상태는 2차 문서가 우선한다.

> **대상:** Twixy 팀
> **한 줄:** 좌표 계산을 순수 TS 코어 하나로 모아, **pptx 내보내기와 화면 프리뷰가 같은 계산의 두 출력**이 되게 한 구조. 그 위에 덱을 스펙으로 authoring 하는 Content 모드와, 받은 .pptx를 다시 읽어들이는 임포터가 얹혀 있다.
> **상태:** 구현 + 로컬 검증 완료. **미완 1건** (§9 — 앱 구동 E2E).
> **브랜치:** `feature/pptx-skill-upgrade`
> **관련:** [ADDING_A_NEW_AGENT_TOOL.md](ADDING_A_NEW_AGENT_TOOL.md) (L1 툴 계층) · [ADDING_A_TOOL_SKILL.md](ADDING_A_TOOL_SKILL.md) (L2 런북 계층)
> **템플릿 목록:** [DECK_TEMPLATE_CATALOG.md](DECK_TEMPLATE_CATALOG.md) — 테마·스타일·페이지 전체 카탈로그와 관리 가이드 (비개발 문서)
> **참조 소스:** [MiniMax pptx-generator](https://github.com/MiniMax-AI/skills/tree/main/skills/pptx-generator) · [PPTAgent](https://github.com/icip-cas/PPTAgent)

---

## 1. 왜 이 모양인가

출발점은 `tool_write_pptx` 하나였다. 슬라이드 kind 5종, 단일 액센트, 좌표 하드코딩 — 결과물은 "불릿 슬라이드 10장 연속"이었다. 디자인을 올리는 과정에서 두 가지가 드러났고, 그게 지금 구조를 결정했다.

**첫째, 실행자에게 눈이 없다.** 2026-08-12 EDIS 리포트 실측: 파이프라인·렌더는 정상이었는데 실행자가 스켈레톤(목차·섹션·요약)을 통째로 생략하고 테마를 습관적으로 `twixy`로 골랐다. 자기가 만든 덱을 볼 수 없으니 교정할 방법이 없었다. → **프리뷰**(사람의 눈)와 **경고·구조 리포트**(모델의 눈)가 필요했다.

**둘째, 프리뷰를 따로 구현하면 반드시 어긋난다.** 그래서 좌표 계산을 순수 TS 코어로 뽑고 페인터를 둘 뒀다. 프리뷰는 재구현이 아니라 **같은 디스플레이 리스트의 다른 출력**이다.

참조에서 가져온 것과, 우리 제약 때문에 번역해야 했던 것:

| 소스 | 가져온 것 | 우리 번역 |
|---|---|---|
| **MiniMax** | 페이지 아키타입 5종, 테마 토큰 구조, 스타일 레시피 4종(radius·여백 스펙표), 폰트 페어링, 페이지 번호 뱃지, "직전과 다른 레이아웃" 하드 룰, 함정 체크리스트 | 그쪽은 슬라이드마다 **자유 pptxgenjs 코드**를 짜서 무한 자유도를 얻는다. 모델이 쓴 코드를 실행할 수 없으므로 **선언적 조합**(`layout` kind + 12칼럼 그리드)으로 옮겼다 (§5) |
| **PPTAgent** | 아웃라인 우선 파이프라인, PPTEval 3축(Content/Design/Coherence)을 QA 루브릭으로 | 레퍼런스 덱 편집 생성은 미채택 — pptx 편집 엔진이 필요한 별개 판. 대신 **임포터**(§7)가 "받은 덱을 재료로 쓴다"는 같은 효용의 일부를 제공 |

**의도적 미채택:** PPTAgent의 레퍼런스 덱 기반 생성, MiniMax 팔레트 18종 중 나머지, react-icons 아이콘(외부 의존성). 구현 방식(python-pptx, markitdown 검증)도 런타임에 Python이 없어 불가.

## 2. 구조 — 코어 하나, 페인터 둘, 진입점 셋

```
                     ┌────────────────────────────────────┐
                     │  shared/deck/  (순수 TS, 양쪽 런타임) │
   덱 스펙 ──────────▶│  buildDeck(payload) → El[]          │
   (SlideSpec[])     │  테마·스타일·좌표·줄바꿈·autofit      │
                     └───────┬──────────────────┬─────────┘
                             │                  │
                    pptxPainter               SlidePreview
                    (pptxgenjs)                 (SVG)
                             │                  │
                          .pptx 파일          화면 프리뷰
```

**진입점 셋** — 셋 다 같은 `WritePptxPayload`를 쓴다:

| 진입점 | 누가 스펙을 쓰나 | 경로 |
|---|---|---|
| **Content 모드** (§4) | 채팅의 tool-less `builder` 에이전트가 ` ```deck-spec ` 펜스 블록으로 | 앱이 렌더·프리뷰·내보내기 소유 |
| **워크플로 노드** | 실행자가 `tool_write_pptx` 호출 | 브리지 → `writePptx` |
| **임포터** (§7) | 기존 .pptx를 읽어 스펙으로 역산 | `tool_read_pptx` / 드롭 |

**능력은 코어에, 판단은 프롬프트에.** 새 kind·테마를 추가하면 `shared/deck` 수정이고, "숫자 3개는 stats로 가라"를 바꾸면 런북/CONTENT_SOUL 수정이다.

### 순수성 규칙 (`shared/deck/page.ts` 헤더에 명시)

이 폴더는 electron 메인과 브라우저 렌더러 **양쪽에서** 돈다:
- `node:*`/`electron`/`pptxgenjs`/`react` import 금지
- **`Intl`·`toLocaleString`·`localeCompare` 금지** — Node와 Chromium의 ICU 데이터가 달라 export와 preview가 갈라진다
- `Date.now`/`Math.random` 금지 — 레이아웃은 `(spec, theme, style, index)`의 순수 함수여야 스냅샷 오라클이 성립한다

## 3. 코어 레퍼런스

### 테마 7종 (`payload.theme`)

| 프리셋 | 도메인 | primary / accent | 폰트 페어 | 기본 style |
|---|---|---|---|---|
| `twixy` (폴백) | 나머지 전부 | `4638B3` / `7C6AFF` | Trebuchet MS / Calibri | soft |
| `petrol` | 에디토리얼·월간 리포트 | `0F4C5C` / `2A9D8F` | Georgia / Calibri | soft |
| `navy` | 금융·B2B·공식 보고 | `0B2545` / `B8860B` | Cambria / Calibri | sharp |
| `vivid` | 테크·스타트업·소셜/에이전시 | `1D3557` / `FF6B35` | Arial Black / Arial | rounded |
| `earth` | 식품·자연·뷰티·지속가능 | `3A5A40` / `BC6C25` | Georgia / Calibri | soft |
| `charts` | 통계·데이터 헤비 | `264653` / `E76F51` | Calibri / Calibri Light | sharp |
| `night` **(다크)** | 키노트·테크 런칭·프리미엄 | `003566` / `FFC300` | Consolas / Calibri | sharp |

- **알 수 없는 이름은 throw** — 조용한 폴백이 "예전 디자인 같다"의 원인 절반이었다. 오래된 문서의 테마명이 twixy로 렌더되고 아무도 몰랐다.
- `resolveRoles(theme)` → `{title, onLight, onAccent, body, muted, hairline, cardFill, ghostAlpha, chartRun}`. **페인터는 여기만 읽는다** — `t.dark ? A : B` 분기가 13개 렌더러에 흩어져 있던 게 새 렌더러를 짤 때마다 다크 모드를 잊는 1순위 함정이었다.
- `charts`는 `chartColors` 5색 런을 오버라이드(레퍼런스의 "perfect chart color scheme").

### 스타일 레시피 4종 (`payload.style`) — 테마와 직교

| style | radius(S/M/L) | 마진 | 성격 |
|---|---|---|---|
| `sharp` | 0 / 0.03 / 0.05 | 0.45" | 고밀도·격식 — 금융, 데이터 |
| `soft` | 0.05 / 0.08 / 0.12 | 0.55" | 무난한 코퍼레이트 (안전값) |
| `rounded` | 0.1 / 0.15 / 0.25 | 0.65" | 친근·모던 — 제품 마케팅 |
| `pill` | 0.2 / 0.3 / 0.4 | 0.75" | 에어리·프리미엄 — 브랜드 |

카드/뱃지 radius, gap, 패딩이 전부 여기서 나온다. 생략 시 테마의 `styleDefault`.

### 슬라이드 kind 14종

구조: `cover`(variant block/split/center) · `toc`(list/sidebar/cards) · `section`(number/accentBlock/split) · `summary`(takeaways/split/thanks) · `title`(cover의 레거시 alias)
데이터: `stats`(cards/bare, ≤4) · `chart`(bar/line/pie/doughnut/area + takeaway·source) · `compare` · `timeline`(≤6) · `table`(15행 초과 시 "see XLSX")
텍스트: `bullets`(≤8은 액센트 도트 행) · `text`(좌측 액센트 레일) · `quote` · `image`
조합: **`layout`** — 12칼럼 그리드 (§5)

전 슬라이드 공통: 페이지 번호 뱃지(cover 제외), `notes`(스피커 노트), autofit(§6). **알 수 없는 kind는 throw** — 툴 스키마의 `slides`가 passthrough라 오타를 컴파일 타임에 못 잡는다.

## 4. Content 모드 — Copilot 3번째 모드

PPT는 워크플로 노드 모델과 안 맞는다. 노드는 1회 실행 + 수락 판정인데, 덱은 **만들고 → 보고 → 고치는 반복**이 본질이다.

에이전트는 **tool-less `builder` 그대로** 두고 스펙만 쓰게 한다. 앱이 렌더를 소유한다 — 이미 있던 ` ```workflow-spec ` 패턴과 같은 모양이라 세션·소울·라우팅 배선이 전부 재사용됐다.

| 지점 | 파일 |
|---|---|
| 모드 타입·소울 주입 | [useCopilotChat.ts](../src/hooks/useCopilotChat.ts) — `CopilotMode = 'wf' \| 'simple' \| 'content'`. 세션 키가 이미 mode를 포함해 세션이 자동 분리 |
| 프롬프트 | [CONTENT_SOUL.md](../CONTENT_SOUL.md) + [contentSoul.ts](../src/lib/contentSoul.ts). **런북 대신인 이유**: 이 모드는 툴을 안 써서 SKILLS.md 발견 경로를 타지 않는다 |
| 프로토콜 | [parseDeckSpec.ts](../src/lib/parseDeckSpec.ts) — ` ```deck-spec `(전체) / ` ```deck-patch `(슬라이드 1장) |
| UI | [DeckPanel.tsx](../src/components/copilot/deck/DeckPanel.tsx) · [SlidePreview.tsx](../src/components/copilot/deck/SlidePreview.tsx) |
| 영속 | [copilotDecks.ts](../src/lib/copilotDecks.ts) — 대화별 localStorage |

**슬라이드 단위 재생성**은 그 슬라이드 스펙만 실어 보낸다 — 전체를 다시 쓰면 사용자의 다른 편집이 날아가고 느리다. **Export**는 프리뷰와 같은 스펙을 기존 IPC로 구우므로 프리뷰와 파일이 갈라질 수 없다.

### SVG 프리뷰의 두 결정

- **pt viewBox** (`0 0 959.76 540`) — 인치 viewBox면 sub-1 font-size가 되어 힌팅 문제가 생긴다
- **`<text>` 수동 배치, `foreignObject` 금지** — foreignObject는 줄바꿈을 Blink에 위임하고, Node 익스포터는 그걸 재현할 수 없어 드리프트가 되살아난다
- 차트는 **영구적 근사** — PowerPoint가 축 눈금·바 간격·라벨 충돌을 자체 계산한다. 근사 로직도 코어(`preview/chart.ts`)에 둬서 rect·색 런·폰트 크기는 공유한다

## 5. `layout` kind — MiniMax 자유도의 선언적 번역

```jsonc
{ "kind": "layout", "title": "…", "blocks": [
  { "span": 7, "body": { "type": "paragraph", "text": "…" } },
  { "span": 5, "card": true, "body": { "type": "bullets", "items": ["…"] } },
  { "span": 4, "card": true, "body": { "type": "stat", "value": "+34%", "label": "매출 성장" } }
] }
```

블록이 좌→우로 흐르고 행이 차면 줄바꿈(12칼럼), 행은 쪼개지 않는다. `body`: heading · paragraph · bullets · stat · quote · chart · image · kv · spacer.
레시피: 2열 = span-6 둘 · 스탯 행 = span-4 셋 + `card` · 차트+사이드 = span-8 + span-4.

간격은 전부 StyleRecipe에서 나오므로 sharp/soft/rounded/pill 성격을 그대로 물려받는다. 세로 여유는 flexible 블록(차트·이미지)이 흡수하고, 모자라면 autofit 후 남은 초과분을 **overflow 경고**로 — 콘텐츠를 조용히 버리지 않는다.

### 자동 variant 로테이션 + 구조 리포트

**프롬프트 룰은 밀린다.** 런북이 "같은 kind 3연속 금지"라고 하는데도 실행자가 거의 동일한 슬라이드 8장을 낸 걸 실측했다. 그래서 코드로 넣었다([variety.ts](../shared/deck/layout/variety.ts)):

- **로테이션** — 같은 kind가 반복되고 작성자가 variant를 안 정했으면 두 번째부터 코드가 다른 얼굴을 고른다. 커버 3장 → block/split/center. **섹션 구분자는 의도적 제외**(디바이더는 리듬이라 중간에 바뀌면 실수로 읽힌다).
- **구조 리포트** — 목차·섹션·요약 누락, 같은 kind 3연속, 텍스트-only 연속을 계산해 툴 반환값에 실어 보낸다. 경고(`clamped`/`rowsTruncated`/`overflow`/`shrunk`)와 함께 **모델의 유일한 눈**이다.

## 6. autofit — 출시 버그였던 것

pptxgenjs는 `fit:'shrink'`에 대해 `fontScale` 없이 `<a:normAutofit/>`만 emit하고(`pptxgen.cjs.js` ~6067에서 해당 줄이 주석 처리됨), **파워포인트는 도형을 편집할 때만 그 배율을 계산한다.** 즉 긴 제목들은 첫 열람 시 실제로 넘치고 있었고 플래그는 아무 일도 하지 않았다.

코어가 직접 푼다([autofit.ts](../shared/deck/text/autofit.ts)): 공칭 크기에서 0.5pt씩 내리며 들어가는 크기를 찾아 El에 **확정 fontSize**를 굽는다. 가독성 하한 60% — 그 아래로는 줄이지 않고 overflow 경고를 낸다(6pt 글씨보다 정직한 답).

### 텍스트 메트릭 — 실측 보정

`canvas.measureText`는 **금지**다. 브라우저에만 있어서 export와 preview가 갈라진다. 대신 결정론적 자폭 테이블을 쓰되, 브라우저에서 실제 폰트를 재서 보정했다:

| | 보정 전 | 보정 후 |
|---|---|---|
| 문장 단위 평균 오차 | ±10% | **1.5%** (최대 3.3%) |

7개 테마 폰트 × 한/영 기준. **오차가 전부 양수**(약간 과대추정)라 실제 폰트보다 일찍 줄바꿈한다 = 오버플로를 놓치지 않는 안전한 방향.

- 한글/CJK는 **글자 단위 분절 + 최소 금칙** — 공백 기준 래핑은 한국어에서 아예 작동하지 않아 필수 요건이었다. serif 스택은 한글 폴백도 serif라 폭이 달라서 따로 잡는다
- `Calibri`/`Cambria`/`Consolas`는 macOS 기본 미탑재 → 프리뷰 전용 폴백 스택([preview/fonts.ts](../shared/deck/preview/fonts.ts)). pptx 쪽은 실제 이름을 그대로 보내 Windows PowerPoint가 진짜 폰트를 쓰게 한다

## 7. 임포터 — 받은 .pptx를 재료로

[pptxRead.ts](../electron/tools/files/pptxRead.ts). zip은 jszip(pptxgenjs가 이미 쓰던 것을 직접 의존성으로 승격), XML은 **목적에 맞춘 스캐너**(새 XML 의존성 없음 — 대신 §8의 왕복 테스트로 검증).

**무엇을 복구하고 무엇을 못 하나 — 이 경계가 중요하다.** 임포터는 **내용**(슬라이드별 제목·본문·아웃라인 레벨·표·노트)을 가져와 우리 디자인 시스템으로 다시 그린다. 픽셀 복사가 아니다:
- **차트는 불릿으로 돌아온다** — 데이터가 슬라이드 XML이 아니라 내장 워크북에 있다
- 레이아웃·마스터·SmartArt는 복구 불가

이게 오히려 쓸모 있는 방향이다: 클라이언트가 준 덱을 받아 **리테마**하는 게 목적이다.

두 가지 정제가 필요했다:
- **페이지 번호 뱃지 제거** — 안 그러면 모든 임포트 슬라이드에 유령 "7" 불릿이 붙고 분류기가 문단 수를 잘못 센다. 셰이프 좌표(EMU)를 읽어 하단 12% 밴드의 숫자만 제거하고, 슬라이드 높이는 `presentation.xml`에서 읽어 4:3 덱도 맞게
- **노트 마스터의 슬라이드 번호 자리표시자 제거** — 노트 파트는 작성자가 아무것도 안 써도 비어 있지 않다

분류는 **의도적으로 보수적**: 확신 없으면 `bullets`/`text`로 떨어뜨린다(잘못 찍은 rich kind를 되돌리는 비용이 더 크다). 다만 어느 덱에나 통하는 관습 3개는 인식 — "Contents/목차"+목록 → `toc`, 숫자만 있는 제목 → `section`, 첫 슬라이드 제목+짧은 부제 → `cover`.

### 채팅 첨부

드래그&드롭 배선은 이미 있었고 `.pptx`만 accept 리스트에서 막혀 있었다. 그 리스트가 **세 곳에 각자 하드코딩**돼 있다: [CopilotView](../src/components/copilot/CopilotView.tsx) 드롭 · [ChatPanel](../src/components/ChatPanel.tsx) 드롭 · `MSG_FILE_RE`([useCopilotChat.ts](../src/hooks/useCopilotChat.ts)). 새 타입을 지원할 땐 넷(+데이터 파일 카탈로그) 전부 봐야 한다.

Content 모드에서 .pptx를 떨어뜨리면 **즉시 편집 가능한 덱으로 열린다** — 첨부 텍스트로도 가고(모델이 읽음) 프리뷰로도 간다(사람이 봄).

## 8. 검증 장치 — 이게 없으면 이 리팩터는 불가능했다

테스트 러너가 없는 리포라 두 개를 직접 만들었다. 둘 다 의존성 0.

### 스냅샷 오라클 — `npx tsx scripts/deck/snapshot.ts`

pptxgenjs 호출을 **인자 deep-clone으로 기록**(라이브러리가 옵션 객체를 in-place 변형하므로 기록 시점 클론 필수)해 JSON 베이스라인과 비교. `--update`로 재베이스라인.
현재 **16 픽스처 / 407 슬라이드 / 2854 콜**. 전 kind×variant, 7테마, 4스타일, 구형 payload, 클램프 케이스, autofit 오버플로, 자동 로테이션, 그리드.

**실제로 두 건을 잡았다:**
1. **커버 배경 소실 45건** — 오라클 자체 버그(스텁의 `background`가 setter만 있고 getter가 없어 JSON에서 통째로 빠짐)를 먼저 고치자 즉시 검출. 안 잡았으면 전 테마의 표지가 깨진 채 나갔다
2. **도넛/파이 미렌더** — path의 `d` 문자열을 정규식으로 72배 할 때 arc의 플래그(0/1)까지 곱해져 경로가 깨짐

### 왕복 테스트 — `npx tsx scripts/deck/roundtrip.ts`

우리 writer로 굽고 → 임포터로 되읽고 → **텍스트가 살아남는지** 검증. 손으로 쓴 XML 스캐너에 대한 가장 강한 검증이다. 현재 **2136개 문자열 전량 복구, 손실 0**.
기대값은 kind-aware — 렌더러가 클램프한 것(stats>4 등)과 차트 데이터(슬라이드 XML에 없음)는 애초에 제외해야 테스트가 노이즈가 되지 않는다.

### 육안 검증 — `npx tsx scripts/deck/preview-html.tsx`

**진짜 `SlidePreview` 컴포넌트**를 `renderToStaticMarkup`으로 HTML에 뽑는다(복사본이 아님). 도넛 버그를 잡은 게 이것이다.

## 9. 현재 검증 상태

완료:
- 스냅샷 0 diffs · 왕복 0 손실 · electron tsc 클린 · renderer tsc 신규 에러 0(기존 8개 유지) · `vite build` 성공(렌더러 번들에 `shared/deck`와 CONTENT_SOUL 포함 확인)
- 7테마 실제 .pptx 생성, unknown theme/style throw, 구형 payload 하위호환
- 실제 덱 읽기 → night/pill 리테마 → 재읽기 왕복
- 12종 데이터 슬라이드 + 그리드 3종 + 로테이션 육안 확인

**미완 — 앱 구동 E2E:** Content 모드에서 "이 xlsx로 덱 만들어줘" → 프리뷰 → "3번만 차트로" → Export → 키노트로 열어 **프리뷰와 대조**. 그리고 워크플로 노드 경로에서 실행자가 런북을 읽고 새 kind·theme를 쓰는지 (`~/.openclaw/agents/workflow-runner/sessions/<latest>.jsonl`).
앱 재시작이 필요하다 — `openclaw.json`은 spawn 시에만 읽히므로 새 `tool_read_pptx`가 그 전엔 안 보인다.

## 10. 유지보수 — 손으로 동기화해야 하는 것들

같은 사실이 여러 곳에 복제돼 있고 드리프트 감지 장치가 없다. **새 kind/테마/스타일을 추가할 때 전부:**

| 지점 | 파일 |
|---|---|
| 코어 | `shared/deck/spec.ts`(union + `SLIDE_KINDS`) · `theme.ts` · 해당 `layout/*.ts` · `layout/index.ts` 디스패치 |
| 툴 description | `patches/openclaw+2026.4.2.patch` → **`npx patch-package openclaw` → `npm run prepare:openclaw`** |
| allowlist | 같은 패치의 `tool-policy` CORE_TOOL_DEFINITIONS |
| 빌더 카탈로그 | `src/lib/workflowTools.ts` |
| 프롬프트 | `skills/pptx/pptx.tskill`(→ SKILL.md 재컴파일) · `CONTENT_SOUL.md` · `SOUL.md` |
| 오라클 | `scripts/deck/fixtures.ts`에 픽스처 추가 — **없으면 그 경로는 무방비다** (autofit이 실제로 그랬다) |

`src/global.d.ts`는 **자동** — `import()` 타입으로 코어를 직접 가리키므로 드리프트가 컴파일 에러가 된다(예전엔 손 미러였고 실제로 드리프트가 나 있었다).

### 함정

- **SOUL.md 20,000자 캡** — 현재 19,701자. 넘으면 테일(딜리버러블 툴 매핑 표)이 잘려 LLM이 툴 자체를 못 본다. 수정 시 `wc -c SOUL.md` 필수
- **다크 테마** — 새 페인터는 색을 반드시 `c.r`(Roles)에서 읽을 것. `t.dark ? A : B`를 직접 쓰면 그 함정이 부활한다
- **pptxgenjs 옵션 객체 변형** — 페인터는 호출마다 새 리터럴을 만든다. El을 그대로 넘기면 디스플레이 리스트가 오염되고 프리뷰·스냅샷까지 망가진다
- **El 배열 순서 = 페인트 순서** — 섹션 고스트 번호가 실번호보다 먼저 와야 한다. "rect 먼저 일괄" 같은 최적화 금지
- **첨부 accept 리스트 4곳** (§7)
- **번들 패치** — `prepare:openclaw`가 바닐라 openclaw를 설치한 뒤 패치를 재적용한다. 이 단계가 없으면 dmg에 Twixy 툴이 빠진 채 나간다(2026-08-12에 실제로 그랬고 dev에선 안 보였다)
