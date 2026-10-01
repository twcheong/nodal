# 파일 인제스트 — 첨부 추출 · 잘림 계약 · 표의 진실 경로

> **대상:** Twixy 팀
> **한 줄:** 유저가 첨부한 xlsx/docx/pptx/pdf 를 모델이 읽을 수 있게 바꾸는 계층. 그리고 **잘릴 때 잘렸다고 말하게** 만드는 계약.
> **상태:** 구현 + 실파일 검증 완료. **미지원 1건** (§8 — 구형 `.xls`).
> **브랜치:** `feature/pptx-skill-upgrade`
> **관련:** [DATA_TOOLS.md](DATA_TOOLS.md) (§3 `tool_query_data` — 표의 진실 경로) · [PPTX_DECK_GENERATION.md](PPTX_DECK_GENERATION.md) (같은 OOXML 스캐너를 쓰는 덱 임포터)

---

## 1. 왜 이 모양인가

2026-08-13, EDIS 에이전시 인스타 인벤토리 60행짜리 `.xlsx` 를 첨부하고 물었더니 이런 답이 나왔다.

> "현재 Excel은 60개 중 43개만 있다 (positions 1–43). posts 44–60의 engagement data가 수집 안됐어."

확신에 차 있었고, 틀렸다. 파일에는 60행이 다 있었다. 잘린 건 파일이 아니라 **첨부 추출의 문자 예산**이었다.

측정값:

```
edis_agency_post_inventory_final.xlsx  →  추출 텍스트 10,365자
extractText 기본 상한                    12,000자
실제 호출값 (useCopilotChat / useWorkflowTest)  8,000자   ← 기본값을 덮어씀
8,000자 지점에서 마지막 온전한 행         Position 43,  그 뒤는 "44,https://w" 에서 절단
```

`Math.min(budget, 8_000)` 이 기본값을 덮어써서 정확히 43행에서 끊겼다. 12,000자였다면 55행까지 보였을 것이다.

그리고 그 오판은 **디스크에 굳었다.** 같은 시각에 43행짜리 산출물이 새로 쓰였다 (`2026-08-13T20-01-55-edis_agency_post_inventory_final_1.xlsx`, 정확히 43행). 잘린 뷰를 데이터로 읽은 노드가 그 뷰대로 파일을 다시 쓴 것이다.

여기서 나온 일반화가 이 문서 전체의 근거다.

> **모델은 "내가 본 마지막 행" 을 "존재하는 마지막 행" 으로 읽는다.**

산문은 40번째 문단이 없어도 요약이 조금 나빠질 뿐이다. 표는 다르다. **표에서 조용한 잘림은 품질 저하가 아니라 사실 오류가 된다.** 그리고 그 오류는 "데이터가 누락됐다" 라는, 자신만만하고 검증하기 귀찮은 형태로 나온다.

### 부수적으로 드러난 것: `.docx` 가 아예 안 읽혔다

확장자 목록이 **네 군데에 따로** 하드코딩돼 있었고 전부 달랐다.

| 위치 | 목록 | 결과 |
|---|---|---|
| `extractText.ts` REGISTRY | `.pptx` O, `.docx` **X** | 워드 첨부 → `extractPlainText` → zip 이라 `looksBinary()` → "cannot read as text" |
| `useCopilotChat` `MSG_FILE_RE` | `.pptx` O, `.docx` **X** | 채팅에서 워드 경로를 언급해도 매칭 자체가 안 됨 |
| `useWorkflowTest` `DOC_PATH_RE` | `xlsx\|xls\|pdf` 뿐 | **노드에선 `.pptx` 도 안 붙음** — 채팅과 노드의 조용한 비대칭 |
| `useCopilotChat` 워크스페이스 walk | 또 다른 목록 | 카탈로그에 안 뜸 |

`supportedExtractExts()` 는 "단일 진실 공급원" 이라 주석까지 달려 있었지만 **아무도 안 쓰고 있었다.** 목록이 네 벌이면 드리프트는 시간 문제고, 실제로 드리프트했다.

---

## 2. 두 경로 — 첨부는 미리보기, query-data 는 진실

다른 LLM 서비스들이 표를 다루는 방식은 하나로 수렴한다: **표를 프롬프트에 넣지 않는다.** ChatGPT 는 파이썬 샌드박스에서 pandas 로 질의하고, Claude.ai 는 JS REPL 을 쓴다. 모델은 파일 전체를 본 적이 없고, `len(df)` 가 **접근 가능한 진실**이라 행을 눈으로 셀 이유가 없다.

