import assert from "node:assert/strict";
import pg from "pg";
import { test } from "node:test";
import { applyGateEnv, appDatabaseUrl, resetDatabase, withSuperuser } from "./harness.ts";

applyGateEnv(1);

/**
 * @spec §4.4.3 — app_rw may insert and read the audit trail, and is refused
 * UPDATE and DELETE. The refusal is a grant, not an unused code path.
 */
test("app_rw cannot update or delete audit_log", async () => {
  await resetDatabase();
  const clinicId = "00000000-0000-4000-8000-000000000443";

  const writer = new pg.Client({ connectionString: appDatabaseUrl });
  await writer.connect();
  let auditId = "";
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const inserted = await writer.query(
      `INSERT INTO audit_log (clinic_id, actor_role, action, subject)
       VALUES ($1, 'owner', 'test.wrote', 'grant') RETURNING id`,
      [clinicId],
    );
    auditId = String(inserted.rows[0].id);
    await writer.query("COMMIT");
  } finally {
    await writer.end();
  }

  const grants = await withSuperuser(async (client) => {
    const rows = await client.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'app_rw' AND table_name = 'audit_log'`,
    );
    return rows.rows.map((row) => row.privilege_type as string).sort();
  });
  assert.deepEqual(grants, ["INSERT", "SELECT"]);

  const updater = new pg.Client({ connectionString: appDatabaseUrl });
  await updater.connect();
  try {
    await assert.rejects(
      updater.query("UPDATE audit_log SET action = 'rewritten' WHERE id = $1", [auditId]),
      (err: unknown) => (err as { code?: string }).code === "42501",
    );
    await assert.rejects(
      updater.query("DELETE FROM audit_log WHERE id = $1", [auditId]),
      (err: unknown) => (err as { code?: string }).code === "42501",
    );
  } finally {
    await updater.end();
  }
});

/**
 * @spec §4.4.5 — the migrated catalog matches the core schema extract:
 * FORCE RLS on every tenant table, btree_gist, and the append-only audit trigger.
 */
test("the migrated catalog matches the core schema extract", async () => {
  await resetDatabase();
  await withSuperuser(async (client) => {
    const gist = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'");
    assert.equal(gist.rowCount, 1);

    const trigger = await client.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_append_only' AND NOT tgisinternal`,
    );
    assert.equal(trigger.rowCount, 1);

    const tenant = await client.query(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (
          EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'clinic_id' AND NOT a.attisdropped
          )
          OR c.relname = 'clinics'
        )
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    `);
    assert.deepEqual(tenant.rows, [], "tenant tables without FORCE RLS: " + JSON.stringify(tenant.rows));

    const clinics = await client.query(`
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'clinics'
        AND column_name IN ('slug', 'legal_name', 'vertical', 'followup_days', 'timezone')
    `);
    assert.equal(clinics.rowCount, 5);
    const followup = clinics.rows.find((row) => row.column_name === "followup_days");
    assert.equal(followup?.column_default, "7");

    const masked = await client.query(`
      SELECT is_generated, generation_expression
      FROM information_schema.columns
      WHERE table_name = 'patients' AND column_name = 'phone_masked'
    `);
    assert.equal(masked.rows[0]?.is_generated, "ALWAYS");

    const phone = await client.query(`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'patients_phone_self'
    `);
    assert.match(String(phone.rows[0]?.indexdef), /self_managing/);

    const during = await client.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'appointments' AND column_name = 'during'
    `);
    assert.equal(during.rows[0]?.data_type, "tstzrange");
  });
});
