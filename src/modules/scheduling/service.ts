import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import {
  eraseClinic,
  provisionClinic,
  queueNotify,
  withTenant,
} from "../../db/tenant.js";
import { hashSecret, newToken, secretMatches } from "../../platform/auth.js";
import { t } from "../../platform/catalog.js";
import { toE164 } from "../../platform/phone.js";
import { seedFor } from "../../platform/seeds.js";
import type { BillingPort } from "../billing/index.js";
import type { MessagingPort } from "../messaging/index.js";

type Tx = pg.PoolClient;

export function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function portalsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../web/portals");
}

export function writePortalPage(slug: string, displayName: string, langs: string[]): void {
  const dir = portalsDir();
  mkdirSync(dir, { recursive: true });
  const links = langs.map((code) => `<a href="?lang=${code}">${escapeHtml(code)}</a>`).join(" ");
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(displayName)}</title></head><body><h1>${escapeHtml(displayName)}</h1><nav>${links}</nav></body></html>`;
  writeFileSync(path.join(dir, `${slug}.html`), html);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch
  ));
}

function kolkataDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function daysBetween(earlier: string, later: string): number {
  const ms = Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

async function audit(
  tx: Tx,
  clinicId: string,
  actorId: string | null,
  actorRole: string,
  action: string,
  subject: string,
  detail: unknown,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (clinic_id, actor_id, actor_role, action, subject, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [clinicId, actorId, actorRole, action, subject, JSON.stringify(detail ?? {})],
  );
}

export async function openClinic(input: {
  legalName: string;
  slug: string;
  vertical: string;
  email: string;
  password: string;
  ownerName: string;
}): Promise<{ token: string; clinicId: string }> {
  const seed = seedFor(input.vertical);
  const clinicId = await provisionClinic(input.slug, input.legalName, input.vertical);
  const password = await hashSecret(input.password);
  const token = newToken();
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `UPDATE clinics SET prepay_required = $2, display_name = $3 WHERE id = $1`,
      [clinicId, seed.prepayRequired, input.legalName],
    );
    for (let i = 0; i < seed.stages.length; i += 1) {
      const stage = seed.stages[i];
      await tx.query(
        `INSERT INTO queue_stages (clinic_id, position, label_key, role, dwell_alert_mins)
         VALUES ($1,$2,$3,$4,$5)`,
        [clinicId, i + 1, stage.labelKey, stage.role, stage.dwell],
      );
    }
    for (const moduleName of seed.modules) {
      await tx.query(
        `INSERT INTO clinic_modules (clinic_id, module) VALUES ($1,$2)`,
        [clinicId, moduleName],
      );
    }
    for (const orderType of seed.workOrders) {
      await tx.query(
        `INSERT INTO work_order_types (clinic_id, type_key, required_fields) VALUES ($1,$2,$3)`,
        [clinicId, orderType.typeKey, orderType.required],
      );
    }
    for (const rule of seed.recalls) {
      await tx.query(
        `INSERT INTO recall_rules (clinic_id, trigger, offset_days, template_key)
         VALUES ($1,$2,$3,$4)`,
        [clinicId, rule.trigger, rule.offsetDays, rule.templateKey],
      );
    }
    const identity = await tx.query<{ upsert_identity: string }>(
      `SELECT upsert_identity($1,$2,$3,$4)`,
      [input.email, input.ownerName, password.hash, password.salt],
    );
    const user = await tx.query<{ id: string }>(
      `INSERT INTO staff_users (clinic_id, email, full_name, role, password_hash, password_salt, identity_id)
       VALUES ($1,$2,$3,'owner',$4,$5,$6) RETURNING id`,
      [clinicId, input.email, input.ownerName, password.hash, password.salt, identity.rows[0].upsert_identity],
    );
    await tx.query(
      `INSERT INTO staff_sessions (token, clinic_id, user_id, expires_at)
       VALUES ($1,$2,$3, now() + interval '7 days')`,
      [token, clinicId, user.rows[0].id],
    );
  });
  writePortalPage(input.slug, input.legalName, ["en"]);
  return { token, clinicId };
}

export async function wizardState(clinicId: string): Promise<Record<string, unknown>> {
  return withTenant(clinicId, async (tx) => {
    const clinic = await tx.query(
      `SELECT slug, legal_name, display_name, vertical, wizard_step, wizard_draft,
              followup_days, standard_fee_paise, languages, prepay_required, address, registration_no
       FROM clinics WHERE id = $1`,
      [clinicId],
    );
    const practitioners = await tx.query(
      `SELECT id, full_name FROM practitioners WHERE clinic_id = $1 ORDER BY full_name`,
      [clinicId],
    );
    const chairs = await tx.query(
      `SELECT id, label FROM chairs WHERE clinic_id = $1 ORDER BY label`,
      [clinicId],
    );
    const hours = await tx.query(
      `SELECT weekday, opens::text, closes::text FROM working_hours WHERE clinic_id = $1 ORDER BY weekday`,
      [clinicId],
    );
    return {
      clinic: clinic.rows[0],
      practitioners: practitioners.rows,
      chairs: chairs.rows,
      hours: hours.rows,
    };
  });
}

export async function saveWizard(
  clinicId: string,
  step: string,
  body: Record<string, unknown>,
  skip: boolean,
): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    if (!skip && step === "practitioners") {
      const people = body.practitioners as { fullName: string }[];
      await tx.query(`DELETE FROM practitioners WHERE clinic_id = $1`, [clinicId]);
      for (const person of people) {
        await tx.query(
          `INSERT INTO practitioners (clinic_id, full_name) VALUES ($1,$2)`,
          [clinicId, person.fullName],
        );
      }
    }
    if (!skip && step === "chairs") {
      const chairs = body.chairs as { label: string }[];
      await tx.query(`DELETE FROM chairs WHERE clinic_id = $1`, [clinicId]);
      for (const chair of chairs) {
        await tx.query(
          `INSERT INTO chairs (clinic_id, label) VALUES ($1,$2)`,
          [clinicId, chair.label],
        );
      }
    }
    if (!skip && step === "hours") {
      const hours = body.hours as { weekday: number; opens: string; closes: string }[];
      const breaks = (body.breaks as { weekday: number; starts: string; ends: string }[]) ?? [];
      await tx.query(`DELETE FROM working_hours WHERE clinic_id = $1`, [clinicId]);
      await tx.query(`DELETE FROM break_windows WHERE clinic_id = $1`, [clinicId]);
      for (const row of hours) {
        await tx.query(
          `INSERT INTO working_hours (clinic_id, weekday, opens, closes) VALUES ($1,$2,$3,$4)`,
          [clinicId, row.weekday, row.opens, row.closes],
        );
      }
      for (const row of breaks) {
        await tx.query(
          `INSERT INTO break_windows (clinic_id, weekday, starts, ends) VALUES ($1,$2,$3,$4)`,
          [clinicId, row.weekday, row.starts, row.ends],
        );
      }
    }
    if (!skip && step === "fees") {
      await tx.query(
        `UPDATE clinics SET standard_fee_paise = $2, followup_days = $3 WHERE id = $1`,
        [clinicId, body.standardFeePaise, body.followupDays],
      );
    }
    if (!skip && step === "languages") {
      await tx.query(`UPDATE clinics SET languages = $2 WHERE id = $1`, [clinicId, body.languages]);
    }
    if (!skip && step === "profile") {
      await tx.query(
        `UPDATE clinics SET display_name = $2, mark = $3, accent = $4, address = $5, registration_no = $6
         WHERE id = $1`,
        [clinicId, body.displayName, body.mark ?? null, body.accent ?? "#1f4b3a", body.address ?? null, body.registrationNo ?? null],
      );
    }
    await tx.query(
      `UPDATE clinics SET wizard_step = $2,
         wizard_draft = wizard_draft || $3::jsonb
       WHERE id = $1`,
      [clinicId, step, JSON.stringify({ [step]: skip ? { skipped: true } : body })],
    );
    const clinic = await tx.query<{ slug: string; display_name: string; languages: string[] }>(
      `SELECT slug, display_name, languages FROM clinics WHERE id = $1`,
      [clinicId],
    );
    const row = clinic.rows[0];
    writePortalPage(row.slug, row.display_name, row.languages);
  });
}

async function ensureBookable(tx: Tx, clinicId: string): Promise<{ practitionerId: string; chairId: string }> {
  let practitioner = await tx.query<{ id: string }>(
    `SELECT id FROM practitioners WHERE clinic_id = $1 ORDER BY full_name LIMIT 1`,
    [clinicId],
  );
  if (!practitioner.rows[0]) {
    practitioner = await tx.query<{ id: string }>(
      `INSERT INTO practitioners (clinic_id, full_name) VALUES ($1,'Doctor') RETURNING id`,
      [clinicId],
    );
  }
  let chair = await tx.query<{ id: string }>(
    `SELECT id FROM chairs WHERE clinic_id = $1 ORDER BY label LIMIT 1`,
    [clinicId],
  );
  if (!chair.rows[0]) {
    chair = await tx.query<{ id: string }>(
      `INSERT INTO chairs (clinic_id, label) VALUES ($1,'Chair 1') RETURNING id`,
      [clinicId],
    );
  }
  const hours = await tx.query(`SELECT 1 FROM working_hours WHERE clinic_id = $1`, [clinicId]);
  if (hours.rowCount === 0) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      await tx.query(
        `INSERT INTO working_hours (clinic_id, weekday, opens, closes) VALUES ($1,$2,'09:00','17:00')`,
        [clinicId, weekday],
      );
    }
  }
  return { practitionerId: practitioner.rows[0].id, chairId: chair.rows[0].id };
}

export async function placeTestBooking(
  clinicId: string,
  messaging: MessagingPort,
): Promise<{ appointmentId: string }> {
  return withTenant(clinicId, async (tx) => {
    const ready = await ensureBookable(tx, clinicId);
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM patients WHERE clinic_id = $1 AND phone_e164 = '+919800000000' AND self_managing`,
      [clinicId],
    );
    const patientId = existing.rows[0]?.id ?? (await tx.query<{ id: string }>(
      `INSERT INTO patients (clinic_id, full_name, phone_e164, preferred_lang)
       VALUES ($1,'Test Patient','+919800000000','en') RETURNING id`,
      [clinicId],
    )).rows[0].id;
    const when = new Date(Date.now() + 86_400_000);
    const day = kolkataDay(when);
    const start = `${day}T10:00:00+05:30`;
    const end = `${day}T10:30:00+05:30`;
    const token = await nextToken(tx, ready.practitionerId, day);
    const stage = await tx.query<{ id: string }>(
      `SELECT id FROM queue_stages WHERE clinic_id = $1 AND role = 'pre_arrival' ORDER BY position LIMIT 1`,
      [clinicId],
    );
    const created = await tx.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, patient_id, practitioner_id, chair_id, during, mode, state,
         fee_paise, fee_reason, prepaid, token_no, stage_id
       ) VALUES (
         $1,$2,$3,$4, tstzrange($5::timestamptz, $6::timestamptz, '[)'),
         'clinic','expected', 0, 'onboarding test booking', true, $7, $8
       ) RETURNING id`,
      [clinicId, patientId, ready.practitionerId, ready.chairId, start, end, token, stage.rows[0]?.id ?? null],
    );
    await sendTemplate(tx, messaging, clinicId, {
      appointmentId: created.rows[0].id,
      phone: "+919800000000",
      lang: "en",
      template: "confirmation",
      name: "Test Patient",
    });
    return { appointmentId: created.rows[0].id };
  });
}

async function nextToken(tx: Tx, practitionerId: string, day: string): Promise<number> {
  const res = await tx.query<{ n: number }>(
    `SELECT coalesce(max(token_no), 0) + 1 AS n
     FROM appointments
     WHERE practitioner_id = $1
       AND during && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
    [practitionerId, `${day}T00:00:00+05:30`, addDay(day)],
  );
  return Number(res.rows[0].n);
}

function addDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.toISOString().slice(0, 10)}T00:00:00+05:30`;
}

export async function exportClinic(clinicId: string): Promise<unknown> {
  return withTenant(clinicId, async (tx) => {
    const patients = await tx.query(
      `SELECT id, full_name, phone_e164, preferred_lang, alerts FROM patients WHERE clinic_id = $1`,
      [clinicId],
    );
    const appointments = await tx.query(
      `SELECT id, patient_id, practitioner_id, state, fee_paise, fee_reason FROM appointments WHERE clinic_id = $1`,
      [clinicId],
    );
    return { patients: patients.rows, appointments: appointments.rows };
  });
}

export async function eraseOwnedClinic(clinicId: string, role: string): Promise<void> {
  if (role !== "owner") fail(403, "only the owner can erase a clinic");
  await eraseClinic(clinicId);
}

export async function publicProfile(clinicId: string, lang: string): Promise<unknown> {
  return withTenant(clinicId, async (tx) => {
    const clinic = await tx.query<{
      display_name: string; mark: string | null; accent: string; languages: string[];
      prepay_required: boolean; address: string | null;
    }>(
      `SELECT display_name, mark, accent, languages, prepay_required, address FROM clinics WHERE id = $1`,
      [clinicId],
    );
    const modules = await tx.query<{ module: string }>(
      `SELECT module FROM clinic_modules WHERE clinic_id = $1 ORDER BY module`,
      [clinicId],
    );
    const row = clinic.rows[0];
    return {
      displayName: row.display_name,
      mark: row.mark,
      accent: row.accent,
      languages: row.languages,
      modules: modules.rows.map((item) => item.module),
      prepayRequired: row.prepay_required,
      policy: row.prepay_required ? t(lang, "prepayNote") : null,
      noApp: t(lang, "noApp"),
    };
  });
}

export async function sendOtp(
  clinicId: string,
  phoneRaw: string,
  lang: string,
  messaging: MessagingPort,
): Promise<void> {
  const phone = toE164(phoneRaw);
  if (!phone) fail(400, "phone must be an Indian mobile number");
  await withTenant(clinicId, async (tx) => {
    const recent = await tx.query<{ created_at: Date }>(
      `SELECT created_at FROM otp_challenges
       WHERE clinic_id = $1 AND phone_e164 = $2
       ORDER BY created_at DESC LIMIT 1`,
      [clinicId, phone],
    );
    if (recent.rows[0] && Date.now() - new Date(recent.rows[0].created_at).getTime() < 60_000) {
      fail(429, "wait before requesting another code");
    }
    const cap = await tx.query<{ messaging_sent: number; messaging_cap: number }>(
      `SELECT messaging_sent, messaging_cap FROM clinics WHERE id = $1`,
      [clinicId],
    );
    const channel = cap.rows[0].messaging_sent >= cap.rows[0].messaging_cap ? "sms" : "whatsapp";
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hashed = await hashSecret(code);
    await tx.query(
      `INSERT INTO otp_challenges (clinic_id, phone_e164, code_hash, salt, expires_at)
       VALUES ($1,$2,$3,$4, now() + interval '10 minutes')`,
      [clinicId, phone, hashed.hash, hashed.salt],
    );
    if (channel === "whatsapp") {
      await tx.query(
        `UPDATE clinics SET messaging_sent = messaging_sent + 1 WHERE id = $1`,
        [clinicId],
      );
    }
    const sent = await messaging.dispatch({
      to: phone,
      lang,
      template: "otp",
      body: `${t(lang, "otpSent", { phone })} ${code}`,
      channel,
    });
    await tx.query(
      `INSERT INTO message_outbox (clinic_id, phone_e164, channel, lang, template, body, status, receipt_id)
       VALUES ($1,$2,$3,$4,'otp',$5,'delivered',$6)`,
      [clinicId, phone, sent.channel, lang, `${t(lang, "otpSent", { phone })} ${code}`, sent.receiptId],
    );
  });
}

export async function verifyOtp(
  clinicId: string,
  phoneRaw: string,
  code: string,
  name: string | undefined,
  lang: string,
): Promise<{ token: string }> {
  const phone = toE164(phoneRaw);
  if (!phone) fail(400, "phone must be an Indian mobile number");
  return withTenant(clinicId, async (tx) => {
    const challenge = await tx.query<{
      id: string; code_hash: string; salt: Buffer; attempts: number;
    }>(
      `SELECT id, code_hash, salt, attempts FROM otp_challenges
       WHERE clinic_id = $1 AND phone_e164 = $2 AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [clinicId, phone],
    );
    const row = challenge.rows[0];
    if (!row || row.attempts >= 5) fail(401, "code expired");
    const salt = Buffer.isBuffer(row.salt) ? row.salt : Buffer.from(row.salt);
    const ok = await secretMatches(code, row.code_hash, salt);
    if (!ok) {
      await tx.query(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      fail(401, "code rejected");
    }
    let patient = await tx.query<{ id: string }>(
      `SELECT id FROM patients WHERE clinic_id = $1 AND phone_e164 = $2 AND self_managing`,
      [clinicId, phone],
    );
    if (!patient.rows[0]) {
      if (!name) fail(400, "name is required for a new patient");
      patient = await tx.query<{ id: string }>(
        `INSERT INTO patients (clinic_id, full_name, phone_e164, preferred_lang)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [clinicId, name, phone, lang],
      );
    }
    const token = newToken();
    await tx.query(
      `INSERT INTO patient_sessions (token, clinic_id, patient_id, expires_at)
       VALUES ($1,$2,$3, now() + interval '12 hours')`,
      [token, clinicId, patient.rows[0].id],
    );
    return { token };
  });
}

export async function listSlots(
  clinicId: string,
  practitionerId: string,
  day: string,
  mode: "clinic" | "video",
): Promise<{ start: string; end: string }[]> {
  return withTenant(clinicId, async (tx) => {
    const weekday = new Date(`${day}T12:00:00+05:30`).getDay();
    const clinic = await tx.query<{ slot_minutes: number }>(
      `SELECT slot_minutes FROM clinics WHERE id = $1`,
      [clinicId],
    );
    const hours = await tx.query<{ opens: string; closes: string }>(
      `SELECT opens::text, closes::text FROM working_hours WHERE clinic_id = $1 AND weekday = $2`,
      [clinicId, weekday],
    );
    if (!hours.rows[0]) return [];
    const breaks = await tx.query<{ starts: string; ends: string }>(
      `SELECT starts::text, ends::text FROM break_windows WHERE clinic_id = $1 AND weekday = $2`,
      [clinicId, weekday],
    );
    const busy = await tx.query<{ start: Date; end: Date }>(
      `SELECT lower(during) AS start, upper(during) AS end
       FROM appointments
       WHERE practitioner_id = $1 AND state NOT IN ('cancelled','no_show')
         AND during && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
      [practitionerId, `${day}T00:00:00+05:30`, addDay(day)],
    );
    const step = clinic.rows[0].slot_minutes;
    const slots: { start: string; end: string }[] = [];
    let cursor = minutes(hours.rows[0].opens);
    const close = minutes(hours.rows[0].closes);
    while (cursor + step <= close) {
      const startMin = cursor;
      const endMin = cursor + step;
      cursor += step;
      const blocked = breaks.rows.some((item) => overlaps(startMin, endMin, minutes(item.starts), minutes(item.ends)));
      if (blocked) continue;
      const startIso = `${day}T${hhmm(startMin)}:00+05:30`;
      const endIso = `${day}T${hhmm(endMin)}:00+05:30`;
      const startMs = Date.parse(startIso);
      const endMs = Date.parse(endIso);
      const taken = busy.rows.some((item) => startMs < new Date(item.end).getTime() && endMs > new Date(item.start).getTime());
      if (taken) continue;
      if (mode === "clinic") {
        const chairFree = await chairAvailable(tx, clinicId, startIso, endIso);
        if (!chairFree) continue;
      }
      slots.push({ start: startIso, end: endIso });
    }
    return slots;
  });
}

