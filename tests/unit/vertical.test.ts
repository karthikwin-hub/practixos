import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/** @spec FR-1.1.4 — vertical seeds configuration and is not a runtime branch. */
test("application code does not branch on vertical", () => {
  const files = walk("src").filter((file) => file.endsWith(".ts"));
  const conditional = /if\s*\([^)]*vertical|switch\s*\([^)]*vertical|vertical\s*===|vertical\s*==|vertical\s*!==|\bvertical\s*\?/;
  const hits = files.filter((file) => conditional.test(readFileSync(file, "utf8")));
  assert.deepEqual(hits, []);
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
