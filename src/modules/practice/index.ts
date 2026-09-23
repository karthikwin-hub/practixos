import {
  createIdentitySession,
  lookupIdentity,
  membershipsFor,
  resolveIdentitySession,
  withTenant,
} from "../../db/tenant.js";
import type { CalendarPort } from "../calendar/index.js";
import type { MessagingPort } from "../messaging/index.js";
import { hashSecret, newToken, secretMatches } from "../../platform/auth.js";
import { fail } from "../scheduling/service.js";

const maskedTitle = "Doctor Unavailable (External Sync)";

async function audit(
  tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  clinicId: string,
  actorId: string,
  actorRole: string,
  action: string,
  subject: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (clinic_id, actor_id, actor_role, action, subject, detail)
     VALUES ($1,$2,$3,$4,$5,'{}')`,
    [clinicId, actorId, actorRole, action, subject],
  );
}

export async function createMembership(
  clinicId: string,
  actorRole: string,
  input: { email: string; password: string; fullName: string; practitionerId: string; splitBps?: number },
): Promise<{ userId: string }> {
  if (actorRole !== "owner" && actorRole !== "admin") fail(403, "only an owner can add a membership");
  const password = await hashSecret(input.password);
  return withTenant(clinicId, async (tx) => {
    const identity = await tx.query<{ upsert_identity: string }>(
      `SELECT upsert_identity($1,$2,$3,$4)`,
      [input.email, input.fullName, password.hash, password.salt],
    );
    const identityId = identity.rows[0].upsert_identity;
    const existing = await tx.query(
      `SELECT id FROM staff_users WHERE clinic_id = $1 AND email = $2`,
      [clinicId, input.email],
    );
    if ((existing.rowCount ?? 0) > 0) fail(409, "that person already belongs to this clinic");
    const user = await tx.query<{ id: string }>(
      `INSERT INTO staff_users (
         clinic_id, email, full_name, role, password_hash, password_salt, identity_id, practitioner_id, split_bps
       ) VALUES ($1,$2,$3,'consultant',$4,$5,$6,$7,$8) RETURNING id`,
      [
        clinicId, input.email, input.fullName, password.hash, password.salt, identityId,
        input.practitionerId, input.splitBps ?? 6000,
      ],
    );
    return { userId: user.rows[0].id };
  });
}

export async function login(email: string, password: string): Promise<{
  token: string;
  memberships: { clinicId: string; slug: string; displayName: string; role: string }[];
}> {
  const identity = await lookupIdentity(email);
  if (!identity || !(await secretMatches(password, identity.passwordHash, identity.passwordSalt))) {
    fail(401, "unknown email or password");
  }
  const token = newToken();
  await createIdentitySession(token, identity.id);
  const memberships = await membershipsFor(identity.id);
  return {
    token,
    memberships: memberships.map((row) => ({
      clinicId: row.clinicId,
      slug: row.slug,
      displayName: row.displayName,
      role: row.role,
    })),
  };
}

export async function switchClinic(identityToken: string, clinicId: string): Promise<{ token: string }> {
  const identityId = await resolveIdentitySession(identityToken);
  if (!identityId) fail(401, "staff session required");
  const memberships = await membershipsFor(identityId);
  const membership = memberships.find((row) => row.clinicId === clinicId);
  if (!membership) fail(404, "no membership in that clinic");
  const token = newToken();
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `INSERT INTO staff_sessions (token, clinic_id, user_id, expires_at)
       VALUES ($1,$2,$3, now() + interval '7 days')`,
      [token, clinicId, membership.userId],
    );
  });
  return { token };
}

export async function itinerary(identityToken: string): Promise<{
  clinic: string; start: string; end: string;
}[]> {
  const identityId = await resolveIdentitySession(identityToken);
  if (!identityId) fail(401, "staff session required");
  const memberships = await membershipsFor(identityId);
  const rows: { clinic: string; start: string; end: string }[] = [];
  for (const membership of memberships) {
    if (!membership.practitionerId) continue;
    const part = await withTenant(membership.clinicId, async (tx) => {
      return tx.query<{ display_name: string; start: Date; end: Date }>(
        `SELECT c.display_name, lower(a.during) AS start, upper(a.during) AS end
         FROM appointments a
         JOIN clinics c ON c.id = a.clinic_id
         WHERE a.practitioner_id = $1 AND NOT a.external_hold
           AND a.state NOT IN ('cancelled','no_show')`,
        [membership.practitionerId],
      );
    });
    for (const row of part.rows) {
      rows.push({
        clinic: row.display_name,
        start: new Date(row.start).toISOString(),
        end: new Date(row.end).toISOString(),
      });
    }
  }
  return rows;
}

export async function recordFeeLine(
  clinicId: string,
  input: { appointmentId: string; practitionerId: string; grossPaise: number; labPaise: number; consumablePaise: number },
): Promise<{ id: string; netPaise: number }> {
  return withTenant(clinicId, async (tx) => {
    const split = await tx.query<{ split_bps: number }>(
      `SELECT split_bps FROM staff_users
       WHERE clinic_id = $1 AND practitioner_id = $2 AND role = 'consultant'`,
      [clinicId, input.practitionerId],
    );
    const bps = split.rows[0]?.split_bps ?? 6000;
    const net = Math.round((input.grossPaise - input.labPaise - input.consumablePaise) * bps / 10000);
    const row = await tx.query<{ id: string }>(
      `INSERT INTO fee_lines (
         clinic_id, practitioner_id, appointment_id, gross_paise, lab_paise, consumable_paise, split_bps, net_paise
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        clinicId, input.practitionerId, input.appointmentId, input.grossPaise,
        input.labPaise, input.consumablePaise, bps, net,
      ],
    );
    return { id: row.rows[0].id, netPaise: net };
  });
}

