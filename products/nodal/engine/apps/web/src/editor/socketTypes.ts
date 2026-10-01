import type { SocketTypeExpr } from "../api/types";
import {
  describeType,
  isCompatible,
  parseTypeExpr,
  TypeSpecError,
  type SocketType,
} from "../graph/typesystem";

/** OpenAPI의 구조화 표현식을 `types.json` 기반 런타임 타입으로 푼다. */
export function parseSocketType(expr: SocketTypeExpr): SocketType {
  return parseTypeExpr(expr);
}

/** 호환 규칙을 복제하지 않고 기존 타입 시스템에 위임한다. */
export function socketTypesCompatible(source: SocketTypeExpr, target: SocketTypeExpr): boolean {
  try {
    return isCompatible(parseSocketType(source), parseSocketType(target));
  } catch (error) {
    if (error instanceof TypeSpecError) return false;
    throw error;
  }
}

export function describeSocketType(expr: SocketTypeExpr): string {
  try {
    return describeType(parseSocketType(expr));
  } catch {
    return JSON.stringify(expr);
  }
}
