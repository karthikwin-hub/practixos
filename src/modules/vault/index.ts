import type { BillingPort } from "../billing/index.js";
import type { MessagingPort } from "../messaging/index.js";
import { bookAppointment, fail } from "../scheduling/service.js";
import { definePackage, purchasePackage, redeemPackage } from "../vertical/index.js";
import { withTenant } from "../../db/tenant.js";
import { decryptNote, encryptNote, loadServerSecret, type VaultPayload } from "./crypto.js";

export const RELOCK_AFTER_MS = 600_000;
const LOCKOUT = 5;

export const DSM5 = ["F41.1", "F32.1", "F43.1", "F40.1", "F42.2"] as const;

export interface SessionNote {
  s: string;
  o: string;
  a: string;
  p: string;
  dsm: string;
  gad7: number;
  phq9: number;
}

export function shouldRelock(idleMs: number): boolean {
  return idleMs >= RELOCK_AFTER_MS;
}

function noteFrom(input: SessionNote): SessionNote {
  if (!DSM5.includes(input.dsm as (typeof DSM5)[number])) fail(400, "unknown DSM-5 code");
  if (!Number.isInteger(input.gad7) || input.gad7 < 0 || input.gad7 > 21) fail(400, "GAD-7 is 0 to 21");
  if (!Number.isInteger(input.phq9) || input.phq9 < 0 || input.phq9 > 27) fail(400, "PHQ-9 is 0 to 27");
  if (!input.s || !input.o || !input.a || !input.p) fail(400, "a session note needs all four SOAP fields");
  return {
    s: input.s, o: input.o, a: input.a, p: input.p,
    dsm: input.dsm, gad7: input.gad7, phq9: input.phq9,
  };
}

function pinOf(pin: string): void {
  if (!/^\d{4}$/.test(pin)) fail(400, "the vault PIN is four digits");
}

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

export async function vaultDesk(clinicId: string, patientId: string): Promise<{
  enabled: boolean;
  fullName: string | null;
  payments: { appointmentId: string; feePaise: number; prepaid: boolean }[];
}> {
  return withTenant(clinicId, async (tx) => {
    const module = await tx.query(
      `SELECT 1 FROM clinic_modules WHERE clinic_id = $1 AND module = 'vault'`,
      [clinicId],
    );
    if ((module.rowCount ?? 0) === 0) return { enabled: false, fullName: null, payments: [] };
    const patient = await tx.query<{ full_name: string }>(
      `SELECT full_name FROM patients WHERE id = $1`,
      [patientId],
    );
    const payments = await tx.query<{ id: string; fee_paise: number; prepaid: boolean }>(
      `SELECT id, fee_paise, prepaid FROM appointments WHERE patient_id = $1 ORDER BY lower(during)`,
      [patientId],
    );
    return {
      enabled: true,
      fullName: patient.rows[0]?.full_name ?? null,
      payments: payments.rows.map((row) => ({
        appointmentId: row.id, feePaise: Number(row.fee_paise), prepaid: row.prepaid,
      })),
    };
  });
}

export async function saveNote(
  clinicId: string,
  actor: { userId: string; role: string },
  patientId: string,
  pin: string,
  input: SessionNote,
): Promise<{ id: string }> {
  if (actor.role === "reception") fail(403, "the front desk cannot write the vault");
  pinOf(pin);
  const note = noteFrom(input);
  const payload = await encryptNote(JSON.stringify(note), pin, loadServerSecret());
  return withTenant(clinicId, async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO vault_notes (clinic_id, patient_id, salt, nonce, ciphertext)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [clinicId, patientId, payload.salt, payload.nonce, payload.ciphertext],
    );
    return { id: row.rows[0].id };
  });
}

export async function unlockNotes(
  clinicId: string,
  actor: { userId: string; role: string },
  patientId: string,
  pin: string,
): Promise<{ notes: SessionNote[] }> {
  if (actor.role === "reception") fail(403, "the front desk cannot open the vault");
  pinOf(pin);
  const secret = loadServerSecret();
  const outcome = await withTenant(clinicId, async (tx) => {
    const attempts = await tx.query<{ failures: number }>(
      `SELECT failures FROM vault_attempts WHERE user_id = $1 AND patient_id = $2`,
      [actor.userId, patientId],
    );
    if ((attempts.rows[0]?.failures ?? 0) >= LOCKOUT) return { locked: true as const };
    const rows = await tx.query<VaultPayload>(
      `SELECT salt, nonce, ciphertext FROM vault_notes WHERE patient_id = $1 ORDER BY created_at`,
      [patientId],
    );
    if (rows.rows.length === 0) return { missing: true as const };
    try {
      const notes: SessionNote[] = [];
      for (const row of rows.rows) {
        notes.push(JSON.parse(await decryptNote(row, pin, secret)) as SessionNote);
      }
      await tx.query(
        `INSERT INTO vault_attempts (clinic_id, user_id, patient_id, failures)
         VALUES ($1,$2,$3,0)
         ON CONFLICT (clinic_id, user_id, patient_id) DO UPDATE SET failures = 0`,
        [clinicId, actor.userId, patientId],
      );
      await audit(tx, clinicId, actor.userId, actor.role, "vault.open", patientId);
      return { notes };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode) throw err;
      await tx.query(
        `INSERT INTO vault_attempts (clinic_id, user_id, patient_id, failures)
         VALUES ($1,$2,$3,1)
         ON CONFLICT (clinic_id, user_id, patient_id)
         DO UPDATE SET failures = vault_attempts.failures + 1`,
        [clinicId, actor.userId, patientId],
      );
      await audit(tx, clinicId, actor.userId, actor.role, "vault.denied", patientId);
      return { denied: true as const };
    }
  });
  if ("locked" in outcome) fail(429, "the vault is locked after repeated failures");
  if ("missing" in outcome) fail(404, "no sealed notes");
  if ("denied" in outcome) fail(401, "incorrect PIN");
  return { notes: outcome.notes };
}

export async function openSeries(
  clinicId: string,
  input: { patientId: string; practitionerId: string; sessions: number },
  billing: BillingPort,
  messaging: MessagingPort,
): Promise<{ packageId: string; appointmentIds: string[] }> {
  if (!Number.isInteger(input.sessions) || input.sessions < 1) fail(400, "a series needs at least one session");
  const defined = await definePackage(clinicId, {
    name: "Weekly counselling",
    sessions: input.sessions,
    pricePaise: input.sessions * 50000,
  });
  const purchased = await purchasePackage(clinicId, {
    patientId: input.patientId,
    definitionId: defined.id,
  });
  const appointmentIds: string[] = [];
  for (let i = 0; i < input.sessions; i += 1) {
    const when = new Date(Date.now() + (7 + i * 7) * 86_400_000);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(when);
    const booked = await bookAppointment(clinicId, input.patientId, {
      practitionerId: input.practitionerId,
      start: `${day}T10:00:00+05:30`,
      end: `${day}T10:50:00+05:30`,
      mode: "video",
      lang: "en",
    }, billing, messaging) as { appointmentId: string };
    await redeemPackage(clinicId, purchased.id, booked.appointmentId);
    appointmentIds.push(booked.appointmentId);
  }
  return { packageId: purchased.id, appointmentIds };
}
