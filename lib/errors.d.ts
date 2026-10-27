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
 * Readable text for any thrown value.
 * `AggregateError` (Node's dual-stack connect failures) carries an empty message,
 * so fall back to its first meaningful nested error.
 */
export declare function describeThrown(error: unknown): string;
export declare function isReadonlySettingRejection(error: unknown): boolean;
