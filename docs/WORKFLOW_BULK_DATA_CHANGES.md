# Workflow 대량 데이터 파이프라인 — 변경 종합

> **한 줄:** 워크플로가 대량 데이터를 다룰 때 LLM 컨텍스트를 거치지 않게 하는 툴 2개와, 그걸 실제로 쓰이게 만들기까지 드러난 신뢰성 버그 수정들.
> **계기:** IG 감사 run 1건 정독($1.12/30행, 190:1 토큰) → 3개 쇼핑몰 4,724개 수집 워크플로.
> **관련 문서:** [DATA_TOOLS.md](DATA_TOOLS.md) (툴 상세) · [RUN_REVIEW_MODEL_UPGRADE.md](RUN_REVIEW_MODEL_UPGRADE.md) (자동 리뷰 모델 제안) · [ADDING_A_NEW_AGENT_TOOL.md](ADDING_A_NEW_AGENT_TOOL.md) (SOP, 이번 교훈 반영).

---

## 0. 결과

4,724개 상품(sukoshi 1,692 · koreanshop 1,588 · kiokii 1,444)을 **172초 · $0.146**에 수집. 기존 방식(chrome + 아이템당 LLM 턴, IG 단가 $0.037/건)이면 **~$175 / ~16시간**이었을 작업 — 약 1,200배 절감.

핵심 원칙 한 줄로: **모델은 무엇을 할지 한 번 말하고, 데이터는 source → disk → disk 로만 흐른다.** 노드의 토큰 비용이 아이템 수 N 에 대해 평평해진다.

---

## 1. 새 툴 2개 (`electron/tools/data/`)

| 툴 | 하는 일 | 반환 |
|---|---|---|
| `tool_fetch_to_file` | 페이지네이션 HTTP 리소스를 끝까지 순회해 워크스페이스 파일로 저장 (page/offset/cursor/Link 4방식) | 카운트만 — 본문 절대 안 돌려줌 |
| `tool_query_data` | 워크스페이스 파일에 대한 read-only SQL (DuckDB). 결과를 파일로 쓰거나 작으면 인라인 | 행 수 / 컬럼 / (작으면) 결과셋 |

- 의존성: `@duckdb/duckdb-wasm@1.32.0` (stable 고정). native 바이너리 0개 → mac 서명 파이프라인 무영향. 배포본 +34MB (§배포 메모).
- 6계층 배선: 순수함수 → IPC → 브리지 → openclaw 패치 → 정책 허용목록 → 워크플로 카탈로그. 자세히는 [ADDING_A_NEW_AGENT_TOOL.md](ADDING_A_NEW_AGENT_TOOL.md).

### 보안 — 실측 후 구조로 봉인

`tool_query_data`의 SQL은 모델이 쓰므로 신뢰 불가. DuckDB의 NODE_FS 런타임은 쿼리가 지목한 아무 경로나 열어줬다 — `COPY (SELECT 1) TO '/tmp/pwned.csv'`가 **실제로 파일을 생성**. 정규식 denylist 대신 구조로 막음: 입력을 메모리 버퍼로 materialize → `SET enable_external_access=false` → 이후 엔진 자체가 모든 파일 연산 거부. 대가는 "입력이 메모리에 들어가야 함"이고, 이 앱 규모에선 무해.

---

## 2. 빌더가 `data` 를 고르게 만들기 (여러 번 실패 후)

툴을 만들어도 **빌더가 안 골랐다.** chrome 이 계속 나왔고, 원인이 한 겹씩 드러났다:

1. **서브스킬 설명이 빌더에 전달 안 됨** — `renderToolCatalog()`가 sub-skill **id만** 찍는다. `collect`의 설명은 도달한 적 없음 → 모든 유도 문구를 depth-1 `description`으로 이동.
2. **SOUL 이 정반대 교리를 가르침** — "chrome 페이지 방문은 10–15개씩 배칭" 이 ✅ 모범사례로 박혀 있었다. 산문으로 반박해도 **작동 예시가 규칙을 이긴다** → 유일 예시(chrome SEO 감사)에 더해 **Example B(data/collect ×N → query)를 선택 표와 함께 추가**. batching 절엔 "damage control이지 목표가 아니다, N 을 없애라" 전제.
3. **원칙과 수단이 안 이어짐** — `## Keep the model off the data path`가 "데이터 경로에서 비켜라"까지만 하고 "그 수단이 `data` 툴"을 안 말함 → 연결 문장 추가.

### Layer 7 — 카탈로그 라벨 ≠ 호출 이름 (가장 값비싼 함정)

빌더가 고르는 `tool: "data"`는 실행기가 부를 수 없다. 실제 호출명은 `tool_fetch_to_file`. 둘을 잇는 매핑(`BRIDGE_TOOL_BY_SKILL`, `workflowTools.ts`)이 없으면 실행기는 "그런 툴 없음" → browser/web_fetch 로 폴백. 노드 프롬프트가 실행기에게 실제 이름을 지목하게 함:

```
### Node Collect all products from Site A [data / collect]
Tools for this node: tool_fetch_to_file — call these directly.
Do NOT substitute browser page reads, web_fetch, or shell scripts...
```

