import { withTenant } from "../../db/tenant.js";
import type { MessagingPort } from "../messaging/index.js";
import { fail } from "../scheduling/service.js";

const FDI = [
  18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
];

export const quadrants = [
  { id: "UR", label: "Upper right", teeth: [18, 17, 16, 15, 14, 13, 12, 11] },
  { id: "UL", label: "Upper left", teeth: [21, 22, 23, 24, 25, 26, 27, 28] },
  { id: "LR", label: "Lower right", teeth: [48, 47, 46, 45, 44, 43, 42, 41] },
  { id: "LL", label: "Lower left", teeth: [31, 32, 33, 34, 35, 36, 37, 38] },
];

const states: Record<string, { label: string; colour: string; pattern: string | null }> = {
  healthy: { label: "Healthy", colour: "#4E8A5B", pattern: null },
  caries: { label: "Caries", colour: "#D2574A", pattern: "hatch" },
  rct: { label: "RCT", colour: "#E8952A", pattern: "cross" },
  crown: { label: "Crown", colour: "#3FB8AC", pattern: "dots" },
  missing: { label: "Missing", colour: "#7D948F", pattern: null },
};

const protocols: Record<string, { name: string; feePaise: number; minutes: number; consumables: string[]; needsLab: boolean }[]> = {
  caries: [{ name: "Composite restoration", feePaise: 180000, minutes: 30, consumables: ["Composite kit", "LA carpule"], needsLab: false }],
  rct: [
    { name: "Biomechanical prep & pulpectomy", feePaise: 250000, minutes: 45, consumables: ["Rotary endo file", "LA carpule", "Rubber dam", "Sterilisation pouch"], needsLab: false },
    { name: "Obturation & composite core", feePaise: 200000, minutes: 40, consumables: ["Gutta-percha", "Sealer"], needsLab: false },
    { name: "Zirconia crown fixation", feePaise: 450000, minutes: 35, consumables: ["Luting cement"], needsLab: true },
  ],
  crown: [
    { name: "Crown preparation & impression", feePaise: 300000, minutes: 40, consumables: ["Impression material", "Retraction cord"], needsLab: true },
    { name: "Crown cementation", feePaise: 450000, minutes: 25, consumables: ["Luting cement"], needsLab: false },
  ],
  missing: [{ name: "Implant assessment & CBCT", feePaise: 120000, minutes: 20, consumables: [], needsLab: false }],
};

export async function requireCharting(clinicId: string): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    const row = await tx.query(
      `SELECT 1 FROM clinic_modules WHERE clinic_id = $1 AND module = 'charting'`,
      [clinicId],
    );
    if ((row.rowCount ?? 0) === 0) fail(404, "charting is not provisioned");
  });
}

export function odontogramModel(): { teeth: number[]; quadrants: typeof quadrants; states: typeof states } {
  return { teeth: FDI, quadrants, states };
}

export async function chartTooth(
  clinicId: string,
  patientId: string,
  tooth: number,
  state: string,
): Promise<void> {
  await requireCharting(clinicId);
  const look = states[state];
  if (!look || !FDI.includes(tooth)) fail(400, "unknown tooth or state");
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `INSERT INTO tooth_charts (clinic_id, patient_id, tooth_fdi, state, label, colour, pattern)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (clinic_id, patient_id, tooth_fdi)
       DO UPDATE SET state = EXCLUDED.state, label = EXCLUDED.label, colour = EXCLUDED.colour, pattern = EXCLUDED.pattern`,
      [clinicId, patientId, tooth, state, look.label, look.colour, look.pattern],
    );
  });
}

export async function readChart(clinicId: string, patientId: string): Promise<unknown> {
  await requireCharting(clinicId);
  return withTenant(clinicId, async (tx) => {
    const teeth = await tx.query(
      `SELECT tooth_fdi, state, label, colour, pattern FROM tooth_charts WHERE patient_id = $1 ORDER BY tooth_fdi`,
      [patientId],
    );
    const steps = await tx.query(
      `SELECT tooth_fdi, step_no, name, fee_paise, minutes, consumables, needs_lab, status
       FROM treatment_steps WHERE patient_id = $1 ORDER BY tooth_fdi, step_no`,
      [patientId],
    );
    return { teeth: teeth.rows, steps: steps.rows, model: odontogramModel() };
  });
}

