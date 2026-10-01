// @vitest-environment node
// 엔진이 실제로 허용하는 툴 — 계산과 그 근거(openclaw 테이블)를 같이 고정한다.
// 여기서 깨지면 "프롬프트가 부르는 툴 ≠ 엔진이 허용하는 툴" 이 다시 벌어진 것이다.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_TOOL_IDS, CORE_TOOLS, buildToolsBlock, expandToolEntries,
  normalizeToolId, resolveToolPermissions, type ToolFeatureFlags,
} from './toolPermissions'
import { PRODUCT } from '../shared/product/current.generated'
import { profile as twixy } from '../products/twixy/profile'
import { profile as nodal } from '../products/nodal/profile'
import { profile as enterprise } from '../products/twixy-enterprise/profile'

const permsFor = (features: ToolFeatureFlags) => resolveToolPermissions(buildToolsBlock(features))

describe('openclaw 테이블 드리프트', () => {
  // 우리 CORE_TOOLS 는 openclaw dist 의 CORE_TOOL_DEFINITIONS 사본이다. openclaw 를 올렸는데
  // 테이블이 바뀌면 (툴 추가/프로필 변경) 조용히 틀린 답을 주므로, 여기서 먼저 깨지게 한다.
  const dir = 'node_modules/openclaw/dist'
  const file = fs.existsSync(dir)
    ? fs.readdirSync(dir).find(n => n.startsWith('tool-policy-') && n.endsWith('.js'))
    : undefined

  it('설치된 openclaw 의 정의와 id·섹션·coding 프로필 소속이 일치한다', (ctx) => {
    if (!file) return ctx.skip()   // 설치본이 없으면(CI 캐시 등) 건너뛴다
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    const body = src.slice(src.indexOf('const CORE_TOOL_DEFINITIONS'), src.indexOf('const CORE_TOOL_BY_ID'))
    const actual = body.split('id: "').slice(1).map(block => {
      const id = block.slice(0, block.indexOf('"'))
      const secAt = block.indexOf('sectionId: "')
      const section = block.slice(secAt + 'sectionId: "'.length, block.indexOf('"', secAt + 'sectionId: "'.length))
      const profAt = block.indexOf('profiles:')
      const profiles = block.slice(profAt, block.indexOf(']', profAt))
      return { id, section, coding: profiles.includes('"coding"') }
    })
    const ours = CORE_TOOLS.map(t => ({ id: t.id, section: t.section, coding: t.profiles.includes('coding') }))
    expect(actual).toEqual(ours)
  })

  it('브릿지 툴 id 가 openclaw 테이블에도 coding 프로필로 들어 있다', () => {
    for (const id of BRIDGE_TOOL_IDS) {
      const t = CORE_TOOLS.find(x => x.id === id)
      expect(t, id).toBeTruthy()
      expect(t!.profiles, id).toContain('coding')
    }
  })
})

describe('정규화 · 그룹 확장 (deny 가 취할 수 있는 형태)', () => {
  it('별칭과 대소문자', () => {
    expect(normalizeToolId('BASH')).toBe('exec')
    expect(normalizeToolId('  Apply-Patch ')).toBe('apply_patch')
    expect(normalizeToolId('web_search')).toBe('web_search')
  })

  it('group:<섹션> 은 멤버로 펼쳐진다', () => {
    expect(expandToolEntries(['group:web']).sort()).toEqual(['web_fetch', 'web_search', 'x_search'])
    expect(expandToolEntries(['group:runtime']).sort()).toEqual(['code_execution', 'exec', 'process'])
  })

  it('group:openclaw 는 그 플래그가 붙은 툴만', () => {
    const g = expandToolEntries(['group:openclaw'])
    expect(g).toContain('web_search')
    expect(g).not.toContain('read')      // read 에는 includeInOpenClawGroup 이 없다
  })

  it('모르는 group: 은 그대로 둔다 (없는 섹션을 전부로 오해하지 않게)', () => {
    expect(expandToolEntries(['group:nope'])).toEqual(['group:nope'])
  })
})

