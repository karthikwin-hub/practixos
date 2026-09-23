import assert from "node:assert/strict";
import { test } from "node:test";
import { signBody } from "../src/modules/billing/index.ts";
import { auth, boot, finishDental, owner, shutdown } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/**
 * @spec FR-4.1, FR-4.2, FR-4.3, FR-4.4, FR-4.5, FR-4.6, FR-1.1.5, FR-6.1, FR-6.2, FR-6.3, FR-6.4, FR-6.5, BR-03 — charting tooth 16 settles a consultant visit.
 */
test("charting tooth 16 produces a plan, a lab order and a settlement", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "rao");
    const { practitionerId } = await finishDental(app, token);
    const headers = auth(token);
    await app.inject({
      method: "PATCH",
      url: "/api/onboarding/profile",
      headers,
      payload: { displayName: "Rao Dental", registrationNo: "A-1", address: "Pune" },
    });
    const neighbour = await owner(app, "neighbour");
    await finishDental(app, neighbour);
    const invited = await app.inject({
      method: "POST",
      url: "/api/memberships",
      headers,
      payload: {
        email: "mds@rao.test",
        password: "correct horse battery",
        fullName: "Dr MDS",
        practitionerId,
        splitBps: 6000,
      },
    });
    assert.equal(invited.statusCode, 200);
    const neighbourState = await app.inject({ method: "GET", url: "/api/onboarding", headers: auth(neighbour) });
    const neighbourPractitioner = neighbourState.json().practitioners[0].id as string;
    const second = await app.inject({
      method: "POST",
      url: "/api/memberships",
      headers: auth(neighbour),
      payload: {
        email: "mds@rao.test",
        password: "correct horse battery",
        fullName: "Dr MDS",
        practitionerId: neighbourPractitioner,
      },
    });
    assert.equal(second.statusCode, 200);

    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { email: "mds@rao.test", password: "correct horse battery" },
    });
    assert.equal(session.statusCode, 200);
    const memberships = session.json().memberships as { clinicId: string; displayName: string }[];
    assert.equal(memberships.length, 2);
    assert.equal(JSON.stringify(session.json()).includes("Secret Patient"), false);
    const raoClinic = memberships.find((row) => row.displayName === "Rao Dental");
    assert.ok(raoClinic);
    const switched = await app.inject({
      method: "POST",
      url: "/api/session/switch",
      headers: auth(session.json().token as string),
      payload: { clinicId: raoClinic.clinicId },
    });
    assert.equal(switched.statusCode, 200);
    const consultant = auth(switched.json().token as string);

    const walkIn = await app.inject({
      method: "POST",
      url: "/api/walk-ins",
      headers,
      payload: { phone: "9822099999", name: "Secret Patient", practitionerId },
    });
    assert.equal(walkIn.statusCode, 200);
    const patientId = walkIn.json().patientId as string;
    const appointmentId = walkIn.json().appointmentId as string;

    const counselling = await owner(app, "counsel", "mental_health");
    const blocked = await app.inject({
      method: "GET",
      url: "/api/odontogram",
      headers: auth(counselling),
    });
    assert.equal(blocked.statusCode, 404);

    const chart = await app.inject({
      method: "POST",
      url: `/api/chart/${patientId}/teeth`,
      headers,
      payload: { tooth: 16, state: "rct" },
    });
    assert.equal(chart.statusCode, 200);
    const plan = await app.inject({
      method: "POST",
      url: `/api/chart/${patientId}/plans`,
      headers,
      payload: { tooth: 16 },
    });
    assert.equal(plan.statusCode, 200);
    assert.equal(plan.json().sittings, 3);
    const recorded = await app.inject({ method: "GET", url: `/api/chart/${patientId}`, headers });
    const tooth = recorded.json().teeth[0];
    assert.equal(tooth.label, "RCT");
    assert.equal(tooth.colour, "#E8952A");
    assert.equal(tooth.pattern, "cross");
    const names = recorded.json().steps.map((step: { name: string; needs_lab: boolean }) => step.name);
    assert.deepEqual(names, [
      "Biomechanical prep & pulpectomy",
      "Obturation & composite core",
      "Zirconia crown fixation",
    ]);
    assert.equal(recorded.json().steps[2].needs_lab, true);

    const incomplete = await app.inject({
      method: "POST",
      url: "/api/lab-orders",
      headers,
      payload: { patientId, appointmentId, typeKey: "restoration", fields: { tooth: "16" } },
    });
    assert.equal(incomplete.statusCode, 200);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/lab-orders/${incomplete.json().id}/dispatch`,
      headers,
    });
    assert.equal(rejected.statusCode, 400);

    const order = await app.inject({
      method: "POST",
      url: "/api/lab-orders",
      headers,
      payload: {
        patientId,
        appointmentId,
        typeKey: "restoration",
        lab: "City Lab",
        dueOn: "2026-10-12",
        fields: { tooth: "16", restoration: "Monolithic zirconia", shade: "A2" },
      },
    });
    const dispatched = await app.inject({
      method: "POST",
      url: `/api/lab-orders/${order.json().id}/dispatch`,
      headers,
    });
    assert.equal(dispatched.statusCode, 200);
    const ledger = await withSuperuser(async (client) => {
      return client.query<{ event_type: string; amount_paise: string; evidence_ref: string }>(
        `SELECT event_type, amount_paise, evidence_ref FROM recovered_revenue WHERE event_type = 'remake_avoided'`,
      );
    });
    assert.equal(ledger.rowCount, 1);
    assert.equal(ledger.rows[0].evidence_ref, order.json().id);
    assert.equal(Number(ledger.rows[0].amount_paise), 140000);
    const clinicId = raoClinic.clinicId;
    await withSuperuser(async (client) => {
      await client.query(
        `INSERT INTO recovered_revenue (clinic_id, appointment_id, event_type, amount_paise, evidence_ref)
         VALUES ($1,$2,'deposit_converted',50000,'dep-beside-remake')`,
        [clinicId, appointmentId],
      );
    });

    const line = await app.inject({
      method: "POST",
      url: "/api/fee-lines",
      headers: consultant,
      payload: { appointmentId, practitionerId, grossPaise: 900000, labPaise: 140000, consumablePaise: 25000 },
    });
    assert.equal(line.statusCode, 200);
    assert.equal(line.json().netPaise, 441000);
    const other = await app.inject({
      method: "POST",
      url: "/api/fee-lines",
      headers: consultant,
      payload: { appointmentId, practitionerId, grossPaise: 100000, labPaise: 0, consumablePaise: 0 },
    });
    const settlement = await app.inject({
      method: "POST",
      url: "/api/settlements",
      headers: consultant,
      payload: { lineIds: [line.json().id, other.json().id] },
    });
    assert.equal(settlement.statusCode, 200);
    const settlementId = settlement.json().id as string;
    const dispute = await app.inject({
      method: "POST",
      url: `/api/settlements/${settlementId}/respond`,
      headers,
      payload: { lineId: other.json().id, action: "dispute", reason: "consumable query" },
    });
    assert.equal(dispute.statusCode, 200);
    const approve = await app.inject({
      method: "POST",
      url: `/api/settlements/${settlementId}/respond`,
      headers,
      payload: { lineId: line.json().id, action: "approve" },
    });
    assert.equal(approve.statusCode, 200);
    const paid = await app.inject({
      method: "POST",
      url: `/api/settlements/${settlementId}/paid`,
      headers,
      payload: { lineIds: [line.json().id] },
    });
    assert.equal(paid.statusCode, 200);
    const lines = await app.inject({
      method: "GET",
      url: `/api/fee-lines?practitionerId=${practitionerId}`,
      headers: consultant,
    });
    const byId = new Map(lines.json().map((row: { id: string; status: string }) => [row.id, row.status]));
    assert.equal(byId.get(line.json().id), "paid");
    assert.equal(byId.get(other.json().id), "disputed");
    const audits = await withSuperuser(async (client) => {
      return client.query(`SELECT action FROM audit_log WHERE action LIKE 'settlement.%'`);
    });
    assert.ok((audits.rowCount ?? 0) >= 3);

    const board = await itineraryOf(app, session.json().token as string);
    assert.equal(JSON.stringify(board).includes("Secret Patient"), false);
    assert.ok(board.some((row) => row.clinic === "Rao Dental"));

    const raw = JSON.stringify({
      provider: "google",
      providerEventId: "evt-personal",
      clinicId,
      practitionerId,
      start: "2026-09-28T10:00:00+05:30",
      end: "2026-09-28T11:00:00+05:30",
      title: "Dentist anniversary",
    });
    const inbound = await app.inject({
      method: "POST",
      url: "/api/calendar/webhook",
      headers: { "content-type": "application/json", "x-practix-signature": signBody("m1-test-secret", raw) },
      payload: raw,
    });
    assert.equal(inbound.statusCode, 200);
    const leaked = await withSuperuser(async (client) => {
      return client.query(
        `SELECT count(*)::int AS n FROM (
           SELECT full_name AS t FROM patients
           UNION ALL SELECT fee_reason FROM appointments
           UNION ALL SELECT body FROM message_outbox
           UNION ALL SELECT body FROM calendar_outbound
         ) rows WHERE t ILIKE '%anniversary%'`,
      );
    });
    assert.equal(leaked.rows[0].n, 0);
    const slots = await app.inject({
      method: "GET",
      url: `/api/portal/slots?practitionerId=${practitionerId}&day=2026-09-28`,
      headers: { host: "rao.localhost" },
    });
    const starts = slots.json().map((slot: { start: string }) => slot.start);
    assert.equal(starts.some((start: string) => start.includes("T10:00:00")), false);
    const pushed = await app.inject({
      method: "POST",
      url: "/api/calendar/push",
      headers,
      payload: { appointmentId },
    });
    assert.equal(pushed.statusCode, 200);

    const printed = await app.inject({
      method: "POST",
      url: `/api/patients/${patientId}/documents`,
      headers,
      payload: { kind: "prescription" },
    });
    assert.equal(printed.statusCode, 200);
    assert.match(printed.json().body, /Rao Dental/);
    assert.equal(printed.json().registrationNo, "A-1");
    const same = await withSuperuser(async (client) => {
      return client.query<{ body: string }>(
        `SELECT body FROM message_outbox WHERE template = 'prescription' ORDER BY created_at DESC LIMIT 1`,
      );
    });
    assert.equal(same.rows[0].body, printed.json().body);
  } finally {
    await shutdown(app);
  }
});

async function itineraryOf(
  app: { inject: (opts: { method: string; url: string; headers?: Record<string, string> }) => Promise<{ json: () => { clinic: string }[] }> },
  token: string,
): Promise<{ clinic: string }[]> {
  const res = await app.inject({ method: "GET", url: "/api/itinerary", headers: auth(token) });
  return res.json();
}
