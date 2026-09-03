/**
 * API 계약이 프론트까지 도달했는지 검사한다.
 *
 * 백엔드 쪽은 `packages/server/tests/test_openapi_export.py` 가 지킨다. 이
 * 파일은 그 산출물이 **실제로 쓸 수 있는 TypeScript 타입이 됐는지**를 본다 —
 * 생성이 조용히 실패하거나 WS 이벤트가 빠지면 여기서 걸린다.
 *
 * 타입은 런타임에 존재하지 않으므로, 타입 단언은 `satisfies` 로 컴파일 시점에
 * 검사하고(=`tsc --noEmit` 이 게이트) 런타임 헬퍼만 실제로 실행한다.
 */

import { describe, expect, it } from "vitest";

import openapi from "@nodal/schemas/openapi.json";

import {
  API_PATHS,
  assetSrc,
  isEvent,
  isImageAsset,
  isVideoAsset,
  previewSize,
  previewSrc,
  runIdOf,
} from "./types";
import type {
  GraphFromPngResponse,
  NodeCachedEvent,
  NodeDoneEvent,
  Preview,
  RunStatus,
  ValidateResponse,
  WsEvent,
  WsEventType,
} from "./types";

describe("생성된 산출물", () => {
  it("design.md §6 과 M3의 엔드포인트가 모두 있다", () => {
    const declared = new Set<string>();
    for (const [path, operations] of Object.entries(openapi.paths)) {
      for (const verb of Object.keys(operations)) {
        declared.add(`${verb.toUpperCase()} ${path}`);
      }
    }
    for (const operation of [
      "GET /api/nodes",
      "POST /api/graph/validate",
      "POST /api/runs",
      "GET /api/runs",
      "GET /api/runs/{run_id}",
      "DELETE /api/runs/{run_id}",
      "POST /api/assets",
      "GET /api/assets/{asset_hash}",
      "GET /api/extensions",
      "POST /api/graph/from-png",
    ]) {
      expect(declared).toContain(operation);
    }
  });

  it("GET /api/models 는 계약에 없다", () => {
    // design.md §6 에는 있었지만 뺐다. 모델 목록은 `/api/nodes` 의
    // `widget.options` 로만 나간다 — 두 경로로 같은 목록을 보내다가 실제로
    // 어긋났다 (`decisions.md` 2026-08-18).
    expect(Object.keys(openapi.paths)).not.toContain("/api/models");
  });

  it("WS 이벤트 스키마가 주입되어 있다 — OpenAPI 는 WS 를 모른다", () => {
    const schemas = openapi.components.schemas as Record<string, unknown>;
    expect(schemas).toHaveProperty("WsEvent");
    for (const name of [
      "WsRunStarted",
      "WsNodeStarted",
      "WsNodeProgress",
      "WsNodePreview",
      "WsNodeCached",
      "WsNodeDone",
      "WsNodeError",
      "WsRunDone",
      "WsRunCancelled",
      "WsQueueStatus",
    ]) {
      expect(schemas).toHaveProperty(name);
    }
  });

  it("타입 규칙 버전이 types.json 과 같다", async () => {
    const { TYPES_VERSION } = await import("../graph/typesystem");
    expect(openapi["x-nodal-types-version"]).toBe(TYPES_VERSION);
  });
});

describe("이벤트 판별", () => {
  const cached: NodeCachedEvent = { t: "node.cached", run_id: "r1", node_id: "n1" };
  const done: NodeDoneEvent = {
    t: "node.done",
    run_id: "r1",
    node_id: "n1",
    outputs: [{ socket: "sum", type: "INT", inline: 42 }],
  };

  it("t 로 좁힌다", () => {
    const events: WsEvent[] = [cached, done];
    const onlyCached = events.filter((event) => isEvent(event, "node.cached"));
    expect(onlyCached).toEqual([cached]);
  });

  it("좁힌 타입에서 필드에 바로 닿는다", () => {
    if (isEvent(done, "node.done")) {
      // 좁혀지지 않으면 tsc 가 여기서 실패한다.
      // `outputs` 는 기본값이 있어 옵셔널이다 — 프론트는 없을 수 있음을 다뤄야 한다.
      expect(done.outputs?.[0]?.socket).toBe("sum");
      expect(done.outputs?.[0]?.inline).toBe(42);
    }
  });

  it("queue 를 뺀 모든 이벤트가 run_id 를 갖는다", () => {
    expect(runIdOf(cached)).toBe("r1");
    expect(runIdOf({ t: "queue", pending: 0, running: null })).toBeNull();
  });

  it("판별자 목록이 design.md §6 과 같다", () => {
    const types: WsEventType[] = [
      "run.started",
      "node.started",
      "node.progress",
      "node.preview",
      "node.cached",
      "node.done",
      "node.error",
      "run.done",
      "run.cancelled",
      "queue",
    ];
    expect(new Set(types).size).toBe(10);
  });
});

describe("계약 형태", () => {
  it("실행 상태는 5개다", () => {
    const statuses: RunStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];
    expect(statuses).toHaveLength(5);
  });

  it("검증 실패도 성공적인 응답이다 — issues 로 소켓을 지목한다", () => {
    const response: ValidateResponse = {
      valid: false,
      issues: [
        {
          code: "type_mismatch",
          message: "c.value (INT) 를 이 소켓(STRING)에 연결할 수 없다",
          node_id: "f",
          socket: "template",
          location: "nodes.f.inputs.template",
        },
      ],
    };
    expect(response.issues?.[0]?.location).toBe("nodes.f.inputs.template");
  });

  it("경로 헬퍼가 선언된 경로와 맞는다", () => {
    expect(API_PATHS.run("r1")).toBe("/api/runs/r1");
    expect(API_PATHS.asset("abc")).toBe("/api/assets/abc");
    expect(Object.keys(openapi.paths)).toContain(API_PATHS.nodes);
    expect(Object.keys(openapi.paths)).toContain(API_PATHS.validate);
    expect(Object.keys(openapi.paths)).toContain(API_PATHS.graphFromPng);
  });

  it("인라인과 에셋 프리뷰를 kind로 나누고 크기를 보존한다", () => {
    const inline: Preview = {
      kind: "inline",
      data_uri: "data:image/png;base64,abc",
      width: 320,
      height: 200,
    };
    const asset: Preview = {
      kind: "asset",
      asset: {
        hash: "abc",
        media_type: "image/png",
        size_bytes: 123,
        width: 640,
        height: 400,
      },
    };

    expect(previewSrc(inline)).toBe(inline.data_uri);
    expect(previewSize(inline)).toEqual({ width: 320, height: 200 });
    expect(previewSrc(asset)).toBe("/api/assets/abc");
    expect(previewSize(asset)).toEqual({ width: 640, height: 400 });
    expect(isImageAsset(asset.asset)).toBe(true);
    expect(assetSrc(asset.asset)).toBe("/api/assets/abc");

    const restored = { graph: { nodal_version: "1" } } satisfies GraphFromPngResponse;
    expect(restored.graph.nodal_version).toBe("1");
  });
});

describe("영상 에셋", () => {
  it("이미지와 영상의 재생 경로를 구분한다", () => {
    const video = { hash: "abc", media_type: "video/webm", size_bytes: 100 };
    expect(isVideoAsset(video)).toBe(true);
    expect(isImageAsset(video)).toBe(false);
    expect(isVideoAsset({ ...video, media_type: "image/png" })).toBe(false);
    expect(isVideoAsset(null)).toBe(false);
  });
});
