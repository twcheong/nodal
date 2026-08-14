import { memo, useMemo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import type { InputSocket } from "../api/types";
import { describeSocketType, socketTypesCompatible } from "../editor/socketTypes";
import type { NodalFlowNode } from "../editor/types";
import { isLink, type JsonValue } from "../graph/types";
import { useEditorStore } from "../state/editorStore";

const STATUS_LABEL = {
  idle: "대기",
  queued: "예약",
  running: "실행 중",
  cached: "캐시",
  succeeded: "완료",
  error: "오류",
} as const;

export const NodalNode = memo(function NodalNode({ data, selected }: NodeProps<NodalFlowNode>) {
  const setLiteralInput = useEditorStore((state) => state.setLiteralInput);
  const beginConnection = useEditorStore((state) => state.beginConnection);
  const issueSockets = useMemo(
    () => new Set(data.issues.map((issue) => issue.socket).filter(Boolean)),
    [data.issues],
  );

  return (
    <article className={`nodal-node status-${data.runtime.status}${selected ? " is-selected" : ""}`}>
      <header className="node-header">
        <span className="node-category">{data.schema.category}</span>
        <span className="node-status" aria-label={`상태: ${STATUS_LABEL[data.runtime.status]}`}>
          <i /> {STATUS_LABEL[data.runtime.status]}
        </span>
        <strong>{data.graphNode.meta?.title || data.schema.title}</strong>
        <small>{data.schema.id}</small>
      </header>

      {data.runtime.progress ? (
        <div className="node-progress" aria-label="노드 진행률">
          <span
            style={{ width: `${(data.runtime.progress.step / data.runtime.progress.total) * 100}%` }}
          />
        </div>
      ) : null}

      <div className="node-sockets">
        {(data.schema.inputs ?? []).map((socket) => {
          const inputValue = data.graphNode.inputs?.[socket.name];
          const linked = inputValue !== undefined && isLink(inputValue);
          const compatible =
            data.connectionSourceType === null ||
            socketTypesCompatible(data.connectionSourceType, socket.type);
          return (
            <div
              className={`socket-row input${compatible ? " is-compatible" : " is-incompatible"}${issueSockets.has(socket.name) ? " has-error" : ""}`}
              key={socket.name}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={socket.name}
                title={`${socket.name}: ${describeSocketType(socket.type)}`}
              />
              <label title={socket.doc}>
                <span>{socket.name}</span>
                <small>{describeSocketType(socket.type)}</small>
              </label>
              {!linked ? (
                <SocketWidget
                  socket={socket}
                  value={data.graphNode.inputs?.[socket.name]}
                  onChange={(value) => setLiteralInput(data.nodeId, socket.name, value)}
                />
              ) : (
                <span className="linked-value">연결됨</span>
              )}
            </div>
          );
        })}

        {(data.schema.outputs ?? []).map((socket) => (
          <div className="socket-row output" key={socket.name}>
            <label title={socket.doc}>
              <span>{socket.name}</span>
              <small>{describeSocketType(socket.type)}</small>
            </label>
            <Handle
              type="source"
              position={Position.Right}
              id={socket.name}
              title={`${socket.name}: ${describeSocketType(socket.type)}`}
              onMouseDown={() =>
                beginConnection({ nodeId: data.nodeId, socket: socket.name, type: socket.type })
              }
            />
          </div>
        ))}
      </div>

      {data.runtime.preview ? (
        <img className="node-preview" src={data.runtime.preview} alt="노드 미리보기" />
      ) : null}

      {data.runtime.status === "cached" ? (
        <p className="cache-note">입력 시그니처가 같아 실행하지 않았습니다.</p>
      ) : null}

      {data.issues.map((issue) => (
        <p className="inline-issue" key={`${issue.code}:${issue.location}`}>
          {issue.socket ? `${issue.socket}: ` : ""}
          {issue.message}
        </p>
      ))}

      {data.runtime.error ? (
        <div className="inline-error">
          <strong>{data.runtime.error.socket ? `${data.runtime.error.socket}: ` : ""}</strong>
          {data.runtime.error.message}
          {data.runtime.error.traceback.length ? (
            <details>
              <summary>기술 세부정보</summary>
              <pre>{data.runtime.error.traceback.join("\n")}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

function SocketWidget({
  socket,
  value,
  onChange,
}: {
  socket: InputSocket;
  value: unknown;
  onChange: (value: JsonValue) => void;
}): React.JSX.Element | null {
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  if (socket.type === "BOOLEAN") {
    return (
      <input
        className="nodrag"
        type="checkbox"
        checked={Boolean(value)}
        onPointerDown={stop}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  if (socket.type === "INT" || socket.type === "FLOAT") {
    return (
      <input
        className="nodrag socket-number"
        type="number"
        value={typeof value === "number" ? value : ""}
        min={numberHint(socket, "min")}
        max={numberHint(socket, "max")}
        step={numberHint(socket, "step") ?? (socket.type === "INT" ? 1 : "any")}
        onPointerDown={stop}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    );
  }
  if (socket.type === "STRING") {
    return (
      <input
        className="nodrag socket-text"
        value={typeof value === "string" ? value : ""}
        placeholder={socket.required ? "필수" : "선택"}
        onPointerDown={stop}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return null;
}

function numberHint(socket: InputSocket, key: string): number | undefined {
  const value = socket.widget?.[key];
  return typeof value === "number" ? value : undefined;
}
