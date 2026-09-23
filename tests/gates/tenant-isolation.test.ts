import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { endPool, getPool, withTenant } from "../../src/db/tenant.ts";
import { applyGateEnv, appDatabaseUrl, resetDatabase } from "./harness.ts";

applyGateEnv(1);

before(async () => {
  await resetDatabase();
});

after(async () => {
  await endPool();
});

/**
 * @spec FR-1.1.2, 4.4.1, 10.1 — two tenants interleaved on one physical
 * connection never see each other's rows, and a forgotten context reads zero
 * rows rather than the previous tenant.
 */
test("interleaved tenants on a pool of size 1 never see each other's rows", async () => {
  assert.equal(getPool().options.max, 1);

  const clinicA = randomUUID();
  const clinicB = randomUUID();
  await withTenant(clinicA, (tx) =>
    tx.query(
      `INSERT INTO clinics (id, slug, legal_name, vertical, display_name) VALUES ($1, $2, $3, 'dental', $3)`,
      [clinicA, `a-${clinicA.slice(0, 8)}`, "Clinic A"],
    ),
  );
  await withTenant(clinicB, (tx) =>
    tx.query(
      `INSERT INTO clinics (id, slug, legal_name, vertical, display_name) VALUES ($1, $2, $3, 'dental', $3)`,
      [clinicB, `b-${clinicB.slice(0, 8)}`, "Clinic B"],
    ),
  );
  await withTenant(clinicA, (tx) =>
    tx.query(
      `INSERT INTO patients (clinic_id, full_name, phone_e164) VALUES ($1, $2, $3)`,
      [clinicA, "Patient A", "+919820011111"],
    ),
  );
  await withTenant(clinicB, (tx) =>
    tx.query(
      `INSERT INTO patients (clinic_id, full_name, phone_e164) VALUES ($1, $2, $3)`,
      [clinicB, "Patient B", "+919820022222"],
    ),
  );

  const seenByA = await withTenant(clinicA, (tx) => tx.query("SELECT full_name FROM patients"));
  const seenByB = await withTenant(clinicB, (tx) => tx.query("SELECT full_name FROM patients"));
  assert.deepEqual(seenByA.rows.map((row) => row.full_name), ["Patient A"]);
  assert.deepEqual(seenByB.rows.map((row) => row.full_name), ["Patient B"]);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const forgotten = await client.query("SELECT full_name FROM patients");
    assert.equal(forgotten.rowCount, 0);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  const again = await withTenant(clinicB, (tx) => tx.query("SELECT full_name FROM patients"));
  assert.deepEqual(again.rows.map((row) => row.full_name), ["Patient B"]);
});

/** @spec 4.4.1 — reception can read the masked number and cannot read phone_e164. */
test("reception cannot select the real phone number", async () => {
  const clinicId = randomUUID();
  await withTenant(clinicId, (tx) =>
    tx.query(
      `INSERT INTO clinics (id, slug, legal_name, vertical, display_name) VALUES ($1, $2, $3, 'dental', $3)`,
      [clinicId, `r-${clinicId.slice(0, 8)}`, "Reception Clinic"],
    ),
  );
  await withTenant(clinicId, (tx) =>
    tx.query(
      `INSERT INTO patients (clinic_id, full_name, phone_e164) VALUES ($1, $2, $3)`,
      [clinicId, "Masked Patient", "+919820033333"],
    ),
  );

  const reception = new pg.Client({
    connectionString: appDatabaseUrl.replace("app_rw:app_rw_local", "app_reception:app_reception_local"),
  });
  await reception.connect();
  try {
    await reception.query("BEGIN");
    await reception.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const masked = await reception.query("SELECT full_name, phone_masked FROM patients");
    assert.equal(masked.rows[0].full_name, "Masked Patient");
    assert.equal(masked.rows[0].phone_masked.includes("•••"), true);
    await assert.rejects(
      reception.query("SELECT phone_e164 FROM patients"),
      (err: unknown) => (err as { code?: string }).code === "42501",
    );
    await reception.query("ROLLBACK");
  } finally {
    await reception.end();
  }
});
