// ═════════════════════════════════════════════════════════════════════════════
//  Twixy Skill Language Compiler  v1.0
//  tsl-compiler.ts
//
//  역할: `.tskill`(DSL 소스) → `SKILL.md` (OpenClaw 에이전트가 읽는 마크다운) 변환.
//
//  파이프라인 4 단계:
//    1) stripComments  : 블록/라인 주석 제거 (URL 콜론은 보존)
//    2) parse          : 헤더(@workspace) / SKILL 블록 / PLATFORMS 블록 / STAGE 블록들 파싱
//    3) validate       : 이름·버전·필수 스테이지 검증, 스테이지 순서 경고
//    4) render         : 메타데이터 YAML front-matter + 각 스테이지 본문을 마크다운으로 렌더
//
//  본문 렌더러(renderBody) 가 TSL 구문(EXTRACT, STORE, LOAD, HYPOTHESIZE, PLAN,
//  SPAWN, POST, EMIT 등) 각각을 자연어 지시문으로 풀어낸다 — 에이전트는 이 마크다운만
//  읽고도 무엇을 할지 정확히 이해할 수 있어야 한다.
//
//  사용 예:
//    import { compileTSL } from './tsl-compiler'
//    const result = compileTSL(source, 'my-skill.tskill')
//    if (result.ok) fs.writeFileSync('SKILL.md', result.markdown)
// ═════════════════════════════════════════════════════════════════════════════

import type {
  TslCompileResult, TslError, TslWarning,
  TslParsed, TslStageBlock, TslSkillMeta,
  Platform, StageKind,
} from './tsl-types'
import { PRODUCT } from '../shared/product/current.generated'

// ── Constants — 어휘/순서/라벨 상수들 ────────────────────────────────────────
// TSL 문법이 수용하는 식별자 집합.
// 여기 없는 플랫폼/스테이지가 소스에 등장하면 validator 가 에러/경고를 쏜다.

const KNOWN_PLATFORMS = new Set<string>([
  'INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'TWITTER', 'LINKEDIN',
  'GOOGLE_ANALYTICS', 'GOOGLE_ADS', 'META_ADS', 'NOTION', 'AIRTABLE', 'SLACK',
])

const STAGE_KINDS = new Set<string>([
  'GOAL', 'COLLECT', 'ANALYZE', 'STRATEGIZE', 'EXECUTE', 'TRACK',
])

// 스테이지 실행 권장 순서. validator 가 이 순서에서 벗어난 배치를 감지해 경고.
const STAGE_ORDER: Record<StageKind, number> = {
  GOAL: 0, COLLECT: 1, ANALYZE: 2, STRATEGIZE: 3, EXECUTE: 4, TRACK: 5,
}

const STAGE_LABELS: Record<StageKind, string> = {
  GOAL:       'Define Objective',
  COLLECT:    'Collect Data',
  ANALYZE:    'Analyze',
  STRATEGIZE: 'Strategize',
  EXECUTE:    'Execute',
  TRACK:      'Track Results',
}

// `.tskill` 본문에서 사용하는 경로 별칭($RAW 등)을 실제 경로로 치환하는 맵.
// expandAlias / expandAliases 유틸이 이 맵을 참조한다.
//
// SYNC: 이 맵의 키와 절대경로의 마지막 세그먼트(들)는 `electron/tools/files/
// designatedPaths.ts` 의 `DESIGNATED_ROOTS` 와 1:1 로 맞춰야 한다. 어긋나면
// LLM 프롬프트가 안내하는 경로와 쓰기 가드가 막는 경로가 달라져 사일런트
// 에러가 난다. `diffWithPathMap()` 헬퍼로 테스트에서 검증한다.
const WS_ROOT = `~/${PRODUCT.stateDirName}/workspace/${PRODUCT.defaultWorkspaceName}`
export const PATH_MAP: Record<string, string> = {
  '$RAW':        `${WS_ROOT}/data/raw/`,
  '$INSIGHTS':   `${WS_ROOT}/data/insights/`,
  '$STRATEGIES': `${WS_ROOT}/strategies/`,
  '$DRAFTS':     `${WS_ROOT}/content/drafts/`,
  '$PUBLISHED':  `${WS_ROOT}/content/published/`,
  '$REPORTS':    `${WS_ROOT}/data/reports/`,
}

