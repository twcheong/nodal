// Nodal — B2C 이미지·영상 생성 앱. Twixy 의 에이전트 코어(런타임·가드레일·크레딧·워크스페이스)
// 위에 생성 채팅 모드 + 노드 에디터 탭 + 엔진 설치 탭을 얹는다. 생성 엔진은 ./engine (twcheong/nodal
// 을 subtree 로 편입)의 로컬 서버이고, 앱이 띄우고(electron/engineManager.ts) 에이전트는 그 MCP 에 붙는다.
//
// Twixy 와 같은 PC 에 나란히 설치돼 동시에 돌 수 있어야 하므로 상태 폴더·포트·딥링크
// 스킴이 전부 다르다. 엔진이 ~/.nodal 을 쓰므로 앱 상태 폴더는 그 이름을 피한다.
import type { ProductProfile } from '../../shared/product/types'
import { ENGINE_MCP_URL } from './engineConfig'

export const profile: ProductProfile = {
  id: 'nodal',

  displayName: 'Nodal',
  wordmark: 'NODAL',
  accountName: 'Nodal',
  appId: 'com.nodal.app',
  protocolScheme: 'nodal',
  htmlEntry: 'products/nodal/index.html',
  chromeDisplayName: 'Nodal',
  workspaceSeedDir: 'products/nodal/workspace-seed',

  stateDirName: '.nodal-agent',
  stateFilePrefix: 'nodal',
  defaultWorkspaceName: 'nodal',
  appDataDirName: 'Nodal',
  gatewayPort: 18889,
  cdpPort: 18900,
  workflowCdpPorts: [],

  workspaceDirs: ['inputs', 'outputs', 'notes'],
  // workspace-seed/AGENTS.md 의 Workspace Layout 과 맞춘다.
  designatedPaths: {
    roots: ['inputs', 'outputs', 'notes'],
    allowedSubdirs: { inputs: [], outputs: [], notes: [] },
  },

  // Nodal 전용 Supabase ("Nodal Project", 서울 리전) — Twixy 와 계정·과금이 분리돼 있다.
  // 키는 publishable(공개 안전) 키다. 실제 보안은 RLS — 스키마: products/nodal/supabase/migrations.
  supabase: {
    url: 'https://vbwempftdyuuegcoqizl.supabase.co',
    anonKey: 'sb_publishable_-QLkuxg6Ub5ivWyUTggaOg_CNT2oynV',
  },
  // 웹 백엔드 — products/nodal/backend (Vercel 프로젝트 "nodal"): 로그인 핸드오프 페이지 +
  // LLM 키 발급·사용량·요금제 API. 계약: docs/BACKEND_CONTRACT.md
  // TODO(nodal-backend): 요금제 페이지와 결제는 아직 없다 (pricingUrl 비어 있음).
  webUrl: 'https://nodal-inky.vercel.app',
  pricingUrl: '',

  features: {
    browser: false,
    subagents: false,
    webSearch: false,
    channels: false,
    cron: false,
    sidetab: false,
    workflows: false,
    libreoffice: false,
    bundledSkills: false,
    bridgeTools: [],
    // 영상 앱의 에이전트가 가질 것: 워크스페이스 파일 읽기·쓰기, 이미지 보기, 메모리,
    // 그리고 Nodal MCP 툴. 셸 실행·웹·외부 이미지 생성은 B2C 앱에서 열어둘 이유가 없다
    // (엔진 문서: 이미지 생성은 nodal 내부 모델만 쓰고 외부 서비스로 대체하지 않는다).
    toolsDeny: ['exec', 'process', 'apply_patch', 'web_search', 'web_fetch', 'image_generate', 'tts', 'message', 'gateway', 'nodes'],
    builtinMcp: [
      // 주소는 engineConfig.ts 한 곳에서 — 엔진 매니저(electron/engineManager.ts)가 같은 포트로 띄운다.
      { id: 'nodal', kind: 'http', url: ENGINE_MCP_URL, transport: 'streamable-http' },
    ],
    copilotModes: ['video'],
    defaultCopilotMode: 'video',
    // 'nodes'(노드 에디터) · 'engine'(설치·모델) 은 renderer/main.tsx 가 registerProductView 로 등록한 탭.
    views: ['copilot', 'studio', 'nodes', 'data', 'engine'],
    panels: ['copilot', 'studio', 'nodes', 'data', 'engine', 'settings'],
    initialView: 'copilot',
    enterpriseAdmin: false,
    team: false,
    googleWorkspace: false,
  },

  packaging: {
    // CUDA(영상 생성)는 x64 NVIDIA 에서만 — arm64 Windows 설치 파일은 만들지 않는다.
    winArch: ['x64'],
    extraResources: [
      // 엔진 파이썬 소스 — 첫 실행 마법사가 이걸로 uv sync 하고 electron/engineManager.ts 가 띄운다.
      // 에디터(apps/web)는 앱 렌더러에 이미 번들돼 있으므로 싣지 않는다. LICENSE·NOTICE 는 Apache-2.0 의무.
      {
        from: 'products/nodal/engine',
        to: 'nodal-engine/src',
        filter: [
          'pyproject.toml', 'uv.lock', 'LICENSE', 'NOTICE', 'NOTICE-provenance.md',
          'packages/**/*', 'examples/templates/**/*', 'examples/sample*.png',   // 템플릿 하네스의 예시 입력
          '!**/tests/**', '!**/__pycache__/**', '!**/.venv/**', '!**/*.egg-info/**',
        ],
      },
      // uv 실행 파일 — scripts/fetch-uv.mjs 가 tmp/nodal-uv 에 받아 둔다 (npm run prepare:nodal-uv).
      { from: 'tmp/nodal-uv', to: 'nodal-engine', filter: ['uv', 'uv.exe'] },
    ],
  },
}
