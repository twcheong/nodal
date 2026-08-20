import { memo, useContext, useMemo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { isImageAsset, previewSize, previewSrc, type InputSocket } from "../api/types";
import { AssetUrlContext } from "../api/context";
import { formatDuration } from "../editor/progress";
import { readSeedControl } from "../editor/seed";
import { describeSocketType, socketTypesCompatible } from "../editor/socketTypes";
import { IDLE_RUNTIME, type NodalFlowNode, type NodeRuntimeState } from "../editor/types";
import { isLink, type JsonValue } from "../graph/types";
import {
  comboOptions,
  comboProvider,
  isSeedWidget,
  SEED_CONTROLS,
  type SeedControl,
  type SeedWidget,
} from "../graph/widgets";
import { useEditorStore } from "../state/editorStore";

const STATUS_LABEL = {
  idle: "대기",
  queued: "예약",
  running: "실행 중",
  cached: "캐시",
  succeeded: "완료",
  error: "오류",
} as const;

const SEED_CONTROL_LABEL: Record<SeedControl, string> = {
  fixed: "고정",
  increment: "증가",
  randomize: "랜덤",
};

export const NodalNode = memo(function NodalNode({ data, selected }: NodeProps<NodalFlowNode>) {
  // 런타임은 캔버스 투영과 분리한다. 프리뷰가 몰려도 해당 노드만 다시 그린다.
  const runtime = useEditorStore((state) => state.runtime[data.nodeId] ?? IDLE_RUNTIME);
  const setLiteralInput = useEditorStore((state) => state.setLiteralInput);
  const assetUrl = useContext(AssetUrlContext);
  const beginConnection = useEditorStore((state) => state.beginConnection);
  const issueSockets = useMemo(
    () => new Set(data.issues.map((issue) => issue.socket).filter(Boolean)),
    [data.issues],
  );
  const imageOutputs = useMemo(
    () => (runtime.outputs ?? []).filter((output) => isImageAsset(output.asset)),
    [runtime.outputs],
  );

  return (
    <article className={`nodal-node status-${runtime.status}${selected ? " is-selected" : ""}`}>
      <header className="node-header">
        <span className="node-category">{data.schema.category}</span>
        <span className="node-status" aria-label={`상태: ${STATUS_LABEL[runtime.status]}`}>
          <i /> {STATUS_LABEL[runtime.status]}
        </span>
        <strong>{data.graphNode.meta?.title || data.schema.title}</strong>
        <small>{data.schema.id}</small>
      </header>

      {runtime.progress ? (
        <div
          className="node-progress"
          aria-label={`노드 진행률 ${runtime.progress.step}/${runtime.progress.total}`}
        >
          <i
            style={{
              width: `${(runtime.progress.step / runtime.progress.total) * 100}%`,
            }}
          />
          <small>
            스텝 {runtime.progress.step} / {runtime.progress.total} · 약{" "}
            {formatDuration(runtime.progress.etaMs)} 남음
          </small>
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
                  nodeId={data.nodeId}
                  socket={socket}
                  value={data.graphNode.inputs?.[socket.name]}
                  runtime={runtime}
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

      {runtime.preview ? (
        <NodeImage
          src={
            runtime.preview.kind === "asset"
              ? assetUrl(runtime.preview.asset)
              : previewSrc(runtime.preview)
          }
          size={previewSize(runtime.preview)}
          alt="노드 미리보기"
          badge={
            runtime.progress
              ? `${runtime.progress.step} / ${runtime.progress.total} · ${formatDuration(runtime.progress.etaMs)}`
              : undefined
          }
        />
      ) : null}

      {imageOutputs.length ? (
        <section className="node-results" aria-label="실행 결과 이미지">
          <small>실행 결과</small>
          {imageOutputs.map((output) => (
            <div className="node-result" key={output.socket}>
              <span>{output.socket}</span>
              <NodeImage
                src={assetUrl(output.asset!)}
                size={{
                  width: output.asset?.width ?? null,
                  height: output.asset?.height ?? null,
                }}
                alt={`${output.socket} 실행 결과`}
              />
            </div>
          ))}
        </section>
      ) : null}

      {runtime.status === "cached" ? (
        <p className="cache-note">입력 시그니처가 같아 실행하지 않았습니다.</p>
      ) : null}

      {data.issues.map((issue) => (
        <p className="inline-issue" key={`${issue.code}:${issue.location}`}>
          {issue.socket ? `${issue.socket}: ` : ""}
          {issue.message}
        </p>
      ))}

      {runtime.error ? (
        <div className="inline-error">
          <strong>{runtime.error.socket ? `${runtime.error.socket}: ` : ""}</strong>
          {runtime.error.message}
          {runtime.error.traceback.length ? (
            <details>
              <summary>기술 세부정보</summary>
              <pre>{runtime.error.traceback.join("\n")}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

function NodeImage({
  src,
  size,
  alt,
  badge,
}: {
  src: string;
  size: { width: number | null; height: number | null };
  alt: string;
  badge?: string;
}): React.JSX.Element {
  const hasSize = Boolean(size.width && size.height);
  return (
    <div
      className="node-image-frame"
      style={{ aspectRatio: hasSize ? `${size.width} / ${size.height}` : "16 / 10" }}
    >
      <img
        className="node-preview"
        src={src}
        alt={alt}
        width={size.width ?? undefined}
        height={size.height ?? undefined}
        loading="lazy"
        decoding="async"
      />
      {badge ? <span className="preview-step-badge">{badge}</span> : null}
    </div>
  );
}

function SocketWidget({
  nodeId,
  socket,
  value,
  runtime,
  onChange,
}: {
  nodeId: string;
  socket: InputSocket;
  value: unknown;
  runtime: NodeRuntimeState;
  onChange: (value: JsonValue) => void;
}): React.JSX.Element | null {
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  if (socket.widget?.seed === true) {
    if (!isSeedWidget(socket.widget)) {
      return <span className="widget-contract-error">지원하지 않는 시드 계약</span>;
    }
    return (
      <SeedInput
        nodeId={nodeId}
        socket={socket}
        widget={socket.widget}
        value={value}
        runtime={runtime}
        onChange={onChange}
      />
    );
  }
  if (socket.type === "BOOL") {
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
    const provider = comboProvider(socket.widget);
    const options = comboOptions(socket.widget);
    if (provider) {
      return (
        <ProviderCombo
          socket={socket}
          provider={provider}
          options={options}
          value={value}
          onChange={onChange}
        />
      );
    }
    if (options.length) {
      return (
        <select
          className="nodrag socket-select"
          value={typeof value === "string" ? value : ""}
          onPointerDown={stop}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option value={option} key={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
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

function SeedInput({
  nodeId,
  socket,
  widget,
  value,
  runtime,
  onChange,
}: {
  nodeId: string;
  socket: InputSocket;
  widget: SeedWidget;
  value: unknown;
  runtime: NodeRuntimeState;
  onChange: (value: JsonValue) => void;
}): React.JSX.Element {
  const graph = useEditorStore((state) => state.graph);
  const setSeedControl = useEditorStore((state) => state.setSeedControl);
  const control = readSeedControl(graph, nodeId, socket.name, widget.control);
  const current =
    typeof value === "number" ? value : typeof socket.default === "number" ? socket.default : 0;
  const submitted = runtime.submittedSeeds?.[socket.name];
  const busy = runtime.status === "queued" || runtime.status === "running";
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  let transition = `실행 후 ${SEED_CONTROL_LABEL[control]}`;
  if (busy && submitted !== undefined) transition = `이번 실행 ${submitted}`;
  else if (["succeeded", "cached"].includes(runtime.status) && submitted !== undefined) {
    transition =
      control === "fixed"
        ? `이번 ${submitted} · 다음에도 유지`
        : `이번 ${submitted} → 다음 ${current}`;
  }
  return (
    <div className="seed-widget nodrag" onPointerDown={stop}>
      <div>
        <input
          className="socket-number"
          aria-label={`${socket.name} 시드`}
          type="number"
          value={current}
          min={widget.min}
          max={widget.max}
          step={widget.step}
          disabled={busy}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <select
          className="socket-select seed-control"
          aria-label={`${socket.name} 실행 후 동작`}
          value={control}
          disabled={busy}
          onChange={(event) =>
            setSeedControl(nodeId, socket.name, event.target.value as SeedControl)
          }
        >
          {SEED_CONTROLS.map((option) => (
            <option value={option} key={option}>
              {SEED_CONTROL_LABEL[option]}
            </option>
          ))}
        </select>
      </div>
      <small>{transition}</small>
    </div>
  );
}

/**
 * 공급자 기반 콤보 — 체크포인트 · LoRA · ControlNet 목록.
 *
 * 목록은 **`/api/nodes` 가 실어 보낸 `widget.options`** 다. 서버가 소켓마다
 * 공급자를 스캔해 채워 준다 (`nodal_server.wire._widget_model`).
 *
 * 한동안 이 컴포넌트는 별도의 `/api/models` 응답을 스토어에 담아 읽었다.
 * 그 엔드포인트는 **언제나 빈 목록**이었으므로 화면에는 늘 "모델 없음" 이
 * 떴다 — 서버는 옵션을 이미 보내고 있었는데 프론트가 다른 곳을 보고 있었다.
 * 목록이 두 경로로 오면 반드시 이렇게 어긋난다. 그래서 경로를 하나로 줄였고
 * `/api/models` 는 스펙에서 뺐다 (`decisions.md` 2026-08-18).
 */
function ProviderCombo({
  socket,
  provider,
  options,
  value,
  onChange,
}: {
  socket: InputSocket;
  provider: string;
  options: string[];
  value: unknown;
  onChange: (value: JsonValue) => void;
}): React.JSX.Element {
  const catalogState = useEditorStore((state) => state.catalogState);
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  if (catalogState === "loading") return <span className="model-catalog-note">모델 확인 중…</span>;
  if (options.length === 0) {
    return (
      <span className="model-empty" role="status">
        <select className="socket-select" disabled aria-label={`${socket.name} 모델 없음`}>
          <option>모델 없음</option>
        </select>
        <small>{provider} 모델 폴더가 비어 있습니다. 모델 파일을 추가해주세요.</small>
      </span>
    );
  }
  // `value` 가 `options` 에 없으면(예: 다른 머신에서 저장된 그래프) 그대로
  // `<select>` 에 넘기지 않는다. 네이티브 `<select>` 는 바인딩된 값이 그 어떤
  // `<option>` 과도 안 맞으면 **목록의 첫 항목을 조용히 표시하면서 onChange 를
  // 내지 않는다** — 실제로는 선택되지 않았는데 골라진 것처럼 보이는 것이다.
  // 플레이스홀더로 떨어뜨려 "선택 안 됨" 임을 화면에서도 정확히 드러낸다.
  const isKnownOption = typeof value === "string" && options.includes(value);
  return (
    <select
      className="nodrag socket-select model-select"
      aria-label={`${socket.name} 모델 선택`}
      value={isKnownOption ? value : ""}
      onPointerDown={stop}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="" disabled>
        모델 선택…
      </option>
      {options.map((option) => (
        <option value={option} key={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function numberHint(socket: InputSocket, key: string): number | undefined {
  const value = socket.widget?.[key];
  return typeof value === "number" ? value : undefined;
}
