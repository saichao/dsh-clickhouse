/** Error caused by user input, guard rules or configuration: safe to show as-is. */
export class UserError extends Error {
  override readonly name: string = "UserError";
}

interface ClickHouseErrorLike {
  code?: unknown;
  type?: unknown;
  message?: unknown;
}

/** ClickHouse error codes worth naming explicitly in user-facing messages. */
export const ClickHouseErrorCode = {
  UNKNOWN_IDENTIFIER: 47,
  SYNTAX_ERROR: 62,
  TIMEOUT_EXCEEDED: 159,
  TOO_MANY_ROWS: 158,
  READONLY: 164,
  QUERY_WAS_CANCELLED: 394,
} as const;

export function asClickHouseError(error: unknown): { code: number; type: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as ClickHouseErrorLike;
  const code = typeof candidate.code === "number" ? candidate.code : Number(candidate.code);
  if (!Number.isFinite(code)) return null;
  return {
    code,
    type: typeof candidate.type === "string" ? candidate.type : "UNKNOWN",
    message: typeof candidate.message === "string" ? candidate.message : String(candidate.message ?? ""),
  };
}

export function describeError(error: unknown): string {
  if (error instanceof UserError) return error.message;

  const clickhouseError = asClickHouseError(error);
  if (clickhouseError) {
    const lines = [`ClickHouse 错误 ${clickhouseError.code} (${clickhouseError.type})`, clickhouseError.message.trim()];
    return lines.join("\n");
  }
  return describeThrown(error);
}

/** 单个错误的可读文本：`AggregateError` 消息为空时退回它第一个有内容的子错误。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) return `${error.name}: ${message}`;
    const nested = (error as { errors?: unknown[] }).errors;
    if (Array.isArray(nested)) {
      const inner = nested.find(
        (item): item is Error => item instanceof Error && item.message.trim().length > 0,
      );
      if (inner) return `${error.name}: ${inner.message.trim()}`;
    }
    return error.name;
  }
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * 可读文本，并展开 `error.cause`（最多三层）。
 *
 * undici 的网络失败外层永远只是 `TypeError: fetch failed`，真正的原因
 * （`connect ECONNREFUSED 127.0.0.1:8123`、`getaddrinfo ENOTFOUND`、超时）在 `cause` 里。
 * 不展开的话，连接被拒、域名解析失败、超时全都长成同一句 "fetch failed"：调用方既分不出
 * 原因，也匹配不到下面 `describeNetworkError` 里的友好提示。
 */
export function describeThrown(error: unknown): string {
  const parts = [messageOf(error)];
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < 3 && cause !== undefined && cause !== null; depth += 1) {
    const text = messageOf(cause);
    if (text.trim().length > 0 && !parts.includes(text)) parts.push(text);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join(" ← ");
}

export function isReadonlySettingRejection(error: unknown): boolean {
  const clickhouseError = asClickHouseError(error);
  if (!clickhouseError) return false;
  return clickhouseError.code === ClickHouseErrorCode.READONLY && /setting in readonly mode/i.test(clickhouseError.message);
}