// ── Public API — 외부에 노출되는 엔트리 포인트 ──────────────────────────────
// 컴파일 성공 시: { ok: true, markdown, metadata }
// 실패 시:      { ok: false, markdown: null, errors[] } — parse/validate 단계에서 모은 에러.
// 단계별 early-return — 에러가 있으면 그 이후 단계를 진행하지 않는다.
export function compileTSL(source: string, filename: string): TslCompileResult {
  const errors:   TslError[]   = []
  const warnings: TslWarning[] = []

  // Phase 1: strip comments
  const clean = stripComments(source)
  const lines = clean.split('\n')

  // Phase 2: parse
  let parsed: TslParsed
  try {
    parsed = parse(lines, errors, warnings)
  } catch (e) {
    errors.push({ message: `Parse error: ${String(e)}` })
    return { ok: false, markdown: null, errors, warnings, metadata: null }
  }

  if (errors.length > 0) {
    return { ok: false, markdown: null, errors, warnings, metadata: null }
  }

  // Phase 3: validate
  validate(parsed, filename, errors, warnings)

  if (errors.length > 0) {
    return { ok: false, markdown: null, errors, warnings, metadata: null }
  }

  // Phase 4: render
  const markdown = render(parsed, filename)

  return {
    ok: true,
    markdown,
    errors,
    warnings,
    metadata: {
      skill:      parsed.skill.name,
      version:    parsed.skill.version || '1.0',
      compiledAt: new Date().toISOString(),
      filename,
    },
  }
}

// ── Comment Stripping — 파싱 전 주석 제거 ───────────────────────────────────
// `/* … */` 블록 주석과 `// …` 라인 주석을 지운다.
//
// 왜 정규식 두 줄이 아니라 스캐너인가 (2026-08-14):
//   예전 구현은 `src.replace(/(?<!:)\/\/[^\n]*/g, '')` 였다. lookbehind 는 URL 의
//   "://" 만 막아줄 뿐, 따옴표 안쪽을 전혀 모른다. 그래서 skills/instagram 의
//
//     fn='() => { … a.href.match(/instagram\.com\/(p|reel)\/([A-Za-z0-9_-]+)\//); … }'
//
//   에서 정규식 리터럴을 닫는 `\//` 가 라인 주석으로 잡혀 642자 중 399자가 날아갔다.
//   결과는 조용했고 두 단계로 번졌다:
//     1) 남은 조각의 중괄호가 안 맞아 extractBraceBlock 이 블록을 못 닫는다 →
//        뒤따르는 모든 STAGE 가 앞 블록 본문으로 흡수돼 섹션이 사라진다.
//     2) SKILL.md 에 실린 evaluate 스니펫 자체가 정규식 중간에서 끊긴다 →
//        에이전트가 실행 불가능한 자바스크립트를 지시받는다. 업로드 타입 오분류를
//        막으려고 만든 스킬이, 바로 그 분류 코드를 깨진 채로 배포하고 있었다.
//
//   컴파일도 통과하고 경고도 없었다. 그래서 문자열 상태를 실제로 추적한다 —
//   `fn='…'` 안은 통째로 보호되고, 주석은 따옴표 밖에서만 주석이다.
function stripComments(src: string): string {
  let out = ''
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]

    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue }   // 이스케이프는 통째로
      if (c === quote) quote = null
      else if (c === '\n') quote = null   // TSL 문자열은 줄을 넘지 않는다. 넘어간 것처럼
      out += c; i++                        // 보이면 따옴표 짝이 안 맞는 것이므로 줄에서 끊는다
      continue
    }

    if (c === '"' || c === "'") { quote = c; out += c; i++; continue }

    if (c === '/' && next === '*') {                       // 블록 주석
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    // 라인 주석. 따옴표 밖의 bare URL("자세한 건 https://… 참고" 같은 산문)을 위해
    // ':' 뒤의 '//' 는 여전히 살려 둔다.
    if (c === '/' && next === '/' && src[i - 1] !== ':') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }

    out += c; i++
  }
  return out
}

// ── Parser — TSL 소스 → TslParsed AST ───────────────────────────────────────
// 라인 기반 파서 (복잡한 Pratt 파서가 필요할 만큼 문법이 복잡하지 않음).
// 한 줄씩 훑으며 @workspace / SKILL 메타 / PLATFORMS / 6개 STAGE 블록을 식별,
// 블록 내부는 extractBraceBlock 으로 균형 잡힌 `{ … }` 덩어리를 잘라낸다.

