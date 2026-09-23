import { withTenant } from "../../db/tenant.js";
import { fail } from "../scheduling/service.js";

export async function recordVitals(
  clinicId: string,
  input: {
    patientId: string;
    appointmentId?: string;
    bpSystolic?: number;
    bpDiastolic?: number;
    pulse?: number;
    sugar?: number;
    weightG?: number;
    updatedAt?: string;
  },
): Promise<{ id: string }> {
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO vitals (
         clinic_id, patient_id, appointment_id, bp_systolic, bp_diastolic, pulse, sugar, weight_g, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now()))
       RETURNING id`,
      [
        clinicId, input.patientId, input.appointmentId ?? null, input.bpSystolic ?? null,
        input.bpDiastolic ?? null, input.pulse ?? null, input.sugar ?? null, input.weightG ?? null,
        input.updatedAt ?? null,
      ],
    );
    return { id: row.rows[0].id };
  });
}

export async function setAlerts(clinicId: string, patientId: string, alerts: string[]): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    const updated = await tx.query(
      `UPDATE patients SET alerts = $2 WHERE id = $1 RETURNING id`,
      [patientId, alerts],
    );
    if (updated.rowCount === 0) fail(404, "patient not found");
  });
}
