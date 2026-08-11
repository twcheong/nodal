/**
 * 캐논 그래프 포맷 (docs/design.md §4.1) — TypeScript 표현.
 *
 * 백엔드 pydantic 모델과 같은 문서를 서술한다. 실행용/UI용 포맷을 분리하지
 * 않으므로 여기 있는 타입이 곧 저장 포맷이고 곧 전송 포맷이다.
 *
 * 형태는 여기 있지만 **규칙(패턴·제약)의 단일 소스는 `schemas/graph.schema.json`**
 * 이고, 그것은 pydantic 모델에서 생성된다. 두 표현이 어긋나면
 * `schema.test.ts` 의 계약 테스트가 깨진다.
 */

/** 리터럴 값과 링크를 구분하는 예약 키. */
export const LINK_KEY = "$link" as const;

/** 캐논 포맷 버전. */
export const GRAPH_VERSION = "1" as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 다른 노드의 출력 소켓 참조: `{ "$link": ["n_c3d4", "image"] }` */
export interface Link {
  readonly [LINK_KEY]: readonly [nodeId: string, socket: string];
}

/** 입력 슬롯의 값 — 링크이거나 JSON 리터럴이다. */
export type InputValue = Link | JsonValue;

export interface NodeMeta {
  title?: string | null;
  notes?: string | null;
  [key: string]: JsonValue | undefined;
}

export interface GraphNode {
  /** 네임스페이스를 포함한 타입 ID (예: `image.Resize`). */
  type: string;
  inputs?: Record<string, InputValue>;
  meta?: NodeMeta;
}

export interface GraphDocument {
  nodal_version: typeof GRAPH_VERSION;
  id?: string;
  nodes?: Record<string, GraphNode>;
  /** 실행을 요청할 노드들. */
  outputs?: string[];
  /** 프론트엔드 전용 상태. 백엔드는 읽지 않는다. */
  ui?: Record<string, JsonValue>;
}

/** 입력 슬롯 값이 링크인지 판별한다. 백엔드 `_input_kind` 와 같은 규칙이다. */
export function isLink(value: InputValue): value is Link {
  return typeof value === "object" && value !== null && !Array.isArray(value) && LINK_KEY in value;
}

export function linkSource(link: Link): { nodeId: string; socket: string } {
  const [nodeId, socket] = link[LINK_KEY];
  return { nodeId, socket };
}

export function makeLink(nodeId: string, socket: string): Link {
  return { [LINK_KEY]: [nodeId, socket] };
}