describe('deny 의 표현 형태별 판정', () => {
  const base: ToolFeatureFlags = { subagents: true, browser: true, cron: true, bridgeTools: 'all', toolsDeny: [] }

  it('정확한 id', () => {
    expect(permsFor({ ...base, toolsDeny: ['web_search'] }).allowed).not.toContain('web_search')
  })

  it('glob', () => {
    const p = permsFor({ ...base, toolsDeny: ['tool_google_*'] })
    expect(p.allowed).not.toContain('tool_google_connect')
    expect(p.allowed).toContain('tool_write_pdf')        // 같은 접두사가 아닌 것은 남는다
    expect(p.denied).toContain('tool_google_status')
  })

  it('그룹', () => {
    const p = permsFor({ ...base, toolsDeny: ['group:web'] })
    for (const id of ['web_search', 'web_fetch', 'x_search']) expect(p.allowed, id).not.toContain(id)
  })

  it('별칭 — bash 로 막아도 exec 가 막힌다', () => {
    expect(permsFor({ ...base, toolsDeny: ['bash'] }).allowed).not.toContain('exec')
  })

  it('write 를 막으면 apply_patch 도 막힌다 (openclaw 특례)', () => {
    const p = permsFor({ ...base, toolsDeny: ['write'] })
    expect(p.allowed).not.toContain('write')
    expect(p.allowed).not.toContain('apply_patch')
    expect(p.denied).toContain('apply_patch')
  })

  it('deny 는 alsoAllow 를 이긴다 — 순서가 뒤집히면 이 테스트가 깨진다', () => {
    // browser:true 면 alsoAllow 에 browser 가 들어간다. 그런데 toolsDeny 로도 막으면 결과는 거부.
    const p = permsFor({ ...base, browser: true, toolsDeny: ['browser'] })
    expect(p.policy.alsoAllow).toContain('browser')
    expect(p.policy.deny).toContain('browser')
    expect(p.allowed).not.toContain('browser')
    expect(p.denied).toContain('browser')
  })
})

describe('브릿지 툴 필터와 toolsDeny 의 합성', () => {
  const base: ToolFeatureFlags = { subagents: true, browser: true, cron: true, bridgeTools: 'all', toolsDeny: [] }

  it('bridgeTools 가 all 이면 브릿지 툴이 전부 허용', () => {
    const p = permsFor(base)
    for (const id of BRIDGE_TOOL_IDS) expect(p.allowed, id).toContain(id)
  })

  it('목록이면 목록에 없는 브릿지 툴만 deny 로 들어간다', () => {
    const p = permsFor({ ...base, bridgeTools: ['tool_write_pdf', 'tool_query_data'] })
    expect(p.allowed).toContain('tool_write_pdf')
    expect(p.allowed).toContain('tool_query_data')
    for (const id of BRIDGE_TOOL_IDS.filter(i => i !== 'tool_write_pdf' && i !== 'tool_query_data')) {
      expect(p.allowed, id).not.toContain(id)
      expect(p.denied, id).toContain(id)
    }
  })

  it('bridgeTools 로 켠 툴을 toolsDeny 가 다시 막을 수 있다 (deny 가 나중이자 우선)', () => {
    const p = permsFor({ ...base, bridgeTools: ['tool_write_pdf'], toolsDeny: ['tool_write_pdf'] })
    expect(p.allowed).not.toContain('tool_write_pdf')
    expect(p.denied).toContain('tool_write_pdf')
  })

  it('빈 목록이면 브릿지 툴이 하나도 안 남는다', () => {
    const p = permsFor({ ...base, bridgeTools: [] })
    for (const id of BRIDGE_TOOL_IDS) expect(p.allowed, id).not.toContain(id)
  })
})