**함정 안의 함정:** `buildNodePrompt`가 **두 곳**에 복제돼 있다 — `useWorkflowTest.ts`(Test run, 실사용) + `runWorkflowNodes.ts`(Orchestration). 처음엔 후자만 고쳐서 여전히 chrome 으로 돌았다. 프롬프트 규칙은 반드시 양쪽에.

---

## 3. 실행 신뢰성 버그 (수집을 돌려보며 하나씩)

| 증상 | 원인 | 수정 |
|---|---|---|
| **노드 ID 중복** — 리뷰 노드가 스펙 노드와 같은 id (`n2`, `n4`) | `interleaveHumanReviews`가 리뷰 노드를 id 없이 삽입 → 저장 계층 위치 fallback(`n${i+1}`)이 뒷번호와 충돌. 런 상태가 id 로 키잉돼 두 노드가 한 칸 공유 | 리뷰 노드에 `rev_<uuid>` 부여 + `createWorkflow`/`updateWorkflow`에 중복 id 강제 유일화 + SOUL 규칙(`rev_*` 예약, UPDATE 시 id 보존) |
| **"시작하자마자 human review"** | 위 ID 충돌 — 리뷰 노드의 `awaiting-review` 상태를 같은 id 의 수집 노드 카드가 읽음 | 위 ID 수정으로 해소 |
| **다인스턴스 목록 미동기화** — Workflow 탭에서 지운 WF 를 Copilot 이 계속 매칭 (재시작 전까지) | `useWorkflows`가 3인스턴스(App/WorkflowView/Orchestration) 독립, mutation 전파 없음 | 모듈 레벨 구독 Set — mutation 시 피어 전부 refresh |
| **타임아웃 시 run 전체 사망** | 노드 9분 초과 → 그냥 failed | 런타임 자동 분할(C): abort → drain → "about half → quarter → eighth" 재시도. 성공 크기를 `autoSlice`로 남겨 빌더에게 영구 분할 제안 |
| **재시도 후 노드 상태 뒤섞임** | 타임아웃 turn 을 안 죽이고 재전송 → 뒤늦은 final 이 FIFO awaiter 와 짝 어긋남 → 리뷰에 엉뚱한 출력, approve 시 다음 노드 즉시 통과 | 재시도 전 `cancelTurn`(sessions.abort) + 1.5초 drain |
| **HTML 을 수집 툴에 먹임** | 실행기가 목록 페이지 URL 을 그대로 `fetch_to_file`에 → 420MB markup, query 가 못 읽음 | 프롬프트에 "STRUCTURED source(JSON/CSV)를 먼저 찾아 검증, HTML 저장은 실패지 폴백 아님, 없으면 FAILED" (양쪽 빌더) |
| **`NODE_STATUS: PARTIAL` 로 미완성 노드가 done** | 프로토콜은 OK/FAILED 뿐인데 실행기가 상태를 지어냄. 파서가 FAILED 만 잡아 262/418 페이지가 완료 처리 | `OK` 아닌 모든 상태를 실패 취급(사유는 보존) + 프롬프트에 "다른 상태 없음, 부분완료=FAILED+재개지점" |
| **csv→xlsx 에서 헤매기** | 실행기가 DuckDB 관용구(`FROM 'file.csv'`)로 경로를 SQL 에 넣고 `inputs` 비움 → 샌드박스 거부 → "파일시스템 잠김"으로 오독하고 툴 포기 | 에러 문구에 교정법 내장 + SQL 내 경로 리터럴 사전 거부. `tool_write_xlsx` 설명에 "행이 컨텍스트를 통과·append 없음, 디스크의 큰 표는 query output:.xlsx로" |

---

## 4. 배포 메모 (팀 확인 필요)

- `@duckdb/duckdb-wasm` 실제 필요분은 34MB(`duckdb-node-blocking.cjs` + `duckdb-eh.wasm`)인데 현재 `asarUnpack: node_modules/**/*`가 138MB 전량을 싣는다. electron-builder `files` 제외 패턴 미적용 — **아직 안 함**.
- native 바이너리 0개 → mac 서명/공증 무영향 (확인됨).
- `mvp.wasm` 없이 `eh.wasm` 만으로 충분한지 미검증 — 안전하게 둘 다면 73MB.

## 5. 미완

- **빌더 통합** — `buildNodePrompt` 복제 2개. 지금은 양쪽 동시 수정 + 교차참조 주석으로 방어. 근본 해법은 Test 경로가 `runWorkflowNodes`의 것을 공유하는 것(프롬프트 미묘한 차이 때문에 별도 작업으로 보류).
- **자동 저장 UX** — Copilot 이 새 워크플로 스펙을 만들면 `⊕ New` 클릭 → `▶ Run` 클릭 2번이 필요한데 어시스턴트는 "바로 실행"이라 말한다. 계측 로그(`[copilot-spec]`)만 심어둠, 원인 재현 대기.
- **DB 파일 watcher 없음** — 앱 UI 밖(디스크 직접 삭제)의 워크플로 변경은 감지 못 함.