function minutes(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

function hhmm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && a1 > b0;
}

async function chairAvailable(tx: Tx, clinicId: string, start: string, end: string): Promise<string | null> {
  const chairs = await tx.query<{ id: string }>(
    `SELECT id FROM chairs WHERE clinic_id = $1 ORDER BY label`,
    [clinicId],
  );
  for (const chair of chairs.rows) {
    const hit = await tx.query(
      `SELECT 1 FROM appointments
       WHERE chair_id = $1 AND state NOT IN ('cancelled','no_show')
         AND during && tstzrange($2::timestamptz, $3::timestamptz, '[)')
       LIMIT 1`,
      [chair.id, start, end],
    );
    if (hit.rowCount === 0) return chair.id;
  }
  return null;
}

export async function quoteFee(
  tx: Tx,
  clinicId: string,
  patientId: string,
  practitionerId: string,
  at: Date,
): Promise<{ feePaise: number; feeReason: string }> {
  const clinic = await tx.query<{ followup_days: number; standard_fee_paise: string }>(
    `SELECT followup_days, standard_fee_paise FROM clinics WHERE id = $1`,
    [clinicId],
  );
  const last = await tx.query<{ ended: Date }>(
    `SELECT upper(during) AS ended FROM appointments
     WHERE patient_id = $1 AND practitioner_id = $2 AND state = 'done'
     ORDER BY upper(during) DESC LIMIT 1`,
    [patientId, practitionerId],
  );
  const standard = Number(clinic.rows[0].standard_fee_paise);
  const window = clinic.rows[0].followup_days;
  if (!last.rows[0]) {
    return { feePaise: standard, feeReason: "standard consultation" };
  }
  const gap = daysBetween(kolkataDay(new Date(last.rows[0].ended)), kolkataDay(at));
  if (gap <= window) {
    return { feePaise: 0, feeReason: `complimentary follow-up within ${window} days` };
  }
  return { feePaise: standard, feeReason: "standard consultation" };
}

