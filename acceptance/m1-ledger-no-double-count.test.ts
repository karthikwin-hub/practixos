import assert from "node:assert/strict";
import { test } from "node:test";
import { auth, boot, finishDental, otp, owner, shutdown, webhook } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/**
 * @spec FR-7.4, FR-7.4.1, FR-7.4.2, FR-7.4.3, FR-7.4.4, FR-7.4.5 — one attribution, append-only.
 */
test("a deposit-secured attended visit writes one ledger row and a late one writes none", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "ledger", "mental_health");
    const headers = auth(token);
    const { practitionerId } = await finishDental(app, token);
    const host = "ledger.localhost";
    const patient = await otp(app, host, "9822002220", "Meera", "mr");
    const booked = await app.inject({
      method: "POST",
      url: "/api/portal/bookings",
      headers: { host, ...auth(patient) },
      payload: {
        practitionerId,
        start: "2026-09-28T12:00:00+05:30",
        end: "2026-09-28T12:30:00+05:30",
        mode: "clinic",
        lang: "mr",
      },
    });
    const appointmentId = booked.json().appointmentId as string;
    const clinicId = await withSuperuser(async (client) => {
      const res = await client.query(`SELECT id FROM clinics WHERE slug = 'ledger'`);
      return res.rows[0].id as string;
    });
    const settled = await webhook(app, {
      provider: "local",
      providerEventId: "evt-ledger",
      appointmentId,
      clinicId,
    });
    assert.equal(settled.statusCode, 200);
    await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/reminder`, headers });
    await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/confirm`, headers });
    const attended = await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/attend`, headers });
    assert.equal(attended.statusCode, 200);
    const rows = await withSuperuser(async (client) => {
      return client.query<{ event_type: string; evidence_ref: string; amount_paise: string }>(
        `SELECT event_type, evidence_ref, amount_paise FROM recovered_revenue WHERE appointment_id = $1`,
        [appointmentId],
      );
    });
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].event_type, "deposit_converted");
    assert.equal(rows.rows[0].evidence_ref, "evt-ledger");
    assert.ok(rows.rows[0].evidence_ref);

    const ledgerId = await withSuperuser(async (client) => {
      const res = await client.query(`SELECT id FROM recovered_revenue WHERE appointment_id = $1`, [appointmentId]);
      return res.rows[0].id as string;
    });
    const corrected = await app.inject({
      method: "POST",
      url: `/api/ledger/${ledgerId}/correct`,
      headers,
      payload: { reason: "disputed" },
    });
    assert.equal(corrected.statusCode, 200);
    const denied = await withSuperuser(async (client) => {
      await client.query(`SET ROLE app_rw`);
      try {
        await client.query(`UPDATE recovered_revenue SET amount_paise = 1 WHERE id = $1`, [ledgerId]);
        return "updated";
      } catch (err) {
        return (err as { message: string }).message;
      } finally {
        await client.query(`RESET ROLE`);
      }
    });
    assert.match(denied, /permission denied/);
    const edited = await withSuperuser(async (client) => {
      try {
        await client.query(`UPDATE recovered_revenue SET amount_paise = 1 WHERE id = $1`, [ledgerId]);
        return "updated";
      } catch (err) {
        return (err as { message: string }).message;
      }
    });
    assert.match(edited, /append-only/);

    const lateToken = await owner(app, "late", "mental_health");
    const lateReady = await finishDental(app, lateToken);
    const latePatient = await otp(app, "late.localhost", "9822003330", "Late");
    const lateBooked = await app.inject({
      method: "POST",
      url: "/api/portal/bookings",
      headers: { host: "late.localhost", ...auth(latePatient) },
      payload: {
        practitionerId: lateReady.practitionerId,
        start: "2026-09-28T15:00:00+05:30",
        end: "2026-09-28T15:30:00+05:30",
        mode: "clinic",
      },
    });
    const lateId = lateBooked.json().appointmentId as string;
    const lateClinic = await withSuperuser(async (client) => {
      const res = await client.query(`SELECT id FROM clinics WHERE slug = 'late'`);
      return res.rows[0].id as string;
    });
    await webhook(app, {
      provider: "local",
      providerEventId: "evt-late",
      appointmentId: lateId,
      clinicId: lateClinic,
    });
    await withSuperuser(async (client) => {
      await client.query(
        `UPDATE deposits SET settled_at = now() - interval '10 days' WHERE appointment_id = $1`,
        [lateId],
      );
    });
    await app.inject({
      method: "POST",
      url: `/api/appointments/${lateId}/attend`,
      headers: auth(lateToken),
    });
    const lateRows = await withSuperuser(async (client) => {
      return client.query(`SELECT 1 FROM recovered_revenue WHERE appointment_id = $1`, [lateId]);
    });
    assert.equal(lateRows.rowCount, 0);
  } finally {
    await shutdown(app);
  }
});
