import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

/**
 * @spec §5.4 — Compose and Caddy are the production topology: caddy, api,
 * postgres, and netdata on the host; the API connects as app_rw; Caddy
 * terminates TLS-facing traffic, serves the static client, and proxies the API.
 * Terraform is read, not applied.
 */
test("compose and caddy match the production topology", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const caddy = readFileSync("infra/caddy/Caddyfile", "utf8");
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const compute = readFileSync("infra/terraform/compute.tf", "utf8");
  const storage = readFileSync("infra/terraform/storage.tf", "utf8");

  for (const service of ["caddy:", "api:", "postgres:", "netdata:"]) {
    assert.equal(compose.includes(service), true, service);
  }
  assert.equal(/kubernetes|kind:\s*Deployment/i.test(compose), false);
  assert.match(compose, /pgdata:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /pgbackrest:/);
  assert.match(compose, /APP_DATABASE_URL: postgres:\/\/app_rw:/);
  assert.match(compose, /DATABASE_URL: postgres:\/\/postgres:/);
  assert.match(compose, /"3000:3000"/);
  assert.match(compose, /"8080:80"/);

  assert.match(caddy, /coraza_waf/);
  assert.match(caddy, /reverse_proxy api:3000/);
  assert.match(caddy, /file_server/);

  assert.match(dockerfile, /FROM node:22/);
  assert.match(compute, /VM\.Standard\.A1\.Flex/);
  assert.match(compute, /VM\.Standard\.E2\.1\.Micro/);
  assert.match(storage, /practixos-pgbackrest/);
  assert.match(storage, /centralindia/i);
});

/**
 * @spec §5.6 — the restore drill exits clean and the restored database
 * answers the checksum query.
 */
test("the restore drill restores a database that answers a query", { timeout: 180_000 }, () => {
  const bash = process.platform === "win32"
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash";
  const result = spawnSync(bash, ["scripts/restore-drill.sh"], {
    encoding: "utf8",
    timeout: 170_000,
  });
  assert.equal(result.status, 0, (result.stdout ?? "") + (result.stderr ?? ""));
  assert.match(result.stdout ?? "", /PASS drill-/);
});
