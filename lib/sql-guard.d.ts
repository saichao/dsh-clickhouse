import { UserError } from "./errors.js";
export interface GuardOptions {
    /** Allow file()/url()/remote()/s3()/... table functions. Default false. */
    allowExternalSources: boolean;
    /** Allow a trailing `SETTINGS ...` clause. Default false. */
    allowQuerySettings: boolean;
}
export interface GuardedStatement {
    /** Statement with trailing comments/whitespace removed and trailing `;` stripped. */
    sql: string;
    /** Comment/literal-free view of `sql`, used for keyword inspection. */
    masked: string;
    /** Uppercase first keyword, e.g. `SELECT`. */
    statement: string;
    /** True when the statement already carries a `LIMIT` clause. */
    hasLimit: boolean;
    /** Human-readable warnings produced by the guard (non fatal). */
    warnings: string[];
}
export declare class SqlGuardError extends UserError {
    readonly name: string;
}
/**
 * Replace comments and quoted literals/identifiers with spaces, keeping the rest
 * of the SQL intact so keywords can be located reliably.
 *
 * `keepQuoted: true` 时引号里的内容原样保留（只抹注释）。用于「找最后一个代码字符」，
 * 因为把引号内容也抹成空格会让以引号结尾的语句被误判为在引号之前就结束了。
 */
export declare function maskSql(sql: string, options?: {
    keepQuoted?: boolean;
}): string;
/** Drop trailing comments and whitespace: `SELECT 1 -- x` -> `SELECT 1`. */
export declare function stripTrailingComments(sql: string): string;
/**
 * Validate a statement and return its normalized form.
 * @throws {SqlGuardError} when the statement is not a safe read-only query.
 */
export declare function inspectStatement(rawSql: string, options: GuardOptions): GuardedStatement;
/** True when the statement can be wrapped into `SELECT * FROM (<sql>) LIMIT n`. */
export declare function isWrappable(statement: GuardedStatement): boolean;
/** Append a `LIMIT` when the statement has none. Used by the fallback path. */
export declare function applyRowLimit(statement: GuardedStatement, limit: number): string;
/** Hard row cap at the SQL level: `SELECT * FROM (<sql>) LIMIT n + 1`. */
export declare function wrapWithRowLimit(statement: GuardedStatement, limit: number): string;