export async function bookAppointment(
  clinicId: string,
  patientId: string,
  input: { practitionerId: string; start: string; end: string; mode: "clinic" | "video"; lang: string },
  billing: BillingPort,
  messaging: MessagingPort,
): Promise<unknown> {
  return withTenant(clinicId, async (tx) => {
    const clinic = await tx.query<{ prepay_required: boolean; display_name: string }>(
      `SELECT prepay_required, display_name FROM clinics WHERE id = $1`,
      [clinicId],
    );
    const fee = await quoteFee(tx, clinicId, patientId, input.practitionerId, new Date(input.start));
    const day = input.start.slice(0, 10);
    const token = await nextToken(tx, input.practitionerId, day);
    const chairId = input.mode === "clinic" ? await chairAvailable(tx, clinicId, input.start, input.end) : null;
    if (input.mode === "clinic" && !chairId) fail(409, "no chair is free");
    const stage = await tx.query<{ id: string }>(
      `SELECT id FROM queue_stages WHERE clinic_id = $1 AND role = 'pre_arrival' ORDER BY position LIMIT 1`,
      [clinicId],
    );
    let created: { rows: { id: string }[] };
    try {
      created = await tx.query<{ id: string }>(
        `INSERT INTO appointments (
           clinic_id, patient_id, practitioner_id, chair_id, during, mode, state,
           fee_paise, fee_reason, token_no, stage_id
         ) VALUES (
           $1,$2,$3,$4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), $7, 'expected',
           $8,$9,$10,$11
         ) RETURNING id`,
        [
          clinicId, patientId, input.practitionerId, chairId, input.start, input.end, input.mode,
          fee.feePaise, fee.feeReason, token, stage.rows[0]?.id ?? null,
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23P01") fail(409, "that time is already booked");
      throw err;
    }
    const appointmentId = created.rows[0].id;
    const policy = clinic.rows[0].prepay_required ? t(input.lang, "prepayNote") : null;
    if (clinic.rows[0].prepay_required) {
      await tx.query(
        `INSERT INTO deposits (clinic_id, appointment_id, amount_paise, status) VALUES ($1,$2,$3,'pending')`,
        [clinicId, appointmentId, fee.feePaise],
      );
      const intent = billing.intent(appointmentId, fee.feePaise);
      return {
        appointmentId,
        feePaise: fee.feePaise,
        feeReason: fee.feeReason,
        policy,
        intent,
        paid: false,
      };
    }
    await sendTemplate(tx, messaging, clinicId, {
      appointmentId,
      phone: (await tx.query<{ phone_e164: string }>(
        `SELECT phone_e164 FROM patients WHERE id = $1`,
        [patientId],
      )).rows[0].phone_e164,
      lang: input.lang,
      template: "confirmation",
      name: "",
    });
    return { appointmentId, feePaise: fee.feePaise, feeReason: fee.feeReason, policy, paid: true };
  });
}

async function sendTemplate(
  tx: Tx,
  messaging: MessagingPort,
  clinicId: string,
  input: { appointmentId: string; phone: string; lang: string; template: string; name: string },
): Promise<void> {
  const detail = await tx.query<{
    full_name: string; doctor: string; token_no: number; display_name: string; start: Date;
  }>(
    `SELECT p.full_name, pr.full_name AS doctor, a.token_no, c.display_name, lower(a.during) AS start
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     JOIN practitioners pr ON pr.id = a.practitioner_id
     JOIN clinics c ON c.id = a.clinic_id
     WHERE a.id = $1`,
    [input.appointmentId],
  );
  const row = detail.rows[0];
  const cap = await tx.query<{ messaging_sent: number; messaging_cap: number }>(
    `SELECT messaging_sent, messaging_cap FROM clinics WHERE id = $1`,
    [clinicId],
  );
  const channel = cap.rows[0].messaging_sent >= cap.rows[0].messaging_cap ? "sms" : "whatsapp";
  const body = input.template === "reminder"
    ? t(input.lang, "waConfirm", {
      name: row.full_name,
      doctor: row.doctor,
      time: new Date(row.start).toISOString(),
      token: row.token_no,
      clinic: row.display_name,
    })
    : t(input.lang, "waConfirm", {
      name: input.name || row.full_name,
      doctor: row.doctor,
      time: new Date(row.start).toISOString(),
      token: row.token_no,
      clinic: row.display_name,
    });
  const sent = await messaging.dispatch({
    to: input.phone || (await tx.query<{ phone_e164: string }>(
      `SELECT p.phone_e164 FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = $1`,
      [input.appointmentId],
    )).rows[0].phone_e164,
    lang: input.lang,
    template: input.template,
    body,
    channel,
  });
  if (channel === "whatsapp") {
    await tx.query(`UPDATE clinics SET messaging_sent = messaging_sent + 1 WHERE id = $1`, [clinicId]);
  }
  await tx.query(
    `INSERT INTO message_outbox (
       clinic_id, appointment_id, phone_e164, channel, lang, template, body, status, receipt_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'delivered',$8)`,
    [clinicId, input.appointmentId, input.phone, sent.channel, input.lang, input.template, body, sent.receiptId],
  );
}

export async function settleWebhook(
  clinicId: string,
  input: { provider: string; providerEventId: string; appointmentId: string },
  raw: unknown,
  messaging: MessagingPort,
): Promise<{ duplicate: boolean }> {
  return withTenant(clinicId, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO payment_events (provider, provider_event_id, clinic_id, payload)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING
       RETURNING provider_event_id`,
      [input.provider, input.providerEventId, clinicId, JSON.stringify(raw)],
    );
    if (inserted.rowCount === 0) return { duplicate: true };
    const deposit = await tx.query(
      `UPDATE deposits
       SET status = 'settled', settled_at = now(), provider = $3, provider_event_id = $4
       WHERE appointment_id = $1 AND clinic_id = $2 AND status = 'pending'
       RETURNING appointment_id`,
      [input.appointmentId, clinicId, input.provider, input.providerEventId],
    );
    if (deposit.rowCount === 0) fail(404, "no pending deposit");
    await tx.query(
      `UPDATE appointments SET prepaid = true WHERE id = $1`,
      [input.appointmentId],
    );
    const patient = await tx.query<{ phone_e164: string; preferred_lang: string }>(
      `SELECT p.phone_e164, p.preferred_lang
       FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = $1`,
      [input.appointmentId],
    );
    await sendTemplate(tx, messaging, clinicId, {
      appointmentId: input.appointmentId,
      phone: patient.rows[0].phone_e164,
      lang: patient.rows[0].preferred_lang,
      template: "confirmation",
      name: "",
    });
    return { duplicate: false };
  });
}

export async function clientClaimsPaid(): Promise<{ accepted: false }> {
  return { accepted: false };
}

export async function cancelAppointment(
  clinicId: string,
  appointmentId: string,
  lang: string,
): Promise<unknown> {
  return withTenant(clinicId, async (tx) => {
    const appt = await tx.query<{ start: Date; mode: string; state: string }>(
      `SELECT lower(during) AS start, mode, state FROM appointments WHERE id = $1`,
      [appointmentId],
    );
    if (!appt.rows[0]) fail(404, "appointment not found");
    if (appt.rows[0].state === "cancelled") fail(409, "already cancelled");
    const hoursLeft = (new Date(appt.rows[0].start).getTime() - Date.now()) / 3_600_000;
    const deposit = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM deposits WHERE appointment_id = $1`,
      [appointmentId],
    );
    let instruction: string | null = null;
    if (deposit.rows[0]?.status === "settled") {
      instruction = hoursLeft < 24 ? "forfeit" : "refund";
      await tx.query(
        `UPDATE deposits SET status = $2 WHERE id = $1`,
        [deposit.rows[0].id, instruction === "forfeit" ? "forfeited" : "refund_instructed"],
      );
    }
    await tx.query(`UPDATE appointments SET state = 'cancelled' WHERE id = $1`, [appointmentId]);
    const offerVideo = instruction === "refund" && appt.rows[0].mode === "clinic";
    return {
      instruction,
      offerVideo,
      videoOffer: offerVideo ? t(lang, "videoOffer") : null,
    };
  });
}

