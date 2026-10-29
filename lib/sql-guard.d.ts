import { UserError } from "./errors.js";
export interface GuardOptions {
    /** Allow file()/url()/remote()/s3()/... table functions. Default false. */
    allowExternalSources: boolean;
    /** Allow a trailing `SETTINGS ...` clause. Default false. */
    allowQuerySettings: boolean;
    /**
     * Allow JOIN / set operators / references to more than one table. Default false.
     *
     * 注意「单表」是按**引用的表**判定的，不是按 WHERE 条件个数：同表多字段 AND/OR、
     * 同一张表的子查询都算单表，必须放行。
     */
    allowCrossTable: boolean;
    /** 用于把不带库名的表名解析成完整表名（`db.t` 与 `t` 视为同一张表）。 */
    defaultDatabase?: string;
}
/**
 * 列出 SQL 引用到的表（去重，忽略 CTE 名、派生表别名与 ARRAY JOIN 的数组列）。
 *
 * 只看「引用了哪些表」，所以有几个 WHERE 条件、用了多少字段、是不是子查询都不影响结论：
 * `字段A LIKE '%x%' AND 字段B LIKE '%x%'`、多字段 OR、同表子查询都只算一张表。
 *
 * 实现上先定位每个 FROM / JOIN，再解析它后面的表列表（`t`、`db.t`、`` `带空格的表` ``、
 * `t1, t2`、`t AS x` 都认），遇到顶层子句关键字（WHERE / GROUP / ON / …）就结束。
 */
export declare function extractTableReferences(sql: string, defaultDatabase?: string): string[];
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
