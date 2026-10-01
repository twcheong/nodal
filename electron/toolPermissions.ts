// ── 엔진이 실제로 허용하는 툴 (순수 모듈: electron import 없음) ─────────────────
//
// 왜 필요한가: 프롬프트가 모델에게 이름을 불러 주는 툴 목록과, 엔진이 게이트웨이에 넘기는
// 실제 tool policy 가 따로 계산돼 왔다. 그래서 Nodal 처럼 exec·web·이미지 생성을 끈 제품에서
// "프롬프트는 쓰라고 하는데 엔진은 막는" 조합이 나온다. 이 모듈은 **엔진 쪽 사실 하나**를
// 계산해 노출한다 — 소비자(프롬프트·하네스)가 플래그를 보고 다시 추론하지 않게.
//
// ── openclaw 가 실제로 하는 계산 (2026.4.2 dist 확인) ────────────────────────────
// tools 정책은 단계별 필터다. 각 단계를 **전부** 통과한 툴만 남는다:
//   1. tools.profile           — 프로필의 allow 목록 (+ alsoAllow 가 여기 합쳐진다)
//   2. tools.allow / deny      — 우리 deny 가 여기 붙는다
//   3. agents.<id>.tools …     — 에이전트별 (우리는 안 쓴다)
//   4. group / sandbox / subagent 정책
// 한 단계의 판정(makeToolPolicyMatcher):
//   · deny 먼저, **deny 가 allow 를 이긴다**
//   · allow 가 비어 있으면 전부 통과
//   · 이름은 normalizeToolName 으로 정규화 — 소문자 + trim + 별칭(bash→exec, apply-patch→apply_patch)
//   · 항목은 **glob** 이다: '*' 하나면 전부, '*' 포함이면 정규식, 아니면 정확 일치
//   · 'group:<섹션>' · 'group:openclaw' 같은 **그룹 id 는 멤버로 확장**된 뒤 매칭된다
//   · 특례: write 가 deny 면 apply_patch 도 deny (반대로 allow 면 allow)
//
// 즉 deny 는 "정확한 id" 만이 아니다 — id · glob · 그룹 셋 다 올 수 있고, 소비자는 그걸
// 다시 해석하면 안 된다. 그래서 이 모듈이 **해석을 끝낸 id 목록**을 준다.
//
// ── 이 값이 답하지 못하는 것 (소비자가 알아야 한다) ──────────────────────────────
// "정책이 허용한다" 와 "실제로 호출된다" 는 다르다. 아래는 런타임에 갈린다:
//   · MCP 서버가 붙여 주는 툴 — 서버가 떠 있어야 하고 이름도 서버가 정한다. universe 에 없다.
//   · 프로바이더/모델 의존 툴 — code_execution·web_search 등은 런타임이 안 맞으면 광고만 되고 실패한다.
//   · image_generate 는 이미지 프로바이더 키가 있어야 실제로 생성한다.
//   · owner-only 툴(cron·gateway·nodes)은 발신자가 owner 가 아니면 통째로 빠진다.
//   · 서브에이전트 세션은 별도 정책을 한 겹 더 받는다.
// 그래서 이름은 canTell* 가 아니라 "정책이 허용하는 집합" 이다.

/** openclaw CORE_TOOL_DEFINITIONS 의 사본 (dist 에서 기계적으로 추출).
 *  openclaw 를 올리면 toolPermissions.test.ts 의 드리프트 테스트가 먼저 깨진다. */
