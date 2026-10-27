/**
 * 最小 JSON Schema 校验器：只覆盖本插件用到的子集
 * （type / required / properties / additionalProperties / items / enum）。
 *
 * 用途是**核对规范返回值真的符合 `output.schema`**——注册表在呈现前会做同样的校验，
 * 所以在不启动 DSH 的情况下也要能自查。
 *
 * @module dsh-clickhouse/test/schema-check
 */

import type { JsonSchemaNode } from "../src/types.js";

/** 返回违规列表；空数组表示通过。 */
export function validate(schema: JsonSchemaNode, value: unknown, path = "$"): string[] {
  const problems: string[] = [];
  const type = schema.type;

  if (typeof type === "string") {
    const ok =
      (type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) ||
      (type === "array" && Array.isArray(value)) ||
      (type === "string" && typeof value === "string") ||
      (type === "boolean" && typeof value === "boolean") ||
      (type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (type === "number" && typeof value === "number") ||
      (type === "null" && value === null);
    if (!ok) {
      problems.push(`${path}: 期望 ${type}，实际 ${JSON.stringify(value)}`);
      return problems;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} 不在 enum 内`);
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((item, index) =>
      problems.push(...validate(schema.items as JsonSchemaNode, item, `${path}[${index}]`)),
    );
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchemaNode>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) problems.push(`${path}.${key}: 缺少必填字段`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) problems.push(`${path}.${key}: 未声明的字段`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in record) problems.push(...validate(child, record[key], `${path}.${key}`));
    }
  }

  return problems;
}
