# Data Tools — `tool_fetch_to_file` / `tool_query_data`

> **대상:** Twixy 팀
> **한 줄:** 대량 데이터가 LLM 컨텍스트를 통과하지 않게 하는 에이전트 툴 2개.
> **상태:** 6개 계층 전부 구현 + 실사이트 검증 완료. **미결정 1건** (§7), **미완 1건** (§8).
> **관련:** [RUN_REVIEW_MODEL_UPGRADE.md](RUN_REVIEW_MODEL_UPGRADE.md) — 같은 사건의 다른 절반. · [FILE_INGEST.md](FILE_INGEST.md) — 첨부 파일 추출과 잘림 계약. 표가 `tool_query_data` 로 와야 하는 이유가 거기 있다.

---

## 1. 왜 만들었나

`wf_agency_client_ig_audit` run 하나를 정독한 결과가 출발점이다.

```
30개 아이템 수집:  8,771,234 in / 46,174 out tokens  =  190:1,  $1.12
n1 (15개 수집)  $0.2142      n2 (15개 수집, 동일 작업)  $0.7492   ← 3.5×
```

n2가 3.5배 비싼 이유는 n1이 쌓아둔 페이지 스냅샷을 매 턴 다시 실어 보냈기 때문이다. 원인을 일반화하면 하나로 수렴한다:

> **모델의 컨텍스트가 데이터 경로 위에 있다.**

페이지를 읽든, API 응답을 받든, 변환하려고 파일을 열든, 합계를 손으로 내든 — 전부 트랜스크립트에 남고 그 노드의 이후 모든 턴에 재전송된다. 비용이 아이템 수가 아니라 **(아이템 수 × 그때 들고 있는 컨텍스트)** 에 비례하고, 대략 N²로 자란다. 그리고 **30개짜리 테스트에서는 절대 안 보인다.**

이 문제는 딱 두 지점에서만 발생한다. 그래서 툴도 두 개다.

| 지점 | 툴 |
|---|---|
| 외부 데이터가 디스크에 닿기 전에 컨텍스트를 통과함 | `tool_fetch_to_file` |
| 디스크 위 데이터를 바꾸려면 컨텍스트로 올려야 함 | `tool_query_data` |

둘 다 스크래핑 툴도 마케팅 툴도 아니다. **HTTP→디스크**, **디스크→디스크**다. 어떤 사이트를 어떤 엔드포인트로 긁을지, 할인율을 어떻게 계산할지는 전부 워크플로가 아는 것이고 툴은 모른다.

### 왜 프롬프트로는 안 되나

`web_fetch`는 `wrapWebFetchContent(text, maxChars)`로 **반드시 본문을 컨텍스트에 넣는다.** 파일 저장 옵션이 없다. `code_execution`은 전역 deny (`~/.openclaw/openclaw.json` → `tools.deny`). 즉 "파일에 쓰고 카운트만 보고해"라고 아무리 잘 지시해도 툴이 본문을 돌려주는 걸 막을 방법이 없었다.

---

## 2. `tool_fetch_to_file`

페이지네이션을 끝까지 따라가며 응답 원본을 워크스페이스 파일로 저장. **본문은 반환하지 않는다.**

```jsonc
{
  "destDir":   "data/raw/sukoshi",           // designated root의 직속 하위 디렉토리
  "url":       "https://sukoshi.com/collections/korean-skincare/products.json?limit=250",
  "pagination": { "mode": "page", "param": "page", "start": 1 },
  "itemsPath": "products",                    // 아이템 배열 위치 (점 표기)
  "minItemsPerPage": 250,                     // 이보다 적게 오면 마지막 페이지
  "maxPages":  40,
  "delayMs":   250
}
// →  { requests: 7, files: [...], bytes: 9452544, items: 1691, stoppedBy: "short-page", errors: [] }
```

페이지네이션 4방식을 받는다. 이게 "general"의 실체다 — 실무 API의 절반은 페이지 번호를 안 쓴다.

| mode | 대상 |
|---|---|
| `page` | `?page=1,2,3` — Shopify, WooCommerce |
| `offset` | `?offset=0,100,200` — 대부분의 REST |
| `cursor` | 응답 본문 안의 다음 커서 — YouTube `nextPageToken`, Notion `next_cursor`, Graph API |
| `link` | RFC 5988 `Link: <…>; rel="next"` 헤더 — GitHub 등 표준 REST |

