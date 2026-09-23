import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildApp } from "../src/app.ts";

/**
 * M0 exit: health only, the four gates are the other files in tests/gates,
 * and the restore drill has passed unattended. The timed terraform apply
 * transcript needs an OCI tenancy and is recorded separately.
 */
test("M0 health check still answers and M5 routes are absent", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  const routes = app.printRoutes();
  assert.equal(routes.includes("/abdm"), false);
  await app.close();
});

test("the restore drill report records a passing unattended restore", () => {
  const report = readFileSync("docs/evidence/m0/restore-drill.md", "utf8");
  assert.match(report, /Result: PASS/);
  assert.match(report, /Checksum: [0-9a-f]{32}/);
  assert.match(report, /Restored checksum: [0-9a-f]{32}/);
});

test("terraform keeps production in ap-mumbai-1 on an Ampere A1 and DNS-only Cloudflare", () => {
  const variables = readFileSync("infra/terraform/variables.tf", "utf8");
  const compute = readFileSync("infra/terraform/compute.tf", "utf8");
  assert.match(variables, /ap-mumbai-1/);
  assert.match(variables, /cloudflare_proxied == false/);
  assert.match(compute, /VM\.Standard\.A1\.Flex/);
  assert.match(compute, /ocpus\s+=\s+2/);
  assert.match(compute, /memory_in_gbs\s+=\s+12/);
  assert.match(compute, /VM\.Standard\.E2\.1\.Micro/);
});
