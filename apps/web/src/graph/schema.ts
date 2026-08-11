/**
 * 생성된 캐논 그래프 JSON Schema 를 프론트에서 소비한다.
 *
 * 스키마는 백엔드 pydantic 모델에서 `tools/export_schema.py` 로 생성된다.
 * 프론트는 규칙을 다시 쓰지 않고 이 산출물만 읽는다 (CLAUDE.md: 규칙을 두 번
 * 쓰지 않는다).
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import graphSchema from "@nodal/schemas/graph.schema.json";

import type { GraphDocument } from "./types";

export { graphSchema };

const ajv = new Ajv2020({
  allErrors: true,
  // 생성된 스키마는 `x-generated-by` 같은 주석 키워드를 담는다.
  strict: false,
});

// 스키마의 `format: uuid` 를 실제로 검사하게 한다. 없으면 ajv 가 조용히 무시해서
// 백엔드(pydantic)는 거부하는 문서를 프론트가 통과시킨다.
addFormats(ajv, ["uuid"]);

const validator: ValidateFunction<GraphDocument> = ajv.compile<GraphDocument>(graphSchema);

/** 검증에서 발견된 문제 하나. `location` 은 백엔드 `GraphIssue.location` 과 같은 모양이다. */
export interface SchemaIssue {
  /** 예: `nodes.n_a1b2.inputs.image` */
  location: string;
  message: string;
}

export type ValidationResult =
  { valid: true; document: GraphDocument } | { valid: false; issues: SchemaIssue[] };

/**
 * 캐논 문서가 포맷을 만족하는지 검사한다.
 *
 * 여기서 잡는 것은 **포맷**뿐이다. 소켓 타입 호환성은 별개이고 (design.md §4.3),
 * 참조 무결성(끊어진 링크 등)도 별개다 — 백엔드 `validate_graph` 가 담당한다.
 */
export function validateGraphDocument(document: unknown): ValidationResult {
  if (validator(document)) {
    return { valid: true, document };
  }
  return { valid: false, issues: (validator.errors ?? []).map(toIssue) };
}

function toIssue(error: ErrorObject): SchemaIssue {
  // ajv 의 instancePath 는 `/nodes/n_a1b2/inputs/image` 형태다.
  const location = error.instancePath.replace(/^\//, "").split("/").filter(Boolean).join(".");
  return {
    location: location === "" ? "graph" : location,
    message: error.message ?? "유효하지 않은 값",
  };
}
