import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { auth, boot, finishDental, owner, shutdown, webhook } from "../tests/gates/api.ts";
import { databaseUrl, withSuperuser } from "../tests/gates/harness.ts";
import { decryptNote, loadServerSecret } from "../src/modules/vault/crypto.ts";
import { shouldRelock } from "../src/modules/vault/index.ts";

const pin = "1234";
const subjective = "PRACTIXOS_VAULT_PLAINTEXT_SENTINEL the week felt heavier";

/**
 * @spec FR-5.1, FR-5.2, FR-5.3, §4.4.4 — a note written through the product
 * stays unreadable in a dump, and the front desk never receives the text.
 */
test("a product note stays unreadable without the PIN", async () => {
  const secretDir = mkdtempSync(path.join(tmpdir(), "practix-m6-"));
  const secretPath = path.join(secretDir, "server-secret");
  writeFileSync(secretPath, randomBytes(32));
  process.env.VAULT_SERVER_SECRET_PATH = secretPath;
  const app = await boot();
  try {
    const token = await owner(app, "vault-clinic", "mental_health");
    const headers = auth(token);
    const { practitionerId } = await finishDental(app, token);
    const walk = await app.inject({
      method: "POST",
      url: "/api/walk-ins",
      headers,
      payload: { phone: "9811111191", name: "Asha Kulkarni", practitionerId },
    });
    assert.equal(walk.statusCode, 200, walk.body);
    const patientId = walk.json().patientId as string;
    const saved = await app.inject({
      method: "POST",
      url: "/api/vault/notes",
      headers,
      payload: {
        patientId,
        pin,
        s: subjective,
        o: "quiet, slow speech",
        a: "anxiety unchanged",
        p: "same time next week",
        dsm: "F41.1",
        gad7: 12,
        phq9: 8,
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const dump = await dumpDatabase();
    assert.equal(dump.includes(subjective), false);
    const serverSecret = loadServerSecret(secretPath);
    assert.equal(dump.includes(serverSecret.toString("hex")), false);

    const sealed = await app.inject({ method: "GET", url: `/api/vault/notes?patientId=${patientId}`, headers });
    assert.equal(sealed.statusCode, 200);
    assert.equal(JSON.stringify(sealed.json()).includes(subjective), false);
    assert.equal(JSON.stringify(sealed.json()).includes("F41.1"), false);

    const clinicId = await withSuperuser(async (client) => {
      const row = await client.query<{ clinic_id: string }>(
        `SELECT clinic_id FROM patients WHERE id = $1`,
        [patientId],
      );
      const desk = await client.query<{ id: string }>(
        `INSERT INTO staff_users (clinic_id, email, full_name, role, password_hash, password_salt)
         VALUES ($1, 'desk@vault-clinic.test', 'Desk', 'reception', 'x', decode('00','hex'))
         RETURNING id`,
        [row.rows[0].clinic_id],
      );
      await client.query(
        `INSERT INTO staff_sessions (token, clinic_id, user_id, expires_at)
         VALUES ('desk-token', $1, $2, now() + interval '1 day')`,
        [row.rows[0].clinic_id, desk.rows[0].id],
      );
      return row.rows[0].clinic_id;
    });
    const deskView = await app.inject({
      method: "GET",
      url: `/api/vault/notes?patientId=${patientId}`,
      headers: auth("desk-token"),
    });
    assert.equal(deskView.statusCode, 200, deskView.body);
    const masked = JSON.stringify(deskView.json());
    assert.equal(masked.includes(subjective), false);
    assert.equal(masked.includes("F41.1"), false);
    assert.match(masked, /Asha Kulkarni/);
    const denied = await app.inject({
      method: "POST",
      url: "/api/vault/unlock",
      headers: auth("desk-token"),
      payload: { patientId, pin },
    });
    assert.equal(denied.statusCode, 403);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/vault/unlock",
      headers,
      payload: { patientId, pin: "0000" },
    });
    assert.equal(wrong.statusCode, 401);
    const audited = await withSuperuser(async (client) => {
      const row = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE clinic_id = $1 AND action = 'vault.denied'`,
        [clinicId],
      );
      return row.rows[0].n;
    });
    assert.equal(audited, 1);

    const opened = await app.inject({
      method: "POST",
      url: "/api/vault/unlock",
      headers,
      payload: { patientId, pin },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const notes = opened.json().notes as { s: string; dsm: string; gad7: number; phq9: number }[];
    assert.equal(notes[0].s, subjective);
    assert.equal(notes[0].dsm, "F41.1");
    assert.equal(notes[0].gad7, 12);
    assert.equal(notes[0].phq9, 8);

    const stored = await withSuperuser(async (client) =>
      client.query<{ salt: Buffer; nonce: Buffer; ciphertext: Buffer }>(
        `SELECT salt, nonce, ciphertext FROM vault_notes WHERE patient_id = $1`,
        [patientId],
      ),
    );
    await assert.rejects(decryptNote(stored.rows[0], "0000", serverSecret));
    assert.equal(await decryptNote(stored.rows[0], pin, serverSecret), JSON.stringify({
      s: subjective, o: "quiet, slow speech", a: "anxiety unchanged", p: "same time next week",
      dsm: "F41.1", gad7: 12, phq9: 8,
    }));

    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: "POST",
        url: "/api/vault/unlock",
        headers,
        payload: { patientId, pin: "9999" },
      });
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/vault/unlock",
      headers,
      payload: { patientId, pin },
    });
    assert.equal(locked.statusCode, 429);

    assert.equal(shouldRelock(599_999), false);
    assert.equal(shouldRelock(600_000), true);
    const client = readFileSync("web/src/App.tsx", "utf8");
    assert.match(client, /600000/);
    assert.equal(client.includes("localStorage.setItem(\"practix.note\""), false);
    assert.match(client, /Session notes are sealed/);
    assert.match(client, /Subjective/);
  } finally {
    await shutdown(app);
    rmSync(secretDir, { recursive: true, force: true });
  }
});

/**
 * @spec FR-5.4 — a weekly series is a package of sessions, prepaid only once
 * the existing settlement webhook arrives.
 */
test("a weekly series stays unpaid until the settlement webhook", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "series-clinic", "mental_health");
    const headers = auth(token);
    const { practitionerId } = await finishDental(app, token);
    const walk = await app.inject({
      method: "POST",
      url: "/api/walk-ins",
      headers,
      payload: { phone: "9811111192", name: "Weekly Patient", practitionerId },
    });
    assert.equal(walk.statusCode, 200, walk.body);
    const patientId = walk.json().patientId as string;
    const series = await app.inject({
      method: "POST",
      url: "/api/vault/series",
      headers,
      payload: { patientId, practitionerId, sessions: 3 },
    });
    assert.equal(series.statusCode, 200, series.body);
    const ids = series.json().appointmentIds as string[];
    assert.equal(ids.length, 3);
    const before = await withSuperuser(async (client) => {
      const row = await client.query<{ prepaid: boolean; clinic_id: string }>(
        `SELECT prepaid, clinic_id FROM appointments WHERE id = $1`,
        [ids[0]],
      );
      return row.rows[0];
    });
    assert.equal(before.prepaid, false);
    const body = {
      provider: "local",
      providerEventId: "series-1",
      appointmentId: ids[0],
      clinicId: before.clinic_id,
    };
    const paid = await webhook(app, body);
    assert.equal(paid.statusCode, 200);
    const again = await webhook(app, body);
    assert.equal(again.statusCode, 200);
    assert.equal((again.json() as { duplicate: boolean }).duplicate, true);
    const after = await withSuperuser(async (client) => {
      const row = await client.query<{ prepaid: boolean }>(
        `SELECT prepaid FROM appointments WHERE id = $1`,
        [ids[0]],
      );
      const rest = await client.query<{ prepaid: boolean }>(
        `SELECT prepaid FROM appointments WHERE id = ANY($1::uuid[])`,
        [[ids[1], ids[2]]],
      );
      return { first: row.rows[0].prepaid, others: rest.rows.map((item) => item.prepaid) };
    });
    assert.equal(after.first, true);
    assert.deepEqual(after.others, [false, false]);
  } finally {
    await shutdown(app);
  }
});

function hasCommand(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function dumpDatabase(): Promise<string> {
  if (hasCommand("pg_dump")) {
    return capture("pg_dump", ["--dbname", databaseUrl, "--no-owner", "--no-privileges"]);
  }
  return capture("docker", [
    "compose", "exec", "-T", "postgres", "pg_dump", "-U", "postgres", "-d", "practixos_test",
    "--no-owner", "--no-privileges",
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
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString("utf8")}`));
      else resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}
