// WF 노드 디자인 표준 — 기존 앱 디자인을 그대로 표준으로 등재한 문서.
// ★ 이 디자인은 변경 대상이 아니다. 마이그레이션/리브랜딩 시에도 노드 도형·
//   타입 색·상태 색·HoverTip 툴팁은 아래 원본 스펙을 따른다.
// 원본 소스: src/lib/workflowTools.ts (nodeShapeFor),
//   src/components/orchestration/OrchestrationMemberCard.tsx (MiniShape, TYPE_ACCENT, STATUS_COLOR, Port),
//   src/components/orchestration/HoverTip.tsx (HoverTip + TipBody — ui/Tooltip으로 통합 금지)
import type { ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { HoverTip, TipBody } from '../../components/orchestration/HoverTip'

// ── OrchestrationMemberCard.tsx의 MiniShape 재현 (s=20, strokeWidth 1.4) ──
function MiniShape({ shape, order, stroke }: { shape: 'circle' | 'triangle' | 'square'; order: number; stroke: string }) {
  const s = 20
  return (
    <div style={{ width: s, height: s, flexShrink: 0, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ position: 'absolute', inset: 0 }}>
        {shape === 'circle' && <circle cx={s / 2} cy={s / 2} r={s / 2 - 1.5} fill="none" stroke={stroke} strokeWidth={1.4} />}
        {shape === 'triangle' && <polygon points={`${s / 2},1.5 ${s - 1.5},${s - 1.5} 1.5,${s - 1.5}`} fill="none" stroke={stroke} strokeWidth={1.4} />}
        {shape === 'square' && <rect x={2} y={2} width={s - 4} height={s - 4} fill="none" stroke={stroke} strokeWidth={1.4} rx={2} />}
      </svg>
      <span style={{ position: 'relative', fontSize: 9, fontWeight: 600, color: stroke, marginTop: shape === 'triangle' ? 4 : 0 }}>{order}</span>
    </div>
  )
}

// nodeShapeFor + TYPE_ACCENT — 노드 타입 → 도형·색 매핑 (원본 그대로)
const NODE_TYPES = [
  { type: 'action', shape: 'circle', accent: 'var(--accent)', tag: 'Tool', desc: '도구 실행 노드 — 원형, accent 보라' },
  { type: 'review', shape: 'triangle', accent: '#f59e0b', tag: 'Human Review', desc: '사람 검토 노드 — 삼각형, amber' },
  { type: 'validation', shape: 'square', accent: '#10b981', tag: 'Validation', desc: '검증 노드 — 사각형, green' },
] as const

// STATUS_COLOR — 실행 상태 색 (원본 그대로)
const STATUSES = [
  { key: 'pending', color: 'var(--text-muted)' },
  { key: 'running', color: 'var(--accent)' },
  { key: 'done', color: '#3fb950' },
  { key: 'failed', color: '#f85149' },
  { key: 'aborted', color: '#d29922' },
  { key: 'skipped', color: 'var(--text-muted)' },
] as const

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6, marginBottom: 12 }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function WorkflowNodesPage() {
  return (
    <div style={{ fontFamily: 'var(--font-sans)', color: 'var(--text-primary)', maxWidth: 720 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Workflow Nodes — 표준 (기존 디자인)</h1>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 24 }}>
        WF 노드 관련 UI는 <b>기존 앱 디자인이 표준</b>이다. 도형·타입 색·상태 색·툴팁(HoverTip)은
        아래 스펙 그대로 유지하며, atoms 마이그레이션·리브랜딩 대상에서 제외한다.
      </p>

      <Section title="노드 타입 → 도형 매핑 (nodeShapeFor)">
        {NODE_TYPES.map((n, i) => (
          <div key={n.type} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
            <MiniShape shape={n.shape} order={i + 1} stroke={n.accent} />
            <code style={{ fontSize: 11, color: n.accent, fontFamily: 'var(--font-mono)', fontWeight: 600, minWidth: 100 }}>[{n.tag}]</code>
            <code style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 130 }}>type: {n.type}</code>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{n.desc}</span>
          </div>
        ))}
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, fontFamily: 'var(--font-mono)' }}>
          spec: 20×20 SVG, stroke 1.4, fill none, 중앙에 순번(9px/600) — square는 rx 2
        </div>
      </Section>

      <Section title="실행 상태 색 (STATUS_COLOR)">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {STATUSES.map((s) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color }} />
              <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{s.key}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="포트 (Port) — 상단 in / 하단 out">
        <div style={{ width: 240, border: '1px solid var(--border-subtle)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 10px', background: 'var(--bg-base)', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
            <span style={{ fontSize: 8.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>topic list</span>
          </div>
          <div style={{ padding: '10px 10px', fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-surface)' }}>…node body…</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 10px', background: 'var(--bg-base)', borderTop: '1px solid var(--border-subtle)' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3fb950', flexShrink: 0 }} />
            <span style={{ fontSize: 8.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>draft posts</span>
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, fontFamily: 'var(--font-mono)' }}>
          in 포트 점 = var(--accent) · out 포트 점 = #3fb950 · 점 5px · 라벨 8.5px uppercase
        </div>
      </Section>

      <Section title="노드 툴팁 — HoverTip + TipBody (ui/Tooltip으로 통합 금지)">
        <div style={{ display: 'flex', gap: 20 }}>
          <HoverTip side="bottom" content={<TipBody heading="Input" lines={['topics: 5 items', 'source: data/topics.csv']} accent="var(--accent)" />} style={{ display: 'inline-flex' }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', cursor: 'default' }}>
              hover me (in)
            </span>
          </HoverTip>
          <HoverTip side="bottom" content={<TipBody heading="Output" lines={['posts: 12 items', 'format: markdown']} accent="#3fb950" />} style={{ display: 'inline-flex' }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', cursor: 'default' }}>
              hover me (out)
            </span>
          </HoverTip>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, fontFamily: 'var(--font-mono)' }}>
          spec: portal fixed, minWidth 160 / maxWidth 320, bg-elevated, radius 6, shadow 0 4px 16px rgba(0,0,0,.45)
        </div>
      </Section>
    </div>
  )
}

const meta: Meta<typeof WorkflowNodesPage> = {
  title: 'Foundation/Workflow Nodes (standard)',
  component: WorkflowNodesPage,
}
export default meta

export const All: StoryObj<typeof WorkflowNodesPage> = {}