function parse(
  lines: string[],
  errors: TslError[],
  _warnings: TslWarning[],
): TslParsed {
  let workspace = ''
  const skill: TslSkillMeta = {
    name: '', version: '1.0', author: '', description: '', tags: [],
  }
  const platforms: Platform[] = []
  const stages: TslStageBlock[] = []

  let i = 0

  while (i < lines.length) {
    const raw     = lines[i]
    const trimmed = raw.trim()

    if (!trimmed) { i++; continue }

    // ── @workspace ──────────────────────────────────────────────────────────
    if (trimmed.startsWith('@workspace')) {
      workspace = trimmed.replace('@workspace', '').replace('=', '').trim()
      i++
      continue
    }

    // ── SKILL "name" ... ────────────────────────────────────────────────────
    if (/^SKILL\s+"/.test(trimmed)) {
      const m = trimmed.match(/^SKILL\s+"([^"]+)"/)
      if (m) skill.name = m[1]
      i++
      // Collect indented metadata lines until blank line or next top-level keyword
      while (i < lines.length) {
        const ml = lines[i]
        if (!ml.trim()) { i++; break }
        if (/^[A-Z@]/.test(ml[0] ?? '')) break
        const meta = ml.trim()
        if      (meta.startsWith('version:'))     skill.version     = unquote(after(meta, 'version:'))
        else if (meta.startsWith('author:'))      skill.author      = unquote(after(meta, 'author:'))
        else if (meta.startsWith('description:')) skill.description = unquote(after(meta, 'description:'))
        else if (meta.startsWith('schedule:'))    skill.schedule    = unquote(after(meta, 'schedule:'))
        else if (meta.startsWith('tags:')) {
          skill.tags = after(meta, 'tags:')
            .replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean)
        } else if (meta.startsWith('LISTENS TO')) {
          const lm = meta.match(/LISTENS TO\s+"([^"]+)"\s+FROM SKILL\s+"([^"]+)"/)
          if (lm) skill.listensTo = { signal: lm[1], fromSkill: lm[2] }
        }
        i++
      }
      continue
    }

    // ── PLATFORMS { ... } ───────────────────────────────────────────────────
    if (trimmed.startsWith('PLATFORMS')) {
      i++
      while (i < lines.length) {
        const pl = lines[i].trim()
        if (pl === '}' || !pl) { i++; break }
        if (pl !== '{' && KNOWN_PLATFORMS.has(pl)) platforms.push(pl as Platform)
        i++
      }
      continue
    }

    // ── Stage blocks: GOAL|COLLECT|... "label" { ... } ──────────────────────
    const stageM = trimmed.match(/^(GOAL|COLLECT|ANALYZE|STRATEGIZE|EXECUTE|TRACK)\s+"([^"]*)"/)
    if (stageM) {
      const kind      = stageM[1] as StageKind
      const label     = stageM[2]
      const lineStart = i + 1

      const [body, consumed] = extractBraceBlock(lines, i)
      if (body === null) {
        errors.push({ message: `Stage ${kind} "${label}" has no opening brace`, line: lineStart })
        i++
        continue
      }
      stages.push({ kind, label, body, lineStart })
      i += consumed
      continue
    }

    i++
  }

  return { workspace, skill, platforms, stages }
}

// ── Validator — 파싱 후 의미 검증 ────────────────────────────────────────────
// 검사 항목:
//   · 필수 필드 (skill 이름/버전, 최소 1개 스테이지) 존재 여부
//   · 이름 패턴 (소문자/숫자/하이픈) 과 파일명 일치
//   · 중복 스테이지, 알려지지 않은 플랫폼
//   · STAGE_ORDER 를 크게 어기는 배치 → warning (에러 아님)

