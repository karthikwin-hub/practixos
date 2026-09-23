import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { endPool, withTenant } from "../../src/db/tenant.ts";
import { applyGateEnv, resetDatabase } from "./harness.ts";

applyGateEnv(8);

before(async () => {
  await resetDatabase();
});

after(async () => {
  await endPool();
});

/**
 * @spec 10.1 — N simultaneous bookings on one chair and an overlapping range
 * produce exactly one appointment.
 */
test("eight simultaneous bookings on one chair produce exactly one appointment", async () => {
  const clinicId = randomUUID();
  await withTenant(clinicId, (tx) =>
    tx.query(
      `INSERT INTO clinics (id, slug, legal_name, vertical) VALUES ($1, $2, $3, 'dental')`,
      [clinicId, `c-${clinicId.slice(0, 8)}`, "Chair Clinic"],
    ),
  );
  const practitionerId = randomUUID();
  const chairId = randomUUID();
  const patientId = randomUUID();
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `INSERT INTO practitioners (id, clinic_id, full_name) VALUES ($1, $2, 'Dr Rao')`,
      [practitionerId, clinicId],
    );
    await tx.query(
      `INSERT INTO chairs (id, clinic_id, label) VALUES ($1, $2, 'Chair 1')`,
      [chairId, clinicId],
    );
    await tx.query(
      `INSERT INTO patients (id, clinic_id, full_name, phone_e164) VALUES ($1, $2, 'Walker', '+919820044444')`,
      [patientId, clinicId],
    );
  });

  const attempts = Array.from({ length: 8 }, () =>
    withTenant(clinicId, (tx) =>
      tx.query(
        `INSERT INTO appointments (
           clinic_id, patient_id, practitioner_id, chair_id, during, mode, fee_paise, fee_reason
         ) VALUES (
           $1, $2, $3, $4,
           tstzrange('2026-09-23 10:00:00+05:30', '2026-09-23 10:30:00+05:30', '[)'),
           'clinic', 50000, 'new consult'
         )`,
        [clinicId, patientId, practitionerId, chairId],
      ),
    ),
  );

  const results = await Promise.allSettled(attempts);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  assert.equal(fulfilled.length, 1);

  const count = await withTenant(clinicId, (tx) =>
    tx.query("SELECT count(*)::int AS n FROM appointments"),
  );
  assert.equal(count.rows[0].n, 1);
});