Twixy 는 이미 그 구조를 갖고 있었다 — `tool_query_data` (DuckDB, [DATA_TOOLS.md](DATA_TOOLS.md) §3). 문제는 **엑셀만 그 문으로 못 들어갔다**는 것이다.

```ts
// 고치기 전 — queryData.ts readerFor()
.csv/.tsv/.txt  → read_csv_auto
.parquet        → read_parquet
그 외            → read_json_auto      // ← .xlsx 가 여기로 떨어져 실패
```

그래서 스프레드시트만 유일하게 프롬프트 덤프 경로로 우회당했고, 거기서 잘렸다. 아키텍처가 틀린 게 아니라 **입구가 막혀 있었다.**

지금의 역할 분담:

| | 첨부 추출 (`extractText`) | `tool_query_data` |
|---|---|---|
| 무엇 | 모델이 읽을 **미리보기** | 전량이 진실인 **질의** |
| 예산 | 있다 (파일당 30k자) | 없다 |
| 잘리나 | 잘릴 수 있다 → 반드시 명시 | 안 잘린다 |
| 쓰는 때 | 문서를 읽고 이해·요약·인용 | 표를 **세고 거르고 합치고 조인** |
| 못 하는 것 | 정확한 집계 | 산문 이해 |

노드 프롬프트와 툴 설명 양쪽에 이 분담을 박아 뒀다 ([workflowTools.ts](src/lib/workflowTools.ts) `data` 툴 설명, [useWorkflowTest.ts](src/hooks/useWorkflowTest.ts) 첨부 헤더).

---

## 3. 잘림 계약 — 세 가지 규칙

[extractText.ts](electron/tools/files/extractText.ts) 가 모든 포맷에 대해 지킨다.

**① shape 를 데이터보다 먼저.** 전체 행/페이지/슬라이드 수를 내용과 **별도로 선언**한다. 세어보게 두지 않는다.

```
# Sheet "Post Inventory" — 60 data rows × 9 columns
```

**② 단위 경계에서 자른다.** 행·페이지·블록 중간에서 끊지 않는다. `44,https://w` 같은 반쪽 행은 파싱 에러가 아니라 **조용한 오독**을 만든다. 포맷별 단위: 행(xlsx/csv) · 페이지(pdf) · 슬라이드(pptx) · 블록(docx) · 줄(그 외).

**③ 잘린 사실을 끝에 명시한다.** 맨 위 헤더는 무시되기 쉽다. **데이터가 끊기는 바로 그 지점**에 적는다.

```
… [TRUNCATED — showing 41 of 60 rows. 19 more rows exist in the file but are not
shown. This is a display limit, not the end of the data. Use the query-data tool
(SQL over the file) to read or aggregate the full table — it is not limited by
this budget.]
```

문구 설계 두 가지가 의도적이다.

- **"This is a display limit, not the end of the data."** — 사건에서 모델이 내린 결론을 정면으로 부정한다.
- **표에만 붙는 `hint`** — 어디로 가야 전량을 보는지까지 말한다. 문제를 알려주고 해법을 안 주면 모델은 그냥 추측한다.

구현상 주의 두 가지:

- `MARKER_RESERVE = 320` — 마커가 들어갈 자리를 **미리 비워둔다.** 마커까지 잘리면 이 설계가 통째로 무의미해진다. (그래서 8,000자 상한에서 옛 43행이 아니라 41행이 보인다 — 정상 동작이다.)
- `total` 을 units 와 **따로 받는다.** units 자체가 이미 상류에서 잘려 있을 수 있어서(예: `readXlsx` 의 행 상한), `units.length` 를 전체라고 말하면 두 번째 거짓말이 된다. xlsx 는 `actualRowCount` 가 진실을 준다.

### `rowCount` 와 `actualRowCount`

exceljs 의 `rowCount` 는 **값 없이 서식만 남은 꼬리 행까지** 센다. 그걸로 "60행" 이라 선언하고 56행을 보여주면 4행이 사라진 걸로 읽힌다 — 고치려던 바로 그 오류의 재발이다. `actualRowCount`(값이 있는 행)를 추가해 모델에게 보고하는 숫자는 이쪽을 쓴다.

---

## 4. 포맷별 지원 현황

| 확장자 | 파서 | 출력 | 잘림 단위 |
|---|---|---|---|
| `.xlsx` `.xlsm` | exceljs (`xlsx.ts`) | 시트별 CSV + shape 헤더 | 행 |
| `.docx` | **자체** (`docxRead.ts`) | 제목/문단/목록/표 → 마크다운 | 블록 |
| `.pptx` | 자체 (`pptxRead.ts`) | 슬라이드 아웃라인 + 노트 | 슬라이드 |
| `.pdf` | pdfjs-dist | 페이지별 텍스트 | 페이지 |
| `.csv` `.tsv` | 그대로 | 원문 (+ 표 힌트) | 행 |
| `.json` `.md` `.txt` `.log` `.yaml` `.yml` `.html` `.xml` | 그대로 | 원문 | 줄 |
| `.xls` (BIFF) | — | 미지원 안내 문구 | — |

