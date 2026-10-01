# 덱 생성 고도화 2차 — 목적 × 얼굴 × 브랜드, 그리고 모델의 눈

> **대상:** Twixy 팀 (개발)
> **한 줄:** Anthropic 공식 pptx 스킬과의 코드 레벨 비교에서 나온 결론 — "그들의 실체는 모델이 자기 슬라이드를 **본다**는 것" — 을 우리 아키텍처(스펙 계약 + 공유 레이아웃 코어)를 버리지 않고 이식하고, 그 위에 목적 레이어·페이지 얼굴·브랜드 파생·OOXML 편집을 얹은 9단계 업그레이드.
> **상태:** 전 단계 구현 + 로컬 검증 완료. **미완 1건** (§8 — 앱 구동 E2E).
> **브랜치:** `feature/pptx-skill-upgrade` (커밋 731904d…63a17e7)
> **선행 문서:** [PPTX_DECK_GENERATION.md](PPTX_DECK_GENERATION.md) (1차 — 공유 코어 구조) · [DECK_TEMPLATE_CATALOG.md](DECK_TEMPLATE_CATALOG.md) (비즈니스 카탈로그)
> **후속 문서:** [PPTX_UPGRADE_3.md](PPTX_UPGRADE_3.md) (3·4차 — 같은 프롬프트 실측 루프: 밀도·그래픽 어휘·오버뷰·디바이더)

---

## 1. 왜 — Anthropic pptx 스킬 비교의 결론

