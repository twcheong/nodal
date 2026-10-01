// 노드 탭 — 엔진의 노드 에디터(engine/apps/web)를 앱 안에 그대로 띄운다.
//
// 에디터 코드는 복사하지 않는다 (subtree 로 계속 받는다). 여기서 하는 일은 세 가지뿐:
//   1. API 클라이언트를 IPC 중계판(IpcGraphApiClient)으로 바꿔 끼운다 — 엔진은 CORS 가 없다
//   2. 에디터 CSS 를 .nodal-editor 아래로 가둔다 — 원본은 :root·body 를 건드린다
//   3. 위에 템플릿 막대를 얹는다 — 템플릿 열기 / "에이전트 툴로 저장"
import '@xyflow/react/dist/style.css'
import editorCss from '../../engine/apps/web/src/styles.css?inline'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { App as EditorApp } from '../../engine/apps/web/src/App'
import { useEditorStore } from '../../engine/apps/web/src/state/editorStore'
import { Button } from '../../../../src/components/ui/Button'
import { Select } from '../../../../src/components/ui/Select'
import type { ProductViewProps } from '../../../../src/lib/productShell'
import { engineApi } from '../engineApi'
import { EngineNotice, useEngineStatus } from '../useEngineStatus'
import { IpcGraphApiClient } from './ipcClient'
import { installScopedCss } from './scopedCss'
import { SaveTemplateDialog } from './SaveTemplateDialog'
import { templateToGraph } from './templateConvert'

const SCOPE = '.nodal-editor'

// 사용자 앱에서 숨기는 개발자용 표면 — 원본을 고치지 않고(subtree) 여기서 가린다.
// 에디터 툴바가 바뀌면 이 선택자도 같이 볼 것 (engine/apps/web/src/components/Toolbar.tsx).
const HOST_CSS = `
${SCOPE} .toolbar nav > button:nth-of-type(5),   /* "200 노드 측정" 벤치마크 */
${SCOPE} .toolbar .fps,
${SCOPE} .toolbar .api-mode { display: none !important; }
`

export function NodesView({ active }: ProductViewProps) {
  installScopedCss('nodal-editor', editorCss, SCOPE)
  installScopedCss('nodal-editor-host', HOST_CSS, '')
  const { status, refresh } = useEngineStatus(active)
  const running = !!status?.running
  // 엔진이 재시작되면(템플릿 저장 등) 클라이언트를 새로 만들어 노드 목록을 다시 읽게 한다.
  const [generation, setGeneration] = useState(0)
  // generation 은 본문에서 안 읽지만 의도된 의존성이다 — 바뀌면 새 클라이언트(= 새 소켓·노드 목록).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo(() => (running ? new IpcGraphApiClient() : null), [running, generation])
  useEffect(() => () => api?.dispose(), [api])

  const [templates, setTemplates] = useState<string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const loadTemplates = useCallback(async () => {
    try { setTemplates((await engineApi.templates.list()).sort()) } catch { setTemplates([]) }
  }, [])
  useEffect(() => { if (active && running) void loadTemplates() }, [active, running, loadTemplates])

  const openTemplate = async (id: string) => {
    if (!id) return
    try {
      const doc = await engineApi.templates.read(id)
      useEditorStore.getState().loadGraph(templateToGraph(doc, id))
      setMessage(`"${id}" 를 열었습니다`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const onSaved = async (id: string) => {
    setSaving(false)
    setMessage(`"${id}" 를 저장했습니다 — 엔진을 다시 시작해 에이전트가 nodal__run_template_${id} 로 쓸 수 있게 했습니다`)
    await refresh()
    setGeneration((g) => g + 1)
    void loadTemplates()
  }

  if (!running || !api) {
    return <EngineNotice status={status} onRetry={() => void refresh()} />
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
        borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)', fontSize: 12,
      }}>
        <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>템플릿</span>
        <Select size="sm" value="" onChange={(e) => void openTemplate(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">열기…</option>
          {templates.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Button size="sm" variant="primary" onClick={() => setSaving(true)}>에이전트 툴로 저장</Button>
        {message && <span style={{ color: 'var(--text-muted)', marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{message}</span>}
      </div>
      <div className="nodal-editor" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <EditorApp key={generation} api={api} />
      </div>
      {saving && (
        <SaveTemplateDialog
          existing={templates}
          onCancel={() => setSaving(false)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}