export async function requestSettlement(
  clinicId: string,
  actor: { userId: string; role: string },
  lineIds: string[],
): Promise<{ id: string }> {
  return withTenant(clinicId, async (tx) => {
    const lines = await tx.query<{ practitioner_id: string }>(
      `SELECT practitioner_id FROM fee_lines WHERE id = ANY($1::uuid[]) AND status = 'open'`,
      [lineIds],
    );
    if ((lines.rowCount ?? 0) !== lineIds.length) fail(400, "settlement lines must be open");
    const practitionerId = lines.rows[0].practitioner_id;
    const settlement = await tx.query<{ id: string }>(
      `INSERT INTO settlements (clinic_id, practitioner_id, status) VALUES ($1,$2,'requested') RETURNING id`,
      [clinicId, practitionerId],
    );
    await tx.query(
      `UPDATE fee_lines SET status = 'requested', settlement_id = $2 WHERE id = ANY($1::uuid[])`,
      [lineIds, settlement.rows[0].id],
    );
    await audit(tx, clinicId, actor.userId, actor.role, "settlement.requested", settlement.rows[0].id);
    return { id: settlement.rows[0].id };
  });
}

export async function respondSettlement(
  clinicId: string,
  actor: { userId: string; role: string },
  settlementId: string,
  input: { lineId: string; action: "approve" | "dispute"; reason?: string },
): Promise<void> {
  if (actor.role !== "owner" && actor.role !== "admin") fail(403, "only an owner can respond to a settlement");
  await withTenant(clinicId, async (tx) => {
    const next = input.action === "approve" ? "approved" : "disputed";
    const updated = await tx.query(
      `UPDATE fee_lines SET status = $3
       WHERE id = $1 AND settlement_id = $2 AND status IN ('requested','approved','disputed')`,
      [input.lineId, settlementId, next],
    );
    if ((updated.rowCount ?? 0) === 0) fail(404, "settlement line not found");
    const pending = await tx.query(
      `SELECT status FROM fee_lines WHERE settlement_id = $1`,
      [settlementId],
    );
    const statuses = pending.rows.map((row: { status: string }) => row.status);
    const settlementStatus = statuses.includes("disputed")
      ? "disputed"
      : statuses.every((status) => status === "approved" || status === "paid")
        ? "approved"
        : "requested";
    await tx.query(`UPDATE settlements SET status = $2 WHERE id = $1`, [settlementId, settlementStatus]);
    await audit(
      tx,
      clinicId,
      actor.userId,
      actor.role,
      input.action === "approve" ? "settlement.approved" : "settlement.disputed",
      input.lineId,
    );
  });
}

export async function markSettlementPaid(
  clinicId: string,
  actor: { userId: string; role: string },
  settlementId: string,
  lineIds: string[],
): Promise<void> {
  if (actor.role !== "owner" && actor.role !== "admin") fail(403, "only an owner can record payment");
  await withTenant(clinicId, async (tx) => {
    const updated = await tx.query(
      `UPDATE fee_lines SET status = 'paid'
       WHERE settlement_id = $1 AND id = ANY($2::uuid[]) AND status = 'approved'`,
      [settlementId, lineIds],
    );
    if ((updated.rowCount ?? 0) !== lineIds.length) fail(400, "only an approved line can be recorded as paid");
    await tx.query(
      `UPDATE settlements SET status = CASE
         WHEN EXISTS (SELECT 1 FROM fee_lines WHERE settlement_id = $1 AND status = 'disputed') THEN 'disputed'
         ELSE 'paid'
       END
       WHERE id = $1 AND NOT EXISTS (
         SELECT 1 FROM fee_lines WHERE settlement_id = $1 AND status NOT IN ('paid','disputed')
       )`,
      [settlementId],
    );
    await audit(tx, clinicId, actor.userId, actor.role, "settlement.paid", settlementId);
  });
}

