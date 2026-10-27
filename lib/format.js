/** Truncate a single value for output. */
export function truncateText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars)}…[+${text.length - maxChars} chars]`;
}
function toPlainText(value) {
    if (value === null || value === undefined)
        return "NULL";
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
        return String(value);
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
function toMarkdownCell(value, maxChars) {
    return truncateText(toPlainText(value).replace(/\r?\n/g, "\\n").replace(/\|/g, "\\|"), maxChars);
}
function toJsonRow(row, maxChars) {
    const mapped = {};
    for (const [key, value] of Object.entries(row)) {
        mapped[key] = typeof value === "string" ? truncateText(value, maxChars) : value;
    }
    return mapped;
}
function renderMarkdownTable(outcome, maxCellChars) {
    if (outcome.columns.length === 0)
        return "_（无列信息）_";
    if (outcome.rows.length === 0) {
        return `| ${outcome.columns.join(" | ")} |\n| ${outcome.columns.map(() => "---").join(" | ")} |\n\n_（没有数据行）_`;
    }
    const header = `| ${outcome.columns.map((column) => column.replace(/\|/g, "\\|")).join(" | ")} |`;
    const separator = `| ${outcome.columns.map(() => "---").join(" | ")} |`;
    const body = outcome.rows
        .map((row) => `| ${outcome.columns.map((column) => toMarkdownCell(row[column], maxCellChars)).join(" | ")} |`)
        .join("\n");
    return `${header}\n${separator}\n${body}`;
}
function renderSummaryLines(outcome) {
    const lines = [];
    const truncatedNote = outcome.truncated
        ? `（已截断：仅返回前 ${outcome.rows.length} 行，实际结果更多；请收窄条件或加聚合/ORDER BY 后重试）`
        : "";
    lines.push(`rows: ${outcome.rows.length}${truncatedNote} | limit: ${outcome.limit} | elapsed: ${outcome.elapsedMs} ms`);
    lines.push(`query_id: ${outcome.queryId}`);
    if (outcome.statistics) {
        const stats = outcome.statistics;
        const parts = [];
        if (typeof stats.rows_read === "number")
            parts.push(`rows_read=${stats.rows_read}`);
        if (typeof stats.bytes_read === "number")
            parts.push(`bytes_read=${stats.bytes_read}`);
        if (typeof stats.elapsed === "number")
            parts.push(`server_elapsed=${stats.elapsed}s`);
        if (parts.length > 0)
            lines.push(`statistics: ${parts.join(", ")}`);
    }
    if (typeof outcome.rowsBeforeLimitAtLeast === "number") {
        lines.push(`rows_before_limit_at_least: ${outcome.rowsBeforeLimitAtLeast}`);
    }
    if (outcome.sqlWasRewritten) {
        lines.push(`executed_sql: ${outcome.executedSql.replace(/\s+/g, " ").trim()}`);
    }
    return lines;
}
/** Render a query outcome as Markdown (LLM/token friendly) or pretty JSON. */
export function renderOutcome(outcome, options) {
    const notes = [...(options.notes ?? []), ...outcome.notes];
    const noteBlock = notes.length > 0 ? notes.map((note) => `> ${note}`).join("\n") + "\n\n" : "";
    if (options.format === "json") {
        const payload = {
            columns: outcome.columns,
            columnTypes: outcome.columnTypes,
            rowCount: outcome.rows.length,
            truncated: outcome.truncated,
            limit: outcome.limit,
            elapsedMs: outcome.elapsedMs,
            queryId: outcome.queryId,
            statistics: outcome.statistics,
            rowsBeforeLimitAtLeast: outcome.rowsBeforeLimitAtLeast,
            executedSql: outcome.executedSql,
            notes,
            rows: outcome.rows.map((row) => toJsonRow(row, options.maxCellChars)),
        };
        return `${options.title ? `${options.title}\n` : ""}${JSON.stringify(payload, null, 2)}`;
    }
    const heading = options.title ? `${options.title}\n\n` : "";
    const summary = renderSummaryLines(outcome).map((line) => `- ${line}`).join("\n");
    return `${heading}${noteBlock}${summary}\n\n${renderMarkdownTable(outcome, options.maxCellChars)}`;
}
/** Compact one-line summary, used when a tool needs to embed a sub-result. */
export function summarizeOutcome(outcome) {
    return `${outcome.rows.length} 行 / ${outcome.elapsedMs} ms / query_id=${outcome.queryId}`;
}
//# sourceMappingURL=format.js.map