`.docx` 파서는 이번에 새로 넣었다. 취하는 것: 본문 흐름(제목/문단/목록/표)을 **문서 순서대로**. 버리는 것: 머리말·꼬리말·주석·필드코드 — 페이지마다 반복되는 노이즈라 넣으면 정작 본문이 예산에서 밀린다. 추적변경 삭제분(`<w:delText>`)도 자동으로 빠진다.

`mammoth` 같은 의존성을 안 넣은 이유: `pptxRead` 가 이미 같은 종류의 OOXML 을 읽고 있었고 `jszip` 도 이미 있었다. 스캐너를 [ooxml.ts](electron/tools/files/ooxml.ts) 로 끌어올려 둘이 공유한다 (pptxRead 에서 84줄이 빠져나갔다). 원래의 설계 근거가 그대로 유효하다 — **Word/PowerPoint 가 쓴 OOXML 은 기계 생성이라 항상 well-formed 이고, 우리에게 필요한 건 엘리먼트 중첩과 속성 몇 개뿐이다.**

---

## 5. 계층

```
shared/fileTypes.ts          확장자 목록 + 예산 상수  ← 단일 진실 공급원 (main/renderer 양쪽)
  │
  ├─ electron/tools/files/
  │    extractText.ts        레지스트리 + 잘림 계약        ← 여기가 중심
  │    ooxml.ts              OOXML 스캐너 (docx/pptx 공유)
  │    docxRead.ts  pptxRead.ts  xlsx.ts
  │
  ├─ electron/tools/data/
  │    queryData.ts          .xlsx → CSV 버퍼 → DuckDB     ← 표의 진실 경로
  │    resolve.ts            "book.xlsx#Sheet2" 파싱
  │
  └─ src/hooks/
       useCopilotChat.ts     채팅 메시지가 언급한 파일 첨부
       useWorkflowTest.ts    노드가 언급한 파일 첨부
```

**`shared/fileTypes.ts` 가 목록을 소유한다.** 소비처는 정규식을 파생시킨다 (`fileRefRegex()` / `fileExtRegex()`). 레지스트리와 어긋나면 콘솔 경고가 뜬다 — 조용히 죽는 대신 개발 중에 보이게.

예산도 여기 있다. 렌더러가 `Math.min(budget, 8_000)` 처럼 **로컬 상수로 기본값을 덮어쓰는 것이 사건의 직접 원인**이었으므로, 두 훅 모두 공유 상수를 쓴다.

```ts
ATTACH_PER_FILE_CAP = 30_000   // 이전 8,000 — 200행 × 9열 스프레드시트가 통째로 들어감
ATTACH_TOTAL_BUDGET = 60_000   // 이전 16,000
```

### 엑셀이 DuckDB 로 들어가는 방식

`.xlsx` 는 zip 이라 어떤 DuckDB 리더도 못 읽는다. `sourceBytes()` 가 `readXlsx` 로 읽어 CSV 바이트로 만든 뒤 등록한다.

- **행 상한을 두지 않는다** (`maxRowsPerSheet: Infinity`). 여기서 자르면 `COUNT(*)` 가 거짓말을 시작하고 이 경로의 존재 이유가 사라진다.
- 전부 빈 행은 버린다. 서식만 남은 꼬리 행은 `read_csv_auto` 에 컬럼 수 안 맞는 행으로 보이고, 살아남아도 모델에겐 "데이터가 있는 척하는 빈 행" 이 된다.
- 시트는 첫 시트가 기본, `"book.xlsx#Sheet2"` 로 지정. 없는 시트를 부르면 실제 목록을 알려준다.

"모델에게 CSV 변환 노드를 하나 더 만들라고 시키면 되지 않나" 는 이미 실패한 우회다. 변환 단계가 없으면 스프레드시트는 프롬프트 덤프 경로로 밀려나고, 거기서 잘리면 §1 이 반복된다.

---

## 6. 새 파일 타입 추가하기