본문 형식은 안 가린다. JSON이든 CSV든 XML이든 바이너리든 바이트 그대로 저장하고, 확장자만 `Content-Type`으로 정한다. 본문을 들여다보는 건 **아이템 수를 세고 다음 커서를 찾을 때뿐**이고, 파싱 실패는 치명적이지 않다.

## 3. `tool_query_data`

워크스페이스 파일에 대한 read-only SQL. 결과를 파일로 쓰거나, 작으면 인라인으로 돌려준다.

```jsonc
{
  "inputs": { "shopify": "data/raw/sukoshi/p001.json",
              "woo":     "data/raw/koreanshop/p001.json" },   // 테이블명 → 파일
  "sql":    "SELECT ... FROM shopify UNION ALL SELECT ... FROM woo",
  "output": "data/reports/catalog.xlsx"                        // 생략하면 인라인
}
// →  { rows: 350, columns: [...], output: "data/reports/catalog.xlsx", bytes: 22663 }
```

- 입력: `.json` / `.csv` / `.tsv` / `.parquet` / `.xlsx` 자동 인식. 중첩 JSON은 `unnest`로 접근
- **`.xlsx` 는 zip 이라 DuckDB 리더가 없다** → `readXlsx` 로 읽어 CSV 버퍼로 만든 뒤 등록한다.
  시트가 여럿이면 첫 시트가 기본이고, `"book.xlsx#Sheet2"` 로 지정한다. 행 상한은 두지 않는다 —
  여기서 자르면 `COUNT(*)` 가 거짓말을 시작하고, 이 툴의 존재 이유가 사라진다
- 출력: `.csv` / `.json` / `.xlsx` (xlsx는 기존 `writeXlsx` 재사용)
- `output` 생략 시 집계 결과를 인라인 반환 (기본 50행, 최대 1000행)

**엑셀이 여기로 들어와야 하는 이유** (2026-08 실사고): 스프레드시트가 이 경로에 못 들어오면
프롬프트 첨부 경로로 밀려난다. 거기엔 문자 예산이 있고, 60행짜리 표가 43행에서 잘렸다. 모델은
그걸 "44~60번은 수집되지 않았다"로 읽고 43행짜리 파일을 새로 썼다 — 잘린 건 화면인데 결론은
데이터에 대해 났다. 표는 잘림이 품질 저하가 아니라 **사실 오류**가 되는 유일한 부류다.
첨부는 미리보기, 세고 거르고 합치는 건 전부 이 툴. (첨부 쪽 방어는 `extractText.ts` 헤더 참고)

**부수 효과:** 집계가 `GROUP BY`가 되므로 IG 감사의 산술 오류 부류(Reel n=25인데 실제 24, 평균 0.48 vs 실제 0.589)가 **구조적으로 발생 불가능**해진다.

---

## 4. 보안 — 실제 구멍을 발견했고 구조로 막았다

**SQL 문자열은 모델이 쓴다. 즉 신뢰할 수 없는 입력이다.** 그런데 duckdb-wasm의 NODE_FS 런타임은 쿼리가 지목한 아무 경로나 실제 파일시스템에서 열어준다. 직접 확인한 결과:

| 시도 | 초기 구현에서 |
|---|---|
| `read_csv_auto('/etc/passwd')` | 실제 fs 도달 (읽기 권한이 있었다면 성공) |
| `COPY (SELECT 1) TO '/tmp/pwned.csv'` | **파일이 실제로 생성됨** |
| `ATTACH '/tmp/x.db' AS x` | 성공 |

이대로면 임의 파일 읽기/쓰기이고, 일부러 deny해둔 `code_execution`보다 나쁘다. 정규식 denylist는 쓰지 않았다 — 주석·문자열 리터럴·pragma·중첩 앞에서 버티지 못하고, 이 레포는 경로 격리를 하드 불변식으로 다루기 때문이다(`resolveInsideWorkspace`를 모든 진입점에서 재실행).

**대신 구조로 막았다:**

1. 입력 파일은 **이 프로세스가** 이미 격리된 경로에서 읽어 **메모리 버퍼**로 전달
2. 버퍼를 실제 테이블로 materialize한 뒤 버퍼 해제
3. `SET enable_external_access=false` → **엔진 자체가** 모든 파일 연산을 거부
4. 사용자 SQL은 **테이블만** 본다. 지목할 파일이 없고, 지목하면 파싱이 아니라 엔진 에러
5. 출력은 이 프로세스가 기존 `resolveInsideDesignated` 격리를 통해 씀