function validate(
  parsed: TslParsed,
  _filename: string,
  errors: TslError[],
  warnings: TslWarning[],
) {
  if (parsed.workspace !== 'twixy') {
    errors.push({
      message: `Invalid workspace: "${parsed.workspace}" — must be "twixy"`,
      hint:    'Change the first line to: @workspace twixy',
    })
  }

  if (!parsed.skill.name) {
    errors.push({
      message: 'Missing SKILL declaration',
      hint:    'Add: SKILL "Your Skill Name"',
    })
  }

  if (!parsed.skill.description) {
    warnings.push({ message: 'No description provided — add description: "..." inside the SKILL block' })
  }

  // EXECUTE must have APPROVE before POST
  const execStage = parsed.stages.find(s => s.kind === 'EXECUTE')
  if (execStage) {
    const hasPost    = /\bPOST\b/.test(execStage.body)
    const hasApprove = /\bAPPROVE\b/.test(execStage.body)
    if (hasPost && !hasApprove) {
      errors.push({
        message: `EXECUTE stage contains POST without an APPROVE gate`,
        line:    execStage.lineStart,
        hint:    'Add APPROVE { show: $variable, timeout: 24 hours, on_timeout: CANCEL } before POST.',
      })
    }
  }

  // Stage order warning
  let lastOrder = -1
  for (const stage of parsed.stages) {
    const order = STAGE_ORDER[stage.kind]
    if (order < lastOrder) {
      warnings.push({
        message: `Stage ${stage.kind} appears out of order. Expected: GOAL → COLLECT → ANALYZE → STRATEGIZE → EXECUTE → TRACK`,
        line:    stage.lineStart,
      })
    }
    lastOrder = Math.max(lastOrder, order)
  }

  // Unknown path aliases
  const allBody = parsed.stages.map(s => s.body).join('\n')
  const aliasMatches = allBody.match(/\$[A-Z_]{2,}/g) ?? []
  const unknownAliases = [...new Set(aliasMatches)].filter(
    a => !PATH_MAP[a] && a !== '$incoming',
  )
  for (const alias of unknownAliases) {
    warnings.push({
      message: `Unknown path alias ${alias}. Known aliases: ${Object.keys(PATH_MAP).join(', ')}`,
    })
  }
}

// ── Renderer — TslParsed → SKILL.md 마크다운 문자열 ─────────────────────────
// 상단 YAML front-matter 에 skill 메타(name/version/tags/platforms)를 직렬화,
// 이어서 "# <Skill Name>" 헤딩, GOAL 블록, 그리고 각 스테이지를 순서대로 렌더.
// 본문 내부는 renderBody() 가 TSL 명령을 자연어 지시문으로 변환한다.
function render(parsed: TslParsed, filename: string): string {
  const out: string[] = []

  // YAML frontmatter — required for OpenClaw to include this skill in <available_skills>
  const skillId = filename.replace(/\.tskill$/, '')
  out.push('---')
  out.push(`name: ${skillId}`)
  if (parsed.skill.description) {
    out.push(`description: "${parsed.skill.description.replace(/"/g, '\\"')}"`)
  }
  out.push('---')
  out.push('')

  // Compiler header comment
  out.push('<!--')
  out.push('  Generated by Twixy Skill Language Compiler v1.0')
  out.push(`  Source: ${filename}`)
  out.push(`  Workspace: ${parsed.workspace}`)
  out.push(`  Compiled: ${new Date().toISOString()}`)
  out.push('  DO NOT EDIT — edit the .tskill source and recompile')
  out.push('-->')
  out.push('')

  // Title
  out.push(`# ${parsed.skill.name}`)
  if (parsed.skill.description) {
    out.push('')
    out.push(parsed.skill.description)
  }
  out.push('')

  // Purpose
  out.push('## Purpose')
  out.push('')
  const goalStage = parsed.stages.find(s => s.kind === 'GOAL')
  if (goalStage) {
    const gm = parseGoalMeta(goalStage.body)
    if (gm.objective) out.push(gm.objective)
    if (gm.kpi || gm.target || gm.window) {
      out.push('')
      if (gm.kpi)    out.push(`**KPI:** ${gm.kpi}`)
      if (gm.target) out.push(`**Target:** ${gm.target}`)
      if (gm.window) out.push(`**Window:** ${gm.window}`)
    }
  } else if (parsed.skill.description) {
    out.push(parsed.skill.description)
  }
  if (parsed.platforms.length > 0) {
    out.push('')
    out.push(`**Platforms:** ${parsed.platforms.map(p => titleCase(p.replace(/_/g, ' '))).join(', ')}`)
  }
  out.push('')

  // Triggers
  out.push('## Triggers')
  out.push('')
  if (parsed.skill.schedule) {
    out.push(`Runs on schedule: \`${parsed.skill.schedule}\``)
    out.push('')
  }
  if (parsed.skill.listensTo) {
    out.push(`Activates automatically when \`${parsed.skill.listensTo.signal}\` signal is received from **${parsed.skill.listensTo.fromSkill}**.`)
    out.push('')
  }
  if (!parsed.skill.schedule && !parsed.skill.listensTo) {
    out.push('Activates when the user requests this skill directly.')
    out.push('')
  }

  // Behavior
  out.push('## Behavior')
  out.push('')

  const behaviorStages = parsed.stages.filter(s => s.kind !== 'GOAL')
  behaviorStages.forEach((stage, idx) => {
    out.push(`### ${idx + 1}. ${STAGE_LABELS[stage.kind]}${stage.label ? ` — ${stage.label}` : ''}`)
    out.push('')
    const rendered = renderBody(stage.body)
    if (rendered.trim()) out.push(rendered)
    out.push('')
  })

  // Meta footer
  if (parsed.skill.tags.length > 0 || parsed.skill.version) {
    out.push('## Meta')
    out.push('')
    if (parsed.skill.version) out.push(`- **Version:** ${parsed.skill.version}`)
    if (parsed.skill.author)  out.push(`- **Author:** ${parsed.skill.author}`)
    if (parsed.skill.tags.length > 0) out.push(`- **Tags:** ${parsed.skill.tags.join(', ')}`)
    out.push('')
  }

  return out.join('\n')
}

