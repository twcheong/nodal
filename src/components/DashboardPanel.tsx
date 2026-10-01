// ═════════════════════════════════════════════════════════════════════════════
// DashboardPanel.tsx — 자연어로 차트를 그리는 위젯 빌더 패널.
//
// 플로우:
//   1) 사용자가 자연어로 "인스타 포스트별 engagement rate 막대 그래프" 같이 요청
//   2) useDashboardClaw.requestWidget 을 호출해 전용 세션에 전송
//   3) AI 응답에서 ```widget-spec JSON 블록을 파싱 → WidgetSpec 검증
//   4) PreviewCard 로 미리 보여주고, 사용자가 "Pin" 하면 저장 + WidgetCard 로 본 패널에 배치
//   5) 위젯은 localStorage 에 지속 저장 (STORAGE_KEY) — 앱 재기동 후에도 복원
//
// 차트 타입: bar / line / pie / donut / number / table / image.
// 외부 차트 라이브러리 없이 순수 SVG 로 직접 그린다 (번들 크기 최소화).
//
// 주요 내부:
//   · validateSpec    — AI 응답 검증, 잘못된 스키마면 에러 메시지(string) 반환
//   · parseAIResponse — 응답 텍스트에서 widget-spec JSON 블록 추출 + 검증
//   · BarChart/LineChart/PieChart/NumberCard/TableChart/ImageCard — SVG 렌더러
//   · WidgetCard      — 저장된(핀 고정) 위젯 카드 (삭제/핀 해제 컨트롤 포함)
//   · PreviewCard     — 핀 되기 전 미리보기 카드
// ═════════════════════════════════════════════════════════════════════════════

import { useState, useCallback, useEffect, useRef, Fragment } from 'react'
import { buildTable, type TableData } from './DataPanel'

// ── Widget spec types — AI 응답 JSON 의 타입 스키마 ───────────────────────────

export type ChartType = 'bar' | 'line' | 'pie' | 'donut' | 'number' | 'table' | 'image'

export interface WidgetSeries {
  name:   string
  data:   number[]
  color?: string
}

export interface WidgetSpec {
  id:        string
  type:      ChartType
  title:     string
  subtitle?: string
  labels:    string[]
  series:    WidgetSeries[]
  unit?:     string
  prompt:    string
  insight?:  string   // AI's 1-sentence explanation
  createdAt: string
  // Pinning + provenance for the auto-board feature
  pinned?:   boolean
  source?:   { kind: 'auto' | 'manual'; filePath?: string }
  table?:    TableData              // for ChartType === 'table'
  imageSrc?: string                  // data URL, for ChartType === 'image'
}

// ── Palette — 시리즈 기본 색상 목록 ──────────────────────────────────────────
// spec.series[i].color 가 명시되지 않으면 idx 로 PALETTE 를 순환 사용.

const PALETTE = [
  '#6366f1', '#ec4899', '#14b8a6', 'var(--danger)',
  '#a855f7', 'var(--accent)', 'var(--accent)', 'var(--warning)',
]

function seriesColor(series: WidgetSeries, idx: number): string {
  return series.color ?? PALETTE[idx % PALETTE.length]
}

// ── Widget spec validator — AI 응답 JSON 의 필드 검증 ──────────────────────
// 성공 시 완전한 WidgetSpec 반환, 실패 시 사람 읽기 쉬운 에러 문자열 반환.
// 파싱 실패/스키마 불일치는 이 함수에서 전부 걸러내 렌더러는 안심하고 spec 을 써도 됨.

const MAX_LABELS: Record<ChartType, number> = {
  bar: 30, line: 50, pie: 8, donut: 8, number: 1, table: 1000, image: 1,
}

function validateSpec(raw: unknown, prompt: string, insight?: string): WidgetSpec | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Response is not an object'
  const s = raw as Record<string, unknown>

  const VALID_TYPES: ChartType[] = ['bar', 'line', 'pie', 'donut', 'number']
  if (!VALID_TYPES.includes(s.type as ChartType)) return `Unknown chart type: "${s.type}"`

  if (typeof s.title !== 'string' || !s.title.trim()) return 'Missing title'
  if (s.title.length > 120) return 'Title too long (max 120 chars)'

  if (!Array.isArray(s.labels)) return '"labels" must be an array'
  if (!Array.isArray(s.series) || s.series.length === 0) return '"series" must be a non-empty array'
  if (s.series.length > 10) return 'Too many series (max 10)'

  const type = s.type as ChartType
  const labels = (s.labels as unknown[]).map(String)

  if (labels.length > MAX_LABELS[type])
    return `Too many labels for ${type} chart (max ${MAX_LABELS[type]})`

  const series: WidgetSeries[] = []
  for (let i = 0; i < (s.series as unknown[]).length; i++) {
    const sr = (s.series as unknown[])[i]
    if (!sr || typeof sr !== 'object' || Array.isArray(sr)) return `series[${i}] is not an object`
    const s2 = sr as Record<string, unknown>

    if (!Array.isArray(s2.data)) return `series[${i}].data must be an array`
    const data = (s2.data as unknown[]).map(Number)
    if (data.some(n => !isFinite(n))) return `series[${i}].data contains non-numeric values`

    if (type !== 'number' && labels.length > 0 && data.length !== labels.length)
      return `series[${i}].data length (${data.length}) ≠ labels length (${labels.length})`

    series.push({
      name:  String(s2.name ?? `Series ${i + 1}`),
      data,
      color: typeof s2.color === 'string' ? s2.color : undefined,
    })
  }

  return {
    id:        crypto.randomUUID(),
    type,
    title:     s.title.trim(),
    subtitle:  typeof s.subtitle === 'string' ? s.subtitle.trim() : undefined,
    labels,
    series,
    unit:      typeof s.unit === 'string' ? s.unit : undefined,
    prompt,
    insight,
    createdAt: new Date().toISOString(),
  }
}

