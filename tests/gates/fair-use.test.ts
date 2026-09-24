import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";
import { applyGateEnv, appDatabaseUrl, resetDatabase } from "./harness.ts";

applyGateEnv(1);

/**
 * @spec FR-1.1.7 — the application role has a statement timeout, and the edge
 * rate-limits the public surface per client and per host.
 */
test("app_rw has a statement timeout and Caddy rate-limits the public surface", async () => {
  await resetDatabase();
  const client = new pg.Client({ connectionString: appDatabaseUrl });
  await client.connect();
  try {
    const result = await client.query("SHOW statement_timeout");
    assert.equal(result.rows[0].statement_timeout, "10s");
  } finally {
    await client.end();
  }

  const caddyfile = readFileSync("infra/caddy/Caddyfile", "utf8");
  assert.match(caddyfile, /rate_limit/);
  assert.match(caddyfile, /http\.request\.host/);
  assert.match(caddyfile, /coraza_waf/);
});