// ── Body Renderer — 스테이지 본문의 TSL 명령을 마크다운 지시문으로 번역 ────
// 지원하는 구문 (대소문자 혼용 허용):
//   · FROM <platform>          : 소스 선언
//   · USING <skill>            : 서브 스킬 재사용
//   · EXTRACT <field> AS <var> : 데이터 추출 + 변수 바인딩
//   · STORE / LOAD             : 워크스페이스 파일 입출력
//   · HYPOTHESIZE / PLAN       : 가설·계획 단계
//   · SPAWN <agent> ...        : 서브에이전트 스폰
//   · POST <draft> TO ...      : 게시 액션
//   · EMIT <signal> ...        : 다른 스킬에 이벤트 방출
// 그 외 줄은 그대로 bullet 으로 출력해 자유 텍스트 지시도 섞어쓸 수 있게 함.
function renderBody(body: string): string {
  const lines = body.split('\n')
  const out:   string[] = []
  let i = 0

  while (i < lines.length) {
    const raw     = lines[i]
    const trimmed = raw.trim()

    if (!trimmed || trimmed === '}' || trimmed === '};') { i++; continue }

    // ── APPROVE ────────────────────────────────────────────────────────────
    if (trimmed.startsWith('APPROVE')) {
      const lm = trimmed.match(/APPROVE\s+"([^"]+)"/)
      const label = lm ? lm[1] : 'Action requires approval'
      const [blockBody, consumed] = extractBraceBlock(lines, i)
      const show      = blockBody?.match(/show\s*:\s*(\$\w+)/)?.[1]       ?? ''
      const timeout   = blockBody?.match(/timeout\s*:\s*([^\n,}]+)/)?.[1]?.trim() ?? ''
      const onTimeout = blockBody?.match(/on_timeout\s*:\s*(\w+)/)?.[1]  ?? 'CANCEL'
      out.push(`**⚠ Approval required:** ${label}`)
      if (show)    out.push(`- Show to reviewer: \`${show}\``)
      if (timeout) out.push(`- Timeout: ${timeout} — on timeout: **${onTimeout}**`)
      out.push('- Execution resumes only after explicit human approval in the Twixy UI.')
      out.push('')
      i += consumed
      continue
    }

    // ── FOR EACH ───────────────────────────────────────────────────────────
    if (trimmed.startsWith('FOR EACH')) {
      const m = trimmed.match(/^FOR EACH\s+(\$\w+)\s+IN\s+(\$?\w+)/)
      if (m) {
        out.push(`For each \`${m[1]}\` in \`${expandAlias(m[2])}\`:`)
        const [blockBody, consumed] = extractBraceBlock(lines, i)
        if (blockBody) {
          renderBody(blockBody).split('\n').forEach(l => out.push(`  ${l}`))
        }
        i += consumed
        continue
      }
    }

    // ── IF / WHEN ──────────────────────────────────────────────────────────
    if (trimmed.startsWith('IF ') || trimmed.startsWith('WHEN ')) {
      const kw      = trimmed.startsWith('IF') ? 'If' : 'When'
      const condM   = trimmed.match(/^(?:IF|WHEN)\s+(.+?)(?:\s*\{.*)?$/)
      const cond    = condM ? expandAliases(condM[1].trim()) : ''
      out.push(`${kw} \`${cond}\`:`)

      const [blockBody, consumed] = extractBraceBlock(lines, i)
      if (blockBody) {
        renderBody(blockBody).split('\n').forEach(l => out.push(`  ${l}`))
      }
      i += consumed

      // ELSE IF / ELSE
      while (i < lines.length) {
        const next = lines[i].trim()
        if (next.startsWith('} ELSE IF') || next.startsWith('ELSE IF')) {
          const em = next.match(/ELSE IF\s+(.+?)(?:\s*\{.*)?$/)
          out.push(`Otherwise if \`${expandAliases(em?.[1]?.trim() ?? '')}\`:`)
          const [eb, ec] = extractBraceBlock(lines, i)
          if (eb) renderBody(eb).split('\n').forEach(l => out.push(`  ${l}`))
          i += ec
        } else if (next.startsWith('} ELSE') || next.startsWith('ELSE')) {
          out.push('Otherwise:')
          const [eb, ec] = extractBraceBlock(lines, i)
          if (eb) renderBody(eb).split('\n').forEach(l => out.push(`  ${l}`))
          i += ec
          break
        } else {
          break
        }
      }
      continue
    }

    // ── USE ────────────────────────────────────────────────────────────────
    if (trimmed.startsWith('USE ')) {
      const m = trimmed.match(/^USE\s+(\w+)(?:\s+AS\s+(\w+))?/)
      if (m) {
        const p = titleCase(m[1].replace(/_/g, ' '))
        const alias = m[2] ? ` (as \`${m[2]}\`)` : ''
        out.push(`- Open **${p}** browser session${alias}`)
      }
      i++; continue
    }

    // ── EXTRACT (may span multiple indented lines) ─────────────────────────
    if (trimmed.startsWith('EXTRACT ')) {
      const parts = [trimmed]
      let j = i + 1
      while (j < lines.length && /^\s{2,}/.test(lines[j]) && lines[j].trim()) {
        parts.push(lines[j].trim())
        j++
      }
      out.push(renderExtract(parts.join(' ')))
      i = j; continue
    }

    // ── STORE ──────────────────────────────────────────────────────────────
    if (trimmed.startsWith('STORE ')) {
      out.push(renderStore(trimmed))
      i++; continue
    }

    // ── LOAD ───────────────────────────────────────────────────────────────
    if (trimmed.startsWith('LOAD ')) {
      out.push(renderLoad(trimmed))
      i++; continue
    }

    // ── HYPOTHESIZE (multi-line) ───────────────────────────────────────────
    if (trimmed.startsWith('HYPOTHESIZE ')) {
      const parts = [trimmed]
      let j = i + 1
      while (j < lines.length && /^\s{2,}/.test(lines[j]) && lines[j].trim()) {
        parts.push(lines[j].trim()); j++
      }
      out.push(renderHypothesize(parts.join(' ')))
      i = j; continue
    }

    // ── PLAN (multi-line) ──────────────────────────────────────────────────
    if (trimmed.startsWith('PLAN ')) {
      const parts = [trimmed]
      let j = i + 1
      while (j < lines.length && /^\s{2,}/.test(lines[j]) && lines[j].trim()) {
        parts.push(lines[j].trim()); j++
      }
      out.push(renderPlan(parts.join(' ')))
      i = j; continue
    }

    // ── SPAWN (indented continuation: TASK / USING / OUTPUT / AWAIT / ASYNC)
    if (trimmed.startsWith('SPAWN ')) {
      const parts = [trimmed]
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j].trim()
        if (/^(TASK|USING|OUTPUT|AWAIT|ASYNC)\b/.test(next)) {
          parts.push(next); j++
        } else break
      }
      out.push(renderSpawn(parts))
      i = j; continue
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (trimmed.startsWith('POST ')) {
      out.push(renderPost(trimmed))
      i++; continue
    }

    // ── EMIT ───────────────────────────────────────────────────────────────
    if (trimmed.startsWith('EMIT ')) {
      out.push(renderEmit(trimmed))
      i++; continue
    }

    // ── LET ────────────────────────────────────────────────────────────────
    if (trimmed.startsWith('LET ')) {
      const m = trimmed.match(/^LET\s+(\$\w+)\s*=\s*(.+)/)
      if (m) out.push(`- Set \`${m[1]}\` = ${expandAliases(m[2].trim())}`)
      i++; continue
    }

    // ── Unknown / prose ────────────────────────────────────────────────────
    const expanded = expandAliases(trimmed)
    if (expanded) out.push(`- ${expanded}`)
    i++
  }

  return out.join('\n')
}