1. `shared/fileTypes.ts` 의 목록에 확장자 추가 (바이너리 문서면 `BINARY_DOC_EXTS`, 표면 `TABULAR_EXTS` 도)
2. `extractText.ts` 에 extractor 함수 하나 + `REGISTRY` 에 한 줄
3. extractor 안에서 **`joinCapped()` 를 쓴다** — `units`(단위 배열), `total`(진짜 전체 개수), `unit`(단위 이름), `header`(shape 선언). 표라면 `hint` 로 query-data 를 가리킨다
4. 표라면 `queryData.ts` 의 `readerFor` / `sourceBytes` 도 함께

렌더러는 손댈 게 없다. 정규식이 목록에서 파생되므로 채팅·노드·워크스페이스 카탈로그가 자동으로 따라온다 — **§1 의 네 벌 드리프트가 재발하지 않는 지점이 여기다.**

---

## 7. 검증

| 검증 | 결과 |
|---|---|
| 문제의 60행 xlsx, 새 상한 | `truncated=false`, 60행 전부, 헤더가 `60 data rows` 선언 |
| 같은 파일, 옛 8,000자 강제 | `showing 41 of 60 rows` 마커 출력 (예전엔 43행에서 조용히 끝) |
| `query-data` `COUNT(*)` | **60** |
| `query-data` `Position >= 44` | `lo=44, hi=60, n=17` — "누락" 이라던 구간이 실재 |
| `query-data` `GROUP BY Type` | carousel 35 / photo 18 / unavailable 4 / reel 3 |
| 없는 시트 지정 | `sheet "Nope" not found — available: Post Inventory` |
| docx (Word 형식 픽스처) | 제목 `#`/`##`, 중첩 목록 들여쓰기, 표 → 마크다운, 하이퍼링크 run 수집, 추적변경 삭제분 제외 |
| docx 한글 | 정상 (초기 mojibake 는 픽스처 생성기 `textutil` 의 이중 인코딩이었음) |
| pdf | 페이지 경계 컷 + `showing 1 of 2 pages` |
| **pptx 라운드트립** | `2136 strings recovered across 16 fixtures` — 스캐너 분리는 동작 보존 |
| electron tsc / lint | 클린 / 0 errors |

`textutil` 로 만든 docx 는 `<w:tbl>` 도 `pStyle` 도 안 쓴다(직접 서식만). 표·제목 경로를 검증하려면 **Word 형식으로 손으로 짠 픽스처**가 필요하다 — `scripts/` 에 상설화할 가치가 있다 (§8).

---

## 8. 안 한 것 · 미완

**구형 `.xls` (BIFF) 미지원.** exceljs 가 못 읽는다. SheetJS 를 새로 들여야 해서 "xlsx 로 저장해서 다시 첨부하세요" 안내를 유지했다. 유저에게 되묻는 대신 **고치는 법을 알려주는** 문구다.

**docx 픽스처가 상설 테스트가 아니다.** 위 검증은 임시 스크래치에서 돌렸다. pptx 는 `scripts/deck/roundtrip.ts` 가 지키고 있는데 docx 는 아직 없다. Word 형식 픽스처(pStyle/numPr/w:tbl/hyperlink/w:del)를 `scripts/` 로 옮기면 같은 수준의 보호를 받는다.

**첨부는 여전히 잘릴 수 있다.** 상한을 30k 로 올렸을 뿐 없앤 게 아니다. 이 문서의 요지는 "안 잘린다" 가 아니라 **"잘리면 잘렸다고 말한다"** 이고, 표에 대해서는 "그럴 땐 query-data 로 가라" 까지 말한다.

**이미지·스캔 PDF.** 텍스트 레이어가 없는 PDF 는 빈 페이지로 나온다. OCR 은 LLM 판단이 필요한 영역이라 이 결정적 서비스 계층이 아니라 별도 노드/에이전트로 승격할 일이다 (`extractText.ts` 헤더의 원칙 그대로).

---

## 9. 되돌리는 비용

| 되돌릴 것 | 비용 |
|---|---|
| 잘림 계약 | `extractText.ts` 의 `joinCapped()` 하나. 나머지 extractor 는 호출만 함 |
| docx 지원 | `docxRead.ts` 삭제 + `REGISTRY`·`fileTypes` 에서 한 줄씩 |
| ooxml 분리 | `ooxml.ts` 를 `pptxRead.ts` 로 되돌리면 됨. 라운드트립이 즉시 잡아냄 |
| xlsx → DuckDB | `queryData.ts` 의 `sourceBytes()` 하나. 툴 이름·wire shape 는 안 바뀜 |
| 예산 상수 | `shared/fileTypes.ts` 두 줄 |

목록·예산·잘림 로직이 각각 한 곳에 모여 있어서, 되돌리는 단위와 고치는 단위가 같다. §1 의 상태(네 벌 목록 + 두 벌 예산 + 무언의 절단)로는 이게 성립하지 않았다.
