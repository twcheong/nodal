/**
 * 타입 시스템 — `types.json` 의 TypeScript 로더 (docs/design.md §4.3).
 *
 * 규칙과 카탈로그는 여기에 없다. 백엔드와 **같은 `types.json` 파일**을 읽는다.
 * 규칙을 두 번 쓰지 않는다 (AGENTS.md 코딩 컨벤션).
 *
 * 프론트가 이걸 필요로 하는 이유는 하나다: 링크를 드래그하는 동안 서버에
 * 물어보지 않고 호환 소켓을 밝혀야 한다 (design.md §7 UX 1).
 *
 * Python 구현: `packages/core/src/nodal/types.py`. 두 구현이 같은 판정을
 * 내는지는 `types.json` 의 `conformance` 케이스로 검증한다.
 */

import typesJson from "@nodal/types";

export type TypeKind = "any" | "primitive" | "tensor" | "opaque" | "list" | "union";

/** shape 차원: 정수는 고정 크기, 문자열 라벨과 null 은 임의 크기. */
export type Dimension = number | string | null;

export type SocketType =
  | { kind: "any" }
  | { kind: "primitive"; name: string }
  | { kind: "tensor"; dtypes: string[]; shape: Dimension[]; name?: string }
  | { kind: "opaque"; name: string; capabilities: string[] }
  | { kind: "list"; item: SocketType }
  | { kind: "union"; members: SocketType[] };

/** `types.json` 의 타입 표현식. 문법은 그 파일의 `type_expression` 절 참조. */
export type TypeExpr =
  | string
  | { list: TypeExpr }
  | { union: TypeExpr[] }
  | { opaque: string; capabilities?: string[] }
  | { tensor: { dtypes: string[]; shape: Dimension[] } };

export class TypeSpecError extends Error {}

interface RuleSwitch {
  enabled?: boolean;
  edges?: [string, string][];
  [key: string]: unknown;
}

interface TensorRule {
  dtype?: string;
  rank?: string;
  symbolic_dim_matches_any?: boolean;
}

interface TypesDocument {
  types_version: string;
  catalog: {
    primitives: Record<string, unknown>;
    tensors: Record<string, { dtypes: string[]; shape: Dimension[] }>;
    opaque: Record<string, { capabilities?: string[] }>;
  };
  rules: Record<string, RuleSwitch | TensorRule>;
  conformance: ConformanceCase[];
}

export interface ConformanceCase {
  from: TypeExpr;
  to: TypeExpr;
  compatible: boolean;
  rule?: string;
  why?: string;
}

const doc = typesJson as unknown as TypesDocument;

export const TYPES_VERSION: string = doc.types_version;
export const CONFORMANCE_CASES: readonly ConformanceCase[] = doc.conformance ?? [];

function ruleEnabled(name: string): boolean {
  const rule = doc.rules[name] as RuleSwitch | undefined;
  return rule?.enabled === true;
}

const NUMERIC_PROMOTIONS: ReadonlySet<string> = new Set(
  ruleEnabled("numeric_promotion")
    ? ((doc.rules.numeric_promotion as RuleSwitch).edges ?? []).map(([a, b]) => `${a}->${b}`)
    : [],
);

const TENSOR_RULE = (doc.rules.tensor ?? {}) as TensorRule;

/** 이름 → 타입. `Any` 는 이름이 아니라 표현식이라 여기 없다. */
export const CATALOG: ReadonlyMap<string, SocketType> = buildCatalog();

function buildCatalog(): Map<string, SocketType> {
  const out = new Map<string, SocketType>();
  for (const name of Object.keys(doc.catalog.primitives)) {
    out.set(name, { kind: "primitive", name });
  }
  for (const [name, spec] of Object.entries(doc.catalog.tensors)) {
    out.set(name, { kind: "tensor", dtypes: spec.dtypes, shape: spec.shape, name });
  }
  for (const [name, spec] of Object.entries(doc.catalog.opaque)) {
    out.set(name, { kind: "opaque", name, capabilities: spec.capabilities ?? [] });
  }
  return out;
}