// ── Statement Renderers — 개별 TSL 명령 1 줄을 지시문으로 번역 ──────────────
// 각 함수는 "EXTRACT foo AS $bar" 같은 원문을 받아 "Extract foo and bind to $bar" 같은
// 자연어 bullet 으로 변환한다. 출력은 마크다운 bullet 1~N 줄.
function renderExtract(full: string): string {
  const m = full.match(/^EXTRACT\s+(\w+)\s+FROM\s+(\$?\w+)/)
  if (!m) return `- ${expandAliases(full)}`

  const [, type, src] = m
  const source = expandAlias(src)
  const parts: string[] = [`Extract **${type}** records from \`${source}\``]

  const where   = full.match(/WHERE\s+(.+?)(?=\s+(?:LIMIT|SINCE|BETWEEN|ORDER|INTO)\b|$)/)?.[1]
  const limit   = full.match(/LIMIT\s+(\d+)/)?.[1]
  const since   = full.match(/SINCE\s+([\d]+\s+\w+)/)?.[1]
  const between = full.match(/BETWEEN\s+(.+?)\s+AND\s+(\S+)/)?.[0]
  const order   = full.match(/ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?/)?.[0]
  const into    = full.match(/INTO\s+(\$\w+)/)?.[1]

  const filters: string[] = []
  if (where)   filters.push(`where ${expandAliases(where)}`)
  if (limit)   filters.push(`limit ${limit}`)
  if (since)   filters.push(`from the last ${since}`)
  if (between) filters.push(between.toLowerCase())
  if (order)   filters.push(order.toLowerCase())
  if (into)    parts.push(`→ store as \`${into}\``)

  if (filters.length) parts[0] += ` (${filters.join(', ')})`
  return `- ${parts.join(' ')}`
}

