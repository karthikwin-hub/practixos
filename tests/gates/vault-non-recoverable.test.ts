import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as vault from "../../src/modules/vault/crypto.ts";
import { endPool, withTenant } from "../../src/db/tenant.ts";
import { applyGateEnv, databaseUrl, resetDatabase, withSuperuser } from "./harness.ts";

applyGateEnv(2);

const plaintext = "PRACTIXOS_VAULT_PLAINTEXT_SENTINEL";
const pin = "1234";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await endPool();
});

/**
 * @spec 10.1 — note plaintext is unrecoverable from a full dump plus every
 * server-held secret, without the patient's PIN. There is no single-factor path.
 */
test("a dump plus the server secret does not yield note plaintext without the PIN", async () => {
  assert.equal(vault.vaultKdf.memoryKib, 64 * 1024);
  assert.equal(vault.vaultKdf.iterations, 3);
  assert.equal(vault.vaultKdf.parallelism, 1);

  const decrypts = Object.entries(vault).filter(([name, value]) =>
    name.toLowerCase().includes("decrypt") && typeof value === "function",
  );
  assert.deepEqual(decrypts.map(([name]) => name), ["decryptNote"]);
  assert.ok(vault.decryptNote.length >= 3);

  const secretDir = mkdtempSync(path.join(tmpdir(), "practix-vault-"));
  const secretPath = path.join(secretDir, "server-secret");
  const serverSecret = randomBytes(32);
  writeFileSync(secretPath, serverSecret);

  try {
    const payload = await vault.encryptNote(plaintext, pin, serverSecret);
    const clinicId = randomUUID();
    await withTenant(clinicId, (tx) =>
      tx.query(
        `INSERT INTO clinics (id, slug, legal_name, vertical, display_name) VALUES ($1, $2, $3, 'mental_health', $3)`,
        [clinicId, `v-${clinicId.slice(0, 8)}`, "Vault Clinic"],
      ),
    );
    await withTenant(clinicId, (tx) =>
      tx.query(
        `INSERT INTO vault_notes (clinic_id, salt, nonce, ciphertext) VALUES ($1, $2, $3, $4)`,
        [clinicId, payload.salt, payload.nonce, payload.ciphertext],
      ),
    );

    const columns = await withSuperuser((client) =>
      client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (column_name ILIKE '%plain%' OR column_name ILIKE '%server_secret%')`,
      ),
    );
    assert.equal(columns.rowCount, 0);

    const dump = await dumpDatabase();
    assert.ok(!dump.includes(plaintext), "dump contains note plaintext");
    assert.ok(!dump.includes(serverSecret.toString("base64")), "dump contains the server secret");
    assert.ok(!dump.includes(serverSecret.toString("hex")), "dump contains the server secret");

    const stored = await withTenant(clinicId, (tx) =>
      tx.query("SELECT salt, nonce, ciphertext FROM vault_notes"),
    );
    const row = stored.rows[0] as { salt: Buffer; nonce: Buffer; ciphertext: Buffer };
    await assert.rejects(vault.decryptNote(row, "0000", serverSecret));
    assert.equal(await vault.decryptNote(row, pin, serverSecret), plaintext);
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
});

function hasCommand(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function dumpDatabase(): Promise<string> {
  if (hasCommand("pg_dump")) {
    return capture("pg_dump", ["--dbname", databaseUrl, "--no-owner", "--no-privileges"]);
  }
  return capture("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "pg_dump",
    "-U",
    "postgres",
    "-d",
    "practixos_test",
    "--no-owner",
    "--no-privileges",
  ]);
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString("utf8")}`));
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}
