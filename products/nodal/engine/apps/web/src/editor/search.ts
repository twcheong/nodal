import type { NodeSchema } from "../api/types";

export function searchSchemas(schemas: readonly NodeSchema[], query: string): NodeSchema[] {
  const needle = normalize(query);
  if (!needle) return [...schemas];
  return schemas
    .map((schema) => ({ schema, score: schemaScore(schema, needle) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.schema.title.localeCompare(right.schema.title),
    )
    .map((entry) => entry.schema);
}

function schemaScore(schema: NodeSchema, needle: string): number {
  const fields = [schema.title, schema.id, schema.category, ...(schema.aliases ?? [])];
  return Math.max(
    ...fields.map((field, index) => fuzzyScore(normalize(field), needle) - index * 2),
  );
}

function fuzzyScore(text: string, needle: string): number {
  const exact = text.indexOf(needle);
  if (exact >= 0) return 1_000 - exact * 4 - (text.length - needle.length);
  let cursor = 0;
  let first = -1;
  let gaps = 0;
  for (const character of needle) {
    const found = text.indexOf(character, cursor);
    if (found < 0) return -1;
    if (first < 0) first = found;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 500 - first * 4 - gaps * 6 - text.length;
}

function normalize(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("ko-KR")
    .replace(/[\s._-]+/g, "");
}
