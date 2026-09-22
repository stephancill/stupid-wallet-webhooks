import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { URL } from "node:url";

/** Real SQLite transactions/constraints behind the subset of D1 used by these tests. */
export function createTestDatabase({ migrate = true }: { migrate?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../migrations/", import.meta.url);
  const files = readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrate ? files : files.slice(0, 2))
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  let failBatch = false;
  function prepare(sql: string) {
    let args: unknown[] = [];
    function values() {
      return args as Array<string | number | bigint | Uint8Array | null>;
    }
    const statement = {
      bind(...params: unknown[]) {
        args = params;
        return statement;
      },
      all() {
        return { results: sqlite.query(sql).all(...values()), success: true, meta: {} };
      },
      first(column?: string) {
        const row = sqlite.query(sql).get(...values()) as Record<string, unknown> | null;
        return column && row ? row[column] : row;
      },
      run() {
        const result = sqlite.query(sql).run(...values());
        return { success: true, results: [], meta: { changes: result.changes } };
      },
    };
    return statement;
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      return sqlite.transaction(() =>
        statements.map((statement, index) => {
          const result = statement.run();
          if (failBatch && index === 1) {
            failBatch = false;
            throw new Error("injected transaction failure");
          }
          return result;
        }),
      )();
    },
  } as unknown as D1Database;
  return {
    db,
    sqlite,
    failNextBatch() {
      failBatch = true;
    },
  };
}
