import { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type OnConnectStartParams,
} from "@xyflow/react";

import { createBenchmarkGraph, graphToFlow, graphViewport } from "../editor/graph";
import { isPngFile } from "../editor/pngDrop";
import { socketTypesCompatible } from "../editor/socketTypes";
import type { NodalFlowNode } from "../editor/types";
import { useEditorStore } from "../state/editorStore";
import { NodalNode } from "./NodalNode";
import { NodeSearch } from "./NodeSearch";

export interface CanvasHandle {
  benchmark: () => Promise<number | null>;
  restorePng: (file: File) => Promise<void>;
}

interface GraphCanvasProps {
  onPngDrop: (file: File) => Promise<void>;
}

const nodeTypes = { nodal: NodalNode };

export const GraphCanvas = forwardRef<CanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { onPngDrop },
  ref,
) {
  const flow = useReactFlow<NodalFlowNode>();
  const [dropState, setDropState] = useState<"idle" | "loading" | "error">("idle");
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const graph = useEditorStore((state) => state.graph);
  const schemas = useEditorStore((state) => state.schemas);
  const issues = useEditorStore((state) => state.issues);
  const connection = useEditorStore((state) => state.connection);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const nodeMeasurements = useEditorStore((state) => state.nodeMeasurements);
  const applyNodeChanges = useEditorStore((state) => state.applyNodeChanges);
  const finishGraphGesture = useEditorStore((state) => state.finishGraphGesture);
  const deleteEdges = useEditorStore((state) => state.deleteEdges);
  const connectNodes = useEditorStore((state) => state.connectNodes);
  const beginConnection = useEditorStore((state) => state.beginConnection);
  const openSearch = useEditorStore((state) => state.openSearch);
  const setViewport = useEditorStore((state) => state.setViewport);
  const loadGraph = useEditorStore((state) => state.loadGraph);
  const addNode = useEditorStore((state) => state.addNode);
  const setBenchmarkFps = useEditorStore((state) => state.setBenchmarkFps);
  const setMessage = useEditorStore((state) => state.setMessage);

  const schemaMap = useMemo(() => new Map(schemas.map((schema) => [schema.id, schema])), [schemas]);
  const projection = useMemo(
    () =>
      graphToFlow(graph, schemaMap, issues, connection, new Set(selectedNodeIds), nodeMeasurements),
    [connection, graph, issues, nodeMeasurements, schemaMap, selectedNodeIds],
  );

  const sourceIntent = useCallback(
    (_event: MouseEvent | TouchEvent, { nodeId, handleId, handleType }: OnConnectStartParams) => {
      if (handleType !== "source" || !nodeId || !handleId) return;
      const node = graph.nodes?.[nodeId];
      const socket = schemaMap
        .get(node?.type ?? "")
        ?.outputs?.find((item) => item.name === handleId);
      if (socket) beginConnection({ nodeId, socket: handleId, type: socket.type });
    },
    [beginConnection, graph.nodes, schemaMap],
  );

  const validConnection = useCallback(
    (candidate: Edge | Connection) => {
      if (
        !candidate.source ||
        !candidate.target ||
        !candidate.sourceHandle ||
        !candidate.targetHandle
      )
        return false;
      const sourceNode = graph.nodes?.[candidate.source];
      const targetNode = graph.nodes?.[candidate.target];
      const output = schemaMap
        .get(sourceNode?.type ?? "")
        ?.outputs?.find((item) => item.name === candidate.sourceHandle);
      const input = schemaMap
        .get(targetNode?.type ?? "")
        ?.inputs?.find((item) => item.name === candidate.targetHandle);
      return Boolean(output && input && socketTypesCompatible(output.type, input.type));
    },
    [graph.nodes, schemaMap],
  );

  const restorePng = useCallback(
    async (file: File) => {
      setDropState("loading");
      setDropMessage("PNG에서 워크플로를 확인하고 있습니다…");
      try {
        await onPngDrop(file);
        setDropState("idle");
        setDropMessage(null);
      } catch (error) {
        setDropState("error");
        setDropMessage(`워크플로 복원 실패: ${readError(error)}`);
      }
    },
    [onPngDrop],
  );

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (event.dataTransfer.files.length) {
        const file = Array.from(event.dataTransfer.files).find(isPngFile);
        if (!file) {
          setDropState("error");
          setDropMessage("PNG 파일만 캔버스에서 워크플로로 복원할 수 있습니다.");
          return;
        }
        await restorePng(file);
        return;
      }

      const schemaId = event.dataTransfer.getData("application/x-nodal-node");
      const schema = schemaMap.get(schemaId);
      if (schema) {
        addNode(schema, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }
    },
    [addNode, flow, restorePng, schemaMap],
  );

  useImperativeHandle(
    ref,
    () => ({
      restorePng,
      benchmark: async () => {
        if (document.hidden) {
          setBenchmarkFps(null);
          setMessage("성능 측정은 화면에 보이는 브라우저 탭에서 실행해주세요");
          return null;
        }
        loadGraph(createBenchmarkGraph(200));
        setBenchmarkFps(null);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const frameTimes: number[] = [];
        let last = performance.now();
        for (let frame = 0; frame < 90; frame += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame((now) => {
              frameTimes.push(now - last);
              last = now;
              void flow.setViewport({ x: -(frame % 30) * 8, y: -(frame % 10) * 3, zoom: 0.72 });
              resolve();
            }),
          );
        }
        const average = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
        const fps = Math.round(1000 / average);
        setBenchmarkFps(fps);
        return fps;
      },
    }),
    [flow, loadGraph, restorePng, setBenchmarkFps, setMessage],
  );

  return (
    <section
      className="canvas-shell"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      <ReactFlow
        nodes={projection.nodes}
        edges={projection.edges}
        nodeTypes={nodeTypes}
        defaultViewport={graphViewport(graph)}
        onNodesChange={applyNodeChanges}
        onNodeDragStop={() => finishGraphGesture()}
        onEdgesDelete={deleteEdges}
        onConnect={(candidate) => connectNodes(candidate)}
        onConnectStart={sourceIntent}
        onConnectEnd={() => beginConnection(null)}
        onPaneClick={(event) => {
          if (event.detail === 2) {
            openSearch(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
          }
        }}
        isValidConnection={validConnection}
        onMoveEnd={(_event, viewport) => setViewport(viewport)}
        deleteKeyCode={["Backspace", "Delete"]}
        selectionOnDrag
        panOnScroll
        onlyRenderVisibleElements
        fitView
        minZoom={0.15}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
        <MiniMap pannable zoomable nodeStrokeWidth={3} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <NodeSearch />
      {dropMessage ? (
        <div
          className={`canvas-drop-notice ${dropState}`}
          role={dropState === "error" ? "alert" : "status"}
        >
          {dropMessage}
          {dropState === "error" ? (
            <button
              type="button"
              aria-label="복원 오류 닫기"
              onClick={() => {
                setDropState("idle");
                setDropMessage(null);
              }}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="canvas-hint">더블클릭해 노드 찾기</div>
    </section>
  );
});

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