export const CORE_TOOLS: ReadonlyArray<{
  id: string
  section: string
  profiles: readonly string[]
  openclawGroup?: boolean
}> = [
  { id: 'read', section: 'fs', profiles: ['coding'] },
  { id: 'write', section: 'fs', profiles: ['coding'] },
  { id: 'edit', section: 'fs', profiles: ['coding'] },
  { id: 'apply_patch', section: 'fs', profiles: ['coding'] },
  { id: 'exec', section: 'runtime', profiles: ['coding'] },
  { id: 'process', section: 'runtime', profiles: ['coding'] },
  { id: 'code_execution', section: 'runtime', profiles: ['coding'], openclawGroup: true },
  { id: 'web_search', section: 'web', profiles: ['coding'], openclawGroup: true },
  { id: 'web_fetch', section: 'web', profiles: ['coding'], openclawGroup: true },
  { id: 'x_search', section: 'web', profiles: ['coding'], openclawGroup: true },
  { id: 'memory_search', section: 'memory', profiles: ['coding'], openclawGroup: true },
  { id: 'memory_get', section: 'memory', profiles: ['coding'], openclawGroup: true },
  { id: 'sessions_list', section: 'sessions', profiles: ['coding', 'messaging'], openclawGroup: true },
  { id: 'sessions_history', section: 'sessions', profiles: ['coding', 'messaging'], openclawGroup: true },
  { id: 'sessions_send', section: 'sessions', profiles: ['coding', 'messaging'], openclawGroup: true },
  { id: 'sessions_spawn', section: 'sessions', profiles: ['coding'], openclawGroup: true },
  { id: 'sessions_yield', section: 'sessions', profiles: ['coding'], openclawGroup: true },
  { id: 'subagents', section: 'sessions', profiles: ['coding'], openclawGroup: true },
  { id: 'session_status', section: 'sessions', profiles: ['minimal', 'coding', 'messaging'], openclawGroup: true },
  { id: 'browser', section: 'ui', profiles: [], openclawGroup: true },
  { id: 'canvas', section: 'ui', profiles: [], openclawGroup: true },
  { id: 'message', section: 'messaging', profiles: ['messaging'], openclawGroup: true },
  { id: 'cron', section: 'automation', profiles: ['coding'], openclawGroup: true },
  { id: 'gateway', section: 'automation', profiles: [], openclawGroup: true },
  { id: 'nodes', section: 'nodes', profiles: [], openclawGroup: true },
  { id: 'agents_list', section: 'agents', profiles: [], openclawGroup: true },
  { id: 'image', section: 'media', profiles: ['coding'], openclawGroup: true },
  { id: 'image_generate', section: 'media', profiles: ['coding'], openclawGroup: true },
  { id: 'tts', section: 'media', profiles: [], openclawGroup: true },
  { id: 'tool_write_pdf', section: 'fs', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_write_xlsx', section: 'fs', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_read_xlsx', section: 'fs', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_fetch_to_file', section: 'automation', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_query_data', section: 'fs', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_read_pptx', section: 'fs', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_edit_pptx', section: 'fs', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_write_pptx', section: 'fs', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_google_status', section: 'automation', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_google_connect', section: 'automation', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_google_disconnect', section: 'automation', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_write_gdoc', section: 'automation', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_read_gdoc', section: 'automation', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_write_gsheet', section: 'automation', profiles: ['coding'], openclawGroup: true },
  { id: 'tool_read_gsheet', section: 'automation', profiles: ['coding'], openclawGroup: true },
]

const ALIASES: Record<string, string> = { bash: 'exec', 'apply-patch': 'apply_patch' }

/** openclaw normalizeToolName 과 같은 규칙. */
export function normalizeToolId(name: string): string {
  const n = String(name ?? '').trim().toLowerCase()
  return ALIASES[n] ?? n
}

/** 'group:fs' · 'group:openclaw' 같은 그룹 id 를 멤버로 펼친다 (openclaw expandToolGroups). */
export function expandToolEntries(entries: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of entries.map(normalizeToolId).filter(Boolean)) {
    if (raw === 'group:openclaw') { out.push(...CORE_TOOLS.filter(t => t.openclawGroup).map(t => t.id)); continue }
    if (raw.startsWith('group:')) {
      const section = raw.slice('group:'.length)
      const members = CORE_TOOLS.filter(t => t.section === section).map(t => t.id)
      if (members.length) { out.push(...members); continue }
    }
    out.push(raw)
  }
  return Array.from(new Set(out))
}

/** glob 한 개 대조. 정규식을 만들지 않는다 — 툴 id 에 정규식 특수문자가 섞여도
 *  이스케이프 실수로 엉뚱한 걸 매칭하는 사고가 아예 생기지 않게. */
function globTest(id: string, pattern: string): boolean {
  const parts = pattern.split('*')
  if (!id.startsWith(parts[0])) return false
  let pos = parts[0].length
  for (let i = 1; i < parts.length - 1; i++) {
    const at = id.indexOf(parts[i], pos)
    if (at === -1) return false
    pos = at + parts[i].length
  }
  const last = parts[parts.length - 1]
  return id.length - pos >= last.length && id.endsWith(last)
}

/** openclaw compileGlobPattern: '*' = 전부, '*' 포함 = glob, 그 외 정확 일치. */
function matches(id: string, entries: readonly string[]): boolean {
  for (const e of entries) {
    if (!e) continue
    if (e === '*') return true
    if (e.includes('*')) { if (globTest(id, e)) return true; continue }
    if (e === id) return true
  }
  return false
}

/** 패치가 openclaw 에 얹는 브릿지 툴 id. agent-tool-bridge.ts 가 여기서 가져다 쓴다 —
 *  "어떤 툴이 존재하는가" 는 정책 계산의 입력이라, 정책과 같은 파일에 둔다. */
export const BRIDGE_TOOL_IDS = [
  'tool_write_pdf', 'tool_write_xlsx', 'tool_read_xlsx',
  'tool_read_pptx', 'tool_edit_pptx', 'tool_write_pptx',
  'tool_fetch_to_file', 'tool_query_data',
  'tool_google_status', 'tool_google_connect', 'tool_google_disconnect',
  'tool_write_gdoc', 'tool_read_gdoc', 'tool_write_gsheet', 'tool_read_gsheet',
] as const

/** 제품 기능 플래그 중 툴 정책에 영향을 주는 것만. (shared/product/types.ts 의 부분집합) */
export interface ToolFeatureFlags {
  subagents: boolean
  browser: boolean
  cron: boolean
  bridgeTools: 'all' | readonly string[]
  toolsDeny: readonly string[]
}

