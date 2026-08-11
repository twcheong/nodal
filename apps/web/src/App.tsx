/**
 * M0 자리표시자.
 *
 * 캔버스(@xyflow/react)와 노드 팔레트는 M2 에서 들어온다. 지금 이 화면이
 * 증명하는 것은 하나뿐이다: 프론트가 백엔드에서 생성된 캐논 스키마를 그대로
 * 읽어 문서를 검증할 수 있다.
 */

import { useMemo, useState } from "react";

import { validateGraphDocument } from "./graph/schema";

const SAMPLE = JSON.stringify(
  {
    nodal_version: "1",
    nodes: {
      n_c3d4: { type: "image.Load", inputs: { path: "cat.png" } },
      n_a1b2: {
        type: "image.Resize",
        inputs: { image: { $link: ["n_c3d4", "image"] }, width: 512 },
      },
    },
    outputs: ["n_a1b2"],
  },
  null,
  2,
);

export function App(): React.JSX.Element {
  const [text, setText] = useState(SAMPLE);

  const result = useMemo(() => {
    try {
      return validateGraphDocument(JSON.parse(text));
    } catch {
      return { valid: false as const, issues: [{ location: "graph", message: "JSON 파싱 실패" }] };
    }
  }, [text]);

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", padding: "1.5rem", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: "1.1rem" }}>nodal — 캐논 그래프 검증 (M0)</h1>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        rows={20}
        style={{ width: "100%", fontFamily: "inherit", fontSize: "0.85rem" }}
      />
      {result.valid ? (
        <p>유효한 캐논 그래프 문서다.</p>
      ) : (
        <ul>
          {result.issues.map((issue) => (
            <li key={`${issue.location}:${issue.message}`}>
              <code>{issue.location}</code> — {issue.message}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