/** 카탈로그 이름을 타입으로 푼다. */
export function resolveTypeName(name: string): SocketType {
  if (name === "Any") return { kind: "any" };
  const found = CATALOG.get(name);
  if (!found) {
    throw new TypeSpecError(
      `알 수 없는 타입 이름: ${name}. 카탈로그: ${[...CATALOG.keys()].sort().join(", ")}`,
    );
  }
  return found;
}

/** `types.json` 의 타입 표현식을 파싱한다. */
export function parseTypeExpr(expr: TypeExpr): SocketType {
  if (typeof expr === "string") return resolveTypeName(expr);
  if ("list" in expr) return { kind: "list", item: parseTypeExpr(expr.list) };
  if ("union" in expr) {
    if (expr.union.length === 0) throw new TypeSpecError("빈 union 은 만들 수 없다");
    return { kind: "union", members: expr.union.map(parseTypeExpr) };
  }
  if ("opaque" in expr) {
    return { kind: "opaque", name: expr.opaque, capabilities: expr.capabilities ?? [] };
  }
  if ("tensor" in expr) {
    return { kind: "tensor", dtypes: expr.tensor.dtypes, shape: expr.tensor.shape };
  }
  throw new TypeSpecError(`타입 표현식으로 해석할 수 없다: ${JSON.stringify(expr)}`);
}

/** 사람이 읽는 표기. 에러 메시지와 툴팁에 쓴다. */
export function describeType(t: SocketType): string {
  switch (t.kind) {
    case "any":
      return "Any";
    case "primitive":
      return t.name;
    case "tensor": {
      if (t.name) return t.name;
      const dims = t.shape.map((d) => (d === null ? "?" : String(d))).join(", ");
      return `Tensor[${[...t.dtypes].sort().join("|")}, (${dims})]`;
    }
    case "opaque":
      return t.capabilities.length === 0
        ? t.name
        : `${t.name}[${[...t.capabilities].sort().join(", ")}]`;
    case "list":
      return `List[${describeType(t.item)}]`;
    case "union":
      return `Union[${t.members.map(describeType).join(", ")}]`;
  }
}

/**
 * 출력 소켓 `source` 를 입력 소켓 `target` 에 연결할 수 있는지 판정한다.
 *
 * 방향이 있다 — `isCompatible(a, b)` 와 `isCompatible(b, a)` 는 다른 질문이다.
 */
export function isCompatible(source: SocketType, target: SocketType): boolean {
  return incompatibleReason(source, target) === null;
}

/** 호환되면 null, 아니면 사람이 읽는 이유. */
export function explainIncompatibility(source: SocketType, target: SocketType): string | null {
  const why = incompatibleReason(source, target);
  return why === null ? null : `${describeType(source)} → ${describeType(target)}: ${why}`;
}