// AI 응답 텍스트에서 ```widget-spec JSON 블록을 정규식으로 추출 후 validateSpec 에 넘김.
// 블록이 없으면 에러 문자열 반환.
function parseAIResponse(text: string, prompt: string): WidgetSpec | string {
  const match = text.match(/```widget-spec\s*\n([\s\S]*?)\n```/)
  if (!match) return 'No widget-spec block found in response'

  let raw: unknown
  try { raw = JSON.parse(match[1]) }
  catch { return 'widget-spec JSON is malformed' }

  // Extract the insight sentence (text after the closing ```)
  const afterBlock = text.slice(text.indexOf('```', match.index! + 3) + 3).trim()
  const insight = afterBlock.split('\n')[0].trim() || undefined

  return validateSpec(raw, prompt, insight)
}

// ── Storage helpers — 핀 고정한 위젯을 localStorage 에 영속 저장 ─────────────

const STORAGE_KEY = 'twixy_dashboard_widgets'

function loadWidgets(): WidgetSpec[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as WidgetSpec[]) : []
  } catch { return [] }
}

function saveWidgets(widgets: WidgetSpec[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets)) } catch { /* ignore */ }
}

// ── SVG chart renderers — 외부 차트 라이브러리 없이 직접 그리는 순수 SVG ──
// 공통 좌표계: viewBox 0 0 SVG_W SVG_H, PAD 마진 적용, CW/CH 는 실제 플롯 영역 크기.
// 가격/번들 크기 최소화 목적. 고도 인터랙션이 필요해지면 recharts 등으로 교체 고려.

const SVG_W = 340
const SVG_H = 180
const PAD   = { top: 18, right: 16, bottom: 36, left: 38 }
const CW    = SVG_W - PAD.left - PAD.right   // 286
const CH    = SVG_H - PAD.top  - PAD.bottom  // 126

// 값을 Y 좌표(픽셀)로 변환. maxVal=0 이면 0 반환해 NaN 방지.
function yPos(val: number, maxVal: number) {
  return PAD.top + CH - (maxVal === 0 ? 0 : (val / maxVal) * CH)
}

// 큰 숫자를 K/M 단위로 축약 (1234 → "1.2K"). 축 레이블에서 사용.
function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n % 1 === 0 ? String(n) : n.toFixed(1)
}

// ─ Bar chart ─────────────────────────────────────────────────────────────────

function BarChart({ spec }: { spec: WidgetSpec }) {
  const allData = spec.series.flatMap(s => s.data)
  const maxVal  = Math.max(...allData, 0) * 1.05

  const N  = spec.labels.length
  const M  = spec.series.length
  const groupW = N > 0 ? CW / N : CW
  const gap    = Math.max(groupW * 0.15, 2)
  const barW   = Math.max((groupW - gap * (M + 1)) / M, 2)

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y:   PAD.top + CH * (1 - t),
    val: fmt(maxVal * t),
  }))

  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} style={{ width: '100%', height: 'auto' }}>
      {/* Gridlines */}
      {gridLines.map(({ y, val }, i) => (
        <g key={i}>
          <line x1={PAD.left} y1={y} x2={PAD.left + CW} y2={y}
            stroke="var(--border-subtle)" strokeWidth={0.5} strokeDasharray={i === 0 ? 'none' : '3 3'} />
          <text x={PAD.left - 4} y={y + 3.5} textAnchor="end"
            fontSize={8} fill="var(--text-muted)">{val}</text>
        </g>
      ))}

      {/* Bars */}
      {spec.series.map((s, si) =>
        s.data.map((val, li) => {
          const bh = maxVal === 0 ? 0 : (val / maxVal) * CH
          const x  = PAD.left + li * groupW + gap + si * (barW + gap / M)
          const y  = PAD.top + CH - bh
          return (
            <rect key={`${si}-${li}`} x={x} y={y} width={barW} height={bh}
              fill={seriesColor(s, si)} rx={2} opacity={0.9}>
              <title>{val}{spec.unit ?? ''}</title>
            </rect>
          )
        })
      )}

      {/* X-axis labels */}
      {spec.labels.map((label, i) => (
        <text key={i}
          x={PAD.left + (i + 0.5) * groupW}
          y={PAD.top + CH + 13}
          textAnchor="middle"
          fontSize={N > 12 ? 6 : 8}
          fill="var(--text-muted)">
          {label.length > 8 ? label.slice(0, 7) + '…' : label}
        </text>
      ))}

      {/* Legend (if multiple series) */}
      {M > 1 && spec.series.map((s, i) => (
        <g key={i} transform={`translate(${PAD.left + i * 80}, ${SVG_H - 8})`}>
          <rect width={8} height={8} rx={1} fill={seriesColor(s, i)} />
          <text x={11} y={7.5} fontSize={7} fill="var(--text-muted)">{s.name}</text>
        </g>
      ))}
    </svg>
  )
}

// ─ Line chart ─────────────────────────────────────────────────────────────────

