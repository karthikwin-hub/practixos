import { withTenant } from "../../db/tenant.js";
import type { MessagingPort } from "../messaging/index.js";
import { toE164 } from "../../platform/phone.js";
import { fail } from "../scheduling/service.js";

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export async function materialiseRecalls(clinicId: string, messaging: MessagingPort): Promise<number> {
  return withTenant(clinicId, async (tx) => {
    const rules = await tx.query<{ id: string; offset_days: number; template_key: string }>(
      `SELECT id, offset_days, template_key FROM recall_rules
       WHERE clinic_id = $1 AND active AND trigger = 'last_visit'`,
      [clinicId],
    );
    let sent = 0;
    for (const rule of rules.rows) {
      const due = await tx.query<{ patient_id: string; phone_e164: string }>(
        `SELECT p.id AS patient_id, p.phone_e164
         FROM patients p
         JOIN appointments a ON a.patient_id = p.id AND a.state = 'done' AND a.attended_at IS NOT NULL
         WHERE p.clinic_id = $1
         GROUP BY p.id, p.phone_e164
         HAVING max(a.attended_at)::date + $2::int <= $3::date`,
        [clinicId, rule.offset_days, today()],
      );
      for (const patient of due.rows) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO recalls (clinic_id, patient_id, rule_id, due_on, state)
           VALUES ($1,$2,$3,$4,'pending')
           ON CONFLICT (clinic_id, patient_id, rule_id, due_on) DO NOTHING
           RETURNING id`,
          [clinicId, patient.patient_id, rule.id, today()],
        );
        if (!inserted.rows[0]) continue;
        const body = `Recall ${rule.template_key} for a visit due ${today()}`;
        const receipt = await messaging.dispatch({
          to: patient.phone_e164, lang: "en", template: rule.template_key, body, channel: "whatsapp",
        });
        await tx.query(
          `UPDATE recalls SET state = 'sent', attempts = attempts + 1 WHERE id = $1`,
          [inserted.rows[0].id],
        );
        await tx.query(
          `INSERT INTO message_outbox (clinic_id, phone_e164, channel, lang, template, body, status, receipt_id)
           VALUES ($1,$2,$3,'en',$4,$5,'delivered',$6)`,
          [clinicId, patient.phone_e164, receipt.channel, rule.template_key, body, receipt.receiptId],
        );
        sent += 1;
      }
    }
    const expiring = await tx.query<{ id: string; name: string; batch_no: string; expires_on: string }>(
      `SELECT b.id, i.name, b.batch_no, b.expires_on::text
       FROM inventory_batches b
       JOIN inventory_items i ON i.id = b.item_id
       WHERE b.clinic_id = $1 AND b.qty_remaining > 0 AND b.expires_on <= $2::date + 30`,
      [clinicId, today()],
    );
    for (const batch of expiring.rows) {
      const notice = await tx.query(
        `INSERT INTO expiry_notices (clinic_id, batch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING batch_id`,
        [clinicId, batch.id],
      );
      if ((notice.rowCount ?? 0) === 0) continue;
      const body = `Batch ${batch.batch_no} of ${batch.name} expires ${batch.expires_on}`;
      const receipt = await messaging.dispatch({
        to: "+910000000000", lang: "en", template: "expiry", body, channel: "whatsapp",
      });
      await tx.query(
        `INSERT INTO message_outbox (clinic_id, phone_e164, channel, lang, template, body, status, receipt_id)
         VALUES ($1,'+910000000000',$2,'en','expiry',$3,'delivered',$4)`,
        [clinicId, receipt.channel, body, receipt.receiptId],
      );
    }
    return sent;
  });
}

export async function attributePlanResumed(clinicId: string, appointmentId: string): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    const visit = await tx.query<{ patient_id: string; fee_paise: string }>(
      `SELECT patient_id, fee_paise FROM appointments WHERE id = $1`,
      [appointmentId],
    );
    if (!visit.rows[0]) return;
    const recall = await tx.query<{ id: string }>(
      `SELECT id FROM recalls
       WHERE patient_id = $1 AND state = 'sent' AND due_on >= $2::date - 30
       ORDER BY due_on DESC LIMIT 1`,
      [visit.rows[0].patient_id, today()],
    );
    if (!recall.rows[0]) return;
    try {
      await tx.query(
        `INSERT INTO recovered_revenue (clinic_id, appointment_id, event_type, amount_paise, evidence_ref)
         VALUES ($1,$2,'plan_resumed',$3,$4)`,
        [clinicId, appointmentId, visit.rows[0].fee_paise, recall.rows[0].id],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return;
      throw err;
    }
    await tx.query(`UPDATE recalls SET state = 'booked' WHERE id = $1`, [recall.rows[0].id]);
  });
}

export async function definePackage(
  clinicId: string,
  input: { name: string; sessions: number; pricePaise: number },
): Promise<{ id: string }> {
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO package_definitions (clinic_id, name, sessions, price_paise) VALUES ($1,$2,$3,$4) RETURNING id`,
      [clinicId, input.name, input.sessions, input.pricePaise],
    );
    return { id: row.rows[0].id };
  });
}

export async function purchasePackage(
  clinicId: string,
  input: { patientId: string; definitionId: string },
): Promise<{ id: string }> {
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO patient_packages (clinic_id, patient_id, definition_id) VALUES ($1,$2,$3) RETURNING id`,
      [clinicId, input.patientId, input.definitionId],
    );
    return { id: row.rows[0].id };
  });
}

export async function redeemPackage(clinicId: string, packageId: string, appointmentId: string): Promise<void> {
  try {
    await withTenant(clinicId, async (tx) => {
      await tx.query(
        `INSERT INTO package_redemptions (clinic_id, package_id, appointment_id) VALUES ($1,$2,$3)`,
        [clinicId, packageId, appointmentId],
      );
    });
  } catch (err) {
    if (String(err).includes("package overdrawn")) fail(409, "package overdrawn");
    throw err;
  }
}

export async function addItem(clinicId: string, name: string): Promise<{ id: string }> {
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO inventory_items (clinic_id, name) VALUES ($1,$2) RETURNING id`,
      [clinicId, name],
    );
    return { id: row.rows[0].id };
  });
}