[anthropics/skills/skills/pptx](https://github.com/anthropics/skills/tree/main/skills/pptx)를 SKILL.md + scripts 전체 수준에서 분석했다. 그들의 구조: 모델이 매번 **자유 pptxgenjs 코드**를 쓰고, LibreOffice→PDF→이미지로 렌더해 **모델이 직접 보고** 고치고, OOXML을 직접 수술해 편집하고, XSD 검증기를 돌린다.

핵심 판단 두 가지:

1. **자유 코드로 갈아타지 않는다.** 갈아타면 우리가 이기는 것 — 라이브 프리뷰, 프리뷰↔파일 구조적 일치, 속도/비용, 품질 바닥, 스냅샷 회귀망 — 을 다 내준다.
2. 그들의 고도화의 실체는 스크립트 5개가 아니라 **"만들고→보고→고친다"의 '보고'를 모델이 한다**는 것 하나다. 나머지(팔레트 규칙, AI-티 금지 목록, 폰트 목록)는 그 루프를 보조하는 프롬프트고, 프롬프트 규칙이 코드에 진다는 건 이 레포가 두 번 실측한 사실이다.

그래서 이식한 것 4개(모델의 눈 · 파일 자가검증 · OOXML 편집 · 아이콘) + 자체 계획 4개(목적 · 얼굴 · 시드 회전 · 브랜드 색) + 기반 1개(프롬프트 사본 기계화).

수입하지 **않은** 것도 기록해 둔다: 그들의 "AI 티" 금지 목록 중 액센트 밑줄·가운데 정렬 금지(무작위 코드 출력의 티를 지우는 규칙이지, 우리처럼 일관된 디자인 시스템에는 해당 없음), 폰트 교체(그들의 QA-unreliable 목록은 LibreOffice 대체 렌더 특유의 리스크. 우리는 자체 메트릭으로 autofit하고 해당 폰트는 Win/Mac 표준 탑재. 단, 폰트 미탑재 환경에서 폭이 달라질 수 있음은 카탈로그에 명기).

---

## 2. 새 아키텍처 — 네 겹, 서로 직교

```
payload = { purpose?, theme?, brand?, style?, accent?, slides[] }
              │        │       │
              │        │       └─ deriveTheme: hex 하나 → 전체 팔레트 (theme 은 폰트·스타일·명암만 공급)
              │        └─ 7 프리셋 (구조: 폰트·스타일·light/dark)
              └─ 6종 (pitch/report/decide/align/analyze/teach) — 구조 검사만, 기하에 절대 불개입

buildDeck 파이프라인:
  resolveTheme(+brand) → resolveStyle → resolvePurpose → rotateVariants(slides, deckSeed)
  → layoutSlide × n → autofit → DeckDisplay { slides, purpose, structure: structureReport(specs, purpose) }
```

**불변식 (전부 실측으로 강제):**

| 불변식 | 강제 수단 |
|---|---|
| painter는 `purpose`로 분기하지 않는다 — 목적은 리포팅 레이어 | 스냅샷이 purpose-blind (recorder가 structure를 안 기록) → purpose 추가 시 0 diffs |
| 회전은 내용 가시성을 못 바꾼다 | 유일하게 lossy한 `table:kv`(헤더 없음)를 회전에서 제외, 명시 선택 전용 — roundtrip이 위반을 잡음 |
| variant는 내용을 버리지 않는다 — 못 담으면 기본 얼굴로 폴백 | cards>6 · twoCol<4 · stacked>3/변 · kv≠2열 · split w/o takeaway, 전부 픽스처로 고정 |
| painter는 `t.dark`를 읽지 않는다 — 색은 롤(`c.r.*`)로만 | 다크 시트 눈검사 + 브랜드 대비 단언 |
| 시드 = title+theme **만** (슬라이드 목록 제외) | deck-patch로 한 장 추가해도 기존 장 기하 불변 — `structure-check`의 patch-stable 단언 |
| 모르는 이름(theme/style/purpose/icon/kind)은 hard error | resolveTheme 규율의 전면 확장 |

---

## 3. 단계별 — 무엇을, 왜, 어디에

### Phase 0 — 프롬프트 사본 기계화 (5e77581)
같은 필드 계약이 6곳 사본이었고 그 드리프트가 "모델이 필드명을 지어내 전 덱 렌더 실패" 사고의 근원. 큰 사본 2곳(CONTENT_SOUL.md, pptx.tskill)을 **마커 구간 + 생성물**로 전환.
- `shared/deck/spec.ts` `FIELD_SIGS` — 필드 SHAPE를 데이터로 (SLIDE_FIELDS와 같은 이중 타입체크)
- `scripts/deck/gen-prompt-block.ts` — 스키마 펜스·목적 테이블·아이콘 로스터를 마커 사이에 생성 (`npm run gen:deck-prompt -- --write`)
- `scripts/deck/check-prompt-schema.ts` — 마커 구간 정확 일치 diff ×4 + 패치 정규식 ×1. `npm run lint`에 편입
- `scripts/skills/compile.ts` — SKILL.md를 앱 부팅 없이 재컴파일 (`npm run skills:compile`)
- ⚠️ 함정 2개 문서화: `stripEnums()`가 `a|b|c` 런을 지우므로 목적 테이블은 ` / ` 구분자 · 패치 검사 앵커는 `name: "tool_write_pptx"`(bare 이름은 edit 툴 설명이 먼저 언급)

### Phase V — 모델의 눈 (8255d28)
- **V1** `shared/deck/preview/svg.ts` — SlidePreview의 그리기를 React 없는 순수 문자열 빌더로 추출(`slideSvgInner`/`slideSvg`). JSX가 해주던 XML 이스케이프는 `esc()`로 직접. painter 하나 = 소비자 셋(React 래퍼 · preview-html · main 래스터)
- **V2** `electron/tools/files/pptxPreview.ts` — `renderDeckSheet`: buildDeck → slideSvg → sharp → **번호 라벨 4열 컨택트시트 1장** (≤1200px — openclaw sanitizer 재압축 회피). 34장 ≈0.5초
- **V3** 에이전트 경로: bridge `write-pptx`가 `__images`(base64 PNG)를 결과에 실으면 패치의 bridge 래퍼가 image content block으로 승격 (openclaw `AgentToolResult`는 원래 이미지 지원 — browser 툴 screenshot이 선례). 툴 description + 런북 TRACK에 "이미지를 보고 체크리스트 확인, 같은 relPath로 **1회만** 재작성"
- **V4** Content 모드: builder는 tool-less라 IPC `deck-render-sheet`가 시트를 **워크스페이스 안** `data/tmp/deck-qa/<convId>.png`에 저장(밖이면 openclaw workspaceOnly 인라이너가 거부, 7일 lazy 청소), CopilotView가 대화당 1회 `[Image: source: …]` + 구조 노트 + 체크리스트 후속 메시지 전송. **구조 노트 되먹임과 같은 메시지 — 왕복 하나**
- 배선 중 발견: QA 응답은 "고칠 슬라이드마다 deck-patch 하나"인데 파서가 첫 펜스만 읽어 나머지를 조용히 버림 → `parseAllPatches` 신설, CONTENT_SOUL "블록 하나" 규칙에 QA 예외 명시

### Phase Q — 내보내기 자가검증 (6a9f0bc)
그들의 validate.py(XSD) 등가인데 실효는 더 강함: 방금 쓴 파일을 **우리 임포터로 되읽어** slideCount + 전 문자열 생존 확인. `visibleTexts`를 `shared/deck/visibleTexts.ts`로 승격해 roundtrip 테스트와 런타임 검증이 같은 정의 공유. 실패해도 파일은 남기고 사실만 보고. bridge/IPC 결과 `verified` 필드 + Content 모드 "(34 slides verified)".

### Phase E — OOXML 직접 편집 (cc01f99)
- `electron/tools/files/pptxEdit.ts` — replaceText / setNotes / duplicateSlide / deleteSlide / reorderSlides / .potx→pptx. **원문 XML 위의 문자열 수술** (parse→serialize 왕복은 남의 마크업을 뭉갠다). 트랜잭션: 임시 파일 → 자기 스캐너로 되읽혀야만 원본 교체
- 명시된 한계: replaceText는 한 formatting run 안에서만(분할 시 문단 원문과 함께 거부) · 복제본은 차트/미디어 파트 공유 · 미디어는 삭제 안 함(공유 리스크) · **남의 덱 픽셀 프리뷰 없음**(우리 렌더러는 우리 스펙만 그림 — 텍스트 개요로 확인)
- `tool_edit_pptx` 등록(패치 스키마+설명+카탈로그) · SOUL 라우팅: "원본 그대로 고쳐줘"=edit / "우리 스타일로 다시"=read→write
- **이 작업이 잡은 스캐너 잠복 버그**: readPptx가 슬라이드를 파일명 번호로 정렬(실제 표시 순서인 `sldIdLst` 무시), 노트도 번호 일치 매핑. 우리 writer 출력은 둘이 일치해 안 드러났지만 reorder된 덱에서 거짓 보고 → 표시 순서 + rels 경유 노트 해석으로 수정

### Phase 1 — 목적 레이어 (e6d38b7)
- `shared/deck/purpose.ts` — 목적 6종 페이지 테이블: 슬롯 `{ role, kinds(선호순), repeat[min,max], guide }`. 슬롯당 kind 복수 = 같은 목적 안 베리에이션의 원천. `fitPurpose`는 **lazy** 매칭(greedy면 analyze 덱에서 'finding'이 차트를 다 먹고 'implication' 없음이라는 거짓 노트)
- `varietyReport` → `structureReport(specs, purpose)` 노트 3군: **A** 목적(필수 슬롯 누락·미달·첫등장 인덱스 역전 — 디바이더 인터리브는 오발 안 함) · **B** 미선언 넛지 + 레거시 뼈대 검사 유지 · **C** 기하 — `faceOf`(kind:variant, layout은 span 패턴)로 같은 얼굴 3연속·가짓수 하한·**layout 압력**을 코드로
- 기존 버그 수정: `structureReport`에 회전 **후** specs 전달 (전 목록이면 렌더된 적 없는 variant를 측정)

### Phase 2 — 페이지 얼굴 + 시드 회전 (f024984 · 888edea)
- **2A**: chart(full/split/banner) · bullets(rows/cards/numbered/twoCol) · compare(cards/vs/stacked) · table(grid/zebra/kv) · timeline(rail/vertical/bars) · text(rail/panel/twoCol) — 고정 얼굴 22→37. 커밋 분리 이유: painter와 회전 정책을 섞으면 baseline diff에서 painter 회귀가 정책 변경에 묻힘. 기존 픽스처 28곳에 기본 얼굴 명시 고정 → 2B diff가 "배정 변경"만으로 좁혀짐
- **2B**: FNV-1a 시드(title+theme) · 첫 등장도 회전 · **kind 해시 오프셋으로 탈상관**(길이 3 회전이 5개라 seed%3만으로는 전 kind가 같은 인덱스 — 실측) · section은 덱당 1종 균일 · 킬스위치 seed 0 = 옛 동작 바이트 동일

### Phase 3 — 브랜드 색 파생 (ca8389f)
- `shared/deck/color.ts`(순수 색 수학: WCAG contrast, pickReadable, ensureContrast 40회 상한) + `deriveTheme(brand, base)` — hue 파생 팔레트, 저채도 브랜드는 보색 액센트, 차트 런 hue 32° 간격
- **dark는 절대 추론 안 함** — navy 프리셋(primary 0B2545)이 밝은 덱인 것과 같은 이유. `theme:'night'` + `brand` = 다크 브랜드 덱
- `Theme.onAccent/onLight` 옵셔널 롤 — deriveTheme만 채우고 프리셋은 undefined → 프리셋 출력 바이트 동일(스냅샷 diff 0)
- 대비 단언 12 hex × light/dark(순노랑·근검정·연분홍·회색 포함). 잡은 것: #0B2545 다크 4.45 → 텍스트 후보로 안 되면 **액센트 자체가 움직이는** 마무리 단계

### Phase I — 아이콘 (e23a1df)
- `scripts/deck/gen-icons.ts` — lucide-react 패키지에서 68종 path 코드젠(별칭 re-export 추적). 산출물 `shared/deck/icons.ts` 커밋 — shared는 의존성 없이 순수
- El `icon` + layout 블록 `{ type:'icon', name, label?, sublabel? }`. SVG는 path 스트로크, pptx는 writePptx가 sharp로 128px PNG data URI 선래스터(painter는 동기 유지). **SVG 임베드 배제** — Office 2019+만 렌더하고 Keynote 임포트 불안정

### 부수: i18n (731904d · 0dce12b) + 빌드 수정 (63a17e7)
- UI·모델 대면 프롬프트·**프롬프트 속 예시**(특히 tskill의 견본 덱 — 가장 강한 few-shot 편향원) 전부 영어. 규칙: "슬라이드는 사용자 요청과 소스 데이터의 언어로"
- sharp는 네이티브 모듈이라 electron 번들에서 external로 (`vite.config.ts`) — 안 하면 앱 로드 크래시

---

## 4. 검증 하네스와 잡은 버그 실록

이번 웨이브에서 하네스가 잡은 실제 결함 — **하네스를 유지해야 하는 이유** 그 자체다:

| 잡은 것 | 잡은 하네스 |
|---|---|
| readPptx가 표시 순서 대신 파일명 순 정렬 (+노트 번호 매핑) | edit-roundtrip ("reorder가 안 됐다"는 거짓 보고로 노출) |
| 회전이 kv를 골라 헤더가 무단 소실 | roundtrip (문자열 생존 단언) |
| 시드가 길이 3 회전 5개를 같은 인덱스에 상관 | seed-a/b 얼굴 목록 실측 |
| #0B2545 다크 onAccent 대비 4.45 | structure-check 대비 단언 |
| QA 응답의 복수 deck-patch 중 첫 것만 적용 | 배선 중 파서 검토 |
| 패치 검사 창이 엉뚱한 툴 위에 열림 | check:deck (edit 툴 추가 직후 14건 실패) |

**정기 실행 명령:**

```bash
npm run check:deck          # 프롬프트 마커 diff + 목적/기하/대비 동작 단언
npx tsx scripts/deck/snapshot.ts        # pptxgenjs 호출 스냅샷 (26 픽스처 / 601 슬라이드)
npx tsx scripts/deck/roundtrip.ts       # writer→importer 문자열 생존 (3,172)
npx tsx scripts/deck/edit-roundtrip.ts  # OOXML 편집 전 연산 + 실제 PowerPoint 파일
npx tsx scripts/deck/preview-html.tsx   # SVG painter 눈검사 HTML
```

`snapshot.ts --update`는 **diff를 읽은 뒤에만.** baseline에 삭제가 있으면 기존 픽스처가 움직였다는 뜻 — 멈추고 원인부터.

**스키마/프롬프트를 바꿀 때:** `shared/deck/spec.ts`(또는 purpose.ts/icons.ts) 수정 → `npm run gen:deck-prompt -- --write` → `npm run skills:compile` → `npm run check:deck`. 패치의 툴 description은 dist 수정 후 `npx patch-package openclaw`로 재생성.

---

## 5. 새 파일 지도

| 파일 | 역할 |
|---|---|
| `shared/deck/purpose.ts` | 목적 6종 페이지 테이블 + lazy 매처 |
| `shared/deck/color.ts` | 순수 색 수학 (WCAG) |
| `shared/deck/icons.ts` | lucide 68종 path (코드젠 산출물, 커밋) |
| `shared/deck/visibleTexts.ts` | "슬라이드에 실제 실리는 문자열" — roundtrip과 런타임 verify 공유 |
| `shared/deck/preview/svg.ts` | El[] → SVG 문자열 (painter 본체) |
| `electron/tools/files/pptxPreview.ts` | 컨택트시트 래스터 (sharp) |
| `electron/tools/files/pptxVerify.ts` | 내보내기 후 되읽기 검증 |
| `electron/tools/files/pptxEdit.ts` | OOXML 수술 (tool_edit_pptx) |
| `scripts/deck/gen-prompt-block.ts` | 프롬프트 마커 구간 생성기 |
| `scripts/deck/gen-icons.ts` | 아이콘 코드젠 |
| `scripts/deck/structure-check.ts` | 목적/기하/대비 동작 단언 |
| `scripts/deck/edit-roundtrip.ts` | 편집 연산 검증 |
| `scripts/skills/compile.ts` | SKILL.md 재컴파일 |

**바뀐 계약 지점** (새 payload 필드 추가 시 반드시): 패치 `Type.Object`(additionalProperties:false — 누락=툴콜 거부) · `parseDeckSpec.ts` pick(누락=조용한 드롭) · 마커 구간 재생성.

---

## 6. 툴 라우팅 (최종형)

| 요청 | 경로 |
|---|---|
| 덱 새로 / 우리 디자인으로 | `tool_write_pptx` — purpose 선언, 툴이 컨택트시트 이미지 + structure + verified 반환, 1회 자가수정 |
| 받은 덱을 원본 그대로 수정 | `tool_edit_pptx` — 문구·노트·복제·삭제·순서·.potx, `outline`으로 확인 |
| 받은 덱을 우리 스타일로 | `tool_read_pptx` → `tool_write_pptx` (리테마) |
| Content 모드 | `deck-spec`/`deck-patch` 펜스 — 앱이 렌더·QA 이미지 주입·검증 |

## 7. 위험 · 운영 노트

- **패치 재적용**: `npm run postinstall`이 유일한 적용 경로. `prepare-openclaw-bundle.mjs`도 패치를 적용함(확인됨 — 과거 사고 지점)
- **vision 비용**: 시트 1장 · 덱당 1회로 제한. 모델이 반복 호출하면 런북 상한 문구를 조정
- **Windows 빌드**: sharp 크로스 빌드 시 `npm install --os=win32 --cpu=x64 sharp` 단계 필요 (현재 Mac 전용이라 미적용)
- **sharp/lucide 업그레이드**: baseline의 아이콘 PNG 바이트가 바뀔 수 있음 — 재생성(`gen-icons`) 후 스냅샷 재기록이 정상 절차

## 8. 남은 것 — 앱 구동 E2E

`openclaw.json`과 패치는 스폰 시점에만 읽히므로 **앱 재시작 필수**. 체크리스트:

1. **Content 모드**: "Build an August performance report for a client" → 프리뷰가 뜨고 → 진단 패널에 `purpose report` → 곧 QA 후속 메시지(이미지 포함)가 가고 모델이 deck-patch로 응답하는지 → Export 후 "(N slides verified)"
2. **워크플로 경로**: 덱 노드 1회 실행 → `~/.openclaw/agents/workflow-runner/sessions/<latest>.jsonl`에서 tool 결과에 image block이 있는지 + 재호출이 1회로 끝나는지
3. **편집 경로**: .pptx 첨부 후 "fix the title on slide 2, keep the design" → tool_edit_pptx 라우팅 + PowerPoint/Keynote에서 열어 원본 디자인 유지 확인
4. 같은 요청을 제목만 바꿔 두 번 → 두 덱의 얼굴 배정이 다른지 (시드)