대가: **입력이 메모리에 들어가야 한다.** 이 앱 규모에선 무해하고, 우회하지 않고 코드에 명시했다.

---

## 5. 왜 SQL인가 — 대안 비교

처음엔 `map_json_to_table`이라는 **매핑 DSL**(`rowPath` + `columns[].path` + `transform` + `op`)로 설계했다가 철회했다. 새 질의 언어를 발명하고 있었고, 결말이 뻔했다 — 필터가 필요해지면 `where`, 조인이 필요해지면 `join`, 집계가 필요해지면 `groupBy`가 붙는다.

| | ① 툴 없음<br>(현재) | ② JSON 매핑 명세 | ③ JSONata | ④ SQL/DuckDB<br>(채택) |
|---|---|---|---|---|
| 새 의존성 | 0 | 0 | 853KB | **34MB** |
| 필드 추출 | ○ | ○ | ○ | ○ |
| 필터 | ○ | ✗ | ○ | ○ |
| 집계 | △ 눈대중 | ✗ | ○ | ○ |
| 파일 간 union/조인 | △ | ✗ | △ | ○ |
| 중복 제거 | △ | ✗ | ○ | ○ |
| 컨텍스트 비용 | **∝ N** | 0 | 0 | 0 |
| 4,700행 가능? | **✗** | ○ | ○ | ○ |
| 보안 표면 | 없음 | **없음** | 표현식 평가 | **파일시스템 (§4)** |
| 모델 숙련도 | — | 높음 | **낮음** | **매우 높음** |

정직하게: **②로도 이번 작업의 80%는 된다.** 나머지 20%(3사이트 union·집계·중복제거)가 안 될 뿐인데, **그 20%가 이번에 이미 필요하다.** ②를 골랐다면 지금쯤 `merge`/`dedupeKey`/`groupBy`를 추가하고 있었을 것이다.

③ JSONata는 과소평가했던 중간 지대다(853KB, 보안 표면 없음). 결정적 약점은 **모델 숙련도** — 이 표현식을 쓰는 건 `minimax/minimax-m2.7`이고, SQL은 학습 데이터에 압도적으로 많지만 JSONata는 희귀하다. 틀리면 조용히 빈 결과가 나온다.

**되돌리는 비용:** layer 1의 `queryData.ts` 한 파일만 교체하면 된다. 나머지 5개 계층은 `tool_query_data`라는 이름과 `{sql, inputs, output}` 형태를 그대로 쓰므로 손대지 않는다. ③으로 갈 경우 `sql` → `expr` 이름만 바뀌는 수준.

---

## 6. 구현 — 6개 계층

[ADDING_A_NEW_AGENT_TOOL.md](ADDING_A_NEW_AGENT_TOOL.md)의 절차 그대로.

| 계층 | 파일 | 내용 |
|---|---|---|
| 1. 순수 함수 | `electron/tools/data/fetchToFile.ts`<br>`electron/tools/data/queryData.ts`<br>`electron/tools/data/resolve.ts` | 로직 + 공유 경로격리 규칙 |
| 2. IPC | `electron/main.ts` (`tool-fetch-to-file`, `tool-query-data`)<br>`electron/preload.ts`, `src/global.d.ts` | 렌더러 경로 |
| 3. 브리지 | `electron/agent-tool-bridge.ts` (`fetch-to-file`, `query-data`) | **LLM이 실제로 닿는 경로** |
| 4. 패치 | `pi-embedded-BYdcxQ5A.js` `__twixyExtraTools()` | 툴 정의 2개 |
| 4.5. 허용목록 | `tool-policy-Bk9WQZ0U.js` `CORE_TOOL_DEFINITIONS` | `profiles: ["coding"]` — 빼먹으면 조용히 사라짐 |
| 5. 가드레일 | 위 패치의 designated-path 사전검사 + `__twixyGuardrailClassify` | `kind: "write"` 로 승인 팝업 연동 |
| 6. 카탈로그 | `src/lib/workflowTools.ts` + `WorkflowTool` union + drift 목록 | 새 tool `data` (skills: `collect`, `query`) |

`npx patch-package openclaw` 실행 완료 — `patches/openclaw+2026.4.2.patch`에 4·4.5·5 전부 반영됨.

`resolve.ts`가 경로격리 규칙을 한 곳에 모은다. IPC와 브리지는 독립 진입점이라 각자 격리를 **실행**하지만, 규칙 자체는 두 번 쓰지 않는다. 읽기는 `resolveInsideWorkspace`, 쓰기는 `resolveInsideDesignated` — 기존 파일 툴과 같은 분리.

