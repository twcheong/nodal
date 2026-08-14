import { forwardRef, useCallback, useImperativeHandle, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type OnConnectStartParams,
} from "@xyflow/react";

import { createBenchmarkGraph, graphToFlow, graphViewport } from "../editor/graph";
import { socketTypesCompatible } from "../editor/socketTypes";
import type { NodalFlowNode } from "../editor/types";
import { useEditorStore } from "../state/editorStore";
import { NodalNode } from "./NodalNode";
import { NodeSearch } from "./NodeSearch";

export interface CanvasHandle {
  benchmark: () => Promise<number | null>;
}

const nodeTypes = { nodal: NodalNode };

export const GraphCanvas = forwardRef<CanvasHandle>(function GraphCanvas(_props, ref) {
  const flow = useReactFlow<NodalFlowNode>();
  const nodesInitialized = useNodesInitialized();
  const graph = useEditorStore((state) => state.graph);
  const schemas = useEditorStore((state) => state.schemas);
  const runtime = useEditorStore((state) => state.runtime);
  const issues = useEditorStore((state) => state.issues);
  const connection = useEditorStore((state) => state.connection);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const nodeMeasurements = useEditorStore((state) => state.nodeMeasurements);
  const applyNodeChanges = useEditorStore((state) => state.applyNodeChanges);
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
      graphToFlow(
        graph,
        schemaMap,
        runtime,
        issues,
        connection,
        new Set(selectedNodeIds),
        nodeMeasurements,
      ),
    [connection, graph, issues, nodeMeasurements, runtime, schemaMap, selectedNodeIds],
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

  useImperativeHandle(
    ref,
    () => ({
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
    [flow, loadGraph, setBenchmarkFps, setMessage],
  );

  return (
    <section
      className="canvas-shell"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const schemaId = event.dataTransfer.getData("application/x-nodal-node");
        const schema = schemaMap.get(schemaId);
        if (schema)
          addNode(schema, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }}
    >
      <ReactFlow
        nodes={projection.nodes}
        edges={projection.edges}
        nodeTypes={nodeTypes}
        defaultViewport={graphViewport(graph)}
        onNodesChange={applyNodeChanges}
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
        onlyRenderVisibleElements={nodesInitialized}
        fitView
        minZoom={0.15}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
        <MiniMap pannable zoomable nodeStrokeWidth={3} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <NodeSearch />
      <div className="canvas-hint">더블클릭해 노드 찾기</div>
    </section>
  );
});
