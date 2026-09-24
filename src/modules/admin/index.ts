import type pg from "pg";
import { withTenant } from "../../db/tenant.js";

const DEFAULT_RATES: Record<number, number> = { 1: 1000, 2: 500 };
const DEFAULT_UNIT_PAISE = 80000;

type Bundle = {
  abhaId: string;
  category: 1 | 2;
  kycVerified: boolean;
  bundleRef: string;
  occurredOn: string;
  kind: string;
};

type Accrued = Bundle & { paise: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function accrue(rows: Bundle[], rates: Record<number, number>): { lines: Accrued[]; eligibleCount: number } {
  const eligible: Bundle[] = [];
  const seenDay = new Set<string>();
  const seenMonth = new Map<string, number>();
  const ordered = [...rows].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.bundleRef.localeCompare(b.bundleRef));
  for (const row of ordered) {
    if (!row.kycVerified) continue;
    if (row.category === 2) {
      const day = `${row.abhaId}:${row.occurredOn}`;
      const month = `${row.abhaId}:${row.occurredOn.slice(0, 7)}`;
      if (seenDay.has(day)) continue;
      if ((seenMonth.get(month) ?? 0) >= 5) continue;
      seenDay.add(day);
      seenMonth.set(month, (seenMonth.get(month) ?? 0) + 1);
    }
    eligible.push(row);
  }
  const earning = new Set(eligible.slice(100).map((row) => row.bundleRef));
  return {
    eligibleCount: eligible.length,
    lines: ordered.map((row) => ({
      ...row,
      paise: earning.has(row.bundleRef) ? rates[row.category] : 0,
    })),
  };
}

async function ratesFor(clinicId: string): Promise<Record<number, number>> {
  return withTenant(clinicId, async (tx) => {
    const existing = await tx.query<{ category: number; facility_paise: number }>(
      `SELECT category, facility_paise FROM clinic_dhis_rates WHERE clinic_id = $1`,
      [clinicId],
    );
    if (existing.rowCount === 0) {
      await tx.query(
        `INSERT INTO clinic_dhis_rates (clinic_id, category, facility_paise) VALUES ($1, 1, 1000), ($1, 2, 500)`,
        [clinicId],
      );
      return { ...DEFAULT_RATES };
    }
    const rates = { ...DEFAULT_RATES };
    for (const row of existing.rows) rates[row.category] = row.facility_paise;
    return rates;
  });
}

export async function recordBundles(clinicId: string, rows: Bundle[]): Promise<number> {
  return withTenant(clinicId, async (tx) => {
    await tx.query(
      `INSERT INTO clinic_dhis_rates (clinic_id, category, facility_paise)
       VALUES ($1, 1, 1000), ($1, 2, 500)
       ON CONFLICT DO NOTHING`,
      [clinicId],
    );
    for (const row of rows) {
      await tx.query(
        `INSERT INTO dhis_transactions (clinic_id, abha_id, category, kyc_verified, bundle_ref, occurred_on, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (clinic_id, bundle_ref) DO NOTHING`,
        [clinicId, row.abhaId, row.category, row.kycVerified, row.bundleRef, row.occurredOn, row.kind],
      );
    }
    const count = await tx.query(`SELECT count(*)::int AS n FROM dhis_transactions WHERE clinic_id = $1`, [clinicId]);
    return count.rows[0].n as number;
  });
}

export async function repriceDhis(clinicId: string, category: 1 | 2, facilityPaise: number): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `INSERT INTO clinic_dhis_rates (clinic_id, category, facility_paise) VALUES ($1, $2, $3)
       ON CONFLICT (clinic_id, category) DO UPDATE SET facility_paise = EXCLUDED.facility_paise`,
      [clinicId, category, facilityPaise],
    );
  });
}

export async function dhisStatement(clinicId: string) {
  const rates = await ratesFor(clinicId);
  return withTenant(clinicId, async (tx) => {
    const rows = await tx.query<{
      abha_id: string; category: number; kyc_verified: boolean; bundle_ref: string; occurred_on: string; kind: string;
    }>(
      `SELECT abha_id, category, kyc_verified, bundle_ref, occurred_on::text, kind
       FROM dhis_transactions WHERE clinic_id = $1 ORDER BY occurred_on, bundle_ref`,
      [clinicId],
    );
    const accrued = accrue(rows.rows.map((row) => ({
      abhaId: row.abha_id,
      category: row.category as 1 | 2,
      kycVerified: row.kyc_verified,
      bundleRef: row.bundle_ref,
      occurredOn: String(row.occurred_on).slice(0, 10),
      kind: row.kind,
    })), rates);
    return {
      lines: accrued.lines,
      accruedPaise: accrued.lines.reduce((sum, line) => sum + line.paise, 0),
      rowCount: accrued.lines.length,
      eligibleCount: accrued.eligibleCount,
    };
  });
}

