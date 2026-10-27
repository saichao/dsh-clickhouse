import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SqlGuardError,
  applyRowLimit,
  inspectStatement,
  maskSql,
  wrapWithRowLimit,
  type GuardOptions,
} from "../src/sql-guard.js";

const STRICT: GuardOptions = { allowExternalSources: false, allowQuerySettings: false };
const RELAXED: GuardOptions = { allowExternalSources: true, allowQuerySettings: true };

function statementOf(sql: string, options: GuardOptions = STRICT) {
  return inspectStatement(sql, options);
}

describe("maskSql", () => {
  it("keeps length and blanks comments, strings and quoted identifiers", () => {
    const sql = "SELECT `a b`, 'x--y' /* DROP */ FROM t -- DELETE\nWHERE a = 1";
    const masked = maskSql(sql);
    assert.equal(masked.length, sql.length);
    assert.match(masked, /SELECT\s+,\s+FROM t/);
    assert.doesNotMatch(masked, /DROP|DELETE|a b|x--y/);
    assert.match(masked, /WHERE a = 1/);
  });

  it("handles escaped and doubled quotes", () => {
    const masked = maskSql("SELECT 'it\\'s', 'a''b', \"c\\\"d\" FROM t");
    assert.match(masked, /^SELECT\s+,\s+,\s+FROM t/);
  });
});

describe("inspectStatement: allowed statements", () => {
  it("accepts plain SELECT", () => {
    const statement = statementOf("SELECT 1");
    assert.equal(statement.statement, "SELECT");
    assert.equal(statement.hasLimit, false);
  });

  it("accepts leading whitespace, parentheses and trailing semicolons", () => {
    const statement = statementOf("  \n (SELECT 1) ;  ");
    assert.equal(statement.statement, "SELECT");
    assert.equal(statement.sql, "(SELECT 1)");
  });

  it("accepts CTE queries", () => {
    assert.equal(statementOf("WITH x AS (SELECT 1) SELECT * FROM x").statement, "WITH");
  });

  it("accepts SHOW / DESCRIBE / EXPLAIN / EXISTS", () => {
    for (const [sql, keyword] of [
      ["SHOW TABLES", "SHOW"],
      ["DESCRIBE TABLE db.t", "DESCRIBE"],
      ["DESC TABLE db.t", "DESC"],
      ["EXPLAIN PLAN SELECT 1", "EXPLAIN"],
      ["EXISTS TABLE db.t", "EXISTS"],
    ] as const) {
      assert.equal(statementOf(sql).statement, keyword, sql);
    }
  });

  it("ignores keywords hidden inside strings and quoted identifiers", () => {
    assert.equal(statementOf("SELECT 'DELETE FROM t' AS s").statement, "SELECT");
    assert.doesNotThrow(() => statementOf("SELECT `insert`, `create` FROM t"));
  });

  it("ignores keywords hidden inside comments and strips trailing comments", () => {
    const statement = statementOf("SELECT 1 /* DROP TABLE t */ -- DELETE FROM t");
    assert.equal(statement.sql, "SELECT 1");
  });

  it("detects an existing LIMIT", () => {
    assert.equal(statementOf("SELECT * FROM t LIMIT 5").hasLimit, true);
    assert.equal(statementOf("SELECT * FROM (SELECT 1 LIMIT 2)").hasLimit, true);
  });
});

describe("inspectStatement: rejected statements", () => {
  const rejected: Array<[string, string, RegExp]> = [
    ["empty", "   ", /不能为空/],
    ["comment only", "-- nothing here", /只有注释/],
    ["insert", "INSERT INTO t VALUES (1)", /只读语句/],
    ["truncate", "TRUNCATE TABLE t", /只读语句/],
    ["alter", "ALTER TABLE t ADD COLUMN c Int8", /只读语句/],
    ["system", "SYSTEM FLUSH LOGS", /只读语句/],
    ["set", "SET max_threads = 1", /只读语句/],
    ["multiple statements", "SELECT 1; DROP TABLE t", /单条语句/],
    ["nested write via WITH", "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", /写操作关键字 INSERT/],
    ["nested delete", "WITH x AS (SELECT 1) SELECT * FROM x WHERE 1 = 1 DELETE FROM t", /写操作关键字 DELETE/],
    ["into outfile", "SELECT * FROM t INTO OUTFILE '/tmp/x'", /INTO OUTFILE/],
    ["format clause", "SELECT * FROM t FORMAT JSON", /FORMAT/],
    ["format clause with settings", "SELECT * FROM t FORMAT JSON SETTINGS max_threads = 1", /FORMAT/],
    ["settings clause", "SELECT * FROM t SETTINGS max_result_rows = 0", /SETTINGS/],
  ];

  for (const [name, sql, pattern] of rejected) {
    it(`rejects ${name}`, () => {
      assert.throws(() => statementOf(sql), (error: unknown) => {
        assert.ok(error instanceof SqlGuardError, `${name}: expected SqlGuardError, got ${String(error)}`);
        assert.match(error.message, pattern);
        return true;
      });
    });
  }

  it("allows the quoted-identifier escape hatch for keyword-like column names", () => {
    // bare `delete` is blocked, quoted is fine
    assert.throws(() => statementOf("SELECT delete FROM t"), SqlGuardError);
    assert.doesNotThrow(() => statementOf("SELECT `delete` FROM t"));
  });
});

