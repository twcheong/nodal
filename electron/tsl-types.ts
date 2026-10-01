// ─────────────────────────────────────────────────────────────────────────────
//  Twixy Skill Language (TSL) — 타입 정의
//  tsl-types.ts  (컴파일러와 IPC 양쪽에서 공유)
//
//  TSL 은 Twixy 전용 DSL. 사용자가 작성한 .tskill 소스를 tsl-compiler.ts 가 파싱해
//  여기 정의된 타입(TslParsed)으로 바꾸고, 최종적으로 에이전트가 읽을 SKILL.md 로 렌더한다.
//  이 파일의 타입은 코어 비즈니스 모델이므로 수정 시 파서/IPC 양쪽과 함께 갱신해야 함.
// ─────────────────────────────────────────────────────────────────────────────

// 스킬이 다룰 수 있는 플랫폼 리터럴.
// .tskill 의 PLATFORMS { … } 블록에서 이 이름을 그대로 사용한다.
export type Platform =
  | 'INSTAGRAM' | 'TIKTOK'  | 'YOUTUBE'    | 'TWITTER'
  | 'LINKEDIN'  | 'GOOGLE_ANALYTICS'        | 'GOOGLE_ADS'
  | 'META_ADS'  | 'NOTION'  | 'AIRTABLE'   | 'SLACK'

// 스킬 본문에 등장하는 스테이지 종류.
// 실행 순서 = GOAL → COLLECT → ANALYZE → STRATEGIZE → EXECUTE → TRACK.
export type StageKind =
  | 'GOAL' | 'COLLECT' | 'ANALYZE'
  | 'STRATEGIZE' | 'EXECUTE' | 'TRACK'

// `.tskill` 상단부의 SKILL "..." 블록에서 파싱된 메타데이터.
// schedule 은 cron 식 문자열이 들어오고, listensTo 는 다른 스킬이 방출한 시그널을 트리거로 삼는 설정.
export interface TslSkillMeta {
  name:         string
  version:      string
  author:       string
  description:  string
  tags:         string[]
  schedule?:    string                                           // cron 표현 (예: "0 9 * * 1")
  listensTo?:   { signal: string; fromSkill: string }            // 이벤트 기반 트리거
}

// 단일 STAGE { … } 블록 파싱 결과. body 는 `{}` 내부의 원문 텍스트.
// lineStart 는 1-indexed 소스 라인 번호(에러 위치 리포팅용).
export interface TslStageBlock {
  kind:      StageKind
  label:     string
  body:      string    // `{` 와 `}` 사이의 원문 본문
  lineStart: number    // 1부터 시작하는 소스 라인 번호
}

// `.tskill` 파서의 최종 산출 AST.
// compileTSL() 이 이 구조를 SKILL.md 로 렌더한다.
export interface TslParsed {
  workspace: string              // @workspace 헤더 값 (보통 "twixy")
  skill:     TslSkillMeta
  platforms: Platform[]
  stages:    TslStageBlock[]
}

// 파싱/검증 중 발견된 치명적 오류. 있으면 컴파일 실패.
export interface TslError {
  message: string
  line?:   number
  hint?:   string   // 수정 힌트 (선택)
  code?:   string
}

// 경고는 컴파일을 막지 않는다 (나쁘지만 치명적이지 않은 패턴).
export interface TslWarning {
  message: string
  line?:   number
}

// tsl-compiler.ts 의 compileTSL() 반환 타입.
// ok=true 면 markdown 에 렌더 결과가 들어있고, 실패 시 errors 가 채워진다.
export interface TslCompileResult {
  ok:       boolean
  markdown: string | null
  errors:   TslError[]
  warnings: TslWarning[]
  metadata: {
    skill:      string
    version:    string
    compiledAt: string   // ISO8601 타임스탬프
    filename:   string
  } | null
}

// list-skills IPC 가 렌더러로 보내는 안전한 요약.
// 소스 전문/파서 내부 상태는 제외하고 SkillsPanel 렌더에 필요한 최소치만 포함.
export interface SkillManifest {
  name:        string
  displayName: string
  description: string
  tags:        string[]
  author:      'builtin' | 'user'    // 내장 스킬 vs 사용자 설치 스킬 구분
  version:     string
  platforms:   Platform[]
  schedule?:   string
  stages:      string[]                              // 예: ['COLLECT', 'ANALYZE', 'EXECUTE']
  steps:       { type: string; label: string }[]    // 라벨 순서대로 담긴 스텝 목록
  sourceFile:  string                                // 워크스페이스 기준 `.tskill` 상대 경로
}
