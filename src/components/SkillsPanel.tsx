// ═════════════════════════════════════════════════════════════════════════════
// SkillsPanel.tsx — 사용자 스킬 관리 UI.
//
// 모드:
//   · Dashboard 모드 — 내장/커스텀 스킬을 카드 그리드로 보여주고 호출 통계(runs/success rate) 표시
//   · Editor 모드    — 신규 스킬 생성 또는 기존 스킬 편집 (폼 기반 → .tskill 자동 생성)
//
// 스킬 데이터 흐름:
//   · window.twixy.listSkills() 로 전체 목록(SkillManifest[]) 조회
//   · window.twixy.getSkillStats() 로 호출/성공 통계 조회
//   · 저장 시 generateTSkill(form) → installSkill IPC 로 파일 기록
//   · 커스텀 스킬만 편집/삭제 가능 (내장은 read-only)
//
// 폼 기반 작성으로 사용자가 TSL 문법을 몰라도 되지만, 원본 .tskill 확인/수정은 소스 뷰에서 가능.
// ═════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react'
import { DisplayCost } from '../lib/useDisplayUsd'
import { safeHtml } from '../lib/safeHtml'

// ── Constants — 플랫폼 목록, 스테이지 타입, 라벨 ─────────────────────────────

const ALL_PLATFORMS = [
  'INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'TWITTER', 'LINKEDIN',
  'GOOGLE_ANALYTICS', 'META_ADS', 'NOTION',
]

const PLATFORM_LABELS: Record<string, string> = {
  INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube',
  TWITTER: 'X / Twitter', LINKEDIN: 'LinkedIn',
  GOOGLE_ANALYTICS: 'Google Analytics', META_ADS: 'Meta Ads', NOTION: 'Notion',
}

const STAGE_TYPES = ['COLLECT', 'ANALYZE', 'STRATEGIZE', 'EXECUTE', 'TRACK'] as const
type StageType = typeof STAGE_TYPES[number]

const STAGE_LABELS: Record<StageType, string> = {
  COLLECT:    'Collect',
  ANALYZE:    'Analyze',
  STRATEGIZE: 'Strategize',
  EXECUTE:    'Execute',
  TRACK:      'Track',
}

const STAGE_COLORS: Record<StageType, string> = {
  COLLECT:    'var(--accent)',
  ANALYZE:    'var(--accent)',
  STRATEGIZE: 'var(--warning)',
  EXECUTE:    'var(--accent)',
  TRACK:      'var(--danger)',
}

// ── Form state — SkillEditor 가 유지하는 폼 상태 ────────────────────────────
// 사용자가 폼에 입력한 값은 FormState 로 관리되고, 저장 시 generateTSkill() 로 .tskill 소스 생성.

interface StepState {
  id: string
  type: StageType
  label: string
  body: string
}

interface FormState {
  name: string
  displayName: string
  description: string
  trigger: string
  tags: string
  platforms: string[]
  goalLabel: string
  objective: string
  kpi: string
  steps: StepState[]
}

function emptyForm(): FormState {
  return {
    name: '', displayName: '', description: '', trigger: '', tags: '',
    platforms: [], goalLabel: '', objective: '', kpi: '',
    steps: [{ id: uid(), type: 'COLLECT', label: '', body: '' }],
  }
}

// 스텝 리스트의 React key 용 짧은 랜덤 ID (저장 대상 아님, DnD 재정렬 안정성 확보용).
function uid() { return Math.random().toString(36).slice(2, 8) }

// ── .tskill 코드 생성기 — FormState → TSL 소스 문자열 ───────────────────────
// SKILL 헤더 + PLATFORMS + 각 스텝 블록을 순서대로 렌더. 저장 시 installSkill IPC 로 디스크 기록.

function generateTSkill(f: FormState): string {
  const lines: string[] = []
  lines.push('@workspace twixy', '')
  lines.push(`SKILL "${f.displayName || f.name || 'My Skill'}"`)
  lines.push('  version: 1.0')
  if (f.description) lines.push(`  description: "${f.description.replace(/"/g, '\\"')}"`)
  if (f.trigger)     lines.push(`  trigger: "${f.trigger.replace(/"/g, '\\"')}"`)
  const tags = f.tags.split(',').map(t => t.trim()).filter(Boolean)
  if (tags.length) lines.push(`  tags: [${tags.join(', ')}]`)
  lines.push('')

  if (f.platforms.length) {
    lines.push('PLATFORMS {')
    f.platforms.forEach(p => lines.push(`  ${p}`))
    lines.push('}', '')
  }

  if (f.objective || f.goalLabel) {
    lines.push(`GOAL "${f.goalLabel || 'Define objective'}" {`)
    if (f.objective) lines.push(`  objective: "${f.objective.replace(/"/g, '\\"')}"`)
    if (f.kpi)       lines.push(`  kpi: ${f.kpi.replace(/\s+/g, '_').toLowerCase()}`)
    lines.push('}', '')
  }

  f.steps.forEach(s => {
    if (!s.body.trim() && !s.label.trim()) return
    lines.push(`${s.type} "${s.label || STAGE_LABELS[s.type]}" {`)
    s.body.split('\n').forEach(l => { if (l.trim()) lines.push(`  ${l}`) })
    lines.push('}', '')
  })

  return lines.join('\n')
}

// ── .tskill 역-파서 (기존 스킬 편집용, best-effort) ─────────────────────────
// 이미 설치된 스킬을 다시 편집할 때 FormState 로 복원한다. 완벽한 AST 파서는 아니고
// 폼에서 커버되는 필드만 휴리스틱으로 추출. 인식 못 한 부분은 소스 뷰에서 직접 수정.