export async function reconcileDhis(
  clinicId: string,
  statement: { bundleRef: string; paise: number }[],
): Promise<{ ok: boolean; accruedPaise: number }> {
  const local = await dhisStatement(clinicId);
  const byRef = new Map(statement.map((line) => [line.bundleRef, line.paise]));
  const ok = local.lines.length === statement.length
    && local.lines.every((line) => byRef.get(line.bundleRef) === line.paise);
  return { ok, accruedPaise: local.accruedPaise };
}

export async function recordHandover(clinicId: string, day: string, cashPaise: number): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `INSERT INTO cash_handovers (clinic_id, day, cash_paise) VALUES ($1, $2, $3)
       ON CONFLICT (clinic_id, day) DO UPDATE SET cash_paise = EXCLUDED.cash_paise`,
      [clinicId, day, cashPaise],
    );
  });
}

export async function dayBalance(clinicId: string, day: string): Promise<{ cashPaise: number; upiPaise: number; differencePaise: number }> {
  return withTenant(clinicId, async (tx) => {
    const cash = await tx.query<{ cash_paise: string | null }>(
      `SELECT cash_paise FROM cash_handovers WHERE clinic_id = $1 AND day = $2`,
      [clinicId, day],
    );
    const upi = await tx.query<{ total: string }>(
      `SELECT COALESCE(SUM((payload->>'amountPaise')::bigint), 0)::text AS total
       FROM payment_events
       WHERE clinic_id = $1 AND received_at::date = $2::date AND payload->>'status' = 'settled'`,
      [clinicId, day],
    );
    const cashPaise = Number(cash.rows[0]?.cash_paise ?? 0);
    const upiPaise = Number(upi.rows[0].total);
    return { cashPaise, upiPaise, differencePaise: cashPaise - upiPaise };
  });
}

export async function saveSettings(
  clinicId: string,
  settings: { overheadPaise?: number; subscriptionPaise?: number; valueSource?: "default" | "clinic"; unitPaise?: number },
): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `UPDATE clinics SET
         overhead_paise = COALESCE($2, overhead_paise),
         subscription_paise = COALESCE($3, subscription_paise),
         value_source = COALESCE($4, value_source)
       WHERE id = $1`,
      [clinicId, settings.overheadPaise ?? null, settings.subscriptionPaise ?? null, settings.valueSource ?? null],
    );
    if (settings.unitPaise !== undefined) {
      await tx.query(
        `INSERT INTO clinic_dhis_rates (clinic_id, category, facility_paise) VALUES ($1, 2, $2)
         ON CONFLICT DO NOTHING`,
        [clinicId, 500],
      );
    }
  });
}