export async function sendReminder(
  clinicId: string,
  appointmentId: string,
  messaging: MessagingPort,
): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    const patient = await tx.query<{ phone_e164: string; preferred_lang: string }>(
      `SELECT p.phone_e164, p.preferred_lang
       FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = $1`,
      [appointmentId],
    );
    await sendTemplate(tx, messaging, clinicId, {
      appointmentId,
      phone: patient.rows[0].phone_e164,
      lang: patient.rows[0].preferred_lang,
      template: "reminder",
      name: "",
    });
  });
}

export async function confirmAttendanceIntent(clinicId: string, appointmentId: string): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    await tx.query(`UPDATE appointments SET patient_confirmed = true WHERE id = $1`, [appointmentId]);
  });
}

export async function markAttended(clinicId: string, appointmentId: string): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    const stage = await tx.query<{ id: string }>(
      `SELECT id FROM queue_stages WHERE clinic_id = $1 AND role = 'post_service' ORDER BY position LIMIT 1`,
      [clinicId],
    );
    await tx.query(
      `UPDATE appointments
       SET state = 'done', attended_at = now(), updated_at = now(), stage_id = coalesce($2, stage_id)
       WHERE id = $1`,
      [appointmentId, stage.rows[0]?.id ?? null],
    );
    await writeLedger(tx, clinicId, appointmentId);
    await queueNotify(tx, clinicId, { type: "attended", appointmentId });
  });
}

