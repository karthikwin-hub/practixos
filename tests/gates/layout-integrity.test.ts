import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { boot, finishDental, owner, shutdown } from "./api.ts";

/**
 * This file used to assert that `scripts/verify.sh` contained the string
 * "prototype/check-layout.py", and claimed §8.2 for it. That passes whether or
 * not a single screen has ever been measured — it is the "testing the test"
 * failure §10.1 names, wearing the name of a gate. The checks below execute the
 * measurement instead.
 */

function run(script: string, args: string[], timeout = 600_000) {
  return spawnSync("python3", [script, ...args], { encoding: "utf8", timeout });
}

/**
 * @spec 8.2 — every view, every tenant, seven widths: no horizontal overflow
 * and no collapsed content. Runs the real headless-Chrome measurement over the
 * prototype, which is the behavioural and visual reference.
 */
test("the prototype has no horizontal overflow at any width", () => {
  const result = run("prototype/check-layout.py", []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The script exits 0 with a notice when Chrome is absent, which would make
  // this test green having measured nothing. Insist it actually counted screens.
  assert.match(result.stdout, /No horizontal overflow\. \d+ screens/,
    "check-layout.py exited 0 without measuring anything:\n" + result.stdout);
});

/**
 * @spec 8.2, §6.6 — the same assertions over the built client, plus the
 * breakpoint ladder: Compact below 600, Tablet to 1023, Full at 1024 and above.
 *
 * The prototype check above reads a file the build never touches, so on its own
 * it reports green regardless of what the product looks like. This is the one
 * that measures the product.
 */
test("the built client has no horizontal overflow and honours the §6.6 ladder", async (t) => {
  if (!existsSync("web/dist")) {
    t.skip("no web/dist; run: npm --prefix web run build");
    return;
  }
  const app = await boot();
  try {
    // Signed in and populated. Measuring the empty state would miss the widest
    // thing on every screen, which is a queue lane with cards in it.
    const token = await owner(app, "layout-probe");
    await finishDental(app, token);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    // Twelve screens, each measured at seven widths. The previous ten-screen
    // run already used nearly the whole ten minutes; cutting it off reports
    // a missing status rather than an overflow.
    const result = run("scripts/check-client-layout.py", ["--api", address, "--token", token], 1_200_000);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Client layout intact\. \d+ screens/,
      "check-client-layout.py exited 0 without measuring anything:\n" + result.stdout);
  } finally {
    await shutdown(app);
  }
});
