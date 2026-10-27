/** Error caused by user input, guard rules or configuration: safe to show as-is. */
export declare class UserError extends Error {
    readonly name: string;
}
/** ClickHouse error codes worth naming explicitly in user-facing messages. */
export declare const ClickHouseErrorCode: {
    readonly UNKNOWN_IDENTIFIER: 47;
    readonly SYNTAX_ERROR: 62;
    readonly TIMEOUT_EXCEEDED: 159;
    readonly TOO_MANY_ROWS: 158;
    readonly READONLY: 164;
    readonly QUERY_WAS_CANCELLED: 394;
};
export declare function asClickHouseError(error: unknown): {
    code: number;
    type: string;
    message: string;
} | null;
export declare function describeError(error: unknown): string;
/**
 * 可读文本，并展开 `error.cause`（最多三层）。
 *
 * undici 的网络失败外层永远只是 `TypeError: fetch failed`，真正的原因
 * （`connect ECONNREFUSED 127.0.0.1:8123`、`getaddrinfo ENOTFOUND`、超时）在 `cause` 里。
 * 不展开的话，连接被拒、域名解析失败、超时全都长成同一句 "fetch failed"：调用方既分不出
 * 原因，也匹配不到下面 `describeNetworkError` 里的友好提示。
 */
export declare function describeThrown(error: unknown): string;
export declare function isReadonlySettingRejection(error: unknown): boolean;