export async function addBatch(
  clinicId: string,
  input: { itemId: string; batchNo: string; expiresOn: string; qty: number },
): Promise<{ id: string }> {
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO inventory_batches (clinic_id, item_id, batch_no, expires_on, qty_received, qty_remaining)
       VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
      [clinicId, input.itemId, input.batchNo, input.expiresOn, input.qty],
    );
    return { id: row.rows[0].id };
  });
}

export async function issueBatch(
  clinicId: string,
  input: { itemId: string; appointmentId: string; amountPaise: number },
): Promise<{ batchId: string; issueId: string }> {
  return withTenant(clinicId, async (tx) => {
    const batch = await tx.query<{ id: string }>(
      `SELECT id FROM inventory_batches
       WHERE item_id = $1 AND qty_remaining > 0 AND expires_on >= $2::date
       ORDER BY expires_on, id
       LIMIT 1
       FOR UPDATE`,
      [input.itemId, today()],
    );
    if (!batch.rows[0]) fail(409, "no usable batch");
    await tx.query(
      `UPDATE inventory_batches SET qty_remaining = qty_remaining - 1 WHERE id = $1`,
      [batch.rows[0].id],
    );
    const issue = await tx.query<{ id: string }>(
      `INSERT INTO inventory_issues (clinic_id, batch_id, appointment_id, qty, amount_paise)
       VALUES ($1,$2,$3,1,$4) RETURNING id`,
      [clinicId, batch.rows[0].id, input.appointmentId, input.amountPaise],
    );
    await tx.query(
      `INSERT INTO recovered_revenue (clinic_id, appointment_id, event_type, amount_paise, evidence_ref)
       VALUES ($1,$2,'consumable_billed',$3,$4)`,
      [clinicId, input.appointmentId, input.amountPaise, issue.rows[0].id],
    );
    return { batchId: batch.rows[0].id, issueId: issue.rows[0].id };
  });
}

export async function createDependant(
  clinicId: string,
  input: { guardianId: string; name: string; phone: string },
): Promise<{ id: string }> {
  const phone = toE164(input.phone);
  if (!phone) fail(400, "a dependant needs a mobile number");
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO patients (clinic_id, full_name, phone_e164, self_managing) VALUES ($1,$2,$3,false) RETURNING id`,
      [clinicId, input.name, phone],
    );
    return { id: row.rows[0].id };
  });
}

export async function addRelationship(
  clinicId: string,
  input: {
    guardianId: string; dependantId: string; relationship: string;
    mayBook?: boolean; mayConsent?: boolean; mayViewClinical?: boolean; validUntil?: string;
  },
): Promise<{ id: string }> {
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO patient_relationships (
         clinic_id, guardian_id, dependant_id, relationship, may_book, may_consent, may_view_clinical, valid_until
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        clinicId, input.guardianId, input.dependantId, input.relationship,
        input.mayBook ?? true, input.mayConsent ?? false, input.mayViewClinical ?? false, input.validUntil ?? null,
      ],
    );
    return { id: row.rows[0].id };
  });
}

async function liveRelationship(clinicId: string, guardianId: string, dependantId: string): Promise<{
  relationship: string; may_book: boolean; may_consent: boolean; may_view_clinical: boolean; valid_until: string | null;
}> {
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{
      relationship: string; may_book: boolean; may_consent: boolean; may_view_clinical: boolean; valid_until: string | null;
    }>(
      `SELECT relationship, may_book, may_consent, may_view_clinical, valid_until::text
       FROM patient_relationships WHERE guardian_id = $1 AND dependant_id = $2`,
      [guardianId, dependantId],
    );
    const found = row.rows[0];
    if (!found) fail(404, "relationship not found");
    if (found.valid_until && found.valid_until < today()) fail(403, "the relationship has expired");
    return found;
  });
}

export async function updateRelationship(
  clinicId: string,
  relationshipId: string,
  input: { mayConsent?: boolean; mayBook?: boolean; mayViewClinical?: boolean; validUntil?: string | null },
): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `UPDATE patient_relationships
       SET may_consent = coalesce($2, may_consent),
           may_book = coalesce($3, may_book),
           may_view_clinical = coalesce($4, may_view_clinical),
           valid_until = $5
       WHERE id = $1`,
      [
        relationshipId,
        input.mayConsent ?? null,
        input.mayBook ?? null,
        input.mayViewClinical ?? null,
        input.validUntil === undefined ? null : input.validUntil,
      ],
    );
  });
}

export async function recordConsent(clinicId: string, guardianId: string, dependantId: string): Promise<{ id: string }> {
  const relation = await liveRelationship(clinicId, guardianId, dependantId);
  if (!relation.may_consent) fail(403, "this guardian cannot consent");
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO proxy_consents (clinic_id, guardian_id, dependant_id, relationship, snapshot)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [clinicId, guardianId, dependantId, relation.relationship, JSON.stringify(relation)],
    );
    return { id: row.rows[0].id };
  });
}

export async function assertCanBook(clinicId: string, guardianId: string, dependantId: string): Promise<void> {
  const relation = await liveRelationship(clinicId, guardianId, dependantId);
  if (!relation.may_book) fail(403, "this guardian cannot book");
}