describe("external data sources", () => {
  it("is blocked by default", () => {
    assert.throws(() => statementOf("SELECT * FROM url('http://example.com')"), /url/);
    assert.throws(() => statementOf("SELECT * FROM file('x.csv', 'CSV')"), /file/);
    assert.throws(() => statementOf("SELECT * FROM remote('h', 'db', 't')"), /remote/);
  });

  it("is allowed when explicitly enabled", () => {
    assert.doesNotThrow(() => statementOf("SELECT * FROM url('http://example.com')", RELAXED));
    assert.doesNotThrow(() => statementOf("SELECT * FROM t SETTINGS max_threads = 1", RELAXED));
  });

  it("does not confuse column names with table functions", () => {
    assert.doesNotThrow(() => statementOf("SELECT file, url, input FROM t"));
    assert.doesNotThrow(() => statementOf("SELECT system.tables.name FROM system.tables"));
  });
});

describe("row limits", () => {
  it("appends a LIMIT only when missing", () => {
    assert.equal(applyRowLimit(statementOf("SELECT 1"), 10), "SELECT 1 LIMIT 10");
    assert.equal(applyRowLimit(statementOf("SELECT 1 LIMIT 3"), 10), "SELECT 1 LIMIT 3");
    assert.equal(applyRowLimit(statementOf("SHOW TABLES"), 10), "SHOW TABLES");
  });

  it("wraps SELECT/WITH statements with an outer LIMIT", () => {
    assert.equal(wrapWithRowLimit(statementOf("SELECT 1"), 10), "SELECT * FROM (\nSELECT 1\n) LIMIT 10");
    assert.match(wrapWithRowLimit(statementOf("WITH x AS (SELECT 1) SELECT * FROM x"), 5), /LIMIT 5$/);
  });
});

describe("maskSql 的 keepQuoted 模式", () => {
  it("保留引号内容，只抹掉注释", () => {
    const masked = maskSql("SELECT `行数`, 'x' -- 尾注释", { keepQuoted: true });
    assert.equal(masked.length, "SELECT `行数`, 'x' -- 尾注释".length);
    assert.match(masked, /`行数`/);
    assert.match(masked, /'x'/);
    assert.doesNotMatch(masked, /尾注释/);
  });
});

describe("结尾是引号内容时不能被截断（真实踩过的 bug）", () => {
  it("以反引号标识符结尾", () => {
    assert.equal(statementOf("SELECT 1 AS `行数`").sql, "SELECT 1 AS `行数`");
    assert.equal(statementOf("SELECT `a b` FROM `t t`").sql, "SELECT `a b` FROM `t t`");
  });

  it("以字符串/双引号字面量结尾", () => {
    assert.equal(statementOf("SELECT 'abc'").sql, "SELECT 'abc'");
    assert.equal(statementOf("SELECT * FROM t WHERE name = 'abc'").sql, "SELECT * FROM t WHERE name = 'abc'");
    assert.equal(statementOf('SELECT 1 AS "x"').sql, 'SELECT 1 AS "x"');
  });

  it("再加行数上限时也保持完整", () => {
    const wrapped = wrapWithRowLimit(statementOf("SELECT 1 AS `行数`"), 6);
    assert.equal(wrapped, "SELECT * FROM (\nSELECT 1 AS `行数`\n) LIMIT 6");
  });

  it("仍然会去掉结尾的注释与空白", () => {
    assert.equal(statementOf("SELECT 1 -- 尾注释").sql, "SELECT 1");
    assert.equal(statementOf("SELECT 1 /* 尾注释 */").sql, "SELECT 1");
    assert.equal(statementOf("SELECT `行数` -- 尾注释").sql, "SELECT `行数`");
    assert.equal(statementOf("SELECT 1 /* it's */ FROM t").sql, "SELECT 1 /* it's */ FROM t");
  });
});