function parseTSkill(source: string): FormState {
  const f = emptyForm()
  const nameM       = source.match(/^SKILL\s+"([^"]+)"/m)
  const descM       = source.match(/description:\s*"([^"]+)"/m)
  const triggerM    = source.match(/trigger:\s*"([^"]+)"/m)
  const tagsM       = source.match(/tags:\s*\[([^\]]+)\]/m)
  const goalLabelM  = source.match(/^GOAL\s+"([^"]+)"/m)
  const objectiveM  = source.match(/objective:\s*"([^"]+)"/m)
  const kpiM        = source.match(/kpi:\s*([\w_]+)/m)

  f.displayName = nameM?.[1] ?? ''
  f.description = descM?.[1] ?? ''
  f.trigger     = triggerM?.[1] ?? ''
  f.tags        = tagsM?.[1]?.split(',').map(t => t.trim()).join(', ') ?? ''
  f.goalLabel   = goalLabelM?.[1] ?? ''
  f.objective   = objectiveM?.[1] ?? ''
  f.kpi         = kpiM?.[1] ?? ''

  const platBlock = source.match(/PLATFORMS\s*\{([^}]+)\}/m)
  if (platBlock) {
    f.platforms = platBlock[1].split('\n')
      .map(l => l.trim()).filter(l => ALL_PLATFORMS.includes(l))
  }

  const stageRE = /^(COLLECT|ANALYZE|STRATEGIZE|EXECUTE|TRACK)\s+"([^"]*)"\s*\{([\s\S]*?)^\}/gm
  const steps: StepState[] = []
  let m: RegExpExecArray | null
  while ((m = stageRE.exec(source)) !== null) {
    steps.push({
      id: uid(),
      type: m[1] as StageType,
      label: m[2],
      body: m[3].replace(/^  /gm, '').trim(),
    })
  }
  if (steps.length) f.steps = steps

  return f
}

// ── 소스 뷰용 가벼운 신택스 하이라이터 ───────────────────────────────────
// 외부 highlighter 라이브러리 없이 정규식만으로 키워드/문자열/주석에 색 입힘. 번들 절약 목적.

function highlightTSL(code: string): string {
  return code
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(\/\*[\s\S]*?\*\/)/g, '<span style="color:#6a9955">$1</span>')
    .replace(/(\/\/[^\n]*)/g,        '<span style="color:#6a9955">$1</span>')
    .replace(/("(?:[^"\\]|\\.)*")/g, '<span style="color:#ce9178">$1</span>')
    .replace(/(@\w+)/g,              '<span style="color:#9cdcfe">$1</span>')
    .replace(/\b(SKILL|PLATFORMS|GOAL|COLLECT|ANALYZE|STRATEGIZE|EXECUTE|TRACK|FOR EACH|IF|WHEN|ELSE|USE|EXTRACT|STORE|LOAD|HYPOTHESIZE|PLAN|SPAWN|POST|EMIT|LET|FROM|INTO|WHERE|LIMIT|SINCE|ORDER BY|AS|IN|WITH|TO|AT|OUTPUT|TASK|USING|AWAIT|ASYNC|APPROVE)\b/g,
      '<span style="color:#569cd6">$1</span>')
    .replace(/\b(version|author|description|tags|schedule|objective|kpi|target|window|LISTENS TO|FROM SKILL)\b/g,
      '<span style="color:#4ec9b0">$1</span>')
    .replace(/(\$[A-Z_]+)/g, '<span style="color:#dcdcaa">$1</span>')
    .replace(/\b(\d+)\b/g,   '<span style="color:#b5cea8">$1</span>')
}

// ── Shared input styles ───────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: '100%', background: 'var(--bg-hover)',
  border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text-primary)', fontSize: 12,
  padding: '7px 10px', outline: 'none', fontFamily: 'inherit',
}

const label12: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5,
}

// ── SkillEditor — 폼 기반 스킬 생성/편집 화면 ─────────────────────────────
// 신규면 빈 FormState, 편집이면 parseTSkill 로 복원한 상태에서 시작.
// 저장 시 compileTskill 로 문법 검증 → installSkill 로 기록.

interface EditorProps {
  initialName?: string
  initialSource?: string
  onDone: () => void
  onCancel: () => void
}