// 이제 실제 프로필을 직접 읽는다. 코어의 **테스트 파일**은 제품 경계 검사에서 제외된다
// (scripts/check-product-boundary.mjs 의 isTestFile 주석 참고) — 제품별 파생을 검증하려면
// 세 제품을 다 봐야 하고, 사본 fixture 는 프로필이 바뀌면 조용히 낡기 때문이다.
describe('제품별 실제 결과', () => {
  const PRODUCTS = [
    { id: 'twixy', features: twixy.features },
    { id: 'nodal', features: nodal.features },
    { id: 'twixy-enterprise', features: enterprise.features },
  ] as const
  const permsOf = (p: { features: unknown }) => permsFor(p.features as ToolFeatureFlags)

  it('allowed 와 denied 는 절대 겹치지 않는다 (모든 제품)', () => {
    for (const p of PRODUCTS) {
      const { allowed, denied } = permsOf(p)
      expect(allowed.filter(id => denied.includes(id)), p.id).toEqual([])
    }
  })

  it('활성 제품(current.generated)도 같은 계산을 통과한다', () => {
    const { allowed, denied } = permsFor(PRODUCT.features as ToolFeatureFlags)
    expect(allowed.filter(id => denied.includes(id))).toEqual([])
    expect(allowed.length).toBeGreaterThan(0)
  })

  it('twixy — 브라우저·서브에이전트·브릿지 툴 전부 사용 가능', () => {
    const p = permsOf(PRODUCTS[0])
    for (const id of ['browser', 'canvas', 'subagents', 'sessions_spawn', 'web_search', 'web_fetch', 'exec', 'cron', 'image_generate']) {
      expect(p.allowed, id).toContain(id)
    }
    for (const id of BRIDGE_TOOL_IDS) expect(p.allowed, id).toContain(id)
    // 실행기가 없어 항상 막는 둘
    expect(p.allowed).not.toContain('code_execution')
    expect(p.allowed).not.toContain('x_search')
  })

  it('nodal — 제품이 끈 것이 전부 빠져 있다 (이 버그의 본체)', () => {
    const p = permsOf(PRODUCTS[1])
    // profile.ts 의 toolsDeny + 기능 플래그가 실제로 반영되는지
    for (const id of ['exec', 'process', 'apply_patch', 'web_search', 'web_fetch', 'image_generate',
      'tts', 'message', 'gateway', 'nodes', 'browser', 'canvas', 'subagents',
      'sessions_spawn', 'sessions_yield', 'cron']) {
      expect(p.allowed, id).not.toContain(id)
    }
    for (const id of BRIDGE_TOOL_IDS) expect(p.allowed, id).not.toContain(id)   // bridgeTools: []
    // 남아야 하는 것 — 파일 읽기/쓰기와 세션 조회는 살아 있다
    for (const id of ['read', 'write', 'edit', 'memory_search', 'session_status']) {
      expect(p.allowed, id).toContain(id)
    }
    // nodal 이 실제로 쓸 수 있는 것은 10개뿐 — 프롬프트가 이보다 많이 이름을 부르면 그게 불일치다.
    expect(p.allowed).toHaveLength(10)
  })

  it('nodal 의 toolsDeny 항목은 하나도 allowed 에 없다 (프로필을 직접 읽어 대조)', () => {
    const p = permsOf(PRODUCTS[1])
    for (const id of nodal.features.toolsDeny) expect(p.allowed, id).not.toContain(id)
  })

  it('twixy-enterprise 는 twixy 와 같은 툴 권한 (features 를 상속한다)', () => {
    expect(permsOf(PRODUCTS[2])).toEqual(permsOf(PRODUCTS[0]))
  })
})

describe('resolveToolPermissions 의 계약', () => {
  it('허용 목록은 정렬되고 중복이 없다', () => {
    const { allowed } = permsFor(twixy.features as ToolFeatureFlags)
    expect(allowed).toEqual([...allowed].sort())
    expect(new Set(allowed).size).toBe(allowed.length)
  })

  it('프로필 밖의 툴은 alsoAllow 로만 들어온다', () => {
    const base: ToolFeatureFlags = { subagents: true, browser: false, cron: true, bridgeTools: 'all', toolsDeny: [] }
    expect(permsFor(base).allowed).not.toContain('browser')                       // 안 켜면 없음
    expect(permsFor({ ...base, browser: true }).allowed).toContain('browser')      // 켜면 있음
  })

  it('모르는 툴 이름은 allowed 에 없다 — 소비자가 fail-closed 로 판단할 수 있다', () => {
    const { allowed, denied } = permsFor(twixy.features as ToolFeatureFlags)
    expect(allowed).not.toContain('totally_made_up_tool')
    expect(denied).not.toContain('totally_made_up_tool')
  })

  it('정책 원본을 같이 돌려준다 (감사용)', () => {
    const p = permsFor(nodal.features as ToolFeatureFlags)
    expect(p.policy.profile).toBe('coding')
    expect(p.policy.deny).toContain('web_search')
    expect(p.policy.alsoAllow).toContain('image_generate')   // alsoAllow 에 있어도 deny 가 이긴다
    expect(p.allowed).not.toContain('image_generate')
  })
})
