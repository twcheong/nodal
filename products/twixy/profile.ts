// Twixy — 마케팅 에이전시용 풀 제품. 모든 기능이 켜져 있다.
import type { ProductProfile } from '../../shared/product/types'

export const profile: ProductProfile = {
  id: 'twixy',

  displayName: 'Twixy',
  wordmark: 'TWIXY',
  accountName: 'Twixy Marketing Copilot',
  appId: 'com.twixy.app',
  protocolScheme: 'twixy',
  htmlEntry: 'index.html',
  chromeDisplayName: 'Twixy',
  workspaceSeedDir: '',

  stateDirName: '.openclaw',
  stateFilePrefix: 'twixy',
  defaultWorkspaceName: 'twixy',
  appDataDirName: 'Twixy',
  gatewayPort: 18789,
  cdpPort: 18800,
  workflowCdpPorts: [18801, 18802, 18803],

  workspaceDirs: [
    'data/raw', 'data/insights', 'data/saved', 'data/watches',
    'strategies', 'campaigns', 'reports', 'exports', 'skills',
  ],
  // SYNC: electron/tsl-compiler.ts 의 PATH_MAP($RAW 등)과 1:1 — 어긋나면 스킬이 안내하는
  // 경로와 쓰기 가드가 막는 경로가 달라진다.
  designatedPaths: {
    roots: ['data/raw', 'data/insights', 'strategies', 'content/drafts', 'content/published', 'data/reports'],
    allowedSubdirs: {
      'data/raw':          ['instagram', 'youtube', 'tiktok', 'twitter'],
      'data/insights':     [],
      'strategies':        [],
      'content/drafts':    [],
      'content/published': [],
      'data/reports':      [],
    },
  },

  supabase: {
    url: 'https://mooltalmugrwzkvvawip.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vb2x0YWxtdWdyd3prdnZhd2lwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMTI0NDYsImV4cCI6MjA4ODU4ODQ0Nn0.QC_DQtuRXfYpLxvlghDqHfgn57sobFpjU_6c4IK57YE',
  },
  webUrl: 'https://www.twixy.dev',
  pricingUrl: 'https://twixy.dev/pricing',

  features: {
    browser: true,
    subagents: true,
    webSearch: true,
    channels: true,
    cron: true,
    sidetab: true,
    workflows: true,
    libreoffice: true,
    bundledSkills: true,
    bridgeTools: 'all',
    toolsDeny: [],
    builtinMcp: [],
    copilotModes: ['simple', 'wf', 'content'],
    defaultCopilotMode: 'wf',
    // MVP: chat(legacy) / orchestration / skills / mr / admin 은 사이드바에서 숨긴다
    // (가드레일은 Settings 로 이동). 패널은 계속 마운트 — 복구하려면 views 에 id 를 넣는다.
    views: ['copilot', 'workflow', 'dashboard', 'data'],
    panels: ['copilot', 'chat', 'workflow', 'orchestration', 'dashboard', 'data', 'skills', 'mr', 'admin', 'settings'],
    initialView: 'copilot',
    enterpriseAdmin: false,
    team: true,
    googleWorkspace: true,
  },
}