export async function ownerLedger(clinicId: string): Promise<unknown> {
  return withTenant(clinicId, async (tx) => {
    const clinic = await tx.query<{
      subscription_paise: string; overhead_paise: string; value_source: string; slot_minutes: number;
    }>(
      `SELECT subscription_paise, overhead_paise, value_source, slot_minutes FROM clinics WHERE id = $1`,
      [clinicId],
    );
    const events = await tx.query(
      `SELECT id, event_type, amount_paise, evidence_ref, appointment_id
       FROM recovered_revenue WHERE clinic_id = $1 AND amount_paise > 0 AND corrects_id IS NULL
       ORDER BY id`,
      [clinicId],
    );
    const total = events.rows.reduce((sum, row) => sum + Number(row.amount_paise), 0);
    const unit = events.rows.length
      ? Number(events.rows[0].amount_paise)
      : DEFAULT_UNIT_PAISE;
    const subscription = Number(clinic.rows[0].subscription_paise);
    const chairs = await tx.query(`SELECT count(*)::int AS n FROM chairs WHERE clinic_id = $1`, [clinicId]);
    const hours = await tx.query<{ minutes: string }>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (closes - opens)) / 60), 0)::text AS minutes
       FROM working_hours WHERE clinic_id = $1 AND weekday = EXTRACT(DOW FROM (now() AT TIME ZONE 'Asia/Kolkata'))`,
      [clinicId],
    );
    const used = await tx.query<{ minutes: string }>(
      `SELECT COALESCE(SUM(minutes), 0)::text AS minutes FROM consult_spans WHERE clinic_id = $1`,
      [clinicId],
    );
    const available = Number(hours.rows[0].minutes) * Number(chairs.rows[0].n);
    const utilised = Number(used.rows[0].minutes);
    const perDay = Math.round(Number(clinic.rows[0].overhead_paise) / 26);
    const dhis = await dhisInside(tx, clinicId);
    return {
      subscriptionPaise: subscription,
      valueSource: clinic.rows[0].value_source,
      recoveredPaise: total,
      breakEvenCount: Math.ceil(subscription / unit),
      events: events.rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        amountPaise: Number(row.amount_paise),
        evidenceRef: row.evidence_ref,
      })),
      chairs: {
        availableMinutes: available,
        utilisedMinutes: utilised,
        perAvailableMinutePaise: available > 0 ? Math.round(perDay / available) : 0,
        perUtilisedMinutePaise: utilised > 0 ? Math.round(perDay / utilised) : 0,
      },
      dhis,
    };
  });
}

async function dhisInside(tx: pg.PoolClient, clinicId: string) {
  const rateRows = await tx.query(
    `SELECT category, facility_paise FROM clinic_dhis_rates WHERE clinic_id = $1`,
    [clinicId],
  );
  const rates = { ...DEFAULT_RATES };
  for (const row of rateRows.rows) rates[Number(row.category)] = Number(row.facility_paise);
  const txRows = await tx.query(
    `SELECT abha_id, category, kyc_verified, bundle_ref, occurred_on::text AS occurred_on, kind
     FROM dhis_transactions WHERE clinic_id = $1`,
    [clinicId],
  );
  const accrued = accrue(txRows.rows.map((row) => ({
    abhaId: String(row.abha_id),
    category: Number(row.category) as 1 | 2,
    kycVerified: Boolean(row.kyc_verified),
    bundleRef: String(row.bundle_ref),
    occurredOn: String(row.occurred_on).slice(0, 10),
    kind: String(row.kind),
  })), rates);
  return {
    accruedPaise: accrued.lines.reduce((sum, line) => sum + line.paise, 0),
    rowCount: accrued.lines.length,
    eligibleCount: accrued.eligibleCount,
    category2Paise: rates[2],
    floor: 100,
  };
}

export async function recordSpan(
  clinicId: string,
  practitionerId: string,
  sessionType: string,
  minutes: number,
): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    await tx.query(
      `INSERT INTO consult_spans (clinic_id, practitioner_id, session_type, minutes) VALUES ($1, $2, $3, $4)`,
      [clinicId, practitionerId, sessionType, minutes],
    );
  });
}

export async function quoteToken(clinicId: string, appointmentId: string): Promise<{
  position: number;
  hedged: boolean;
  minutes: number | null;
  range: [number, number] | null;
  notified: boolean;
}> {
  return withTenant(clinicId, async (tx) => {
    const appt = await tx.query<{ practitioner_id: string; token_no: number }>(
      `SELECT practitioner_id, token_no FROM appointments WHERE id = $1 AND clinic_id = $2`,
      [appointmentId, clinicId],
    );
    const mine = appt.rows[0];
    const ahead = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM appointments
       WHERE clinic_id = $1 AND practitioner_id = $2 AND token_no < $3
         AND state NOT IN ('cancelled', 'no_show', 'done')`,
      [clinicId, mine.practitioner_id, mine.token_no],
    );
    const samples = await tx.query<{ minutes: number }>(
      `SELECT minutes FROM consult_spans WHERE clinic_id = $1 AND practitioner_id = $2 AND session_type = 'clinic'`,
      [clinicId, mine.practitioner_id],
    );
    const clinic = await tx.query<{ slot_minutes: number }>(
      `SELECT slot_minutes FROM clinics WHERE id = $1`,
      [clinicId],
    );
    const history = samples.rows.map((row) => row.minutes);
    const hedged = history.length < 3;
    const perPatient = hedged ? clinic.rows[0].slot_minutes : median(history);
    const position = ahead.rows[0].n;
    const projected = position * perPatient;
    const range: [number, number] | null = projected > 20 ? [projected, projected + perPatient] : null;
    const previous = await tx.query<{ quoted_minutes: number }>(
      `SELECT quoted_minutes FROM token_notices WHERE appointment_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [appointmentId],
    );
    const prior = previous.rows[0]?.quoted_minutes;
    const notified = prior === undefined || Math.abs(prior - projected) >= 10;
    if (notified) {
      const body = hedged
        ? `About ${projected} minutes, based on the usual slot length.`
        : range
          ? `Estimated entry in ${range[0]} to ${range[1]} minutes.`
          : `Estimated entry in ${projected} minutes.`;
      await tx.query(
        `INSERT INTO token_notices (clinic_id, appointment_id, quoted_minutes, body) VALUES ($1, $2, $3, $4)`,
        [clinicId, appointmentId, projected, body],
      );
    }
    return { position, hedged, minutes: range ? null : projected, range, notified };
  });
}

export async function requestLater(clinicId: string, appointmentId: string): Promise<{ swappedWith: string | null }> {
  return withTenant(clinicId, async (tx) => {
    const mine = await tx.query<{ practitioner_id: string; token_no: number }>(
      `SELECT practitioner_id, token_no FROM appointments WHERE id = $1 AND clinic_id = $2`,
      [appointmentId, clinicId],
    );
    const waiting = await tx.query<{ id: string; token_no: number }>(
      `SELECT a.id, a.token_no FROM appointments a
       JOIN queue_stages s ON s.id = a.stage_id
       WHERE a.clinic_id = $1 AND a.practitioner_id = $2 AND s.role = 'waiting' AND a.token_no < $3
       ORDER BY a.token_no DESC LIMIT 1`,
      [clinicId, mine.rows[0].practitioner_id, mine.rows[0].token_no],
    );
    const other = waiting.rows[0];
    if (!other) return { swappedWith: null };
    await tx.query(`UPDATE appointments SET token_no = $2 WHERE id = $1`, [appointmentId, other.token_no]);
    await tx.query(`UPDATE appointments SET token_no = $2 WHERE id = $1`, [other.id, mine.rows[0].token_no]);
    return { swappedWith: other.id };
  });
}

const CARE: { procedureKey: string; delayHours: number; lang: string; body: string }[] = [
  {
    procedureKey: "extraction",
    delayHours: 3,
    lang: "mr",
    body: "भूल होईल तेव्हा गरम पेय टाळा, जोरात कुल्ला करू नका, आणि औषध जेवल्यानंतर घ्या.",
  },
  {
    procedureKey: "extraction",
    delayHours: 3,
    lang: "en",
    body: "The anaesthesia will wear off shortly. Avoid hot drinks, do not rinse hard, and take your medicine after food.",
  },
];

export async function sendCare(clinicId: string, patientId: string, procedureKey: string): Promise<{ body: string; delayHours: number }> {
  return withTenant(clinicId, async (tx) => {
    const patient = await tx.query<{ preferred_lang: string; phone_e164: string }>(
      `SELECT preferred_lang, phone_e164 FROM patients WHERE id = $1 AND clinic_id = $2`,
      [patientId, clinicId],
    );
    const lang = patient.rows[0].preferred_lang;
    for (const template of CARE.filter((item) => item.procedureKey === procedureKey)) {
      await tx.query(
        `INSERT INTO care_templates (clinic_id, procedure_key, delay_hours, lang, body)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (clinic_id, procedure_key, lang) DO NOTHING`,
        [clinicId, template.procedureKey, template.delayHours, template.lang, template.body],
      );
    }
    const chosen = await tx.query<{ body: string; delay_hours: number }>(
      `SELECT body, delay_hours FROM care_templates
       WHERE clinic_id = $1 AND procedure_key = $2 AND lang = $3`,
      [clinicId, procedureKey, lang],
    );
    const note = chosen.rows[0] ?? { body: CARE[1].body, delay_hours: 3 };
    await tx.query(
      `INSERT INTO message_outbox (clinic_id, phone_e164, channel, lang, template, body, status)
       VALUES ($1, $2, 'whatsapp', $3, $4, $5, 'queued')`,
      [clinicId, patient.rows[0].phone_e164, lang, procedureKey, note.body],
    );
    return { body: note.body, delayHours: note.delay_hours };
  });
}

export async function recordMood(clinicId: string, patientId: string, reply: string): Promise<void> {
  await withTenant(clinicId, async (tx) => {
    const patient = await tx.query<{ phone_e164: string }>(
      `SELECT phone_e164 FROM patients WHERE id = $1 AND clinic_id = $2`,
      [patientId, clinicId],
    );
    await tx.query(
      `INSERT INTO message_outbox (clinic_id, phone_e164, channel, lang, template, body, status)
       VALUES ($1, $2, 'whatsapp', 'en', 'mood', $3, 'delivered')`,
      [clinicId, patient.rows[0].phone_e164, reply],
    );
  });
}
