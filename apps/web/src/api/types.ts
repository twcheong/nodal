/**
 * API 계약 타입 — `schemas/openapi.json` 에서 생성된 것에 안정적인 이름을 붙인다.
 *
 * 프론트 코드는 `generated.ts` 를 직접 import 하지 않는다. 그 파일은 산출물이라
 * 구조(`components["schemas"][...]`)가 도구 버전에 따라 바뀔 수 있다. 여기서
 * 한 겹 감싸면 그 변화가 앱 전체로 번지지 않는다.
 *
 * 규칙은 여기에 없다 — 백엔드 pydantic 모델이 단일 소스다
 * (AGENTS.md 코딩 컨벤션). 모델이 바뀌면:
 *
 *     uv run python tools/export_openapi.py   # 백엔드에서 산출물 재생성
 *     pnpm --filter @nodal/web gen:api        # 프론트 타입 재생성
 */

import type { components, paths } from "./generated";

type Schemas = components["schemas"];

// ------------------------------------------------------------------ 에러

/** 문제 하나. `location` 이 `nodes.<id>.inputs.<socket>` 경로를 준다. */
export type Issue = Schemas["IssueModel"];
export type ErrorBody = Schemas["ErrorBody"];
/** 모든 4xx·5xx 응답의 본문. */
export type ErrorResponse = Schemas["ErrorResponse"];

// ------------------------------------------------------------------ 노드

export type NodeSchema = Schemas["NodeSchemaModel"];
export type InputSocket = Schemas["InputSocketModel"];
export type OutputSocket = Schemas["OutputSocketModel"];
/** `types.json`의 재귀 타입 표현식. OpenAPI 생성 타입에서 직접 가져온다. */
export type SocketTypeExpr = InputSocket["type"];
export type NodesResponse = Schemas["NodesResponse"];

// ------------------------------------------------------------------ 검증

export type ValidateRequest = Schemas["ValidateRequest"];
export type ValidateResponse = Schemas["ValidateResponse"];
export type GraphFromPngResponse = Schemas["GraphFromPngResponse"];

// ------------------------------------------------------------------ 실행

export type RunStatus = Schemas["RunStatus"];
export type OutputRef = Schemas["OutputRefModel"];
export type AssetRef = Schemas["AssetRefModel"];
export type CreateRunRequest = Schemas["CreateRunRequest"];
export type CreateRunResponse = Schemas["CreateRunResponse"];
export type RunDetail = Schemas["RunDetail"];
export type RunSummary = Schemas["RunSummary"];
export type RunListResponse = Schemas["RunListResponse"];
export type CancelRunResponse = Schemas["CancelRunResponse"];

// ---------------------------------------------------- 모델 · 에셋 · 확장

export type AssetInfo = Schemas["AssetInfo"];
export type ExtensionInfo = Schemas["ExtensionInfo"];
export type ExtensionsResponse = Schemas["ExtensionsResponse"];

// ------------------------------------------------------------ WS 이벤트

/** `/ws` 로 들어오는 모든 메시지. `t` 로 판별한다. */
export type WsEvent = Schemas["WsEvent"];

export type RunStartedEvent = Schemas["WsRunStarted"];
export type NodeStartedEvent = Schemas["WsNodeStarted"];
export type NodeProgressEvent = Schemas["WsNodeProgress"];
export type NodePreviewEvent = Schemas["WsNodePreview"];
export type NodeCachedEvent = Schemas["WsNodeCached"];
export type NodeDoneEvent = Schemas["WsNodeDone"];
export type NodeErrorEvent = Schemas["WsNodeError"];
export type RunDoneEvent = Schemas["WsRunDone"];
export type RunFailedEvent = Schemas["WsRunFailed"];
export type RunCancelledEvent = Schemas["WsRunCancelled"];
export type QueueStatusEvent = Schemas["WsQueueStatus"];

/** 이벤트 판별자. `WsEvent["t"]` 의 모든 경우. */
export type WsEventType = WsEvent["t"];

/** `t` 로 좁힌 이벤트 타입. `NarrowEvent<"node.cached">` → `NodeCachedEvent`. */
export type NarrowEvent<T extends WsEventType> = Extract<WsEvent, { t: T }>;

/** 런타임 판별자. 스위치 없이 한 종류만 걸러낼 때 쓴다. */
export function isEvent<T extends WsEventType>(event: WsEvent, type: T): event is NarrowEvent<T> {
  return event.t === type;
}

/** `queue` 를 뺀 모든 이벤트는 `run_id` 를 갖는다. */
export function runIdOf(event: WsEvent): string | null {
  return "run_id" in event ? event.run_id : null;
}

// ------------------------------------------------------------------ 경로

/** 선언된 엔드포인트 경로. 오타 난 URL 을 타입 단계에서 잡는다. */
export type ApiPath = keyof paths;

export const API_PATHS = {
  nodes: "/api/nodes",
  validate: "/api/graph/validate",
  runs: "/api/runs",
  run: (runId: string) => `/api/runs/${runId}`,
  assets: "/api/assets",
  asset: (hash: string) => `/api/assets/${hash}`,
  extensions: "/api/extensions",
  graphFromPng: "/api/graph/from-png",
  ws: "/ws",
} as const satisfies Record<string, string | ((arg: string) => string)>;

// ---------------------------------------------------------------- 프리뷰 (M3)

export type Preview = Schemas["InlinePreviewModel"] | Schemas["AssetPreviewModel"];

/**
 * 프리뷰를 `<img src>` 에 쓸 문자열로 만든다.
 *
 * M2 까지 `node.preview` 는 `image: string` 하나였고 그것이 base64 인지 에셋
 * 해시인지 구분할 방법이 없었다. M3 계약에서 `kind` 로 판별되는 유니온이 됐다.
 */
export function previewSrc(preview: Preview): string {
  return preview.kind === "inline" ? preview.data_uri : assetSrc(preview.asset);
}

/** 프리뷰의 픽셀 크기. 모르면 `null` — 프론트는 그때만 자리를 추정한다. */
export function previewSize(preview: Preview): { width: number | null; height: number | null } {
  const source = preview.kind === "inline" ? preview : preview.asset;
  return { width: source.width ?? null, height: source.height ?? null };
}

/** 저장된 에셋을 내려받는 URL. */
export function assetSrc(asset: AssetRef): string {
  return API_PATHS.asset(asset.hash);
}

/** `OutputRef.asset` 중 브라우저에서 이미지로 표시할 수 있는 것만 고른다. */
export function isImageAsset(asset: AssetRef | null | undefined): asset is AssetRef {
  return asset?.media_type.startsWith("image/") ?? false;
}
