import { useMemo, useState } from "react";

import { searchSchemas } from "../editor/search";
import { useEditorStore } from "../state/editorStore";

export function NodePalette(): React.JSX.Element {
  const schemas = useEditorStore((state) => state.schemas);
  const catalogState = useEditorStore((state) => state.catalogState);
  const addNode = useEditorStore((state) => state.addNode);
  const graph = useEditorStore((state) => state.graph);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const grouped = new Map<string, ReturnType<typeof searchSchemas>>();
    for (const schema of searchSchemas(schemas, query)) {
      grouped.set(schema.category, [...(grouped.get(schema.category) ?? []), schema]);
    }
    return grouped;
  }, [query, schemas]);

  const add = (schema: (typeof schemas)[number]) => {
    const count = Object.keys(graph.nodes ?? {}).length;
    addNode(schema, { x: 160 + (count % 4) * 40, y: 100 + (count % 5) * 44 });
  };

  return (
    <aside className="palette">
      <div className="panel-heading">
        <span>NODE LIBRARY</span>
        <b>{schemas.length}</b>
      </div>
      <input
        className="palette-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="노드 검색"
        aria-label="팔레트 검색"
      />
      <div className="palette-groups">
        {catalogState === "loading" ? <p className="empty-state">카탈로그를 불러오는 중…</p> : null}
        {catalogState === "error" ? <p className="empty-state error">카탈로그 연결 실패</p> : null}
        {[...groups.entries()].map(([category, nodes]) => (
          <section className="palette-group" key={category}>
            <h2>{category}</h2>
            {nodes.map((schema) => (
              <button
                type="button"
                key={schema.id}
                title={schema.doc}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-nodal-node", schema.id);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onDoubleClick={() => add(schema)}
              >
                <span className="palette-icon">{schema.title.slice(0, 1)}</span>
                <span>
                  <strong>{schema.title}</strong>
                  <small>{schema.id}</small>
                </span>
                <i>＋</i>
              </button>
            ))}
          </section>
        ))}
      </div>
      <footer>끌어서 배치 · 더블클릭으로 추가</footer>
    </aside>
  );
}
