// UI 인벤토리 — 앱에 실제로 존재하는 버튼 스타일 현황 (as-is 조사 자료).
// 스타일 객체는 소스에서 그대로 복사한 것 (ternary는 기본/활성 분기로 고정).
// 목적: 디자이너와 "지금 이렇게 제각각이다 → 무엇으로 통일할까" 논의.
// 통일 대상(to-be)은 Atoms/Button 참고. Phase 2에서 이 페이지의 버튼들을
// atoms로 마이그레이션하면서 클러스터를 하나씩 지워나간다.
import type { CSSProperties, ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

type Sample = { label: ReactNode; style: CSSProperties }
type Cluster = {
  name: string
  count: string
  source: string
  note?: string
  samples: Sample[]
}

const clusters: Cluster[] = [
  {
    name: '1. Accent Filled CTA (primary)',
    count: '~45',
    source: 'SettingsPanel.tsx:1140 외 (TwixyEnterpriseDashboard, GuardrailModal, OrchestrationCanvas…)',
    note: 'padding 6종·radius 4종(6/7/sm/–)이 혼재. → Atoms/Button variant="primary"로 통일 대상',
    samples: [
      {
        label: 'Save channels',
        style: { padding: '8px 20px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
      },
      {
        label: 'Approve',
        style: { padding: '8px 16px', background: 'var(--accent, #0d5c50)', border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
      },
      {
        label: '▶ Run',
        style: { background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: 12, fontWeight: 600, padding: '6px 14px', cursor: 'pointer' },
      },
    ],
  },
  {
    name: '2. Subtle Bordered Secondary',
    count: '~55',
    source: 'DataPanel.tsx:1493, OrchestrationCanvas.tsx:988, WorkflowNodeCard.tsx:661, ChatPanel.tsx:1350',
    note: '가장 많은 비-primary. hover는 onMouseEnter로 accent 보더 (인라인 JS). → variant="secondary"',
    samples: [
      {
        label: 'Cancel',
        style: { padding: '7px 16px', background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' },
      },
      {
        label: 'Reset',
        style: { background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: 12, padding: '6px 12px', cursor: 'pointer' },
      },
      {
        label: '✦ Suggest a skill',
        style: { border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 11, cursor: 'pointer', textAlign: 'center' },
      },
    ],
  },
  {
    name: '3. Surface Bordered Secondary',
    count: '~20',
    source: 'workflow/ShareWorkflowButton.tsx:204, RunsDashboard.tsx:450, MergeRequestPanel.tsx:682',
    samples: [
      {
        label: 'Share to team',
        style: { border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text)', borderRadius: 7, padding: '5px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
      },
      {
        label: 'Refresh',
        style: { padding: '6px 14px', fontSize: 12, fontWeight: 500, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', color: 'var(--text-primary)', cursor: 'pointer' },
      },
    ],
  },
  {
    name: '4. Ghost Text Button',
    count: '~40',
    source: 'ChatPanel.tsx:1955, SkillsPanel.tsx:1190, TwixyEnterpriseDashboard.tsx:586',
    note: '→ variant="ghost"',
    samples: [
      {
        label: 'Open in Finder',
        style: { border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, padding: '4px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer' },
      },
      {
        label: 'View details',
        style: { padding: '3px 8px', background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', fontWeight: 600 },
      },
    ],
  },
  {
    name: '5. Icon-Only Square',
    count: '~30',
    source: 'ChatPanel.tsx:1808(전송), DashboardPanel.tsx:546, SkillsPanel.tsx:556',
    note: '22/24/28/36px 크기 혼재. → IconButton (sm 24 / md 30)으로 통일 대상',
    samples: [
      {
        label: '↑',
        style: { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0, transition: 'background 0.15s' },
      },
      {
        label: '■',
        style: { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--bg-active)', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 },
      },
      {
        label: '📌',
        style: { width: 22, height: 22, borderRadius: 4, border: 'none', background: 'var(--bg-hover)', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      },
    ],
  },
  {
    name: '6. Bare Glyph Close/Dismiss',
    count: '~35',
    source: 'copilot/CopilotView.tsx:993, WorkflowView.tsx:649, TeamDashboardPanel.tsx:1169',
    note: '박스 없이 글리프만. hover 시 빨간색 전환하는 곳도 있음 (CopilotView:1456)',
    samples: [
      {
        label: '×',
        style: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '0 2px', flexShrink: 0 },
      },
      {
        label: '＋',
        style: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' },
      },
      {
        label: '⟳',
        style: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: 2 },
      },
    ],
  },
  {
    name: '7. Pill / Tag Chip',
    count: '~15',
    source: 'copilot/CopilotView.tsx:2286, TeamDashboardPanel.tsx:327·1030, DataPanel.tsx:1040',
    note: 'radius 999/20 혼재, active/dashed 분기. → Badge 또는 별도 Chip atom 후보',
    samples: [
      {
        label: '⚡ Simple',
        style: { padding: '3px 10px', fontSize: 11, fontFamily: 'var(--font-mono)', color: '#fff', background: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 999, cursor: 'pointer', lineHeight: 1.5, fontWeight: 600 },
      },
      {
        label: '◇ Workflow',
        style: { padding: '3px 10px', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 999, cursor: 'pointer', lineHeight: 1.5 },
      },
      {
        label: '+ tag',
        style: { display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', borderRadius: 20, padding: '1px 9px', fontSize: 10, cursor: 'pointer' },
      },
    ],
  },
  {
    name: '8. Tab-Like Segmented Toggle',
    count: '~25',
    source: 'DataPanel.tsx:1127 (Preview/Edit/Table/Raw), copilot/CopilotView.tsx:2296, MergeRequestPanel.tsx:219',
    note: 'active = accent-dim 배경 + accent 텍스트. → Molecule(Tabs/SegmentedControl) 후보',
    samples: [
      {
        label: 'Preview',
        style: { border: 'none', background: 'var(--accent-dim)', color: 'var(--accent)', borderRadius: 'var(--radius-sm)', padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600 },
      },
      {
        label: 'Edit',
        style: { border: 'none', background: 'var(--bg-hover)', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', padding: '3px 10px', fontSize: 11, cursor: 'pointer' },
      },
      {
        label: '⚠ Report',
        style: { padding: '4px 9px', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', background: 'var(--bg-active)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', lineHeight: 1.4 },
      },
    ],
  },
  {
    name: '9. Danger / Red',
    count: '~18',
    source: 'GuardrailModal.tsx:302, copilot/CopilotView.tsx:1520, SkillsPanel.tsx:1045, SettingsPanel.tsx:585',
    note: 'red 표현이 var(--danger) / var(--danger) / var(--red) / var(--danger) 4종. → variant="danger" + --danger 토큰',
    samples: [
      {
        label: 'Deny (Esc)',
        style: { padding: '8px 14px', background: 'transparent', border: '1px solid var(--danger)', borderRadius: 6, color: 'var(--danger)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
      },
      {
        label: '■ Stop',
        style: { background: 'var(--red, #b5482f)', border: 'none', borderRadius: 'var(--radius-md)', color: '#fff', fontSize: 13, fontWeight: 600, padding: '10px 18px', cursor: 'pointer' },
      },
      {
        label: 'Sign out',
        style: { padding: '6px 14px', background: 'transparent', border: 'none', color: 'var(--red, #b5482f)', fontSize: 12, cursor: 'pointer' },
      },
    ],
  },
  {
    name: '10. Semantic Status (green/blue/amber)',
    count: '~14',
    source: 'workflow/WorkflowNodeCard.tsx:649, copilot/CopilotView.tsx:1344·2126, NodeCanvas.tsx:476',
    note: 'green이 var(--accent)/var(--accent)/var(--accent) 혼재. 알파 합성(#0d5c501a) 틴트 변형도 있음',
    samples: [
      {
        label: '✅ Approve',
        style: { background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
      },
      {
        label: '▶ Start',
        style: { display: 'inline-flex', alignItems: 'center', background: '#0d5c501a', border: '1px solid #0d5c5059', color: 'var(--accent)', borderRadius: 'var(--radius-sm)', padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
      },
      {
        label: '⟲ Resume',
        style: { display: 'inline-flex', alignItems: 'center', background: '#b07d181a', border: '1px solid #b07d1859', color: 'var(--warning)', borderRadius: 'var(--radius-sm)', padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
      },
    ],
  },
  {
    name: '11. Full-Width List Row',
    count: '~30',
    source: 'DataPanel.tsx:276 (컨텍스트 메뉴), ChatPanel.tsx:1300 (히스토리), TeamDashboardPanel.tsx:1388',
    note: 'hover 시 bg-hover — 전부 onMouseEnter 인라인 JS. → Molecule(MenuItem/ListRow) 후보',
    samples: [
      {
        label: 'Ask about this',
        style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 12px', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, textAlign: 'left', cursor: 'pointer', borderRadius: 'var(--radius-sm)' },
      },
      {
        label: 'Delete file',
        style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 12px', border: 'none', background: 'transparent', color: 'var(--danger)', fontSize: 12, textAlign: 'left', cursor: 'pointer', borderRadius: 'var(--radius-sm)' },
      },
    ],
  },
  {
    name: '12. Card-as-Button',
    count: '~4',
    source: 'SkillsPanel.tsx:672 (스킬 카드), ChatPanel.tsx:1517 (추천 액션)',
    note: 'hover는 React state로 보더/그림자 전환. → Molecule(Card) 후보',
    samples: [
      {
        label: 'Suggested action card…',
        style: { background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '10px 12px', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s, border-color 0.15s' },
      },
    ],
  },
  {
    name: '13. Accent-Outlined Empty-State CTA',
    count: '~4',
    source: 'ChatPanel.tsx:1166, copilot/CopilotView.tsx:1051, orchestration/AgentPicker.tsx:37',
    samples: [
      {
        label: 'Choose Project Folder',
        style: { padding: '3px 10px', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', borderRadius: 'var(--radius-sm)', fontSize: 11, cursor: 'pointer', fontWeight: 600 },
      },
      {
        label: 'Add',
        style: { border: '1px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)', borderRadius: 'var(--radius-sm)', fontSize: 11, padding: '2px 8px', cursor: 'pointer' },
      },
    ],
  },
  {
    name: '14. Dashed Add/Insert',
    count: '~3',
    source: 'SkillsPanel.tsx:469, workflow/WorkflowNodeCard.tsx:232',
    samples: [
      {
        label: '+ Add step',
        style: { padding: '7px 14px', borderRadius: 6, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' },
      },
      {
        label: '＋',
        style: { width: 22, height: 22, padding: 0, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '50%', cursor: 'pointer' },
      },
    ],
  },
  {
    name: '15. Badge / Path Button',
    count: '~6',
    source: 'ChatPanel.tsx:1139·1186·1219, workflow/NodeCanvas.tsx:154',
    samples: [
      {
        label: '📁 my-project',
        style: { display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', fontSize: 11, cursor: 'pointer', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      },
      {
        label: '+ New Chat',
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)', fontSize: 11, cursor: 'pointer' },
      },
    ],
  },
  {
    name: '16. Mono Micro-Badge / Raw Toggle',
    count: '~10',
    source: 'ChatPanel.tsx:296, workflow/WorkflowNodeCard.tsx:122·524, SettingsPanel.tsx:1275',
    samples: [
      {
        label: 'Raw',
        style: { border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, padding: '1px 5px', borderRadius: 3, cursor: 'pointer', fontFamily: 'var(--font-mono)', opacity: 0.5 },
      },
      {
        label: '⟲ from here',
        style: { border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)', padding: '1px 7px', cursor: 'pointer' },
      },
    ],
  },
  {
    name: '17. Reveal-on-Hover Message Action',
    count: '~6',
    source: 'ChatPanel.tsx:183 (복사/재시도), orchestration/OrchestrationCanvas.tsx:506',
    note: '평소 opacity 0, 부모 row hover 시 1. 여기선 보이도록 opacity 1로 고정 렌더',
    samples: [
      {
        label: '⧉ Copy',
        style: { border: 'none', background: 'transparent', color: 'var(--text-muted)', height: 24, minWidth: 24, borderRadius: 5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', fontSize: 10, whiteSpace: 'nowrap' },
      },
    ],
  },
  {
    name: '18. Vertical Rail Toggle',
    count: '1',
    source: 'WorkflowListsPanel.tsx:101',
    note: '원본 코드에서 borderLeft가 border:none보다 먼저 선언돼 무효화됨 (버그성 코드, 그대로 재현)',
    samples: [
      {
        label: '◀ Workflows',
        style: { width: 24, height: 110, background: 'var(--bg-surface)', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10, writingMode: 'vertical-rl', padding: '12px 0' },
      },
    ],
  },
  {
    name: '19. Green "Saved" Success State',
    count: '~4',
    source: 'SettingsPanel.tsx:1345, DataPanel.tsx:1176, TeamDashboardPanel.tsx:1104',
    samples: [
      {
        label: '✓ Saved — restart app to apply',
        style: { padding: '10px 28px', background: '#0d5c5022', color: 'var(--accent)', border: '1px solid #0d5c5044', borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' },
      },
    ],
  },
  {
    name: '20. Disclosure / Collapsible Header',
    count: '~8',
    source: 'ChatPanel.tsx:471·415',
    samples: [
      {
        label: '◎ Context files ▼',
        style: { display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', width: 260, textAlign: 'left' },
      },
    ],
  },
]

function InventoryPage() {
  return (
    <div style={{ fontFamily: 'var(--font-sans)', color: 'var(--text-primary)', maxWidth: 860 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Button Inventory (as-is)</h1>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 8 }}>
        앱에 실제 존재하는 raw <code>&lt;button&gt;</code> ~346개를 20개 유형으로 클러스터링한 현황.
        스타일은 소스에서 그대로 복사했다. 통일 목표(to-be)는 <b>Atoms/Button</b> 참고.
      </p>
      <div
        style={{
          fontSize: 11,
          color: 'var(--warning)',
          background: 'rgba(176, 125, 24, 0.08)',
          border: '1px solid rgba(176, 125, 24, 0.25)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
          marginBottom: 24,
          lineHeight: 1.7,
        }}
      >
        현재 산재 정도 — radius <b>12종</b> (3·4·5·6·7·8·10·12·20·999·50%·var), 폰트 크기{' '}
        <b>11종</b> (9~16px), accent 표현 <b>4종</b>, red 표현 <b>4종</b>, hover 구현 <b>3방식</b>{' '}
        (DOM 직접 변경 / React state / 없음)
      </div>

      {clusters.map((c) => (
        <section key={c.name} style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
            <h2 style={{ fontSize: 13, fontWeight: 700 }}>{c.name}</h2>
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>{c.count}개</span>
          </div>
          <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginBottom: 6 }}>
            {c.source}
          </div>
          {c.note && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>{c.note}</div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
              padding: 14,
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            {c.samples.map((s, i) => (
              <button key={i} style={s.style}>
                {s.label}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

const meta: Meta<typeof InventoryPage> = {
  title: 'Inventory/Buttons (as-is)',
  component: InventoryPage,
}
export default meta

export const All: StoryObj<typeof InventoryPage> = {}
