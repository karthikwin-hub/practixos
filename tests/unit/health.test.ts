import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildApp } from "../../src/app.ts";

test("the process exposes health and no business route", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  const routes = app.printRoutes();
  for (const forbidden of ["/patients", "/appointments", "/bookings", "/otp", "/payments"]) {
    assert.equal(routes.includes(forbidden), false);
  }
  await app.close();
});

/** @spec 4.4.1 — pool.connect outside the accessor fails the build. */
test("eslint rejects pool.connect outside tenant.ts", () => {
  const file = path.join("src", "modules", "scheduling", "pool-leak.fixture.ts");
  writeFileSync(
    file,
    "export async function leak(pool: { connect(): Promise<void> }) {\n  return pool.connect();\n}\n",
  );
  try {
    execFileSync(
      process.execPath,
      [path.join("node_modules", "eslint", "bin", "eslint.js"), file],
      { encoding: "utf8" },
    );
    assert.fail("expected eslint to reject pool.connect");
  } catch (err) {
    const output = `${(err as { stdout?: string }).stdout ?? ""}\n${(err as { stderr?: string }).stderr ?? ""}`;
    assert.match(output, /Use withTenant|pool\.connect/);
  } finally {
    rmSync(file, { force: true });
  }
});
