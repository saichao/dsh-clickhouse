import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueryOutcome } from "../src/clickhouse.js";
import { renderOutcome, truncateText } from "../src/format.js";

function makeOutcome(overrides: Partial<QueryOutcome> = {}): QueryOutcome {
  return {
    columns: ["name", "value"],
    columnTypes: { name: "String", value: "UInt64" },
    rows: [{ name: "a|b", value: 1 }],
    limit: 10,
    truncated: false,
    elapsedMs: 12,
    queryId: "chmcp-test",
    executedSql: "SELECT 1",
    sqlWasRewritten: false,
    notes: [],
    ...overrides,
  };
}

describe("truncateText", () => {
  it("keeps short text and marks truncated text", () => {
    assert.equal(truncateText("abc", 5), "abc");
    assert.equal(truncateText("abcdef", 3), "abc…[+3 chars]");
  });
});

describe("renderOutcome (markdown)", () => {
  it("renders a summary and an escaped table", () => {
    const output = renderOutcome(makeOutcome(), { format: "markdown", maxCellChars: 100 });
    assert.match(output, /- rows: 1 \| limit: 10 \| elapsed: 12 ms/);
    assert.match(output, /- query_id: chmcp-test/);
    assert.match(output, /\| name \| value \|/);
    assert.match(output, /a\\\|b/);
  });

  it("flags truncated results", () => {
    const output = renderOutcome(makeOutcome({ truncated: true }), { format: "markdown", maxCellChars: 100 });
    assert.match(output, /已截断/);
  });

  it("renders notes and an empty result set", () => {
    const output = renderOutcome(makeOutcome({ rows: [], notes: ["注意 A"] }), {
      format: "markdown",
      maxCellChars: 100,
      title: "标题",
    });
    assert.match(output, /> 注意 A/);
    assert.match(output, /没有数据行/);
    assert.match(output, /^标题/);
  });
});

describe("renderOutcome (json)", () => {
  it("includes structure, types and truncates long cells", () => {
    const output = renderOutcome(makeOutcome({ rows: [{ name: "x".repeat(50), value: 7 }] }), {
      format: "json",
      maxCellChars: 10,
    });
    const parsed = JSON.parse(output) as { columns: string[]; columnTypes: Record<string, string>; rows: Array<{ name: string }> };
    assert.deepEqual(parsed.columns, ["name", "value"]);
    assert.equal(parsed.columnTypes.value, "UInt64");
    assert.match(parsed.rows[0]!.name, /…\[\+40 chars\]$/);
  });
});