/**
 * openclaw.json 에 쓸 tools 블록을 만든다. **main.ts 가 실제로 쓰는 그 함수**다 —
 * 테스트가 이걸 부르는 것과 게이트웨이가 받는 것이 같아야 해서 한 곳에 둔다.
 *
 * 순서가 중요하다: alsoAllow 로 켠 것도 deny 에 걸리면 막힌다 (openclaw 는 deny 를 먼저 본다).
 * 그래서 browser 처럼 "켜면 alsoAllow, 끄면 deny" 인 항목이 양쪽에 동시에 들어가는 일은 없다.
 */
export function buildToolsBlock(
  features: ToolFeatureFlags,
  existingTools?: { alsoAllow?: readonly string[]; deny?: readonly string[]; fs?: Record<string, unknown> } & Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(existingTools ?? {}),
    profile: 'coding',
    alsoAllow: Array.from(new Set([
      ...(existingTools?.alsoAllow ?? []),
      ...(features.subagents ? ['subagents', 'sessions_spawn', 'sessions_yield'] : []),
      // browser/canvas 는 코어에서 profiles: [] 라 "coding" 프리셋에 없다 — 명시적으로 다시 켠다.
      ...(features.browser ? ['browser', 'canvas'] : []),
      // image_generate 는 이미 profiles:["coding"] 이라 belt-and-suspenders.
      'image_generate',
    ])),
    deny: Array.from(new Set([
      ...(existingTools?.deny ?? []),
      // "coding" 프로필은 이 둘을 광고하지만 우리 런타임엔 실행기가 없다 — 모델이 부르면
      // 에러만 나고 루프가 조용히 멈춘다. 그래서 아예 광고하지 않는다.
      'code_execution',
      'x_search',
      // 제품이 끈 기능의 툴은 정책 레이어에서 막는다 (deny 는 alsoAllow·profile 을 이긴다).
      ...(features.subagents ? [] : ['subagents', 'sessions_spawn', 'sessions_yield']),
      ...(features.browser   ? [] : ['browser', 'canvas']),
      ...(features.cron      ? [] : ['cron']),
      ...(features.bridgeTools === 'all'
        ? []
        : BRIDGE_TOOL_IDS.filter((id) => !(features.bridgeTools as readonly string[]).includes(id))),
      ...features.toolsDeny,
    ])),
    fs: {
      ...(existingTools?.fs ?? {}),
      workspaceOnly: true,
    },
  }
}

/** 게이트웨이에 넘어간 tools 블록 (openclaw.json 의 그 값). */
export interface ToolsPolicy {
  profile?: string
  alsoAllow?: readonly string[]
  deny?: readonly string[]
}

export interface ToolPermissions {
  /** 정책이 허용하는 툴 id — **"모델에게 이름을 불러 줘도 되는가" 의 답**. 정렬됨. */
  allowed: string[]
  /** 알려진 툴 중 deny 에 걸린 id. 정렬됨. "왜 안 되는지" 를 구분하려고 같이 준다
   *  (allowed 에도 denied 에도 없으면 = 이 프로필에 없거나 우리가 모르는 툴). */
  denied: string[]
  /** 판정에 쓴 원본 정책 — 감사·디버깅용. 소비자가 이걸로 다시 계산하면 안 된다. */
  policy: { profile: string | null; alsoAllow: string[]; deny: string[] }
}

/**
 * tools 정책 → 허용/거부 id 목록.
 *
 * universe = 프로필이 주는 allow ∪ alsoAllow. 그 안에서 deny 를 뺀 것이 allowed.
 * deny 는 universe 밖의 알려진 툴에도 적용해 denied 에 싣는다 (제품이 "이건 막는다" 고
 * 적어 둔 사실을 그대로 보여 주기 위해 — 어차피 프로필에 없었더라도).
 */
export function resolveToolPermissions(policy: ToolsPolicy): ToolPermissions {
  const alsoAllow = expandToolEntries(policy.alsoAllow ?? [])
  const deny = expandToolEntries(policy.deny ?? [])
  const profile = policy.profile ?? null

  // 프로필이 없으면 allow 가 비어 있는 것과 같다 = 전부 통과 (openclaw 규칙).
  const fromProfile = profile
    ? CORE_TOOLS.filter(t => t.profiles.includes(profile)).map(t => t.id)
    : CORE_TOOLS.map(t => t.id)
  const universe = Array.from(new Set([...fromProfile, ...alsoAllow]))

  const isDenied = (id: string) =>
    matches(id, deny) || (id === 'apply_patch' && matches('write', deny))

  const allowed = universe.filter(id => !isDenied(id)).sort()
  const denied = Array.from(new Set([...universe, ...CORE_TOOLS.map(t => t.id)]))
    .filter(isDenied).sort()

  return {
    allowed,
    denied,
    policy: { profile, alsoAllow: [...alsoAllow].sort(), deny: [...deny].sort() },
  }
}
