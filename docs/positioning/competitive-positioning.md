# Twixy 경쟁 포지셔닝 — vs n8n / OpenClaw / Claude Code

> 내부 전략 문서 · 2026-07-02 작성 · B2C 전환 논의용
> 경쟁사 팩트는 출처 URL 병기, Twixy 팩트는 코드 근거 병기. 지는 지점 미화 없음.

## 1. TL;DR

**포지셔닝 스테이트먼트(안):** Twixy는 개인 마케터가 **자기 계정으로 로그인된 채널(인스타그램·카카오톡 포함)을, 코드 없이, 게시 전 검토 게이트를 걸고** 자동화하는 로컬 데스크톱 코파일럿이다. 자동화의 힘은 OpenClaw 런타임에서, 신뢰는 노드 단위 감독 모델에서, 차별화는 한국 마케팅 채널의 깊이에서 나온다.

상대별 한 줄:

- **vs n8n** — n8n은 스스로 "technical teams"용이라 못박고 엔터프라이즈(SAP 투자)로 갔다. 개인 마케터, API 없는 채널(카카오/인스타 DM), 노코드 브라우저 자동화는 n8n이 구조적으로 비워둔 자리다.
- **vs OpenClaw** — 엔진 vs 완성차. "무료"는 런타임뿐이고 API 키·스킬 큐레이션·브라우저 인프라·안전 설정은 전부 사용자 몫. Twixy는 그걸 제품으로 흡수한 것이고, OpenClaw 위 유료 제품 ~170개가 이 모델의 시장 검증이다.
- **vs Claude Code(Cowork)** — **최대 위협.** "개발자용이라 마케터는 못 쓴다"는 이미 거짓(Cowork GA + Marketing 플러그인 + $20/월). 우리가 이기는 곳은 기술 노출 제로 UX, 채널별 완성 워크플로, 산출물 수준 검토 게이트, 한국 채널 깊이 — 이 네 가지를 계속 벌리는 것이 생존 조건.

**B2C 전환 핵심 판단:** 과금 인프라(Free/Pro)는 이미 있다. 부족한 건 "설치 후 10분 내 첫 성공"으로 가는 온보딩과, Enterprise 잔재(MR·팀 공유)의 분리다. §7 참조.

## 2. 비교 방법론 — 왜 기능표 하나로 비교하면 안 되는가

세 상대는 **비교의 목적 자체가 다르다.** 하나의 기능표에 나란히 놓으면 "n8n은 통합이 400개인데 우리는 10개" 같은 무의미한 셀만 남는다. 상대별로 답해야 할 질문이 다르므로 섹션을 분리한다:

| 상대 | 비교의 성격 | 답해야 할 질문 |
|---|---|---|
| **n8n** | 제품 경쟁 — 사용자가 실제로 저울질하는 대안 | "자동화하려면 n8n 쓰면 되잖아?" |
| **OpenClaw** | 기반 vs 완성품 — 우리가 그 위에 지은 오픈소스 런타임 | "오픈소스 원본 쓰면 공짜잖아?" |
| **Claude Code** | 범용 vs 수직특화 — 카테고리 경계 다툼 | "범용 에이전트가 다 하는 시대에 왜 전용 앱?" |

각 비교는 공통 5축으로 평가한다. 이 축은 팀이 다른 경쟁자(Zapier, Make, Gumloop 등)를 볼 때도 재사용한다:

1. **타깃 사용자** — 누구를 위해 만들어졌나 (터미널을 아는가? API를 아는가?)
2. **Job-to-be-done** — 사용자가 실제로 고용하는 일이 무엇인가
3. **실행 모델** — 어디서 무엇으로 실행되나 (클라우드/로컬, API/브라우저, 1회성/반복자산)
4. **신뢰·감독 모델** — AI가 틀릴 때 사용자가 어떻게 개입하나
5. **가격 모델** — 무엇에 돈을 내나, 진입 비용은 얼마인가