export async function feeLedger(clinicId: string, practitionerId: string): Promise<unknown[]> {
  return withTenant(clinicId, async (tx) => {
    const rows = await tx.query(
      `SELECT id, gross_paise, lab_paise, consumable_paise, split_bps, net_paise, status, settlement_id
       FROM fee_lines WHERE practitioner_id = $1 ORDER BY id`,
      [practitionerId],
    );
    return rows.rows;
  });
}

export async function ingestCalendar(
  input: {
    provider: string;
    providerEventId: string;
    clinicId: string;
    practitionerId: string;
    start: string;
    end: string;
  },
  port: CalendarPort,
  raw: Buffer,
  signature: string,
): Promise<{ duplicate: boolean }> {
  if (!port.verify(raw, signature)) fail(401, "invalid calendar signature");
  return withTenant(input.clinicId, async (tx) => {
    const seen = await tx.query(
      `SELECT 1 FROM calendar_events WHERE provider = $1 AND provider_event_id = $2`,
      [input.provider, input.providerEventId],
    );
    if ((seen.rowCount ?? 0) > 0) return { duplicate: true };
    let patient = await tx.query<{ id: string }>(
      `SELECT id FROM patients WHERE clinic_id = $1 AND full_name = $2`,
      [input.clinicId, maskedTitle],
    );
    if (!patient.rows[0]) {
      patient = await tx.query<{ id: string }>(
        `INSERT INTO patients (clinic_id, full_name, phone_e164) VALUES ($1,$2,'+919000000000') RETURNING id`,
        [input.clinicId, maskedTitle],
      );
    }
    const appointment = await tx.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, patient_id, practitioner_id, during, mode, state, fee_paise, fee_reason, external_hold
       ) VALUES (
         $1,$2,$3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), 'clinic', 'expected', 0, $6, true
       ) RETURNING id`,
      [input.clinicId, patient.rows[0].id, input.practitionerId, input.start, input.end, maskedTitle],
    );
    await tx.query(
      `INSERT INTO calendar_events (provider, provider_event_id, clinic_id, appointment_id)
       VALUES ($1,$2,$3,$4)`,
      [input.provider, input.providerEventId, input.clinicId, appointment.rows[0].id],
    );
    return { duplicate: false };
  });
}

export async function pushCalendar(
  clinicId: string,
  appointmentId: string,
  port: CalendarPort,
): Promise<{ id: string }> {
  const event = await withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ start: Date; end: Date }>(
      `SELECT lower(during) AS start, upper(during) AS end FROM appointments WHERE id = $1`,
      [appointmentId],
    );
    if (!row.rows[0]) fail(404, "appointment not found");
    return {
      appointmentId,
      start: new Date(row.rows[0].start).toISOString(),
      end: new Date(row.rows[0].end).toISOString(),
      title: "Clinic appointment",
    };
  });
  const pushed = await port.push(event);
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `INSERT INTO calendar_outbound (clinic_id, appointment_id, provider, body)
       VALUES ($1,$2,'google',$3)`,
      [clinicId, appointmentId, JSON.stringify(event)],
    );
  });
  return pushed;
}

export async function printDocument(
  clinicId: string,
  patientId: string,
  kind: "prescription" | "receipt",
  messaging: MessagingPort,
): Promise<{ body: string; displayName: string; registrationNo: string | null; address: string | null }> {
  return withTenant(clinicId, async (tx) => {
    const clinic = await tx.query<{ display_name: string; registration_no: string | null; address: string | null }>(
      `SELECT display_name, registration_no, address FROM clinics WHERE id = $1`,
      [clinicId],
    );
    const patient = await tx.query<{ full_name: string; phone_e164: string }>(
      `SELECT full_name, phone_e164 FROM patients WHERE id = $1`,
      [patientId],
    );
    if (!patient.rows[0]) fail(404, "patient not found");
    const steps = await tx.query<{ name: string; fee_paise: string }>(
      `SELECT name, fee_paise FROM treatment_steps WHERE patient_id = $1 ORDER BY tooth_fdi, step_no`,
      [patientId],
    );
    const lines = steps.rows.map((step) => `${step.name} ₹${Number(step.fee_paise) / 100}`).join("; ");
    const profile = clinic.rows[0];
    const body = kind === "prescription"
      ? `${profile.display_name}: prescription for ${patient.rows[0].full_name}. ${lines}`
      : `${profile.display_name}: receipt for ${patient.rows[0].full_name}. ${lines}`;
    const sent = await messaging.dispatch({
      to: patient.rows[0].phone_e164,
      lang: "en",
      template: kind,
      body,
      channel: "whatsapp",
    });
    await tx.query(
      `INSERT INTO message_outbox (clinic_id, phone_e164, channel, lang, template, body, status, receipt_id)
       VALUES ($1,$2,$3,'en',$4,$5,'delivered',$6)`,
      [clinicId, patient.rows[0].phone_e164, sent.channel, kind, body, sent.receiptId],
    );
    return {
      body,
      displayName: profile.display_name,
      registrationNo: profile.registration_no,
      address: profile.address,
    };
  });
}
