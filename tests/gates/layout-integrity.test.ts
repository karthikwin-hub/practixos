import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * @spec 8.2 — layout integrity is prototype/check-layout.py across seven widths.
 * verify.sh runs that check; this test does not paint the viewports again.
 */
test("verify.sh runs the layout integrity check", () => {
  const verify = readFileSync("scripts/verify.sh", "utf8");
  assert.match(verify, /prototype\/check-layout\.py/);
});
