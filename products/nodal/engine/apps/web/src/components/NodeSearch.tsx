import { useEffect, useMemo, useRef, useState } from "react";

import { searchSchemas } from "../editor/search";
import { useEditorStore } from "../state/editorStore";

export function NodeSearch(): React.JSX.Element | null {
  const search = useEditorStore((state) => state.search);
  const schemas = useEditorStore((state) => state.schemas);
  const addNode = useEditorStore((state) => state.addNode);
  const closeSearch = useEditorStore((state) => state.closeSearch);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchSchemas(schemas, query).slice(0, 10), [query, schemas]);

  useEffect(() => {
    if (!search.open) return;
    setQuery("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [search.open]);

  if (!search.open) return null;
  const choose = (index = 0) => {
    const schema = results[index];
    if (!schema) return;
    addNode(schema, search.flowPosition);
    closeSearch();
  };

  return (
    <div className="search-backdrop" onPointerDown={closeSearch}>
      <section className="node-search" onPointerDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="노드 이름, 별칭, 한글로 검색…"
          aria-label="노드 검색"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeSearch();
            if (event.key === "Enter") choose();
          }}
        />
        <ul>
          {results.map((schema, index) => (
            <li key={schema.id}>
              <button type="button" onClick={() => choose(index)}>
                <span>
                  <strong>{schema.title}</strong>
                  <small>{schema.id}</small>
                </span>
                <em>{schema.category}</em>
              </button>
            </li>
          ))}
        </ul>
        {!results.length ? <p>일치하는 노드가 없습니다.</p> : null}
        <footer>더블클릭으로 열기 · Enter로 첫 항목 추가 · Esc로 닫기</footer>
      </section>
    </div>
  );
}