async function writeLedger(tx: Tx, clinicId: string, appointmentId: string): Promise<void> {
  const appt = await tx.query<{
    fee_paise: string; attended_at: Date; patient_confirmed: boolean; attribution_hours: number;
  }>(
    `SELECT a.fee_paise, a.attended_at, a.patient_confirmed, c.attribution_hours
     FROM appointments a JOIN clinics c ON c.id = a.clinic_id WHERE a.id = $1`,
    [appointmentId],
  );
  const row = appt.rows[0];
  if (!row?.attended_at) return;
  const attended = new Date(row.attended_at);
  const deposit = await tx.query<{ provider_event_id: string | null; settled_at: Date | null; status: string }>(
    `SELECT provider_event_id, settled_at, status FROM deposits WHERE appointment_id = $1`,
    [appointmentId],
  );
  const reminder = await tx.query<{ receipt_id: string | null; created_at: Date }>(
    `SELECT receipt_id, created_at FROM message_outbox
     WHERE appointment_id = $1 AND template = 'reminder' AND status = 'delivered'
     ORDER BY created_at DESC LIMIT 1`,
    [appointmentId],
  );
  const windowMs = row.attribution_hours * 3_600_000;
  const depositRow = deposit.rows[0];
  const depositOk = depositRow?.status === "settled"
    && depositRow.provider_event_id
    && depositRow.settled_at
    && attended.getTime() - new Date(depositRow.settled_at).getTime() <= windowMs;
  const reminderRow = reminder.rows[0];
  const reminderOk = reminderRow?.receipt_id
    && row.patient_confirmed
    && attended.getTime() - new Date(reminderRow.created_at).getTime() <= windowMs;
  if (depositOk) {
    await insertLedger(tx, clinicId, appointmentId, "deposit_converted", Number(row.fee_paise), depositRow.provider_event_id as string);
    return;
  }
  if (reminderOk) {
    await insertLedger(tx, clinicId, appointmentId, "no_show_prevented", Number(row.fee_paise), reminderRow.receipt_id as string);
  }
}

