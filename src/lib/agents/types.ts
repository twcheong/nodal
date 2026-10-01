// ─────────────────────────────────────────────────────────────────────────────
// agents/types.ts — "에이전트" 좌석의 타입 정의.
//
// 용어(팀 합의):
//   Engine  = AI 런타임 (openclaw, 메인 프로세스 수명주기, 툴 권한, transport)
//   Harness = 일을 어떻게 굴리는가 (턴 루프, 타임아웃, 재시도, 노드 순서, 성공 판정)
//   Agent   = **누가 말하는가** (SOUL·프롬프트 텍스트·툴 카탈로그·agentId·모드) ← 이 파일
//
// 좌석은 두 개다. 하나로 합치지 않은 이유:
//   워크플로 에이전트를 채팅 모드로 표현하려면 러너가 노드를 먼저 text 로 렌더해서
//   buildBody 에 넘겨야 한다 — 그러면 정작 갈아끼우고 싶은 "노드→프롬프트" 로직이
//   좌석 **밖**에 남는다. 그래서 ctx 타입이 다른 두 좌석으로 나누고, 공통분모만
//   AgentDef 로 묶는다. 차이는 전적으로 ctx 와 (채팅 쪽의) UI 블록이다.
//
// 규칙: 에이전트 정의는 **순수 데이터 + 순수 함수**다. React·window.twixy·transport
// 직접 접근 금지 — 이 좌석을 부르는 하네스가 Electron 밖(예: scripts/wf-eval)에서도
// 돌 수 있어야 하기 때문이다.
// ─────────────────────────────────────────────────────────────────────────────

/** 에이전트란 무엇인가 — 최소 정의. Ctx 는 좌석마다 다르다. */
export interface AgentDef<Ctx> {
  /** 레지스트리 키. */
  id: string
  /** 이 에이전트의 세션을 만들 게이트웨이 에이전트 (openclaw.json agents.list 의 id). */
  agentId: string
  /** ctx → LLM 페이로드. 순수 함수여야 한다. */
  buildBody(ctx: Ctx): string | Promise<string>
}

/**
 * 한 노드를 프롬프트로 만들 때 필요한 것 전부.
 *
 * 예전엔 위치 인자 8개였고(`buildNodePrompt(wf, node, inputs, isFirst, browserProfile,
 * resumeRecap, attachedFiles, rawScratchDir)`) 그래서 Test run 쪽과 Orchestration 쪽
 * 시그니처가 갈렸다. 이름 있는 객체로 두면 호출자마다 다른 맥락을 더해도 갈리지 않는다.
 */
export interface NodePromptCtx {
  workflow: TwixyWorkflow
  node:     TwixyWorkflowNode
  /** 실행 시 주입된 입력값. 비면 workflow.inputs[].observed 로 폴백한다. */
  inputs:   Record<string, string>
  /** 이 세션의 첫 노드인가 — 워크플로 헤더·규칙 블록은 이때만 붙는다. */
  isFirst:  boolean
  /** 호출자(하네스)별 실행 맥락. 전부 optional. */
  run?:     NodeRunContext
}

/** 호출 경로마다 다른 실행 맥락. 없는 필드는 그 블록을 통째로 생략한다. */
export interface NodeRunContext {
  /**
   * 첫 노드 맨 앞에 붙을 러너 하네스 블록 (이미 포맷된 텍스트, 없으면 생략).
   *
   * 왜 텍스트를 주입받나: 이 블록의 원본은 `?raw` 로 읽는 .md 라 Vite 에서만 resolve 되고,
   * 켜고 끄는 플래그는 localStorage 에 있다. 둘 다 순수 TS 모듈이 가질 수 없는 의존이다.
   * SOUL 들이 생성 상수로 바뀌면 이 자리는 'v3' | 'off' 같은 선택자로 좁힐 수 있다
   * (그때는 에이전트가 자기 SOUL 을 직접 갖는다).
   */
  harnessPreamble?: string
  /**
   * 이 실행을 모델에게 어떻게 소개하는가. 두 경로의 문구가 **오늘 실제로 다르고**, 그 차이를
   * 보존한다 (Test run 과 production run 은 모델에게 다른 일이라는 판단):
   *   · 헤더        `[Workflow Test — "…"]`        / `[Workflow — "…"]`
   *   · 진행 안내   `I will run this workflow…`     / `Run this workflow…`
   *   · review 태그 `[Human Review]`                / 태그 없음(일반 tool 표기로 떨어진다)
   * 세 번째는 orchestration 에서 도달하지 않는 경로다(러너 루프가 review 노드를 빌더 호출 전에
   * 가로챈다) — 그래도 바이트를 바꾸지 않으려고 같은 스위치에 묶어 뒀다.
   * 기본값은 'workflow-test'.
   */
  promptStyle?: 'workflow-test' | 'orchestration'
  /** Orchestration: 상류 멤버의 출력을 첫 노드 앞에 잇는다. */
  preamble?: string
  /** Test run: 중단된 실행을 재개할 때의 요약. */
  resumeRecap?: string
  /** 이 노드가 참조하는 파일의 추출 텍스트 (앱이 미리 읽어 넘긴다). */
  attachedFiles?: string
  /** 이 실행 전용 브라우저 프로필 슬롯 (wf-1 등). */
  browserProfile?: string
  /** 중간 산출물을 가둘 스크래치 폴더. 탭을 닫으면 이 폴더만 지워진다. */
  rawScratchDir?: string | null
}

/**
 * 워크플로 노드를 실행하는 에이전트.
 *
 * 추가 필드가 없다 — 채팅 좌석과의 차이는 전부 ctx 에 있다. 일부러 넣지 않은 것 둘:
 *  · `statusProtocol` — NODE_STATUS 프로토콜은 지금 한 종류뿐이고, 프롬프트 문구(Agent)와
 *    그걸 읽는 판정(Harness)이 짝이다. 갈아끼우게 열어두면 하네스가 못 읽는 문구를
 *    에이전트가 조용히 내보낼 수 있다. 다른 프로토콜이 실제로 필요해질 때 추가한다.
 *  · 툴 카탈로그 전략 객체 — `bridgeToolsFor` 는 순수 조회 함수다. buildBody 안에서 부르면 된다.
 */
export type WorkflowAgent = AgentDef<NodePromptCtx>
