// ─────────────────────────────────────────────────────────────────────────────
// ToolsCatalog.tsx — Workflow 뷰 좌측 하단 패널.
// WORKFLOW_TOOLS 카탈로그 (closed vocabulary) 를 트리 형태로 렌더. Tool 클릭
// 시 그 안의 Tool Skill 들 펼침. Tool Skill 중 skills/<id>/ backing 이 있는
// 것만 클릭 가능 — 클릭하면 SkillReader 모달이 SKILL.md (or .tskill 폴백) 를
// 띄움. backing 여부는 listSkills() + onSkillsChanged 이벤트 구독으로 동적
// 갱신 — 새 .tskill 이 추가/삭제되면 다음 broadcast 에 반영.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { WORKFLOW_TOOLS } from '../../lib/workflowTools'
import { SkillReader } from './SkillReader'

export function ToolsCatalog() {
  const [openTool, setOpenTool] = useState<string | null>(null)
  // 디스크에 실제 존재하는 skill id 들 — backing 여부 판단용.
  // listSkills 가 SkillManifest[] 를 반환, name 필드를 catalog id 와 매칭.
  const [availableIds, setAvailableIds] = useState<Set<string>>(new Set())
  // 모달 상태 — null 이면 닫힘.
  const [reader, setReader] = useState<{ id: string; label: string } | null>(null)

  // 마운트 시 1회 + skills-changed 이벤트마다 재조회.
  useEffect(() => {
    const refresh = async () => {
      try {
        const list = await window.twixy?.listSkills?.()
        if (!Array.isArray(list)) return
        setAvailableIds(new Set(list.map(m => m.name)))
      } catch { /* 조회 실패 시 빈 셋 유지 — 클릭만 비활성화될 뿐 catalog 자체는 보임 */ }
    }
    void refresh()
    const dispose = window.twixy?.onSkillsChanged?.(() => { void refresh() })
    return () => { try { dispose?.() } catch { /* noop */ } }
  }, [])

  // hover 효과 in-component — 인라인 스타일이라 :hover 가 안 먹어서 mouse 이벤트로.
  const [hoverKey, setHoverKey] = useState<string | null>(null)

  // Tool Skill 클릭 — backing 있는 경우만 호출자에서 막혀 들어옴.
  const openReader = (id: string, label: string) => setReader({ id, label })

  return (
    <section style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
    }}>
      <header style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-secondary)',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}>
        Tools &amp; Tool Skills
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
        {WORKFLOW_TOOLS.map(tool => {
          const isOpen = openTool === tool.id
          const hasSkills = tool.skills.length > 0
          return (
            <div key={tool.id}>
              <div
                onClick={() => hasSkills && setOpenTool(isOpen ? null : tool.id)}
                onMouseEnter={() => hasSkills && setHoverKey(`tool:${tool.id}`)}
                onMouseLeave={() => setHoverKey(null)}
                title={tool.description}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 14px',
                  fontSize: 12,
                  cursor: hasSkills ? 'pointer' : 'default',
                  color: 'var(--text-secondary)',
                  background: hoverKey === `tool:${tool.id}` ? 'var(--bg-hover)' : 'transparent',
                }}
              >
                <span style={{
                  fontSize: 8,
                  color: 'var(--text-muted)',
                  width: 8,
                  display: 'inline-block',
                  opacity: hasSkills ? 0.8 : 0,
                  transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.12s',
                }}>▸</span>
                <span style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                }}>
                  [{tool.label}]
                </span>
              </div>
              {isOpen && hasSkills && (
                <div style={{ paddingBottom: 4 }}>
                  {tool.skills.map(skill => {
                    const clickable = availableIds.has(skill.id)
                    const hoverK = `skill:${tool.id}:${skill.id}`
                    return (
                      <div
                        key={skill.id}
                        onClick={() => clickable && openReader(skill.id, skill.label)}
                        onMouseEnter={() => clickable && setHoverKey(hoverK)}
                        onMouseLeave={() => setHoverKey(null)}
                        title={clickable
                          ? `${skill.description} — click to read runbook`
                          : skill.description}
                        style={{
                          padding: '2px 14px 2px 36px',
                          fontSize: 11,
                          fontFamily: 'var(--font-mono)',
                          color: clickable ? 'var(--text-secondary)' : 'var(--text-muted)',
                          cursor: clickable ? 'pointer' : 'default',
                          background: hoverKey === hoverK ? 'var(--bg-hover)' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                        }}
                      >
                        <span style={{ opacity: 0.6 }}>·</span>
                        <span style={{
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {skill.label}
                        </span>
                        {clickable && (
                          <span style={{ fontSize: 9, opacity: 0.7 }}>📄</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <SkillReader
        open={!!reader}
        skillId={reader?.id ?? null}
        label={reader?.label ?? ''}
        onClose={() => setReader(null)}
      />
    </section>
  )
}