export async function buildPlan(clinicId: string, patientId: string, tooth: number): Promise<{ sittings: number }> {
  await requireCharting(clinicId);
  return withTenant(clinicId, async (tx) => {
    const chart = await tx.query<{ state: string }>(
      `SELECT state FROM tooth_charts WHERE patient_id = $1 AND tooth_fdi = $2`,
      [patientId, tooth],
    );
    const state = chart.rows[0]?.state ?? "healthy";
    const proto = protocols[state];
    if (!proto) fail(400, "no protocol for a healthy tooth");
    await tx.query(
      `DELETE FROM treatment_steps WHERE clinic_id = $1 AND patient_id = $2 AND tooth_fdi = $3`,
      [clinicId, patientId, tooth],
    );
    for (let i = 0; i < proto.length; i += 1) {
      const step = proto[i];
      await tx.query(
        `INSERT INTO treatment_steps (
           clinic_id, patient_id, tooth_fdi, step_no, name, fee_paise, minutes, consumables, needs_lab, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          clinicId, patientId, tooth, i + 1, step.name, step.feePaise, step.minutes,
          step.consumables, step.needsLab, i === 0 ? "chair" : "planned",
        ],
      );
    }
    return { sittings: proto.length };
  });
}

export async function createWorkOrder(
  clinicId: string,
  input: {
    patientId: string;
    appointmentId?: string;
    typeKey: string;
    lab?: string;
    dueOn?: string;
    fields: Record<string, string>;
  },
): Promise<{ id: string }> {
  return withTenant(clinicId, async (tx) => {
    const type = await tx.query<{ id: string }>(
      `SELECT id FROM work_order_types WHERE clinic_id = $1 AND type_key = $2`,
      [clinicId, input.typeKey],
    );
    if (!type.rows[0]) fail(404, "work order type is not provisioned");
    const row = await tx.query<{ id: string }>(
      `INSERT INTO work_orders (clinic_id, patient_id, appointment_id, type_id, lab_name, fields, due_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        clinicId, input.patientId, input.appointmentId ?? null, type.rows[0].id,
        input.lab ?? null, JSON.stringify(input.fields), input.dueOn ?? null,
      ],
    );
    return { id: row.rows[0].id };
  });
}

export async function dispatchWorkOrder(
  clinicId: string,
  orderId: string,
  messaging: MessagingPort,
): Promise<{ receiptId: string }> {
  return withTenant(clinicId, async (tx) => {
    const order = await tx.query<{
      id: string; appointment_id: string | null; fields: Record<string, string>;
      required_fields: string[]; lab_name: string | null; due_on: string | null; patient_id: string;
    }>(
      `SELECT o.id, o.appointment_id, o.fields, t.required_fields, o.lab_name, o.due_on::text, o.patient_id
       FROM work_orders o JOIN work_order_types t ON t.id = o.type_id WHERE o.id = $1`,
      [orderId],
    );
    const row = order.rows[0];
    if (!row) fail(404, "work order not found");
    if (!row.appointment_id) fail(400, "a work order needs a visit");
    const missing = row.required_fields.filter((field) => !String(row.fields[field] ?? "").trim());
    if (missing.length > 0) fail(400, `missing ${missing.join(", ")}`);
    const patient = await tx.query<{ phone_e164: string }>(
      `SELECT phone_e164 FROM patients WHERE id = $1`,
      [row.patient_id],
    );
    const body = `Lab order ${row.id}: ${JSON.stringify(row.fields)} due ${row.due_on ?? ""} lab ${row.lab_name ?? ""}`;
    const sent = await messaging.dispatch({
      to: patient.rows[0].phone_e164,
      lang: "en",
      template: "lab_order",
      body,
      channel: "whatsapp",
    });
    await tx.query(
      `UPDATE work_orders SET status = 'dispatched', receipt_id = $2 WHERE id = $1`,
      [orderId, sent.receiptId],
    );
    await tx.query(
      `INSERT INTO message_outbox (
         clinic_id, appointment_id, phone_e164, channel, lang, template, body, status, receipt_id
       ) VALUES ($1,$2,$3,$4,'en','lab_order',$5,'delivered',$6)`,
      [clinicId, row.appointment_id, patient.rows[0].phone_e164, sent.channel, body, sent.receiptId],
    );
    const cost = await tx.query<{ remake_cost_paise: string }>(
      `SELECT remake_cost_paise FROM clinics WHERE id = $1`,
      [clinicId],
    );
    await tx.query(
      `INSERT INTO recovered_revenue (clinic_id, appointment_id, event_type, amount_paise, evidence_ref)
       VALUES ($1,$2,'remake_avoided',$3,$4)`,
      [clinicId, row.appointment_id, cost.rows[0].remake_cost_paise, orderId],
    );
    return { receiptId: sent.receiptId };
  });
}