각 섹션 끝에 **이기는 지점 / 지는 지점 / 무승부**를 명시한다. 내부 문서이므로 지는 지점을 솔직하게 적는다 — 대외 자료로 변환할 때 걸러내면 된다.

## 3. Twixy 측 팩트 (코드베이스 검증 완료)

비교의 "우리 쪽" 근거. 전부 현재 코드에서 확인된 것만.

**제품 형태** — 로컬 데스크톱 앱(Electron). 8개 탭: Chat / Workflow(노드 캔버스) / Orchestration(멀티 워크플로 조율, 5패턴) / Dashboard(자연어 차트 빌더) / Data / Skills / Merge Requests / Admin. (`src/components/Sidebar.tsx`)

> ⚠️ Orchestration 탭은 `feature/orchestration-tab` 브랜치 — 아직 미출시. 대외 자료에는 출시 후 포함할 것.

**마케팅 수직특화** — Instagram(피드/DM/저장 릴스), YouTube(트랜스크립트), TikTok, Threads, X, SEO 크롤, Google Analytics, Meta Ads, KakaoTalk 스킬이 도구 카탈로그에 내장. (`src/lib/workflowTools.ts`, `SOUL.md`)

**실행 모델** — 임베디드 OpenClaw 런타임(로컬 WS 127.0.0.1:8765, 클라우드 백엔드 의존 없음) + **Twixy가 직접 관리하는 로컬 Chrome**: 사용자의 실제 로그인 세션·쿠키가 유지되는 프로필로 브라우저를 구동하고, 워크플로 테스트는 headless 모드에서 LiveBrowserPreview로 화면을 스트리밍한다. (`electron/managedChrome.ts`, `electron/browserPreview.ts`) → **공식 API가 없는 채널(Instagram DM, 카카오톡)을 사용자 본인 계정으로 조작 가능**하다는 것이 핵심 차별 기반.

**신뢰·감독 모델** — 3단 가드레일: ① 도구 실행 승인(write/bash 등), ② 가드레일 설정(자동승인/매번확인/허용목록), ③ 워크플로 노드 타입(🔺Human Review = 사람 승인 게이트, ⬛Validation = AI 자동 검증). 격리 세션 Test 러너 + 자동 리뷰, Merge Request 리뷰 게이트. 기본값이 supervised(플래닝 모드 ON). (`src/hooks/useGuardrail.ts`, `WORKFLOW_SOUL.md`)

**과금 인프라** — Supabase 기반 프리미엄이 이미 구현되어 있음: Free(25 msg/일, 검색 25/일, $2 토큰캡) / Pro(2,000 msg/일, 검색 500/일, 5M 토큰/일). B2C 전환 시 과금 시스템을 새로 만들 필요 없음. (`src/lib/entitlements.ts`)

**B2B 잔재** — Twixy Enterprise 모드(멀티프로젝트 어드민), shared 팀 라이브러리, MR 리뷰어 지정. B2C 패키징 시 분리 대상 후보. (`src/admin/TwixyEnterpriseDashboard.tsx`)

## 4. vs n8n — "자동화하려면 n8n 쓰면 되잖아?"

