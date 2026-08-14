import {
  CATALOG,
  describeType,
  isCompatible,
  parseTypeExpr,
  TypeSpecError,
  type SocketType,
  type TypeExpr,
} from "../graph/typesystem";

/**
 * OpenAPI 는 소켓 타입을 사람이 읽는 문자열로 운반한다. 호환 판정은 기존
 * typesystem.ts 에 맡기고, 이 함수는 문자열을 그 시스템의 TypeExpr 로만 바꾼다.
 */
export function parseSocketTypeLabel(label: string): SocketType {
  const value = label.trim();
  if (value.startsWith("List[") && value.endsWith("]")) {
    return parseTypeExpr({ list: toExpr(value.slice(5, -1)) });
  }
  if (value.startsWith("Union[") && value.endsWith("]")) {
    return parseTypeExpr({ union: splitTopLevel(value.slice(6, -1)).map(toExpr) });
  }

  const bracket = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(value);
  if (bracket) {
    const [, name, inner = ""] = bracket;
    const catalogType = CATALOG.get(name ?? "");
    if (catalogType?.kind === "opaque" && name) {
      return parseTypeExpr({
        opaque: name,
        capabilities: splitTopLevel(inner).filter(Boolean),
      });
    }
  }

  return parseTypeExpr(value);
}

export function socketTypesCompatible(source: string, target: string): boolean {
  try {
    return isCompatible(parseSocketTypeLabel(source), parseSocketTypeLabel(target));
  } catch (error) {
    if (error instanceof TypeSpecError) return false;
    throw error;
  }
}

export function describeSocketType(label: string): string {
  try {
    return describeType(parseSocketTypeLabel(label));
  } catch {
    return label;
  }
}

function toExpr(label: string): TypeExpr {
  const value = label.trim();
  if (value.startsWith("List[") && value.endsWith("]")) {
    return { list: toExpr(value.slice(5, -1)) };
  }
  if (value.startsWith("Union[") && value.endsWith("]")) {
    return { union: splitTopLevel(value.slice(6, -1)).map(toExpr) };
  }
  const bracket = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(value);
  if (bracket) {
    const [, name, inner = ""] = bracket;
    const catalogType = CATALOG.get(name ?? "");
    if (catalogType?.kind === "opaque" && name) {
      return { opaque: name, capabilities: splitTopLevel(inner).filter(Boolean) };
    }
  }
  return value;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "[") depth += 1;
    if (character === "]") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}