---

## 7. 검증 결과

실사이트 대상, 브리지 핸들러와 동일한 경로로 실행.

```
── 격리 거부 (LLM이 못 해야 하는 것)
✖ destDir outside designated roots     ✖ output outside designated roots
✖ destDir traversal (../../../etc)     ✖ bad table ident (SQL injection 시도)
✖ non-http url (file://)               ✖ input outside workspace

── 정상 동작
✔ collect shopify:     2 requests, 500 items, 2.96MB → 파일
✔ collect woocommerce: 1 request,  100 items, 2.73MB → 파일
✔ union → xlsx:  350 rows, 7 columns → data/reports/catalog.xlsx (22KB)
✔ aggregate inline: K-Skincare 224 / J-Skincare 16 / Beauty Tool 4

/tmp/evil.csv leaked? false
```

마지막이 핵심이다: **Shopify와 WooCommerce라는 완전히 다른 스키마 두 개를 쿼리 한 방으로 합쳐 350행 xlsx를 만드는 동안, 5.7MB의 데이터가 대화에 단 한 바이트도 들어가지 않았다.**

참고로 대상 3사이트는 전부 구조화 JSON을 그냥 내준다:

| 사이트 | 플랫폼 | 결과 |
|---|---|---|
| sukoshi.com | Shopify | 1,691개 / 7 요청 / 5.0초 |
| kiokii.com | Shopify | 1,444개 / 6 요청 / 3.6초 |
| koreanshop.ca | WooCommerce | 1,587개 (`X-WP-Total`) |

기존 방식(chrome + 아이템당 LLM 턴, IG 단가 $0.037/건)이면 ~4,700개에 **~$150 / ~16시간**. 새 방식이면 **~$0.05 / ~1분**.

---

## 8. 미결정 — 배포본 크기 (팀 확인 필요)

| | |
|---|---|
| `node_modules` 상의 duckdb-wasm | 138MB |
| **실제 필요** (`duckdb-node-blocking.cjs` + `duckdb-eh.wasm`) | **34MB** |
| 안 쓰는 것 (browser 번들, coi/mvp wasm, 소스맵) | 79MB |
| 현재 dmg (arm64) | 619MB |

현재 `package.json`의 `asarUnpack: node_modules/**/*`에 `files` 필터가 없어 **138MB가 그대로 실린다.** 79MB를 제외하면 +34MB(약 5.5%)다.

- **확인 필요 1:** electron-builder `files`에 제외 패턴 추가 — 아직 안 했음
- **확인 필요 2:** `mvp.wasm` 없이 `eh.wasm`만으로 충분한지 (Electron의 V8은 exception handling을 지원하므로 `eh`가 선택될 것으로 보이나 미검증). 안전하게 둘 다 실으면 73MB
- native 바이너리는 0개다. **mac 서명/공증 파이프라인에는 영향 없음** (순수 wasm)

버전은 `@duckdb/duckdb-wasm@1.32.0` **stable로 고정**했다. `latest`가 dev 프리릴리스(`1.33.1-dev57.0`)를 잡아서 되돌렸다.

## 9. 미완

- **앱 실기동 확인 안 함.** 지금까지는 컴파일된 layer 1–3을 Node에서 직접 호출한 검증이다. `npm run dev`로 띄워 LLM이 실제로 `tool_fetch_to_file`을 호출하는지는 미확인. 문서상 가장 흔한 실패는 4.5 허용목록 누락인데 그건 넣었다.
- **3사이트 스킨케어 워크플로 자체.** 툴이 준비됐으니 스펙만 쓰면 된다. 결정 필요 2건: (a) 성분 — `body_html` 안의 자유 텍스트라 기계 추출이 유일하게 안 되는 필드, (b) 행 단위 — Shopify는 상품 1개에 variant 여러 개.

## 10. 함께 바뀐 것 — `WORKFLOW_SOUL.md`

빌더가 애초에 이런 스펙을 안 쓰도록 구조적 규칙 한 절을 넣었다 (`## Keep the model off the data path`). 비용 모델과 규칙, 그리고 스펙 작성 시 자문("이 노드 비용이 N에 비례하는가?")만 남겼다 — N 임계값 표나 플랫폼별 엔드포인트 표 같은 도메인 지식은 의도적으로 뺐다. 그건 워크플로가 아는 것이지 SOUL이 아는 것이 아니다.
