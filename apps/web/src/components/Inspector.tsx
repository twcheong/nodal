import { useEditorStore } from "../state/editorStore";

export function Inspector(): React.JSX.Element {
  const selected = useEditorStore((state) => state.selectedNodeIds);
  const graph = useEditorStore((state) => state.graph);
  const runtime = useEditorStore((state) => state.runtime);
  const issues = useEditorStore((state) => state.issues);
  const runStatus = useEditorStore((state) => state.runStatus);
  const toggleOutput = useEditorStore((state) => state.toggleOutput);
  const selectedId = selected.at(-1);
  const node = selectedId ? graph.nodes?.[selectedId] : undefined;

  return (
    <aside className="inspector">
      <div className="panel-heading"><span>INSPECTOR</span></div>
      {node && selectedId ? (
        <div className="inspector-body">
          <small>선택한 노드</small>
          <h2>{node.meta?.title || node.type}</h2>
          <code>{selectedId}</code>
          <dl>
            <div><dt>타입</dt><dd>{node.type}</dd></div>
            <div><dt>상태</dt><dd>{runtime[selectedId]?.status ?? "idle"}</dd></div>
            <div><dt>입력</dt><dd>{Object.keys(node.inputs ?? {}).length}</dd></div>
          </dl>
          <button
            className={`output-toggle${graph.outputs?.includes(selectedId) ? " active" : ""}`}
            type="button"
            onClick={() => toggleOutput(selectedId)}
          >
            {graph.outputs?.includes(selectedId) ? "✓ 실행 출력" : "실행 출력으로 지정"}
          </button>
        </div>
      ) : (
        <p className="empty-state">노드를 선택하면 세부정보가 표시됩니다.</p>
      )}
      <div className="activity">
        <div className="panel-heading"><span>RUN ACTIVITY</span><b>{runStatus ?? "idle"}</b></div>
        {issues.length ? (
          issues.map((issue) => <p className="activity-error" key={`${issue.code}:${issue.location}`}>{issue.message}</p>)
        ) : (
          <p className="empty-state">오류가 없습니다.</p>
        )}
      </div>
    </aside>
  );
}