function SkillEditor({ initialName = '', initialSource, onDone, onCancel }: EditorProps) {
  const [form,      setForm]      = useState<FormState>(() =>
    initialSource ? { ...parseTSkill(initialSource), name: initialName }
                  : { ...emptyForm(), name: initialName }
  )
  const [viewSrc,   setViewSrc]   = useState(false)
  const [rawSrc,    setRawSrc]    = useState(() => initialSource ?? generateTSkill({ ...emptyForm(), name: initialName }))
  const [errors,    setErrors]    = useState<string[]>([])
  const [warnings,  setWarnings]  = useState<string[]>([])
  const [busy,      setBusy]      = useState(false)
  const [validated, setValidated] = useState(false)
  const [sharedConflict, setSharedConflict] = useState<{ name: string; source: string } | null>(null)
  const [mrMsg,     setMrMsg]     = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // sync form → rawSrc (when in form view)
  useEffect(() => {
    if (viewSrc) return
    const src = generateTSkill(form)
    setRawSrc(src)
    setValidated(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const fname = `${form.name || 'skill'}.tskill`
      const res = await window.twixy.compileTskill({ source: src, filename: fname })
      setErrors(res.errors.map(e => e.message))
      setWarnings(res.warnings.map(w => w.message))
      setValidated(res.ok)
    }, 500)
  }, [form, viewSrc])

  // validate raw src when in source view
  useEffect(() => {
    if (!viewSrc) return
    setValidated(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const fname = `${form.name || 'skill'}.tskill`
      const res = await window.twixy.compileTskill({ source: rawSrc, filename: fname })
      setErrors(res.errors.map(e => e.message))
      setWarnings(res.warnings.map(w => w.message))
      setValidated(res.ok)
    }, 500)
  }, [rawSrc, viewSrc, form.name])

  const install = useCallback(async () => {
    const name = form.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
    if (!name) return
    const src = viewSrc ? rawSrc : generateTSkill(form)
    setBusy(true)
    setSharedConflict(null)
    setMrMsg(null)
    const res = await window.twixy.installSkill({ source: src, name })
    setBusy(false)
    if (res.ok) { onDone(); return }
    const conflict = res.errors.find(e => e.code === 'name_conflict_with_shared')
    if (conflict) {
      setSharedConflict({ name, source: src })
      setErrors([conflict.message])
    } else {
      setErrors(res.errors.map(e => e.message))
    }
  }, [form, viewSrc, rawSrc, onDone])

  const proposeUpdateToShared = useCallback(async () => {
    if (!sharedConflict) return
    setBusy(true)
    setMrMsg(null)
    try {
      const tskillFilename = `${sharedConflict.name}.tskill`
      const compiled = await window.twixy.compileTskill({
        source: sharedConflict.source, filename: tskillFilename,
      })
      if (!compiled.ok || !compiled.markdown) {
        setMrMsg('Compile failed — fix errors above first')
        return
      }
      const tskillShared = `shared/skills/${sharedConflict.name}/${tskillFilename}`
      const mdShared     = `shared/skills/${sharedConflict.name}/SKILL.md`
      const res = await window.twixy.mrCreate({
        title: `Update shared skill: ${sharedConflict.name}`,
        changes: [
          { op: 'modify', path: tskillShared, content: sharedConflict.source },
          { op: 'modify', path: mdShared,     content: compiled.markdown },
        ],
      })
      if (!res.ok) { setMrMsg(res.error ?? 'Failed to open MR'); return }
      setMrMsg('Merge request opened — review in the Merge Requests tab.')
      setSharedConflict(null)
    } finally {
      setBusy(false)
    }
  }, [sharedConflict])

  const setField = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const togglePlatform = (p: string) =>
    setField('platforms', form.platforms.includes(p)
      ? form.platforms.filter(x => x !== p)
      : [...form.platforms, p])

  const updateStep = (id: string, patch: Partial<StepState>) =>
    setField('steps', form.steps.map(s => s.id === id ? { ...s, ...patch } : s))

  const removeStep = (id: string) =>
    setField('steps', form.steps.filter(s => s.id !== id))

  const addStep = () =>
    setField('steps', [...form.steps, { id: uid(), type: 'COLLECT', label: '', body: '' }])

  const canInstall = form.name.trim().length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Top bar */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <input
          style={{ ...inp, flex: 1, fontWeight: 600, fontSize: 13 }}
          placeholder="skill-id (e.g. instagram-reel-tracker)"
          value={form.name}
          onChange={e => setField('name', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
        />
        <button
          onClick={() => {
            if (!viewSrc) {
              setRawSrc(generateTSkill(form))
              setViewSrc(true)
            } else {
              setForm(f => ({ ...parseTSkill(rawSrc), name: f.name }))
              setViewSrc(false)
            }
          }}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: viewSrc ? 'var(--accent-dim)' : 'transparent', color: viewSrc ? 'var(--accent)' : 'var(--text-muted)', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          {viewSrc ? '← Form' : 'Source'}
        </button>
        <button onClick={onCancel} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
          Cancel
        </button>
        <button
          onClick={install}
          disabled={busy || !canInstall}
          style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: canInstall ? 'var(--accent)' : 'var(--bg-hover)', color: canInstall ? '#fff' : 'var(--text-muted)', fontSize: 12, fontWeight: 600, cursor: canInstall ? 'pointer' : 'default' }}
        >
          {busy ? 'Installing…' : initialSource ? 'Update' : 'Install'}
        </button>
      </div>

      {/* Validation bar */}
      {(errors.length > 0 || warnings.length > 0) && (
        <div style={{ padding: '6px 16px', background: errors.length ? 'rgba(181, 72, 47,0.07)' : 'rgba(176, 125, 24,0.07)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {errors.map((e, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--red)' }}>⚠ {e}</div>
          ))}
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--yellow)' }}>· {w}</div>
          ))}
          {sharedConflict && (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={proposeUpdateToShared}
                disabled={busy}
                style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}
              >
                {busy ? 'Opening…' : 'Update shared via MR'}
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Opens a review instead of overwriting locally.
              </span>
            </div>
          )}
          {mrMsg && (
            <div style={{ marginTop: 4, fontSize: 11, color: mrMsg.startsWith('Merge request') ? 'var(--accent)' : 'var(--danger)' }}>
              {mrMsg}
            </div>
          )}
        </div>
      )}
      {validated && errors.length === 0 && (
        <div style={{ padding: '5px 16px', fontSize: 11, color: 'var(--green)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          ✓ Valid TSL
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {viewSrc ? (
          /* ── Source view ── */
          <textarea
            value={rawSrc}
            onChange={e => setRawSrc(e.target.value)}
            spellCheck={false}
            style={{ ...inp, height: '100%', minHeight: 400, resize: 'none', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.65 }}
          />
        ) : (
          /* ── Form view ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Display name + description */}
            <Section title="Basic Info">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input style={inp} placeholder="Display name (e.g. YouTube Channel Analytics)" value={form.displayName} onChange={e => setField('displayName', e.target.value)} />
                <textarea
                  style={{ ...inp, resize: 'none', height: 70, lineHeight: 1.5 }}
                  placeholder="Describe what this skill does."
                  value={form.description}
                  onChange={e => setField('description', e.target.value)}
                />
                <input
                  style={inp}
                  placeholder={`Trigger phrases (e.g. "analyze youtube, channel stats, subscriber trends")`}
                  value={form.trigger}
                  onChange={e => setField('trigger', e.target.value)}
                />
                <input style={inp} placeholder="Tags (e.g. youtube, analytics, report)" value={form.tags} onChange={e => setField('tags', e.target.value)} />
              </div>
            </Section>

            {/* Platforms */}
            <Section title="Platforms">
              <PlatformPicker platforms={form.platforms} onChange={p => setField('platforms', p)} />
            </Section>

            {/* Goal */}
            <Section title="Goal">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input style={inp} placeholder="Goal label (e.g. Collect YouTube channel data)" value={form.goalLabel} onChange={e => setField('goalLabel', e.target.value)} />
                <input style={inp} placeholder="Objective — what this skill achieves" value={form.objective} onChange={e => setField('objective', e.target.value)} />
                <input style={inp} placeholder="KPI (e.g. videos_collected, engagement_rate)" value={form.kpi} onChange={e => setField('kpi', e.target.value)} />
              </div>
            </Section>

            {/* Steps */}
            <Section title="Steps">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {form.steps.map((step, idx) => (
                  <StepCard
                    key={step.id}
                    step={step}
                    index={idx}
                    total={form.steps.length}
                    onChange={patch => updateStep(step.id, patch)}
                    onRemove={() => removeStep(step.id)}
                    onMoveUp={() => {
                      if (idx === 0) return
                      const s = [...form.steps]
                      ;[s[idx - 1], s[idx]] = [s[idx], s[idx - 1]]
                      setField('steps', s)
                    }}
                    onMoveDown={() => {
                      if (idx === form.steps.length - 1) return
                      const s = [...form.steps]
                      ;[s[idx], s[idx + 1]] = [s[idx + 1], s[idx]]
                      setField('steps', s)
                    }}
                  />
                ))}
                <button
                  onClick={addStep}
                  style={{ padding: '7px', borderRadius: 6, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}
                >
                  + Add step
                </button>
              </div>
            </Section>

          </div>
        )}
      </div>
    </div>
  )
}

// ── Section — 편집기 내부의 카드/섹션 래퍼 (타이틀 + 자식) ────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={label12}>{title}</div>
      {children}
    </div>
  )
}