function LineChart({ spec }: { spec: WidgetSpec }) {
  const allData = spec.series.flatMap(s => s.data)
  const maxVal  = Math.max(...allData, 0) * 1.1
  const minVal  = Math.min(...allData, 0)
  const range   = maxVal - minVal || 1

  const N = spec.labels.length

  function xPos(i: number) {
    return PAD.left + (N <= 1 ? CW / 2 : (i / (N - 1)) * CW)
  }
  function yPosLine(val: number) {
    return PAD.top + CH - ((val - minVal) / range) * CH
  }

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y:   PAD.top + CH * (1 - t),
    val: fmt(minVal + range * t),
  }))

  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} style={{ width: '100%', height: 'auto' }}>
      <defs>
        {spec.series.map((s, si) => (
          <linearGradient key={si} id={`lg-${spec.id}-${si}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={seriesColor(s, si)} stopOpacity={0.3} />
            <stop offset="100%" stopColor={seriesColor(s, si)} stopOpacity={0}   />
          </linearGradient>
        ))}
      </defs>

      {/* Gridlines */}
      {gridLines.map(({ y, val }, i) => (
        <g key={i}>
          <line x1={PAD.left} y1={y} x2={PAD.left + CW} y2={y}
            stroke="var(--border-subtle)" strokeWidth={0.5} strokeDasharray={i === 0 ? 'none' : '3 3'} />
          <text x={PAD.left - 4} y={y + 3.5} textAnchor="end"
            fontSize={8} fill="var(--text-muted)">{val}</text>
        </g>
      ))}

      {/* Fill + line per series */}
      {spec.series.map((s, si) => {
        const pts  = s.data.map((v, i) => `${xPos(i)},${yPosLine(v)}`).join(' ')
        const fill = [
          `${xPos(0)},${PAD.top + CH}`,
          pts,
          `${xPos(s.data.length - 1)},${PAD.top + CH}`,
        ].join(' ')
        const color = seriesColor(s, si)
        return (
          <g key={si}>
            <polygon points={fill} fill={`url(#lg-${spec.id}-${si})`} />
            <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
            {s.data.map((v, i) => (
              <circle key={i} cx={xPos(i)} cy={yPosLine(v)} r={2.5} fill={color}>
                <title>{spec.labels[i]}: {v}{spec.unit ?? ''}</title>
              </circle>
            ))}
          </g>
        )
      })}

      {/* X-axis labels (sparse for readability) */}
      {spec.labels.map((label, i) => {
        const step = N > 10 ? Math.ceil(N / 6) : 1
        if (i % step !== 0 && i !== N - 1) return null
        return (
          <text key={i} x={xPos(i)} y={PAD.top + CH + 13}
            textAnchor="middle" fontSize={8} fill="var(--text-muted)">
            {label.length > 8 ? label.slice(0, 7) + '…' : label}
          </text>
        )
      })}

      {spec.series.length > 1 && spec.series.map((s, i) => {
        const M = spec.series.length
        return (
          <g key={i} transform={`translate(${PAD.left + i * 80}, ${SVG_H - 8})`}>
            <rect width={14} height={2} y={3} rx={1} fill={seriesColor(s, i)} />
            <text x={17} y={7.5} fontSize={7} fill="var(--text-muted)">{s.name}</text>
          </g>
        )
      })}
    </svg>
  )
}

// ─ Pie / donut chart ──────────────────────────────────────────────────────────

function PieChart({ spec }: { spec: WidgetSpec }) {
  const PIE_W = 200
  const cx = 80, cy = 90, r = 62, innerR = spec.type === 'donut' ? 38 : 0

  const data  = spec.series[0]?.data ?? []
  const total = data.reduce((a, b) => a + b, 0) || 1

  function polar(angle: number, radius: number) {
    const rad = (angle - 90) * Math.PI / 180
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) }
  }

  let cursor = 0
  const arcs = data.map((val, i) => {
    const startAngle = cursor
    const sweep      = (val / total) * 360
    cursor += sweep
    const endAngle   = cursor
    const large      = sweep > 180 ? 1 : 0
    const color      = PALETTE[i % PALETTE.length]

    const s = polar(startAngle, r), e = polar(endAngle, r)
    let path: string

    if (innerR > 0) {
      const si = polar(startAngle, innerR), ei = polar(endAngle, innerR)
      path = [
        `M ${s.x} ${s.y}`,
        `A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`,
        `L ${ei.x} ${ei.y}`,
        `A ${innerR} ${innerR} 0 ${large} 0 ${si.x} ${si.y}`,
        'Z',
      ].join(' ')
    } else {
      path = [
        `M ${cx} ${cy}`,
        `L ${s.x} ${s.y}`,
        `A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`,
        'Z',
      ].join(' ')
    }
    return { path, color, val, label: spec.labels[i] ?? '' }
  })

  return (
    <svg viewBox={`0 0 ${PIE_W} ${PIE_W - 20}`} style={{ width: '100%', height: 'auto' }}>
      {arcs.map((arc, i) => (
        <path key={i} d={arc.path} fill={arc.color} stroke="var(--bg)" strokeWidth={1}>
          <title>{arc.label}: {arc.val}{spec.unit ?? ''}</title>
        </path>
      ))}

      {/* Donut center total */}
      {spec.type === 'donut' && (
        <>
          <text x={cx} y={cy - 4} textAnchor="middle" fontSize={13} fontWeight={700}
            fill="var(--text)">{fmt(total)}</text>
          <text x={cx} y={cy + 10} textAnchor="middle" fontSize={7}
            fill="var(--text-muted)">total</text>
        </>
      )}

      {/* Legend */}
      {arcs.map((arc, i) => (
        <g key={i} transform={`translate(150, ${14 + i * 16})`}>
          <rect width={8} height={8} rx={1} fill={arc.color} />
          <text x={12} y={7.5} fontSize={8} fill="var(--text-muted)">
            {(arc.label.length > 10 ? arc.label.slice(0, 9) + '…' : arc.label)}
            {' '}{spec.unit ?? ''}{arc.val}
          </text>
        </g>
      ))}
    </svg>
  )
}

