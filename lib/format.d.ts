import type { QueryOutcome } from "./clickhouse.js";
export type OutputFormat = "markdown" | "json";
export interface RenderOptions {
    format: OutputFormat;
    /** Longest cell text kept in the output; longer values are truncated with a marker. */
    maxCellChars: number;
    /** Optional heading printed before the result body. */
    title?: string;
    /** Extra notes appended to the result (e.g. tool-specific hints). */
    notes?: string[];
}
/** Truncate a single value for output. */
export declare function truncateText(text: string, maxChars: number): string;
/** Render a query outcome as Markdown (LLM/token friendly) or pretty JSON. */
export declare function renderOutcome(outcome: QueryOutcome, options: RenderOptions): string;
/** Compact one-line summary, used when a tool needs to embed a sub-result. */
export declare function summarizeOutcome(outcome: QueryOutcome): string;