function renderStore(line: string): string {
  const m = line.match(/^STORE\s+(\$\w+)\s+AS\s+"([^"]+)"(?:\s+IN\s+(\$?\S+))?/)
  if (!m) return `- ${expandAliases(line)}`
  const [, varName, filename, folder] = m
  const path = folder ? expandAlias(folder) : '(workspace)'
  return `- Save \`${varName}\` as \`${filename}\` → \`${path}\``
}

function renderLoad(line: string): string {
  const m = line.match(/^LOAD\s+"([^"]+)"(?:\s+FROM\s+(\$?\S+))?\s+AS\s+(\$\w+)/)
  if (!m) return `- ${expandAliases(line)}`
  const [, filename, folder, varName] = m
  const path = folder ? expandAlias(folder) : '(workspace)'
  return `- Load \`${filename}\` from \`${path}\` → \`${varName}\``
}

function renderHypothesize(full: string): string {
  const typeM   = full.match(/^HYPOTHESIZE\s+(\w+)\s+AS\s+(\$\w+)/)
  const from    = full.match(/FROM\s+(\$\w+)/)?.[1]    ?? ''
  const about   = full.match(/ABOUT\s+"([^"]+)"/)?.[1]   ?? ''
  const context = full.match(/CONTEXT\s+"([^"]+)"/)?.[1] ?? ''
  if (!typeM) return `- ${expandAliases(full)}`
  const [, type, varName] = typeM
  const lines = [
    `- Generate a **${type}** from \`${from}\`:`,
    `  - Question: "${about}"`,
  ]
  if (context) lines.push(`  - Context: "${context}"`)
  lines.push(`  - Store as \`${varName}\``)
  return lines.join('\n')
}

function renderPlan(full: string): string {
  const typeM = full.match(/^PLAN\s+(\w+)\s+AS\s+(\$\w+)/)
  const from  = full.match(/FROM\s+(\$\w+)/)?.[1]  ?? ''
  const about = full.match(/ABOUT\s+"([^"]+)"/)?.[1] ?? ''
  if (!typeM) return `- ${expandAliases(full)}`
  const [, type, varName] = typeM
  return [
    `- Create a **${type}** based on \`${from}\`:`,
    `  - Scope: "${about}"`,
    `  - Store as \`${varName}\``,
  ].join('\n')
}

function renderSpawn(parts: string[]): string {
  const agentName = parts[0].replace(/^SPAWN\s+/, '').trim()
  const task      = parts.find(l => l.startsWith('TASK'))?.match(/TASK\s+"([^"]+)"/)?.[1]    ?? ''
  const using     = parts.find(l => l.startsWith('USING'))?.match(/USING\s+(\$\w+)/)?.[1]   ?? ''
  const output    = parts.find(l => l.startsWith('OUTPUT'))?.match(/OUTPUT\s+(\$\w+)/)?.[1] ?? ''
  const isAsync   = parts.some(l => l.trim() === 'ASYNC')

  const lines = [`- Spawn **${agentName}**${isAsync ? ' (async)' : ''}:`]
  if (task)   lines.push(`  - Task: "${task}"`)
  if (using)  lines.push(`  - Input: \`${using}\``)
  if (output) lines.push(`  - Output: \`${output}\``)
  return lines.join('\n')
}

