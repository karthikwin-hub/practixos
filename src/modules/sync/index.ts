import { createWalkIn, moveStage } from "../scheduling/service.js";
import { recordVitals } from "../clinical/index.js";
import { withTenant } from "../../db/tenant.js";

export interface SyncOp {
  id: string;
  kind: string;
  updatedAt: string;
  body: Record<string, unknown>;
}

/** Operational rows are last-write-wins. Clinical notes are never merged. */
export async function applySync(
  clinicId: string,
  ops: SyncOp[],
): Promise<{ applied: string[]; conflicts: { id: string; reason: string }[] }> {
  const applied: string[] = [];
  const conflicts: { id: string; reason: string }[] = [];
  for (const op of ops) {
    if (op.kind === "clinical_note") {
      conflicts.push({ id: op.id, reason: "clinical notes are not auto-merged" });
      continue;
    }
    const fresh = await withTenant(clinicId, async (tx) => {
      const prior = await tx.query<{ updated_at: Date }>(
        `SELECT updated_at FROM sync_applied WHERE id = $1`,
        [op.id],
      );
      if (prior.rows[0] && new Date(prior.rows[0].updated_at).getTime() >= Date.parse(op.updatedAt)) {
        return false;
      }
      await tx.query(
        `INSERT INTO sync_applied (id, clinic_id, kind, updated_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at, kind = EXCLUDED.kind`,
        [op.id, clinicId, op.kind, op.updatedAt],
      );
      return true;
    });
    if (!fresh) {
      applied.push(op.id);
      continue;
    }
    if (op.kind === "walk_in") {
      await createWalkIn(clinicId, {
        phone: String(op.body.phone),
        name: String(op.body.name),
        practitionerId: String(op.body.practitionerId),
        patientId: op.body.patientId ? String(op.body.patientId) : undefined,
        appointmentId: op.body.appointmentId ? String(op.body.appointmentId) : undefined,
      });
    } else if (op.kind === "vitals") {
      await recordVitals(clinicId, {
        patientId: String(op.body.patientId),
        appointmentId: op.body.appointmentId ? String(op.body.appointmentId) : undefined,
        bpSystolic: numberOr(op.body.bpSystolic),
        bpDiastolic: numberOr(op.body.bpDiastolic),
        pulse: numberOr(op.body.pulse),
        sugar: numberOr(op.body.sugar),
        weightG: numberOr(op.body.weightG),
        updatedAt: op.updatedAt,
      });
    } else if (op.kind === "queue_move") {
      await moveStage(clinicId, String(op.body.appointmentId), String(op.body.stageId));
    }
    applied.push(op.id);
  }
  return { applied, conflicts };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