// ─ Number card ────────────────────────────────────────────────────────────────

function NumberCard({ spec }: { spec: WidgetSpec }) {
  const val = spec.series[0]?.data[0] ?? 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: 120, gap: 6 }}>
      <span style={{ fontSize: 42, fontWeight: 800, color: PALETTE[0], lineHeight: 1 }}>
        {fmt(val)}{spec.unit ?? ''}
      </span>
      {spec.subtitle && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{spec.subtitle}</span>
      )}
    </div>
  )
}

// ─ Table chart (spreadsheet view inside the dashboard) ──────────────────────
function TableChart({ spec }: { spec: WidgetSpec }) {
  const data = spec.table
  if (!data) {
    return <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>No table data</p>
  }
  return (
    <div style={{ overflow: 'auto', maxHeight: 220, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 10, width: '100%' }}>
        <thead>
          <tr>
            {data.headers.map((h, i) => (
              <th key={i} style={{
                padding:        '4px 8px',
                textAlign:      'left',
                fontWeight:      600,
                color:          'var(--text)',
                background:     'var(--bg-surface)',
                borderBottom:  '1px solid var(--border)',
                whiteSpace:    'nowrap',
                position:      'sticky',
                top:            0,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.slice(0, 50).map((row, ri) => (
            <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'var(--bg-surface)' }}>
              {row.map((cell, ci) => (
                <td key={ci} style={{
                  padding:      '3px 8px',
                  color:        'var(--text-muted)',
                  borderBottom: '1px solid var(--border-subtle)',
                  maxWidth:      160,
                  overflow:     'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace:   'nowrap',
                }}><span title={cell}>{cell}</span></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(data.truncated || data.rows.length > 50) && (
        <p style={{ margin: 0, padding: '4px 8px', fontSize: 9, color: 'var(--warning)' }}>
          Showing first 50 rows
        </p>
      )}
    </div>
  )
}

// ─ Image card ───────────────────────────────────────────────────────────────
function ImageCard({ spec }: { spec: WidgetSpec }) {
  if (!spec.imageSrc) {
    return <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>Image unavailable</p>
  }
  return (
    <img
      src={spec.imageSrc}
      alt={spec.title}
      style={{
        width: '100%',
        maxHeight: 220,
        objectFit: 'contain',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg)',
      }}
    />
  )
}

// ─ Widget renderer ────────────────────────────────────────────────────────────

// spec.type 에 따라 적절한 차트 컴포넌트를 분기 렌더.
function ChartRenderer({ spec }: { spec: WidgetSpec }) {
  switch (spec.type) {
    case 'bar':    return <BarChart  spec={spec} />
    case 'line':   return <LineChart spec={spec} />
    case 'pie':
    case 'donut':  return <PieChart  spec={spec} />
    case 'number': return <NumberCard spec={spec} />
    case 'table':  return <TableChart spec={spec} />
    case 'image':  return <ImageCard  spec={spec} />
  }
}

// ── Widget card — 핀 고정된(저장된) 위젯 카드 ──────────────────────────────
// 차트 + 제목/부제목 + 우상단 컨트롤(삭제·핀 토글).

function WidgetCard({ spec, onDelete, onTogglePin }: { spec: WidgetSpec; onDelete: () => void; onTogglePin: () => void }) {
  const [hover, setHover] = useState(false)

  return (
    <div
      style={{
        background:   'var(--bg-surface)',
        border:       `1px solid ${spec.pinned ? 'var(--accent-dim)' : (hover ? 'var(--border)' : 'var(--border-subtle)')}`,
        borderRadius: 'var(--radius)',
        padding:      '12px 14px',
        display:      'flex',
        flexDirection:'column',
        gap:           8,
        transition:   'border-color 0.15s',
        position:     'relative',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Action buttons */}
      {(hover || spec.pinned) && (
        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4 }}>
          <button
            onClick={onTogglePin}
            title={spec.pinned ? 'Unpin' : 'Pin to top'}
            style={{
              border:       'none',
              background:   spec.pinned ? 'var(--accent-dim)' : 'var(--bg-hover)',
              color:        spec.pinned ? 'var(--accent)' : 'var(--text-muted)',
              borderRadius: 'var(--radius-sm)',
              width:         22,
              height:        22,
              cursor:       'pointer',
              fontSize:      12,
              display:      'flex',
              alignItems:   'center',
              justifyContent:'center',
            }}>📌</button>
          {hover && (
            <button
              onClick={onDelete}
              title="Remove widget"
              style={{
                border:       'none',
                background:   'var(--bg-hover)',
                color:        'var(--danger)',
                borderRadius: 'var(--radius-sm)',
                width:         22,
                height:        22,
                cursor:       'pointer',
                fontSize:      13,
                display:      'flex',
                alignItems:   'center',
                justifyContent:'center',
              }}>×</button>
          )}
        </div>
      )}

      {/* Header */}
      <div>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--text)',
          paddingRight: 24 }}>{spec.title}</p>
        {spec.subtitle && (
          <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--text-muted)' }}>
            {spec.subtitle}
          </p>
        )}
      </div>

      {/* Chart */}
      <ChartRenderer spec={spec} />

      {/* Insight */}
      {spec.insight && (
        <p style={{ margin: 0, fontSize: 10, color: 'var(--text-muted)',
          lineHeight: 1.4, borderTop: '1px solid var(--border-subtle)', paddingTop: 6 }}>
          {spec.insight}
        </p>
      )}
    </div>
  )
}

// ── Preview card (핀 되기 전) ─────────────────────────────────────────────
// AI 가 막 생성한 차트를 미리보기로 표시. 사용자가 "Pin" 누르면 본 패널로 이동.

function PreviewCard({
  spec, aiText, onPin, onDiscard,
}: {
  spec:      WidgetSpec | null
  aiText:    string
  onPin:     (s: WidgetSpec) => void
  onDiscard: () => void
}) {
  if (!spec) {
    // Show raw AI text when parsing failed
    return (
      <div style={{
        background:   '#b5482f15',
        border:       '1px solid #b5482f40',
        borderRadius: 'var(--radius)',
        padding:       14,
        display:      'flex',
        flexDirection:'column',
        gap:           10,
      }}>
        <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--danger)' }}>
          Could not render chart
        </p>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)',
          fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
          {aiText.slice(0, 400)}
        </p>
        <button onClick={onDiscard} style={{
          alignSelf:    'flex-start',
          border:       '1px solid var(--border)',
          background:   'transparent',
          color:        'var(--text-muted)',
          borderRadius: 'var(--radius-sm)',
          padding:      '4px 12px',
          fontSize:      11,
          cursor:       'pointer',
        }}>Dismiss</button>
      </div>
    )
  }

  return (
    <div style={{
      background:   'var(--bg-surface)',
      border:       '1px solid var(--accent)',
      borderRadius: 'var(--radius)',
      padding:      '12px 14px',
      display:      'flex',
      flexDirection:'column',
      gap:           10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>
          Preview
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          Add this chart to your dashboard?
        </span>
      </div>

      <div>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
          {spec.title}
        </p>
        {spec.subtitle && (
          <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--text-muted)' }}>
            {spec.subtitle}
          </p>
        )}
      </div>

      <ChartRenderer spec={spec} />

      {spec.insight && (
        <p style={{ margin: 0, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
          {spec.insight}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onPin(spec)} style={{
          border:       'none',
          background:   'var(--accent)',
          color:        '#fff',
          borderRadius: 'var(--radius-sm)',
          padding:      '5px 14px',
          fontSize:      12,
          fontWeight:    600,
          cursor:       'pointer',
        }}>Pin to Dashboard</button>
        <button onClick={onDiscard} style={{
          border:       '1px solid var(--border)',
          background:   'transparent',
          color:        'var(--text-muted)',
          borderRadius: 'var(--radius-sm)',
          padding:      '5px 12px',
          fontSize:      12,
          cursor:       'pointer',
        }}>Discard</button>
      </div>
    </div>
  )
}

// ── Main panel — DashboardPanel 본체 ─────────────────────────────────────
// 저장된 위젯 그리드 + 상단 자연어 입력창 + 미리보기 영역을 조합.
// App.tsx 가 내려주는 pendingPrompt (Data→Dashboard 경로) 가 있으면 자동 실행.

interface DashboardPanelProps {
  requestWidget:      (prompt: string) => Promise<string>
  busy:               boolean
  error:              string | null
  pendingPrompt?:     string | null
  onPendingConsumed?: () => void
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'])
const fileExt = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

// Build a default widget straight from a saved file — no LLM call.
// Handles tables (csv/tsv/json/md) and images. Returns null for binary or
// otherwise unrenderable files.
async function buildAutoWidgetForFile(file: { name: string; path: string; mtime: number }): Promise<WidgetSpec | null> {
  try {
    const ext = fileExt(file.name)

    // Image: render as image card
    if (IMAGE_EXTS.has(ext)) {
      const dataUrl = await window.twixy.readImage(file.path)
      if (!dataUrl) return null
      return {
        id:        `auto:${file.path}`,
        type:      'image',
        title:     file.name,
        subtitle:  file.path,
        labels:    [],
        series:    [],
        imageSrc:  dataUrl,
        prompt:    '(auto-generated from saved data)',
        createdAt: new Date(file.mtime).toISOString(),
        pinned:    false,
        source:    { kind: 'auto', filePath: file.path },
      }
    }

    // Tabular: parse as CSV/TSV/JSON/Markdown table
    const content = await window.twixy.readFile(file.path)
    if (!content) return null  // binary / unreadable
    const td = buildTable(file.name, content)
    if (!td || td.headers.length === 0) return null
    return {
      id:        `auto:${file.path}`,
      type:      'table',
      title:     file.name,
      subtitle:  file.path,
      labels:    [],
      series:    [],
      table:     td,
      prompt:    '(auto-generated from saved data)',
      createdAt: new Date(file.mtime).toISOString(),
      pinned:    false,
      source:    { kind: 'auto', filePath: file.path },
    }
  } catch {
    return null
  }
}

export function DashboardPanel({
  requestWidget, busy, error: clawError,
  pendingPrompt, onPendingConsumed,
}: DashboardPanelProps) {
  const [widgets,  setWidgets]  = useState<WidgetSpec[]>(loadWidgets)
  const [input,    setInput]    = useState('')
  const [preview,  setPreview]  = useState<{ spec: WidgetSpec | null; raw: string } | null>(null)
  const [parseErr, setParseErr] = useState<string | null>(null)
  const dashTextareaRef = useRef<HTMLTextAreaElement>(null)

  // ── Snapshot (Recent Reports / Data Sources / Next Actions) ────
  // Single IPC every 6s. Cheap enough to share the auto-sync cadence.
  const [snapshot, setSnapshot] = useState<TwixyDashboardSnapshot | null>(null)
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const s = await window.twixy.dashboardSnapshot?.()
        if (!cancelled && s) setSnapshot(s)
      } catch { /* ignore */ }
    }
    tick()
    const t = setInterval(tick, 6000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // ── @-mention file picker (mirrors ChatPanel) ────────────────────
  type RecentFile = { name: string; path: string; mtime: number; dir: string }
  const [mention, setMention] = useState<{
    open: boolean
    query: string
    start: number
    files: RecentFile[]
    selected: number
  }>({ open: false, query: '', start: -1, files: [], selected: 0 })

  const loadRecentForMention = useCallback(async () => {
    try {
      const files = await window.twixy.recentFiles(50)
      setMention(m => ({ ...m, files }))
    } catch { /* ignore */ }
  }, [])

  const filteredMentionFiles = mention.files
    .filter(f => !mention.query || f.name.toLowerCase().includes(mention.query.toLowerCase()))
    .slice(0, 8)

  const insertDashMention = (file: RecentFile) => {
    const before = input.slice(0, mention.start)
    const after  = input.slice(mention.start + 1 + mention.query.length)
    setInput(`${before}@${file.path} ${after}`)
    setMention(m => ({ ...m, open: false, query: '', start: -1, selected: 0 }))
    setTimeout(() => dashTextareaRef.current?.focus(), 0)
  }

  const handleDashInputChange = (value: string) => {
    setInput(value)
    const caret = dashTextareaRef.current?.selectionStart ?? value.length
    const upto  = value.slice(0, caret)
    const at    = upto.lastIndexOf('@')
    if (at === -1 || (at > 0 && /\S/.test(upto[at - 1]))) {
      if (mention.open) setMention(m => ({ ...m, open: false }))
      return
    }
    const token = upto.slice(at + 1)
    if (/\s/.test(token)) {
      if (mention.open) setMention(m => ({ ...m, open: false }))
      return
    }
    if (!mention.open) void loadRecentForMention()
    setMention(m => ({ ...m, open: true, query: token, start: at, selected: 0 }))
  }

  // Auto-sync widgets from data/saved (Key Data). Polls every few seconds and
  // builds a table widget for any new saved file. Pinned widgets are never
  // touched here — they live forever until the user unpins / deletes them.
  const widgetsRef = useRef(widgets)
  widgetsRef.current = widgets
  useEffect(() => {
    let cancelled = false

    const sync = async () => {
      try {
        const recents = await window.twixy.recentFiles(80)
        // Auto-render anything that lands in the data management area —
        // raw, saved (key data), insights, or exports. Whatever shows up
        // in the Data tab should also show up on the dashboard.
        const savedFiles = recents.filter(f =>
          f.path.startsWith('data/raw/') ||
          f.path.startsWith('data/saved/') ||
          f.path.startsWith('data/insights/') ||
          f.path.startsWith('exports/')
        )
        const cur = widgetsRef.current
        const seen = new Set(cur.filter(w => w.source?.filePath).map(w => w.source!.filePath!))

        // Build widgets for new files (not yet represented)
        const additions: WidgetSpec[] = []
        for (const f of savedFiles) {
          if (seen.has(f.path)) continue
          const w = await buildAutoWidgetForFile(f)
          if (w) additions.push(w)
        }

        // Drop auto widgets whose source file vanished (but never drop pinned)
        const stillThere = new Set(savedFiles.map(f => f.path))
        const survivors = cur.filter(w => {
          if (w.source?.kind !== 'auto') return true
          if (w.pinned) return true
          return w.source.filePath ? stillThere.has(w.source.filePath) : true
        })

        if (additions.length === 0 && survivors.length === cur.length) return
        if (cancelled) return
        const next = [...additions, ...survivors]
        setWidgets(next)
        saveWidgets(next)
      } catch { /* ignore */ }
    }

    sync()
    const t = setInterval(sync, 6000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // Auto-submit when a prompt is injected from outside (e.g. Visualize from DataPanel)
  useEffect(() => {
    if (!pendingPrompt || busy) return
    onPendingConsumed?.()
    setInput('')
    setPreview(null)
    setParseErr(null)
    requestWidget(pendingPrompt).then(aiText => {
      const result = parseAIResponse(aiText, pendingPrompt)
      if (typeof result === 'string') {
        setParseErr(result)
        setPreview({ spec: null, raw: aiText })
      } else {
        setPreview({ spec: result, raw: aiText })
      }
    }).catch(() => { /* error shown via clawError */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt])

  const handleSubmit = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || busy) return
    setInput('')
    setPreview(null)
    setParseErr(null)

    try {
      const aiText = await requestWidget(prompt)
      const result = parseAIResponse(aiText, prompt)
      if (typeof result === 'string') {
        // Parsing failed — show raw + error
        setParseErr(result)
        setPreview({ spec: null, raw: aiText })
      } else {
        setPreview({ spec: result, raw: aiText })
      }
    } catch { /* error already in clawError */ }
  }, [input, busy, requestWidget])

  function pinWidget(spec: WidgetSpec) {
    // From the preview flow → manual, pinned by default.
    const next = [{ ...spec, pinned: true, source: spec.source ?? { kind: 'manual' as const } }, ...widgets]
    setWidgets(next)
    saveWidgets(next)
    setPreview(null)
  }

  function deleteWidget(id: string) {
    const next = widgets.filter(w => w.id !== id)
    setWidgets(next)
    saveWidgets(next)
  }

  function togglePin(id: string) {
    const next = widgets.map(w => w.id === id ? { ...w, pinned: !w.pinned } : w)
    setWidgets(next)
    saveWidgets(next)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.open && filteredMentionFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMention(m => ({ ...m, selected: (m.selected + 1) % filteredMentionFiles.length }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMention(m => ({ ...m, selected: (m.selected - 1 + filteredMentionFiles.length) % filteredMentionFiles.length }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertDashMention(filteredMentionFiles[mention.selected])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(m => ({ ...m, open: false }))
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>

      {/* Header */}
      <div style={{
        padding:      '14px 20px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        flexShrink:    0,
        display:      'flex',
        alignItems:   'center',
        gap:           10,
      }}>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Dashboard</p>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Describe a chart in plain English — Twixy will build it from your data
          </p>
        </div>
        {widgets.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {widgets.length} widget{widgets.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Widget grid */}
      <div style={{
        flex:      1,
        overflowY: 'auto',
        padding:   '16px 20px',
        display:   'flex',
        flexDirection: 'column',
        gap:        16,
      }}>
        {/* Phase 3 — Snapshot strip (Recent Reports / Sources / Next Actions) */}
        {snapshot && (
          <SnapshotStrip
            snap={snapshot}
            onRunPrompt={p => { setInput(p); setTimeout(() => dashTextareaRef.current?.focus(), 0) }}
          />
        )}

        {/* Preview / pending */}
        {busy && (
          <div style={{
            background:   'var(--bg-surface)',
            border:       '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius)',
            padding:       16,
            display:      'flex',
            alignItems:   'center',
            gap:           10,
          }}>
            <span style={{ fontSize: 14, animation: 'spin 1s linear infinite' }}>⟳</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Twixy is building your chart…
            </span>
          </div>
        )}

        {clawError && !busy && (
          <div style={{
            background:   '#b5482f15',
            border:       '1px solid #b5482f40',
            borderRadius: 'var(--radius)',
            padding:       12,
            fontSize:      11,
            color:        'var(--danger)',
          }}>⚠ {clawError}</div>
        )}

        {preview && (
          <PreviewCard
            spec={preview.spec}
            aiText={preview.raw}
            onPin={pinWidget}
            onDiscard={() => setPreview(null)}
          />
        )}

        {parseErr && !preview && (
          <div style={{
            background:   '#b5482f10',
            border:       '1px solid #b5482f30',
            borderRadius: 'var(--radius)',
            padding:       10,
            fontSize:      11,
            color:        'var(--danger)',
          }}>Parse error: {parseErr}</div>
        )}

        {/* Pinned board */}
        {widgets.some(w => w.pinned) && (
          <div style={{
            background:  'var(--bg)',
            paddingBlock: 4,
            borderBottom:'1px dashed var(--border-subtle)',
            marginBottom: 8,
          }}>
            <p style={{
              margin: '0 0 8px',
              fontSize: 10,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontWeight: 600,
            }}>📌 Pinned Board</p>
            <div style={{
              display:             'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
              gap:                  14,
            }}>
              {widgets.filter(w => w.pinned).map(w => (
                <WidgetCard
                  key={w.id}
                  spec={w}
                  onDelete={() => deleteWidget(w.id)}
                  onTogglePin={() => togglePin(w.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Auto board (every saved file rendered) */}
        {widgets.some(w => !w.pinned) ? (
          <div>
            <p style={{
              margin: '0 0 8px',
              fontSize: 10,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontWeight: 600,
            }}>Board · Saved data</p>
            <div style={{
              display:             'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
              gap:                  14,
            }}>
              {widgets.filter(w => !w.pinned).map(w => (
                <WidgetCard
                  key={w.id}
                  spec={w}
                  onDelete={() => deleteWidget(w.id)}
                  onTogglePin={() => togglePin(w.id)}
                />
              ))}
            </div>
          </div>
        ) : (
          !busy && !preview && widgets.length === 0 && (
            <div style={{ textAlign: 'center', paddingTop: 60 }}>
              <p style={{ fontSize: 28, marginBottom: 12 }}>◫</p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No charts yet</p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, maxWidth: 300, margin: '6px auto 0' }}>
                Save a file into <em>Key Data</em> and it'll appear here automatically — or
                describe a chart in plain English below.
              </p>
            </div>
          )
        )}
      </div>

      {/* Input bar */}
      <div style={{
        borderTop:  '1px solid var(--border-subtle)',
        padding:    '10px 16px 14px',
        flexShrink:  0,
        display:   'flex',
        gap:        10,
        alignItems: 'flex-end',
        background: 'var(--bg-surface)',
        position:   'relative',
      }}>
        {/* @-mention dropdown */}
        {mention.open && filteredMentionFiles.length > 0 && (
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 16,
            right: 16,
            marginBottom: 6,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 12px 36px rgba(0,0,0,0.5)',
            zIndex: 50,
            maxHeight: 280,
            overflowY: 'auto',
            padding: 4,
          }}>
            <div style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              padding: '4px 10px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>Recent files</div>
            {filteredMentionFiles.map((f, i) => (
              <button
                key={f.path}
                onMouseDown={e => { e.preventDefault(); insertDashMention(f) }}
                onMouseEnter={() => setMention(m => ({ ...m, selected: i }))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  padding: '7px 10px',
                  border: 'none',
                  background: i === mention.selected ? 'var(--bg-hover)' : 'transparent',
                  color: 'var(--text)',
                  fontSize: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{f.name}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{f.dir}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={dashTextareaRef}
          value={input}
          onChange={e => handleDashInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Describe a chart… e.g. "Pie chart of my content split by type"'
          rows={2}
          disabled={busy}
          style={{
            flex:        1,
            background:  'var(--bg)',
            border:      '1px solid var(--border-subtle)',
            borderRadius:'var(--radius-sm)',
            padding:     '8px 10px',
            fontSize:     12,
            color:       'var(--text)',
            fontFamily:  'inherit',
            lineHeight:   1.5,
            resize:      'none',
            outline:     'none',
            opacity:     busy ? 0.5 : 1,
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={busy || !input.trim()}
          style={{
            border:       'none',
            background:   busy || !input.trim() ? 'var(--bg-hover)' : 'var(--accent)',
            color:        busy || !input.trim() ? 'var(--text-muted)' : '#fff',
            borderRadius: 'var(--radius-sm)',
            width:         36,
            height:        36,
            fontSize:      16,
            cursor:        busy || !input.trim() ? 'not-allowed' : 'pointer',
            flexShrink:    0,
            display:      'flex',
            alignItems:   'center',
            justifyContent:'center',
            transition:   'background 0.15s',
          }}>
          {busy ? '…' : '↑'}
        </button>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}

// ── Phase 3 sections (Recent Reports / Data Sources / Next Actions) ──────

const REPORT_ICON: Record<TwixyReportKind, string> = {
  pdf:   '📄',
  xlsx:  '📊',
  pptx:  '🎞️',
  other: '📎',
}

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024)      return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function fmtRel(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const diff = Date.now() - ts
  if (diff < 60_000)        return 'just now'
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <p style={{
      margin: '0 0 8px',
      fontSize: 10,
      color: 'var(--text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      fontWeight: 600,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      {label}
      {typeof count === 'number' && (
        <span style={{ fontWeight: 500, color: 'var(--text-muted)', opacity: 0.7 }}>
          {count}
        </span>
      )}
    </p>
  )
}

function SnapshotStrip({ snap, onRunPrompt }: {
  snap: TwixyDashboardSnapshot
  onRunPrompt: (prompt: string) => void
}) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
      gap: 14,
      marginBottom: 4,
    }}>
      <RecentReportsCard reports={snap.recentReports} />
      <DataSourcesCard sources={snap.dataSources} />
      <NextActionsCard actions={snap.nextActions} onRunPrompt={onRunPrompt} />
    </div>
  )
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background:   'var(--bg-surface)',
      border:       '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius)',
      padding:      '12px 14px',
      display:      'flex',
      flexDirection:'column',
      gap:           8,
      minHeight:    140,
    }}>
      {children}
    </div>
  )
}

function RecentReportsCard({ reports }: { reports: TwixyDashboardReport[] }) {
  return (
    <CardShell>
      <SectionHeader label="Recent Reports" count={reports.length} />
      {reports.length === 0 ? (
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
          No files in <code style={{ fontSize: 10 }}>data/reports/</code> yet. The
          report-pack and gdoc-report skills land here.
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
          {reports.slice(0, 8).map(r => (
            <li key={r.relPath}>
              <button
                type="button"
                onClick={() => window.twixy.revealInFinder(r.relPath)}
                title={r.relPath}
                style={{
                  display:    'flex',
                  alignItems: 'center',
                  gap:         8,
                  width:      '100%',
                  border:     'none',
                  background: 'transparent',
                  color:      'var(--text)',
                  padding:    '4px 6px',
                  borderRadius: 'var(--radius-sm)',
                  cursor:     'pointer',
                  fontSize:    11,
                  textAlign:  'left',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{ fontSize: 13 }}>{REPORT_ICON[r.kind]}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtBytes(r.sizeBytes)}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtRel(r.mtime)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  )
}

function DataSourcesCard({ sources }: { sources: TwixyDashboardSnapshot['dataSources'] }) {
  const rows: { label: string; value: string }[] = [
    { label: 'data/raw',      value: String(sources.workspace.rawCount) },
    { label: 'data/saved',    value: String(sources.workspace.savedCount) },
    { label: 'data/insights', value: String(sources.workspace.insightsCount) },
    { label: 'data/reports',  value: String(sources.workspace.reportsCount) },
    { label: 'exports',       value: String(sources.workspace.exportsCount) },
  ]
  return (
    <CardShell>
      <SectionHeader label="Data Sources" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 999,
          background: sources.google.connected ? 'var(--accent)' : 'var(--text-muted)',
          opacity: sources.google.connected ? 1 : 0.4,
        }} />
        <span style={{ fontSize: 11, color: 'var(--text)' }}>
          Google Workspace
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sources.google.connected
            ? sources.google.email ?? '(no email)'
            : 'not connected'}
        </span>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        rowGap: 2,
        columnGap: 12,
        marginTop: 4,
      }}>
        {rows.map(r => (
          <Fragment key={r.label}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{r.label}</span>
            <span style={{ fontSize: 10, color: 'var(--text)', textAlign: 'right' }}>{r.value}</span>
          </Fragment>
        ))}
      </div>
      <p style={{ margin: '4px 0 0', fontSize: 10, color: 'var(--text-muted)' }}>
        Last report {fmtRel(sources.lastReportAt)} · last insight {fmtRel(sources.lastInsightAt)}
      </p>
    </CardShell>
  )
}

function NextActionsCard({ actions, onRunPrompt }: {
  actions: TwixyDashboardNextAction[]
  onRunPrompt: (prompt: string) => void
}) {
  return (
    <CardShell>
      <SectionHeader label="Next Actions" count={actions.length} />
      {actions.length === 0 ? (
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
          You're all caught up.
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {actions.map(a => (
            <li key={a.id} style={{
              border:       '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding:      '6px 8px',
              display:      'flex',
              flexDirection:'column',
              gap:           2,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', flex: 1 }}>{a.label}</span>
                {a.prompt && (
                  <button
                    type="button"
                    onClick={() => onRunPrompt(a.prompt!)}
                    style={{
                      border:       'none',
                      background:   'var(--accent)',
                      color:        '#fff',
                      borderRadius: 'var(--radius-sm)',
                      padding:      '2px 8px',
                      fontSize:      10,
                      fontWeight:    600,
                      cursor:       'pointer',
                    }}
                  >Use</button>
                )}
              </div>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{a.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  )
}
