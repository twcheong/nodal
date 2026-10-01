// "에이전트 툴로 저장" — 지금 에디터 그래프를 템플릿 파일로 저장한다. 저장하면 엔진이 재시작되고
// 에이전트에게 nodal__run_template_<이름> 툴이 생긴다.
//
// 사용자가 정할 것: 툴 이름·설명(에이전트가 언제 쓸지 판단하는 글), 밖에서 받을 입력, 돌려줄 결과.
import { useMemo, useState } from 'react'
import { Button } from '../../../../src/components/ui/Button'
import { Checkbox } from '../../../../src/components/ui/Checkbox'
import { Input } from '../../../../src/components/ui/Input'
import { Textarea } from '../../../../src/components/ui/Textarea'
import { isLink, type InputValue } from '../../engine/apps/web/src/graph/types'
import { useEditorStore } from '../../engine/apps/web/src/state/editorStore'
import { engineApi } from '../engineApi'
import { checkTemplatePicks, graphToTemplate, suggestPicks, type ParamPick, type ReturnPick } from './templateConvert'

interface Row { key: string; label: string; pick: ParamPick; on: boolean }

export function SaveTemplateDialog({ existing, onCancel, onSaved }: {
  existing: string[]
  onCancel: () => void
  onSaved: (id: string) => void
}) {
  const graph = useEditorStore((s) => s.graph)
  const schemas = useEditorStore((s) => s.schemas)
  const outputSockets = (type: string) => schemas.find((s) => s.id === type)?.outputs?.map((o) => o.name) ?? []
  const suggested = useMemo(() => suggestPicks(graph, outputSockets), [graph, schemas])   // eslint-disable-line react-hooks/exhaustive-deps

  const [id, setId] = useState('')
  const [doc, setDoc] = useState('')
  // 입력 후보: image.Load 전부(기본 켬) + 다른 노드의 리터럴 입력 전부(기본 끔).
  const [rows, setRows] = useState<Row[]>(() => {
    const out: Row[] = suggested.params.map((p) => ({ key: `img:${p.nodeId}`, label: `이미지 — ${graph.nodes?.[p.nodeId]?.meta?.title ?? p.nodeId}`, pick: p, on: true }))
    for (const [nodeId, node] of Object.entries(graph.nodes ?? {})) {
      if (node.type === 'image.Load') continue
      for (const [input, value] of Object.entries(node.inputs ?? {})) {
        if (isLink(value as InputValue) || (value !== null && typeof value === 'object')) continue
        out.push({ key: `lit:${nodeId}.${input}`, label: `${node.meta?.title ?? nodeId} · ${input} = ${JSON.stringify(value)}`, pick: { kind: 'literal', nodeId, input, name: input }, on: false })
      }
    }
    return out
  })
  const [returns, setReturns] = useState<Array<ReturnPick & { on: boolean }>>(() => suggested.returns.map((r) => ({ ...r, on: true })))
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const params = rows.filter((r) => r.on).map((r) => r.pick)
    const rets = returns.filter((r) => r.on).map(({ on: _on, ...r }) => r)
    const errs = checkTemplatePicks(graph, id, doc, params, rets)
    if (existing.includes(id) && !confirm(`"${id}" 템플릿이 이미 있습니다. 덮어쓸까요?`)) return
    setErrors(errs)
    if (errs.length) return
    setBusy(true)
    try {
      const res = await engineApi.templates.save(id, graphToTemplate(graph, { id, doc, params, returns: rets }))
      if (!res.ok) setErrors(['저장은 됐지만 엔진이 다시 뜨지 않았습니다 — 엔진 탭의 로그를 확인하세요'])
      else onSaved(id)
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div style={{ width: 560, maxHeight: '85vh', overflow: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg, 10px)', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>에이전트 툴로 저장</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          저장하면 채팅의 AI 가 이 그래프를 <code>nodal__run_template_{id || '이름'}</code> 툴로 쓸 수 있습니다. 엔진이 한 번 재시작됩니다.
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          이름 (영문 소문자·숫자·_)
          <Input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="product_backdrop" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          설명 — AI 가 언제 이 툴을 쓸지 이 글을 보고 정합니다
          <Textarea rows={3} value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="제품 사진을 받아 흰 배경의 정사각 썸네일로 만든다." />
        </label>

        <div style={{ fontSize: 12, fontWeight: 600 }}>밖에서 받을 입력</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflow: 'auto' }}>
          {rows.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>입력으로 뺄 값이 없습니다.</div>}
          {rows.map((r, i) => (
            <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Checkbox checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} label={<span style={{ fontSize: 12 }}>{r.label}</span>} />
              {r.on && (
                <Input size="sm" style={{ width: 140, marginLeft: 'auto' }} value={r.pick.name}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pick: { ...x.pick, name: e.target.value } } : x)))} />
              )}
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12, fontWeight: 600 }}>돌려줄 결과</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {returns.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>출력 노드가 없습니다 — 에디터에서 저장(Save) 노드를 출력으로 지정하세요.</div>}
          {returns.map((r, i) => (
            <Checkbox key={`${r.nodeId}.${r.socket}`} checked={r.on}
              onChange={(e) => setReturns(returns.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))}
              label={<span style={{ fontSize: 12 }}>{graph.nodes?.[r.nodeId]?.meta?.title ?? r.nodeId} · {r.socket}</span>} />
          ))}
        </div>

        {errors.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--danger, #b42318)' }}>
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>취소</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>저장</Button>
        </div>
      </div>
    </div>
  )
}