async function insertLedger(
  tx: Tx,
  clinicId: string,
  appointmentId: string,
  eventType: string,
  amountPaise: number,
  evidenceRef: string,
): Promise<void> {
  if (!evidenceRef) return;
  const existing = await tx.query(
    `SELECT 1 FROM recovered_revenue
     WHERE appointment_id = $1 AND corrects_id IS NULL AND amount_paise >= 0`,
    [appointmentId],
  );
  if ((existing.rowCount ?? 0) > 0) return;
  await tx.query(
    `INSERT INTO recovered_revenue (clinic_id, appointment_id, event_type, amount_paise, evidence_ref)
     VALUES ($1,$2,$3,$4,$5)`,
    [clinicId, appointmentId, eventType, amountPaise, evidenceRef],
  );
}

export async function correctLedger(
  clinicId: string,
  ledgerId: string,
  reason: string,
): Promise<void> {
  if (!reason) fail(400, "a correction needs a reason");
  await withTenant(clinicId, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO recovered_revenue (
         clinic_id, appointment_id, event_type, amount_paise, evidence_ref, reason, corrects_id
       )
       SELECT clinic_id, appointment_id, event_type, -amount_paise, evidence_ref, $3, id
       FROM recovered_revenue WHERE id = $1 AND clinic_id = $2
       RETURNING id`,
      [ledgerId, clinicId, reason],
    );
    if (inserted.rowCount === 0) fail(404, "ledger row not found");
  });
}

export async function moveStage(
  clinicId: string,
  appointmentId: string,
  stageId: string,
): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    const stage = await tx.query<{ role: string }>(
      `SELECT role FROM queue_stages WHERE id = $1 AND clinic_id = $2`,
      [stageId, clinicId],
    );
    if (!stage.rows[0]) fail(404, "stage not found");
    if (stage.rows[0].role === "waiting") {
      await tx.query(
        `UPDATE appointments
         SET stage_id = $2, state = 'waiting', arrived_at = coalesce(arrived_at, now()), updated_at = now()
         WHERE id = $1`,
        [appointmentId, stageId],
      );
    } else if (stage.rows[0].role === "post_service") {
      await tx.query(
        `UPDATE appointments SET stage_id = $2, state = 'done', attended_at = now(), updated_at = now() WHERE id = $1`,
        [appointmentId, stageId],
      );
      await writeLedger(tx, clinicId, appointmentId);
    } else if (stage.rows[0].role === "in_service") {
      await tx.query(
        `UPDATE appointments SET stage_id = $2, state = 'in_consult', updated_at = now() WHERE id = $1`,
        [appointmentId, stageId],
      );
    } else {
      await tx.query(
        `UPDATE appointments SET stage_id = $2, updated_at = now() WHERE id = $1`,
        [appointmentId, stageId],
      );
    }
    await queueNotify(tx, clinicId, { type: "stage", appointmentId, stageId });
  });
}

export async function queueBoard(clinicId: string): Promise<unknown> {
  return withTenant(clinicId, async (tx) => {
    const stages = await tx.query(
      `SELECT id, position, label_key, role, dwell_alert_mins FROM queue_stages
       WHERE clinic_id = $1 ORDER BY position`,
      [clinicId],
    );
    const cards = await tx.query(
      `SELECT a.id, a.token_no, a.stage_id, a.arrived_at, a.practitioner_id,
              p.id AS patient_id, p.full_name, p.phone_masked, p.alerts, pr.full_name AS practitioner
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN practitioners pr ON pr.id = a.practitioner_id
       WHERE a.clinic_id = $1 AND a.state NOT IN ('cancelled','no_show','done')
         AND NOT a.external_hold
       ORDER BY a.token_no`,
      [clinicId],
    );
    const now = Date.now();
    return {
      stages: stages.rows,
      cards: cards.rows.map((card) => {
        const stage = stages.rows.find((item: { id: string }) => item.id === card.stage_id) as {
          dwell_alert_mins: number | null;
        } | undefined;
        const arrived = card.arrived_at ? new Date(card.arrived_at).getTime() : null;
        const dwell = stage?.dwell_alert_mins != null && arrived != null
          && now - arrived > stage.dwell_alert_mins * 60_000;
        return { ...card, dwell };
      }),
    };
  });
}

export async function createWalkIn(
  clinicId: string,
  input: { phone: string; name: string; practitionerId: string; patientId?: string; appointmentId?: string },
): Promise<{ patientId: string; appointmentId: string; tokenNo: number }> {
  const phone = toE164(input.phone);
  if (!phone || !input.name) fail(400, "walk-in needs a mobile number and a name");
  return withTenant(clinicId, async (tx) => {
    let patient = await tx.query<{ id: string }>(
      `SELECT id FROM patients WHERE clinic_id = $1 AND phone_e164 = $2 AND self_managing`,
      [clinicId, phone],
    );
    if (!patient.rows[0]) {
      patient = await tx.query<{ id: string }>(
        `INSERT INTO patients (id, clinic_id, full_name, phone_e164)
         VALUES (coalesce($4::uuid, gen_random_uuid()), $1,$2,$3) RETURNING id`,
        [clinicId, input.name, phone, input.patientId ?? null],
      );
    }
    const day = kolkataDay(new Date());
    const tokenNo = await nextToken(tx, input.practitionerId, day);
    const stage = await tx.query<{ id: string }>(
      `SELECT id FROM queue_stages WHERE clinic_id = $1 AND role = 'waiting' ORDER BY position LIMIT 1`,
      [clinicId],
    );
    const startMs = Date.parse(`${day}T00:00:00+05:30`) + tokenNo * 60_000;
    const start = new Date(startMs);
    const end = new Date(startMs + 60_000);
    const created = await tx.query<{ id: string }>(
      `INSERT INTO appointments (
         id, clinic_id, patient_id, practitioner_id, during, mode, state, fee_paise, fee_reason,
         token_no, stage_id, arrived_at
       ) VALUES (
         coalesce($1::uuid, gen_random_uuid()), $2,$3,$4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), 'clinic', 'waiting',
         0, 'walk-in', $7, $8, now()
       ) RETURNING id`,
      [
        input.appointmentId ?? null,
        clinicId, patient.rows[0].id, input.practitionerId, start.toISOString(), end.toISOString(), tokenNo, stage.rows[0]?.id ?? null,
      ],
    );
    await queueNotify(tx, clinicId, { type: "walk-in", appointmentId: created.rows[0].id });
    return { patientId: patient.rows[0].id, appointmentId: created.rows[0].id, tokenNo };
  });
}

export async function unmaskPhone(
  clinicId: string,
  patientId: string,
  actor: { userId: string; role: string },
): Promise<{ phone: string }> {
  if (actor.role !== "owner" && actor.role !== "admin") fail(403, "unmask is limited to an administrator");
  return withTenant(clinicId, async (tx) => {
    const patient = await tx.query<{ phone_e164: string }>(
      `SELECT phone_e164 FROM patients WHERE id = $1`,
      [patientId],
    );
    if (!patient.rows[0]) fail(404, "patient not found");
    await audit(tx, clinicId, actor.userId, actor.role, "unmask", patientId, {});
    return { phone: patient.rows[0].phone_e164 };
  });
}

export async function maskedPatient(clinicId: string, patientId: string): Promise<{ phoneMasked: string; alerts: string[] }> {
  return withTenant(clinicId, async (tx) => {
    const patient = await tx.query<{ phone_masked: string; alerts: string[] }>(
      `SELECT phone_masked, alerts FROM patients WHERE id = $1`,
      [patientId],
    );
    return { phoneMasked: patient.rows[0].phone_masked, alerts: patient.rows[0].alerts };
  });
}