**한 줄 논지: n8n은 "기술팀용 통합 배관 캔버스", Twixy는 "마케팅 결과물을 감독하는 개인용 코파일럿".** n8n은 스스로 홈페이지에 "for technical teams"를 명문화했고 ([n8n.io](https://n8n.io/)), 2026-05 SAP가 $5.2B 밸류에 투자하며 엔터프라이즈로 확실히 기울었다 ([Bloomberg](https://www.bloomberg.com/news/articles/2026-05-12/sap-invests-in-ai-automation-startup-n8n-at-5-2-billion-value)). **B2C 개인 마케터 시장은 n8n이 스스로 비워둔 자리**다.

### 5축 비교 (리서치 근거: 2026-07 기준)

| 축 | n8n | Twixy |
|---|---|---|
| 타깃 | "technical teams" (자칭) — webhook/JSON/expression 전제 | 개인 마케터/크리에이터, 기술 개념 0 전제 |
| JTBD | 시스템 간 데이터 배관을 조립 | 마케팅 산출물(포스트/리포트/DM)을 생산·감독 |
| 실행 모델 | 웹/서버(클라우드 or 셀프호스트 Docker), 데스크톱 앱 없음 | 로컬 데스크톱 앱 + 사용자 브라우저 세션 |
| 감독 모델 | 실행 로그·에러 디버깅(개발자식) | 노드 단위 Human Review/Validation + 라이브 브라우저 프리뷰 |
| 가격 | Cloud Starter €20~24/월(실행 2,500회), **영구 무료 클라우드 없음**; 셀프호스트 무료지만 Docker 관리 | Free 티어 있음(25msg/일), 설치만 하면 끝 |

### 우리가 이기는 지점 (팩트 + 출처)

1. **API 없는 채널 = 결정적 공백.** Instagram DM을 n8n으로 하려면 Meta 개발자 계정 + 앱 생성 + 수 주짜리 권한 심사가 필수고, 세션 쿠키 우회는 계정 정지 리스크 ([flowgent.ai](https://flowgent.ai/blog/instagram-dm-automation-with-n8n), [n8n community](https://community.n8n.io/t/help-on-creating-instagram-automatic-dm-responses/87244)). **카카오톡은 공식 노드 자체가 없고** SOLAPI 알림톡(사업자 등록+템플릿 심사+건당 과금)이 유일한 통로 — 개인 카톡 DM 자동화는 불가 ([svrforum](https://svrforum.com/software/2719299)). Twixy는 사용자의 실제 로그인된 Chrome으로 조작하므로 이 채널들이 기본 동작. **한국 B2C에서 이건 기능 차이가 아니라 카테고리 차이.**
2. **브라우저 자동화가 n8n Cloud에선 사실상 막혀 있음.** Puppeteer/Playwright는 미검증 커뮤니티 노드라 Cloud 설치 불가, 셀프호스트 전용 ([n8n docs](https://docs.n8n.io/integrations/community-nodes/installation/), [n8n-nodes-puppeteer](https://github.com/drudge/n8n-nodes-puppeteer)). 즉 비기술 유저가 노코드로 브라우저 자동화를 쓰는 길이 없다.
3. **학습곡선.** "n8n's learning curve is brutal — 20시간 배우고도 작동하는 걸 못 만든 사업가 다수" (댓글 2,593개 바이럴 포스트, [LinkedIn](https://www.linkedin.com/posts/tomcrawshaw_n8ns-learning-curve-is-brutal-ive-lost-activity-7387473016118693888-tTBF)). expression 문법(`{{ $json... }}`)·에러 핸들링이 비기술 팀 접근을 제한한다는 리뷰 ([lindy.ai](https://www.lindy.ai/blog/n8n-review)). Twixy의 노드는 프롬프트(L6/L7)가 곧 스펙 — JSON 배관이 없다.
4. **AI-네이티브 정도.** n8n의 AI Workflow Builder(프롬프트→워크플로)는 Cloud 전용 + 크레딧제이며, 생성 후엔 결국 노드 편집기에서 손봐야 함 ([n8n docs](https://docs.n8n.io/advanced-ai/ai-workflow-builder/)). Twixy는 빌더 챗이 무료 포함이고, 실행 자체가 LLM 에이전트라 노드 사이 데이터 매핑을 사람이 안 짠다.
5. **한국어/로컬.** n8n은 한국어 공식 지원 없음(자생 커뮤니티만). Twixy는 한국어 네이티브 + 카카오 스킬 내장.

### 지는 지점 (솔직하게)

- **통합 생태계**: n8n은 수백 개 공식 통합 + LangChain 기반 70+ AI 노드. 우리 스킬 카탈로그는 수십 개 수준.
- **셀프호스트 무료·실행 무제한**: 기술 있는 유저에겐 n8n이 비용상 압도적.
- **성숙도·신뢰**: 커뮤니티 200k+, 월간 활성 빌더 170만, SAP 투자. 우리는 무명.
- **결정론적 실행**: 같은 입력 → 같은 출력이 필요한 배관 작업은 n8n이 구조적으로 우월. LLM 실행은 변동성이 있음 — 이걸 Validation 노드로 상쇄한다는 게 우리 서사지만, 100%는 아님.

### 무승부

- 스케줄링/반복 실행(양쪽 다 있음), 셀프서브 온보딩(n8n Cloud 체험 vs 우리 Free 티어).

### 전략 노트

n8n과 기능표로 싸우지 말 것(통합 수에서 무조건 짐). 싸울 땅은 **"당신 계정으로 로그인된 채널(인스타 DM·카카오)을, 코드 없이, 검토 게이트 걸고"** — n8n이 구조적으로 못 들어오는 3중 교집합이다.

## 5. vs OpenClaw — "오픈소스 원본 쓰면 공짜잖아?"

**한 줄 논지: 엔진 vs 완성차.** OpenClaw는 MIT 무료 런타임이고 Twixy는 그 위에 지은 제품이다. 이 비교에서 이기려는 게 아니라, **"직접 조립할 사람"과 "완성품을 살 사람"을 가르는 것**이 목적이다. 실제로 OpenClaw 위에 유료 제품을 얹은 스타트업이 2026년 3월 기준 약 170개, 합산 월 $397K 매출로, "오픈소스 런타임 + 유료 수직 UX"는 시장이 이미 인정한 모델이다 ([vcbacked.co](https://www.vcbacked.co/blog/openclaw-startup-ecosystem)).

### 5축 비교 (리서치 근거: 2026-07 기준)

| 축 | OpenClaw (raw) | Twixy |
|---|---|---|
| 타깃 | 터미널·JSON 설정을 다루는 개발자/해커 | 마케터 — 설치형 데스크톱 앱, 터미널 0회 |
| JTBD | "내 개인 AI 어시스턴트를 내 방식대로 조립" | "마케팅 운영을 감독 가능한 자동화로" |
| 실행 모델 | Gateway 데몬 + 메신저 채널(WhatsApp/Telegram 페어링) + CLI | 동일 런타임을 임베드하되 GUI 앱 + 관리형 Chrome + 워크플로/오케스트레이션 캔버스 |
| 감독 모델 | exec-approvals 정책 파일(deny/allowlist/ask) — 개발자용 | 노드 단위 Human Review/Validation, 격리 Test 러너, 게시물 수준의 검토 UX |
| 가격 | 런타임 무료 + **모델 API 키 자가 조달** | Free/Pro 구독, 키 조달·과금 내장 |

### 팩트 (전부 출처 있음)

- 설치는 npm/터미널 필수, GUI 인스톨러 없음. Node 22.19+, 온보딩 CLI 마법사에서 API 키 직접 입력 ([docs.openclaw.ai/install](https://docs.openclaw.ai/install), [getting-started](https://docs.openclaw.ai/start/getting-started)).
- 유일한 내장 GUI(Gateway Dashboard)는 공식 문서상 **"admin surface — 공개 노출 금지"**인 운영자 도구. 워크플로 빌더·대시보드류 최종사용자 UI 없음 ([docs.openclaw.ai/web/dashboard](https://docs.openclaw.ai/web/dashboard)).
- 실배포기: 첫날 인시던트 16건, "기본값이 전문 지식을 가정한다"(새벽 5시에 메시지 271통 발송 사고 포함) ([blog.rezvov.com](https://blog.rezvov.com/deploying-openclaw-sixteen-incidents-one-day)). 우리 팀도 동일 계열 이슈를 직접 겪음 — heartbeat 기본 ON으로 "앱 켜면 혼자 돌아감".
- 마케팅 용도로 쓰려면: ClawHub에서 스킬 자가 큐레이션(보안 퍼지로 스킬 수 13.7K→3.3K 요동, 품질 검증 사용자 몫) + 브라우저/계정 인프라 자가 구축 + cron JSON 직접 설정 ([multilogin.com](https://multilogin.com/blog/openclaw-for-social-media-marketing/), [gradually.ai](https://www.gradually.ai/en/openclaw-statistics/)).
- 릴리스가 월 수 회(2026.6.11 → 2026.7.1-beta) — 직접 쓰면 업스트림 추적·패치 부담을 사용자가 짐. Twixy는 이걸 패치(`patches/openclaw+2026.4.2.patch`)로 흡수.

### Twixy가 런타임 위에 얹은 것 (= 돈 받는 이유)

① 마케팅 soul·스킬 카탈로그(IG/YouTube/SEO/GA/카카오) ② 비주얼 워크플로+오케스트레이션 편집기 ③ 로그인 세션 유지되는 관리형 Chrome + 라이브 프리뷰 ④ 노드 단위 Human Review/Validation ⑤ 대시보드 차트 ⑥ 계정·과금·토큰캡(키 조달 불필요) ⑦ 안전한 기본값(heartbeat 사고 같은 것들을 제품이 미리 막음)

### 판정

- **이기는 지점**: 비개발자 온보딩(터미널 0회 vs CLI 마법사+JSON), 마케팅 특화 UX 전부, 안전 기본값, 키/과금 추상화.
- **지는 지점**: 가격(무료), 커스텀 자유도, 커뮤니티 스킬 생태계 접근성, 릴리스 속도(우리는 임베드 버전이 뒤처짐 — 현재 2026.4.2 vs 업스트림 2026.6.x).
- **무승부**: 코어 에이전트 능력(같은 런타임).
- **전략 노트**: OpenClaw를 경쟁자로 치지 말고 **"OpenClaw의 힘, 설치 없이"**로 흡수하는 서사가 유리. 다만 OpenClaw 셋업을 즐기는 얼리어답터는 우리 고객이 아님을 인정할 것.

## 6. vs Claude Code — "범용 에이전트가 다 하는데 왜 전용 앱?"

**경고부터: 이 비교가 셋 중 가장 위험하다.** "Claude Code는 개발자용이라 마케터는 못 쓴다"는 논리는 2026-07 현재 **성립하지 않는다.** Anthropic은 2026-01 비개발자용 표면 **Claude Cowork**를 출시했고 수개월 만에 전 유료 플랜 GA — 명시 타깃에 마케터 포함, 공식 Marketing 플러그인(콘텐츠 초안·캠페인 기획·론칭 관리)도 존재한다 ([claude.com/product/cowork](https://claude.com/product/cowork), [cowork-plugins](https://claude.com/blog/cowork-plugins)). Chrome 브라우저 에이전트(설치 900만), 클라우드 Routines(머신 꺼져도 cron 실행), Gmail/Slack/Apollo/Similarweb/WordPress 커넥터까지 **$20/월 Pro에 전부 포함** ([claude.com/pricing](https://claude.com/pricing)).

### 5축 비교 (리서치 근거: 2026-07 기준)

| 축 | Claude Code/Cowork | Twixy |
|---|---|---|
| 타깃 | 개발자 → 전 지식노동자로 하방 확장 중 | 처음부터 마케터 단일 페르소나 |
| JTBD | "무엇이든 시키면 해주는" 범용 에이전트 | 마케팅 운영의 반복 자산화 |
| 실행 모델 | 과제별 프롬프팅 중심(스킬/플러그인은 직접 작성) | Workflow/Orchestration이 1급 시민 — 만들고, 테스트하고, 재실행 |
| 감독 모델 | 도구별 승인 프롬프트(범용) | 노드 단위 Review/Validation — "이 게시물 나가기 전 내가 본다" 수준 |
| 가격 | $20/월, 단 챗과 한도 공유 + 5시간/주간 이중 한도 + 프로그래매틱 별도 과금 — 복잡 | Free/Pro, 메시지·토큰 한도 단순 |

### 우리가 이기는 지점 (좁지만 실재함)

1. **기술 노출 제로.** Cowork조차 코드 아티팩트·HTML 중간 산출물·의미 불명 에러가 새어나온다는 평가 — "문서 만들어달랬더니 JavaScript를 보여줬다" ([coworkhow.com](https://coworkhow.com/blog/claire-vo-cowork-review)). 구조적으로 Claude Code의 래퍼이기 때문. Twixy는 마케터 어휘(캠페인/채널/게시물)만 노출.
2. **완성형 버티컬 워크플로.** 공식 Marketing 플러그인은 범용 번들이지 채널별 완성 워크플로가 아님 — 재사용 자산을 만들려면 스킬/플러그인을 직접 작성해야 함 ([cowork-plugins](https://claude.com/blog/cowork-plugins)). Twixy는 인스타 리포스팅·SEO 감사·유튜브 요약 같은 완성 템플릿 + 비주얼 편집기 + 격리 Test 러너가 제품의 본체.
3. **감독 UX의 해상도.** Claude의 승인은 "이 도구 실행 허용?"(bash/파일 수준). Twixy의 승인은 "이 DM 발송 전 검토"(산출물 수준). 마케터가 실제로 두려워하는 건 후자다.
4. **MCP/커넥터 셋업 마찰.** Claude Code의 MCP 연결은 여전히 터미널+JSON 편집을 요구하는 경우가 많음 ([code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp)). Twixy는 스킬이 앱에 내장.
5. **로그인 세션 브라우저.** Claude in Chrome은 강력하지만 Pro 플랜은 Haiku 모델 제한 + "inherent risks" 명시 베타 ([support.claude.com](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)). Twixy의 관리형 Chrome은 워크플로 실행에 통합돼 있고 headless+프리뷰로 작업을 방해하지 않음.

### 지는 지점

- **범용성**: 마케팅 밖 업무(엑셀, 문서, 리서치, 코드)는 상대가 안 됨.
- **모델 접근성·인프라**: 최전선 모델, 클라우드 Routines(머신 꺼져도 실행 — 우리는 로컬 앱이라 불가), 900만 설치 Chrome 확장.
- **브랜드·신뢰**: Anthropic vs 무명 스타트업.
- **가격 대비 범위**: $20에 챗+코드+Cowork+브라우저+스케줄링 전부.

### 무승부

- 스킬 개념(양쪽 다 SKILL.md 계열), 로컬 파일 워크스페이스.

### 전략 노트 — 최대 위협 판정

**셋 중 가장 위험한 경쟁자는 n8n이 아니라 이쪽이다.** Cowork 프리뷰→GA가 수개월이었다는 속도로, 플러그인 생태계가 버티컬 깊이(한국어·카카오·채널별 템플릿)까지 확보하면 우리 차별점 1·2번이 침식된다. 방어는 두 가지: (a) 범용 에이전트가 흉내내기 힘든 **감독 해상도 + 한국 채널 깊이**를 계속 벌리기, (b) 우리가 OpenClaw 런타임 위에 있으므로 모델·런타임 발전은 자동 편승 — 싸움을 UX·버티컬 층으로 한정하기.

## 7. B2C 전환 시사점

**시장 공백은 실재한다.** 세 상대 모두 "한국어 네이티브 + 개인 마케터 + 노코드 + 로그인 채널 자동화"의 교집합에 없다: n8n은 기술팀·엔터프라이즈로, OpenClaw는 해커·셀프호스터로, Claude Cowork는 글로벌 범용 지식노동으로 향해 있다.

**재사용할 것:**
- Supabase 프리미엄(Free/Pro) — B2C 과금 인프라 완비. 남은 건 가격 검증(Pro 가격이 Claude Pro $20와 직접 비교당할 것임을 전제로 책정).
- 관리형 Chrome + 라이브 프리뷰 — B2C 데모의 핵심 장면("내 인스타에 실제로 들어가서 움직이는 걸 본다").
- Workflow 템플릿 — B2C에선 "빈 캔버스"가 아니라 **갤러리에서 골라 10분 내 첫 실행**이 온보딩의 전부.

**분리/보류할 것:**
- Twixy Enterprise 모드, shared 팀 라이브러리, MR 리뷰어 지정 — B2C 빌드에서 숨김 처리. 단 MR의 버전 관리 자체는 "실수해도 되돌릴 수 있음" 서사로 개인용에도 가치 있음 — UI만 단순화.
- Orchestration 탭 — 파워유저 기능. B2C 첫 릴리스의 훅이 아니라 리텐션 단계 기능으로.

**가장 위험한 경쟁자 판정:** n8n이 아니라 **범용 에이전트의 하방 확장(Claude Cowork)**. n8n과는 시장이 갈리지만, Cowork는 같은 사용자를 두고 싸운다. 대응은 §6 전략 노트 참조.

## 8. 리스크 & 오픈 퀘스천

**리스크**
1. **Cowork 플러그인 생태계의 버티컬 침식** — 한국어·카카오 지원 플러그인이 나오는 순간 차별점 축소. 감시 지표: cowork 플러그인 마켓의 마케팅 카테고리.
2. **채널 ToS 리스크** — 로그인 세션 브라우저 자동화는 Instagram/카카오 ToS와 긴장 관계. n8n 커뮤니티에서 "계정 정지 리스크"로 분류되는 바로 그 방식이 우리 핵심 차별점이기도 함. B2C 확장 시 법무 검토 + 계정 보호 가드(속도 제한, 행동 패턴) 필요.
3. **임베드 버전 격차** — OpenClaw 업스트림(2026.6.x)과 우리 임베드(2026.4.2) 격차가 벌어지면 "원본이 더 좋다" 역전 발생. 패치 추적 주기를 정할 것.
4. **LLM 실행 변동성** — n8n 대비 구조적 약점. Validation 노드 커버리지가 마케팅 서사가 아니라 실측 지표(테스트 통과율)로 뒷받침돼야 함.

**오픈 퀘스천 (팀 논의용)**
1. B2C Pro 가격 — Claude Pro $20/월 옆에서 얼마가 설득 가능한가? 토큰 원가 구조상 마진은?
2. "개인 마케터"의 세부 페르소나 — 1인 쇼핑몰? 크리에이터? 대행사 프리랜서? 첫 타깃 하나를 골라야 온보딩 템플릿이 정해짐.
3. 데스크톱 앱 설치라는 마찰 — B2C에서 "설치"는 전환율 킬러. 로컬 실행(= 내 계정, 내 데이터)이 주는 신뢰 서사로 상쇄 가능한가, 실측 필요.
4. OpenClaw 생태계와의 관계 — ClawHub 스킬을 Twixy 카탈로그로 큐레이션해 들여오는 파이프라인을 만들 것인가(생태계 편승) vs 자체 카탈로그 유지(품질 통제)?

---

*리서치 상세(출처 전문)는 2026-07-02 세션의 3개 리서치 결과 기반. 검증 불가로 채택하지 않은 주장: ClawHub 정확한 스킬 수(출처 간 불일치), Instagram API "시간당 200콜" 수치(Meta 공식 미확인), n8n 활성 워크플로 제한 폐지 정확한 시행일(서드파티 1곳).*