function incompatibleReason(source: SocketType, target: SocketType): string | null {
  if (ruleEnabled("any_bidirectional") && (source.kind === "any" || target.kind === "any")) {
    return null;
  }

  // 출처가 union 이면 기본적으로 모든 멤버가 대상에 호환이어야 한다.
  if (source.kind === "union") {
    const reasons = source.members.map((m) => incompatibleReason(m, target));
    if (ruleEnabled("union_narrowing")) {
      return reasons.some((r) => r === null) ? null : "union 의 어떤 멤버도 호환되지 않는다";
    }
    for (let i = 0; i < reasons.length; i += 1) {
      const reason = reasons[i];
      if (reason !== null && reason !== undefined) {
        const member = source.members[i];
        const label = member ? describeType(member) : "?";
        return `union 멤버 ${label} 가 호환되지 않는다 (${reason}) — 좁힘은 허용되지 않는다`;
      }
    }
    return null;
  }

  // 대상이 union 이면 멤버 중 하나에만 들어가면 된다.
  if (target.kind === "union") {
    if (!ruleEnabled("union_widening")) return "union 넓힘이 꺼져 있다";
    for (const member of target.members) {
      if (incompatibleReason(source, member) === null) return null;
    }
    return "union 의 어떤 멤버와도 호환되지 않는다";
  }

  if (target.kind === "list") {
    if (source.kind === "list") {
      if (!ruleEnabled("list_covariance")) return "리스트 공변이 꺼져 있다";
      const inner = incompatibleReason(source.item, target.item);
      return inner === null ? null : `리스트 항목이 호환되지 않는다 (${inner})`;
    }
    if (!ruleEnabled("list_promotion")) return "리스트 승격이 꺼져 있다";
    const inner = incompatibleReason(source, target.item);
    return inner === null ? null : `리스트 항목으로 승격할 수 없다 (${inner})`;
  }

  if (source.kind === "list") return "리스트를 단일 값 소켓에 연결할 수 없다";

  if (source.kind === "primitive" && target.kind === "primitive") {
    if (source.name === target.name) return null;
    if (NUMERIC_PROMOTIONS.has(`${source.name}->${target.name}`)) return null;
    return "원시 타입이 다르고 승격 경로도 없다";
  }

  if (source.kind === "tensor" && target.kind === "tensor") {
    return tensorReason(source, target);
  }

  if (source.kind === "opaque" && target.kind === "opaque") {
    if (source.name !== target.name) return "핸들 이름이 다르다";
    if (!ruleEnabled("opaque_capability_subset")) {
      const same =
        source.capabilities.length === target.capabilities.length &&
        target.capabilities.every((c) => source.capabilities.includes(c));
      return same ? null : "능력 태그가 다르다";
    }
    const missing = target.capabilities.filter((c) => !source.capabilities.includes(c));
    return missing.length === 0 ? null : `요구되는 능력이 없다: ${missing.sort().join(", ")}`;
  }

  return "타입 종류가 다르다";
}

function tensorReason(
  source: Extract<SocketType, { kind: "tensor" }>,
  target: Extract<SocketType, { kind: "tensor" }>,
): string | null {
  if (TENSOR_RULE.dtype === "subset") {
    const extra = source.dtypes.filter((d) => !target.dtypes.includes(d));
    if (extra.length > 0) {
      return `대상이 받지 못하는 dtype 이 있다: ${extra.sort().join(", ")}`;
    }
  }

  if (TENSOR_RULE.rank === "equal" && source.shape.length !== target.shape.length) {
    return `랭크가 다르다 (${source.shape.length} vs ${target.shape.length})`;
  }

  const symbolicAny = TENSOR_RULE.symbolic_dim_matches_any !== false;
  const axes = Math.min(source.shape.length, target.shape.length);
  for (let axis = 0; axis < axes; axis += 1) {
    const a = source.shape[axis];
    const b = target.shape[axis];
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b) return `${axis}번 차원 크기가 다르다 (${a} vs ${b})`;
    } else if (!symbolicAny) {
      return `${axis}번 차원이 심볼이라 크기를 확정할 수 없다`;
    }
  }
  return null;
}

/**
 * `types.json` 의 적합성 케이스를 이 구현으로 돌려 불일치 목록을 만든다.
 *
 * Python 로더도 같은 케이스를 돌린다 (`nodal.types.check_conformance`).
 * 양쪽이 모두 빈 목록을 내야 두 구현이 같은 판정을 한다고 말할 수 있다.
 */
export function checkConformance(): string[] {
  const failures: string[] = [];
  CONFORMANCE_CASES.forEach((testCase, index) => {
    const source = parseTypeExpr(testCase.from);
    const target = parseTypeExpr(testCase.to);
    const actual = isCompatible(source, target);
    if (actual !== testCase.compatible) {
      failures.push(
        `[${index}] ${describeType(source)} → ${describeType(target)}: ` +
          `기대 ${testCase.compatible}, 실제 ${actual} (rule=${testCase.rule ?? "?"})`,
      );
    }
  });
  return failures;
}