// ── Step card — 스킬의 단일 스테이지 입력 카드 ────────────────────────────
// 스테이지 타입 / 라벨 / 본문 편집, 순서 변경 버튼(위/아래) 제공.

interface StepCardProps {
  step: StepState
  index: number
  total: number
  onChange: (patch: Partial<StepState>) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

function StepCard({ step, index, total, onChange, onRemove, onMoveUp, onMoveDown }: StepCardProps) {
  const color = STAGE_COLORS[step.type]
  return (
    <div style={{ border: `1px solid var(--border)`, borderRadius: 8, overflow: 'hidden' }}>
      {/* Step header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-hover)', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 16, textAlign: 'center' }}>{index + 1}</span>

        {/* Stage type selector */}
        <div style={{ display: 'flex', gap: 4 }}>
          {STAGE_TYPES.map(t => (
            <button
              key={t}
              onClick={() => onChange({ type: t })}
              style={{ padding: '3px 7px', borderRadius: 4, border: 'none', background: step.type === t ? color + '33' : 'transparent', color: step.type === t ? color : 'var(--text-muted)', fontSize: 10, fontWeight: 700, cursor: 'pointer', transition: 'all 0.1s' }}
            >
              {STAGE_LABELS[t]}
            </button>
          ))}
        </div>

        <input
          style={{ ...inp, flex: 1, padding: '3px 8px', fontSize: 12 }}
          placeholder="Step label"
          value={step.label}
          onChange={e => onChange({ label: e.target.value })}
        />

        {/* Move / delete */}
        <div style={{ display: 'flex', gap: 2 }}>
          <button onClick={onMoveUp}   disabled={index === 0}          style={iconBtn}>↑</button>
          <button onClick={onMoveDown} disabled={index === total - 1}  style={iconBtn}>↓</button>
          <button onClick={onRemove}                                    style={{ ...iconBtn, color: 'var(--red)' }}>×</button>
        </div>
      </div>

      {/* Body */}
      <textarea
        style={{ ...inp, borderRadius: 0, border: 'none', resize: 'vertical', minHeight: 80, fontFamily: 'inherit', lineHeight: 1.5, padding: '8px 10px' }}
        placeholder={`Describe what happens in this step.\ne.g. Open Instagram saved posts, extract 5 most recent reel URLs, collect likes and comments for each`}
        value={step.body}
        onChange={e => onChange({ body: e.target.value })}
      />
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  width: 22, height: 22, borderRadius: 4, border: 'none',
  background: 'transparent', color: 'var(--text-muted)',
  fontSize: 12, cursor: 'pointer', display: 'flex',
  alignItems: 'center', justifyContent: 'center',
}

// ── PlatformPicker — 다중 선택 가능한 플랫폼 칩 리스트 ────────────────────

interface PlatformPickerProps {
  platforms: string[]
  onChange: (platforms: string[]) => void
}

function PlatformPicker({ platforms, onChange }: PlatformPickerProps) {
  const [custom, setCustom] = useState('')

  const toggle = (p: string) =>
    onChange(platforms.includes(p) ? platforms.filter(x => x !== p) : [...platforms, p])

  const addCustom = () => {
    const val = custom.trim().toUpperCase().replace(/\s+/g, '_')
    if (!val || platforms.includes(val)) { setCustom(''); return }
    onChange([...platforms, val])
    setCustom('')
  }

  const allShown = [...ALL_PLATFORMS, ...platforms.filter(p => !ALL_PLATFORMS.includes(p))]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {allShown.map(p => {
          const active = platforms.includes(p)
          const isCustom = !ALL_PLATFORMS.includes(p)
          return (
            <button
              key={p}
              onClick={() => toggle(p)}
              style={{
                padding: '4px 10px', borderRadius: 5,
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'var(--accent-dim)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: 11, fontWeight: active ? 700 : 400, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              {PLATFORM_LABELS[p] ?? p}
              {isCustom && active && (
                <span style={{ fontSize: 10, opacity: 0.7 }}>·custom</span>
              )}
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          style={{ ...inp, flex: 1, fontSize: 11 }}
          placeholder="Add custom platform…"
          value={custom}
          onChange={e => setCustom(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } }}
        />
        <button
          onClick={addCustom}
          disabled={!custom.trim()}
          style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: custom.trim() ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: 11, cursor: custom.trim() ? 'pointer' : 'default' }}
        >
          Add
        </button>
      </div>
    </div>
  )
}

// ── SkillRow / list — 좌측 리스트 뷰 (Editor 모드 진입 전 선택기) ────────

const PLATFORM_ICONS: Record<string, string> = {
  INSTAGRAM: 'IG', TIKTOK: 'TK', YOUTUBE: 'YT', TWITTER: 'TW', LINKEDIN: 'LI',
  GOOGLE_ANALYTICS: 'GA', GOOGLE_ADS: 'GAd', META_ADS: 'MA', NOTION: 'No',
}

// ── SkillDashCard — 메인 대시보드의 스킬 카드 ────────────────────────────
// 스킬 1개당 제목/태그/플랫폼·호출 횟수 게이지(maxRuns 대비) 표시. 클릭하면 편집 진입.

type SkillStatsEntry = {
  executions: number; avgTokens: number; totalCost: number
  lastUsed: number; models: Record<string, number>
}

function SkillDashCard({ skill, stats, maxRuns, onClick }: { skill: SkillManifest; stats?: SkillStatsEntry; maxRuns: number; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const st = stats
  const runs = st?.executions ?? 0
  const barPct = maxRuns > 0 ? runs / maxRuns : 0

  const topModel = st ? (Object.entries(st.models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '') : ''
  const shortModel = topModel.includes('/') ? topModel.split('/').slice(-1)[0] : topModel
  const avgTok = st?.avgTokens ?? 0
  const avgTokStr = avgTok >= 1000 ? `${(avgTok / 1000).toFixed(1)}K` : String(avgTok)
  const lastUsed = st?.lastUsed ? new Date(st.lastUsed).toLocaleDateString() : '—'

  const meta: { label: string; value: React.ReactNode }[] = [
    { label: 'Avg tokens', value: st ? avgTokStr : '—' },
    // Cost — DisplayCost 가 markup IPC + loading/error 처리. raw 가 0 이면 '—'.
    { label: 'Cost',       value: st?.totalCost
        ? <DisplayCost rawUsd={st.totalCost} showZero />
        : '—' },
    { label: 'Model',      value: shortModel || '—' },
    { label: 'Last run',   value: lastUsed },
  ]

  const steps = skill.steps ?? []

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        textAlign: 'left', width: '100%',
        border: `1px solid ${hover ? 'var(--accent)' : 'rgba(20, 32, 27,0.07)'}`,
        borderRadius: 10, overflow: 'hidden',
        background: hover ? 'rgba(13, 92, 80,0.06)' : 'rgba(20, 32, 27,0.025)',
        cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
        display: 'flex', flexDirection: 'column',
        boxShadow: hover ? '0 0 0 1px rgba(13, 92, 80,0.25), 0 4px 16px rgba(0,0,0,0.25)' : '0 1px 4px rgba(0,0,0,0.2)',
      }}
    >
      {/* Header: name + frequency bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px 9px', borderBottom: '1px solid rgba(20, 32, 27,0.06)' }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0, opacity: 0.85 }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {skill.displayName || skill.name}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Runs</span>
          <div style={{ width: 44, height: 3, borderRadius: 2, background: 'rgba(20, 32, 27,0.08)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${barPct * 100}%`, borderRadius: 2, background: 'var(--accent)', transition: 'width 0.3s ease' }} />
          </div>
          <span style={{ fontSize: 11, fontWeight: 600, color: runs > 0 ? 'var(--text-primary)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)', minWidth: 14, textAlign: 'right' }}>
            {runs}
          </span>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '8px 14px 10px', display: 'flex', flexDirection: 'column', gap: 7 }}>

        {/* Description */}
        {skill.description && (
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {skill.description}
          </p>
        )}

        {/* Steps list */}
        {steps.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {steps.map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0, minWidth: 12, textAlign: 'right' }}>
                  {i + 1}.
                </span>
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, flexShrink: 0,
                  background: (STAGE_COLORS[step.type as StageType] ?? 'var(--text-secondary)') + '22',
                  color: STAGE_COLORS[step.type as StageType] ?? 'var(--text-secondary)',
                  letterSpacing: '0.04em',
                }}>
                  {STAGE_LABELS[step.type as StageType] ?? step.type}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', paddingTop: 1, borderTop: '1px solid rgba(20, 32, 27,0.04)', marginTop: 1 }}>
          {meta.map(({ label, value }) => (
            <div key={label} style={{ display: 'flex', gap: 4, alignItems: 'baseline', paddingTop: 4 }}>
              <span style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: st ? 'var(--text-secondary)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </button>
  )
}

// ── Main panel — SkillsPanel 본체 ─────────────────────────────────────────
// Dashboard ↔ Editor 2 모드를 토글. 내장 스킬과 커스텀 스킬을 분리해 나열.
// onSkillsChanged 이벤트를 구독해 파일시스템에서 스킬이 추가/삭제될 때 자동 재로드.

export function SkillsPanel() {
  const [skills,         setSkills]         = useState<SkillManifest[]>([])
  const [selected,       setSelected]       = useState<SkillManifest | null>(null)
  const [source,         setSource]         = useState<string | null>(null)
  const [loadingSource,  setLoadingSource]  = useState(false)
  const [search,         setSearch]         = useState('')
  const [mode,           setMode]           = useState<'list' | 'create' | 'edit'>('list')
  const [deleteConfirm,  setDeleteConfirm]  = useState(false)
  const [deleting,       setDeleting]       = useState(false)
  const [skillStats,     setSkillStats]     = useState<Record<string, SkillStatsEntry>>({})
  const [proposing,      setProposing]      = useState(false)
  const [proposeMode,    setProposeMode]    = useState<'upsert' | 'delete'>('upsert')
  const [proposeTitle,   setProposeTitle]   = useState('')
  const [proposeDesc,    setProposeDesc]    = useState('')
  const [proposeBusy,    setProposeBusy]    = useState(false)
  const [proposeMsg,     setProposeMsg]     = useState<string | null>(null)

  useEffect(() => {
    window.twixy.getSkillStats?.().then((s: typeof skillStats) => setSkillStats(s ?? {}))
  }, [])

  const load = useCallback(async () => {
    const list = await window.twixy.listSkills()
    setSkills(list)
  }, [])

  useEffect(() => {
    load()
    const off = window.twixy.onSkillsChanged?.(() => load())
    return () => { off?.() }
  }, [load])

  const selectSkill = useCallback(async (skill: SkillManifest) => {
    setSelected(skill)
    setMode('list')
    setSource(null)
    setDeleteConfirm(false)
    setLoadingSource(true)
    const res = await window.twixy.readSkillSource(skill.name)
    setLoadingSource(false)
    setSource(res.ok ? res.source : `// Error: ${res.error}`)
  }, [])

  const handleDelete = useCallback(async () => {
    if (!selected) return
    setDeleting(true)
    const res = await window.twixy.deleteSkill(selected.name)
    setDeleting(false)
    setDeleteConfirm(false)
    if (res.ok) {
      setSelected(null); setSource(null); setMode('list')
      await load()
    }
  }, [selected, load])

  // Open an MR that promotes the currently-selected custom skill to shared/.
  // Reads the user's .tskill source + compiled SKILL.md, checks whether the
  // shared version exists (→ modify) or not (→ add), and submits.
  const submitPropose = useCallback(async () => {
    if (!selected) return
    setProposeBusy(true)
    setProposeMsg(null)
    try {
      const tskillShared = `shared/skills/${selected.name}/${selected.name}.tskill`
      const mdShared     = `shared/skills/${selected.name}/SKILL.md`

      let changes: MRChangeInput[]
      let defaultTitle: string

      if (proposeMode === 'delete') {
        const [tskillExists, mdExists] = await Promise.all([
          window.twixy.mrReadShared(tskillShared),
          window.twixy.mrReadShared(mdShared),
        ])
        changes = []
        if (tskillExists.ok) changes.push({ op: 'delete', path: tskillShared })
        if (mdExists.ok)     changes.push({ op: 'delete', path: mdShared })
        if (changes.length === 0) {
          setProposeMsg('Skill is not in shared/')
          return
        }
        defaultTitle = `Remove shared skill: ${selected.name}`
      } else {
        const tskillRel = `skills/${selected.name}/${selected.name}.tskill`
        const mdRel     = `skills/${selected.name}/SKILL.md`
        const [src, md] = await Promise.all([
          window.twixy.readFile(tskillRel),
          window.twixy.readFile(mdRel),
        ])
        if (src == null || md == null) {
          setProposeMsg('Could not read skill files')
          return
        }

        const [tskillExists, mdExists] = await Promise.all([
          window.twixy.mrReadShared(tskillShared),
          window.twixy.mrReadShared(mdShared),
        ])
        changes = [
          tskillExists.ok
            ? { op: 'modify', path: tskillShared, content: src }
            : { op: 'add',    path: tskillShared, content: src },
          mdExists.ok
            ? { op: 'modify', path: mdShared, content: md }
            : { op: 'add',    path: mdShared, content: md },
        ]
        defaultTitle = `Propose skill: ${selected.name}`
      }

      const res = await window.twixy.mrCreate({
        title:       proposeTitle.trim() || defaultTitle,
        description: proposeDesc.trim() || undefined,
        changes,
      })
      if (!res.ok) {
        setProposeMsg(res.error ?? 'failed to open MR')
        return
      }
      setProposing(false)
      setProposeTitle('')
      setProposeDesc('')
      setProposeMsg('Merge request opened — review in the Merge Requests tab.')
    } finally {
      setProposeBusy(false)
    }
  }, [selected, proposeTitle, proposeDesc, proposeMode])

  const filtered = search
    ? skills.filter(s =>
        s.name.includes(search.toLowerCase()) ||
        s.displayName.toLowerCase().includes(search.toLowerCase()) ||
        s.description.toLowerCase().includes(search.toLowerCase()))
    : skills

  const custom   = filtered.filter(s => s.author === 'user')
  const builtins = filtered.filter(s => s.author !== 'user')

  // ── Editor mode ───────────────────────────────────────────────────────────

  if (mode === 'create' || mode === 'edit') {
    return (
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--bg-base)' }}>
        <SkillList
          custom={custom} builtins={builtins} search={search}
          onSearch={setSearch} selected={selected}
          onSelect={selectSkill}
          onNew={() => { setSelected(null); setMode('create') }}
          creating={mode === 'create'}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-surface)' }}>
          <SkillEditor
            initialName={mode === 'edit' ? selected?.name ?? '' : ''}
            initialSource={mode === 'edit' ? source ?? undefined : undefined}
            onDone={async () => { setMode('list'); await load(); if (selected) selectSkill(selected) }}
            onCancel={() => setMode('list')}
          />
        </div>
      </div>
    )
  }

  // ── Dashboard (default / no selection) ───────────────────────────────────

  if (!selected) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg-base)' }}>
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Skills</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{skills.length} total</span>
          <div style={{ flex: 1 }} />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            style={{ width: 180, background: 'var(--bg-hover)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, padding: '5px 8px', outline: 'none' }}
          />
          <button
            onClick={() => { setSelected(null); setMode('create') }}
            style={{ border: 'none', borderRadius: 6, padding: '6px 14px', background: 'var(--accent)', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600, flexShrink: 0 }}
          >
            + New Skill
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

          {/* Custom skills — full-width rows, sorted by runs */}
          {custom.length > 0 && (() => {
            const sorted = [...custom].sort((a, b) => (skillStats[b.name]?.executions ?? 0) - (skillStats[a.name]?.executions ?? 0))
            const maxRuns = skillStats[sorted[0]?.name]?.executions ?? 0
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {sorted.map(s => (
                  <SkillDashCard key={s.name} skill={s} stats={skillStats[s.name]} maxRuns={maxRuns} onClick={() => selectSkill(s)} />
                ))}
              </div>
            )
          })()}

          {/* Empty state */}
          {custom.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, height: 300, color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 40, opacity: 0.25 }}>⚡</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{search ? 'No results' : 'No skills yet'}</div>
              {!search && <div style={{ fontSize: 12 }}>Create a custom skill to automate your workflow</div>}
              {!search && (
                <button
                  onClick={() => setMode('create')}
                  style={{ marginTop: 4, border: 'none', borderRadius: 8, padding: '8px 20px', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  + Create Skill
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Detail mode ───────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--bg-base)' }}>

      <SkillList
        custom={custom} builtins={builtins} search={search}
        onSearch={setSearch} selected={selected}
        onSelect={selectSkill}
        onNew={() => { setSelected(null); setMode('create') }}
        creating={false}
        onBack={() => { setSelected(null); setSource(null) }}
      />

      {/* Detail pane */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-surface)' }}>

        {/* Header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {selected.displayName || selected.name}
                </span>
                {selected.author === 'user' && (
                  <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--accent-dim)', color: 'var(--accent)', padding: '2px 6px', borderRadius: 4 }}>
                    CUSTOM
                  </span>
                )}
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>v{selected.version}</span>
              </div>
              {selected.description && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  {selected.description}
                </div>
              )}
              {selected.platforms.length > 0 && (
                <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                  {selected.platforms.map(p => (
                    <span key={p} style={{ fontSize: 10, background: 'var(--bg-hover)', color: 'var(--text-muted)', padding: '2px 6px', borderRadius: 4 }}>
                      {PLATFORM_ICONS[p] ?? p.slice(0, 2)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {selected.author === 'user' && (
              <div style={{ flexShrink: 0, display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setMode('edit')}
                  style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
                >
                  Edit
                </button>
                <button
                  onClick={() => { setProposing(true); setProposeMode('upsert'); setProposeMsg(null) }}
                  title="Open a merge request to promote this skill to the shared team library"
                  style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
                >
                  Propose to shared
                </button>
                {!deleteConfirm ? (
                  <button onClick={() => setDeleteConfirm(true)} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                    Delete
                  </button>
                ) : (
                  <>
                    <button onClick={handleDelete} disabled={deleting} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--red)', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                      {deleting ? '…' : 'Confirm'}
                    </button>
                    <button onClick={() => setDeleteConfirm(false)} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </>
                )}
              </div>
            )}
            {selected.author !== 'user' && (
              <div style={{ flexShrink: 0, display: 'flex', gap: 6 }}>
                <button
                  onClick={() => { setProposing(true); setProposeMode('delete'); setProposeMsg(null) }}
                  title="Open a merge request to remove this skill from the shared team library"
                  style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}
                >
                  Propose delete from shared
                </button>
              </div>
            )}

          {proposing && (
            <div style={{
              marginTop: 14, padding: 12,
              background: 'var(--bg-hover)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {proposeMode === 'delete'
                  ? <>Remove <code>shared/skills/{selected.name}</code> from the team library. Owner or reviewers must approve.</>
                  : <>Propose this skill to <code>shared/skills/{selected.name}</code>. Owner or reviewers must approve before it becomes available to the team.</>}
              </div>
              <input
                value={proposeTitle}
                onChange={e => setProposeTitle(e.target.value)}
                placeholder={proposeMode === 'delete' ? `Remove shared skill: ${selected.name}` : `Propose skill: ${selected.name}`}
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 12, padding: '6px 8px', outline: 'none' }}
              />
              <textarea
                value={proposeDesc}
                onChange={e => setProposeDesc(e.target.value)}
                placeholder={proposeMode === 'delete' ? 'Why remove this skill? (optional)' : 'What does this skill do? (optional)'}
                rows={3}
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 12, padding: '6px 8px', outline: 'none', fontFamily: 'inherit', resize: 'vertical' }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={submitPropose}
                  disabled={proposeBusy}
                  style={{
                    padding: '5px 12px', borderRadius: 6, border: 'none',
                    background: proposeMode === 'delete' ? 'var(--red)' : 'var(--accent)',
                    color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {proposeBusy ? '…' : (proposeMode === 'delete' ? 'Open delete MR' : 'Open MR')}
                </button>
                <button
                  onClick={() => { setProposing(false); setProposeMsg(null); setProposeTitle(''); setProposeDesc('') }}
                  disabled={proposeBusy}
                  style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </div>
              {proposeMsg && (
                <div style={{ fontSize: 11, color: proposeMsg.startsWith('Merge request') ? 'var(--accent)' : 'var(--danger)' }}>
                  {proposeMsg}
                </div>
              )}
            </div>
          )}
          </div>
        </div>

        {/* Usage stats */}
        {(() => {
          const st = skillStats[selected.name]
          const topModel = st ? (Object.entries(st.models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '') : ''
          const shortModel = topModel.includes('/') ? topModel.split('/').slice(-1)[0] : topModel
          const lastUsed = st?.lastUsed ? new Date(st.lastUsed).toLocaleDateString() : '—'
          const avgTok = st?.avgTokens ?? 0
          return (
            <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {([
                { label: 'Runs',       value: st ? String(st.executions) : '0' },
                { label: 'Avg tokens', value: st ? (avgTok >= 1000 ? `${(avgTok/1000).toFixed(1)}K` : String(avgTok)) : '—' },
                { label: 'Total cost', value: st?.totalCost
                    ? <DisplayCost rawUsd={st.totalCost} showZero />
                    : '—' },
                { label: 'Model',      value: shortModel || '—' },
                { label: 'Last run',   value: lastUsed },
              ] as { label: string; value: React.ReactNode }[]).map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: st ? 'var(--text-primary)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{value}</span>
                </div>
              ))}
            </div>
          )
        })()}

        {/* Source viewer */}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 0' }}>
          {loadingSource ? (
            <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>
          ) : source ? (
            <pre
              style={{ margin: 0, padding: '0 20px', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.65, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'transparent' }}
              dangerouslySetInnerHTML={{ __html: safeHtml(highlightTSL(source)) }}
            />
          ) : (
            <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>No source found</div>
          )}
        </div>

      </div>
    </div>
  )
}

// ── SkillList — Dashboard / Editor 양쪽에서 공유하는 리스트 뷰 ──────────
// 좌측 사이드바 형태로, 검색 입력 + 커스텀/내장 섹션 + 신규 버튼 포함.

interface SkillListProps {
  custom: SkillManifest[]
  builtins: SkillManifest[]
  search: string
  onSearch: (v: string) => void
  selected: SkillManifest | null
  onSelect: (s: SkillManifest) => void
  onNew: () => void
  creating: boolean
  onBack?: () => void
}

function SkillList({ custom, builtins, search, onSearch, selected, onSelect, onNew, creating, onBack }: SkillListProps) {
  return (
    <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {/* Back to dashboard */}
        {onBack && (
          <button
            onClick={onBack}
            style={{ display: 'flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', padding: '0 0 8px 0', width: '100%' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)' }}
          >
            ← Dashboard
          </button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>Skills</span>
          <button
            onClick={onNew}
            style={{ border: 'none', borderRadius: 6, padding: '4px 10px', background: creating ? 'var(--accent-dim)' : 'var(--bg-hover)', color: creating ? 'var(--accent)' : 'var(--text-muted)', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
          >
            + New
          </button>
        </div>
        <input
          value={search} onChange={e => onSearch(e.target.value)}
          placeholder="Search…"
          style={{ width: '100%', background: 'var(--bg-hover)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, padding: '5px 8px', outline: 'none' }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 4px' }}>
        {custom.length > 0 && (
          <>
            <SectionLabel label="Custom" count={custom.length} />
            {custom.map(s => <SkillRowItem key={s.name} skill={s} active={selected?.name === s.name && !creating} onClick={() => onSelect(s)} />)}
          </>
        )}
        {builtins.length > 0 && (
          <>
            <SectionLabel label="Built-in" count={builtins.length} />
            {builtins.map(s => <SkillRowItem key={s.name} skill={s} active={selected?.name === s.name && !creating} onClick={() => onSelect(s)} />)}
          </>
        )}
        {custom.length === 0 && builtins.length === 0 && (
          <div style={{ padding: '20px 10px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
            {search ? 'No results' : 'No skills'}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.08em', padding: '8px 10px 4px', textTransform: 'uppercase' }}>
      {label} · {count}
    </div>
  )
}

function SkillRowItem({ skill, active, onClick }: { skill: SkillManifest; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', borderRadius: 7, padding: '8px 10px', background: active ? 'rgba(13, 92, 80,0.15)' : 'transparent', display: 'flex', flexDirection: 'column', gap: 2, transition: 'background 0.1s' }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: active ? 'var(--accent)' : 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {skill.displayName || skill.name}
        </span>
        {skill.author === 'user' && (
          <span style={{ fontSize: 9, fontWeight: 700, background: 'var(--accent-dim)', color: 'var(--accent)', padding: '1px 5px', borderRadius: 3 }}>
            CUSTOM
          </span>
        )}
      </div>
      {skill.platforms.length > 0 && (
        <div style={{ display: 'flex', gap: 3 }}>
          {skill.platforms.slice(0, 4).map(p => (
            <span key={p} style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg-hover)', padding: '1px 4px', borderRadius: 3 }}>
              {PLATFORM_ICONS[p] ?? p.slice(0, 2)}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}