function renderPost(line: string): string {
  const m = line.match(/^POST\s+(\$\w+)\s+TO\s+(\w+)(?:\s+AT\s+(.+?))?(?:\s+WITH\s+(.+))?$/)
  if (!m) return `- ${expandAliases(line)}`
  const [, varName, platform, at, withClause] = m
  let out = `- Publish \`${varName}\` to **${titleCase(platform.replace(/_/g, ' '))}**`
  if (at) out += ` at ${at}`
  if (withClause) out += ` — ${expandAliases(withClause)}`
  return out
}

function renderEmit(line: string): string {
  const signal  = line.match(/^EMIT\s+"([^"]+)"/)?.[1]              ?? ''
  const payload = line.match(/WITH\s+payload\s*=\s*(\$\w+)/)?.[1]  ?? ''
  const toSkill = line.match(/TO SKILL\s+"([^"]+)"/)?.[1]           ?? ''
  let out = `- Emit signal \`${signal}\``
  if (payload) out += ` with payload \`${payload}\``
  if (toSkill) out += ` → triggers **${toSkill}**`
  return out
}

// ── Utilities — 파싱/렌더 공용 헬퍼 ─────────────────────────────────────────
// extractBraceBlock : 균형 맞는 `{ … }` 본문을 잘라 반환. 중첩 `{}` 는 카운터로 추적.
// parseGoalMeta     : "key: value" 스타일 소형 파서 (GOAL 블록의 objective/kpi 등)
// expandAlias(es)   : $RAW → ~/.openclaw/workspace/... 치환 (PATH_MAP 참조)
// after / unquote / titleCase : 문자열 조작 유틸

/**
 * lines[startIdx] 이후에서 처음 등장하는 균형잡힌 `{ }` 쌍의 내부 문자열을 반환.
 * 중첩된 중괄호도 허용.
 * 반환: [본문, 닫는 괄호가 있는 라인 인덱스].
 */
function extractBraceBlock(lines: string[], startIdx: number): [string | null, number] {
  let i = startIdx
  while (i < lines.length && !lines[i].includes('{')) i++
  if (i >= lines.length) return [null, 1]

  const firstLine = lines[i]
  const openIdx   = firstLine.indexOf('{')
  let depth = 1
  const bodyLines: string[] = []

  // Process remainder of the opening line
  let rest = firstLine.slice(openIdx + 1)
  for (const ch of rest) {
    if      (ch === '{') depth++
    else if (ch === '}') depth--
  }

  if (depth === 0) {
    // Entire block on one line
    const closeIdx = firstLine.lastIndexOf('}')
    return [firstLine.slice(openIdx + 1, closeIdx), i - startIdx + 1]
  }

  if (rest.trim()) bodyLines.push(rest)
  i++

  while (i < lines.length && depth > 0) {
    const line = lines[i]
    let closeAt = -1
    let newDepth = depth

    for (let k = 0; k < line.length; k++) {
      if      (line[k] === '{') newDepth++
      else if (line[k] === '}') {
        newDepth--
        if (newDepth === 0) { closeAt = k; break }
      }
    }

    if (closeAt >= 0) {
      const before = line.slice(0, closeAt)
      if (before.trim()) bodyLines.push(before)
      rest = line.slice(closeAt + 1).trim()
      // rest might contain '} ELSE IF ...' — leave that for the caller
      depth = 0
      i++
    } else {
      bodyLines.push(line)
      depth = newDepth
      i++
    }
  }

  return [bodyLines.join('\n'), i - startIdx]
}

function parseGoalMeta(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const m = line.trim().match(/^(\w+)\s*:\s*(.+)/)
    if (m) result[m[1]] = unquote(m[2].trim())
  }
  return result
}

function expandAlias(s: string): string {
  return PATH_MAP[s] ?? s
}

function expandAliases(text: string): string {
  return text.replace(/\$[A-Z_]{2,}/g, m => PATH_MAP[m] ? `\`${PATH_MAP[m]}\`` : m)
}

function after(line: string, prefix: string): string {
  return line.slice(prefix.length).trim()
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '').trim()
}

function titleCase(s: string): string {
  return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}
