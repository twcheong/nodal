import type { Node as FlowNode, Edge as FlowEdge, XYPosition } from "@xyflow/react";

import type { Issue, NodeSchema, OutputRef, Preview, SocketTypeExpr } from "../api/types";
import type { GraphNode } from "../graph/types";

export type NodeStatus = "idle" | "queued" | "running" | "cached" | "succeeded" | "error";

export interface NodeRuntimeState {
  status: NodeStatus;
  progress?: { step: number; total: number };
  preview?: Preview;
  outputs?: OutputRef[];
  error?: { message: string; socket: string | null; traceback: string[] };
}

export interface ConnectionIntent {
  nodeId: string;
  socket: string;
  type: SocketTypeExpr;
}

export interface SearchState {
  open: boolean;
  flowPosition: XYPosition;
}

export interface NodalNodeData extends Record<string, unknown> {
  nodeId: string;
  graphNode: GraphNode;
  schema: NodeSchema;
  runtime: NodeRuntimeState;
  issues: Issue[];
  connectionSourceType: SocketTypeExpr | null;
}

export type NodalFlowNode = FlowNode<NodalNodeData, "nodal">;
export type NodalFlowEdge = FlowEdge<Record<string, never>, "default">;

export const IDLE_RUNTIME: NodeRuntimeState = Object.freeze({ status: "idle" });
