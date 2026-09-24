import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { auth, boot, finishDental, owner, shutdown } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/**
 * @spec FR-7.4.6, FR-7.1, FR-7.3, §10.2 — recovered rupees resolve to evidence,
 * the day's cash balances UPI, and chair-minutes are priced two ways.
 */
test("every recovered rupee resolves to evidence and the month states its break-even", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "ledger");
    const headers = auth(token);
    const { practitionerId } = await finishDental(app, token);
    const ids: string[] = [];
    let patientId = "";
    let clinicId = "";
    for (const phone of ["9811111101", "9811111102", "9811111103"]) {
      const walk = await app.inject({
        method: "POST",
        url: "/api/walk-ins",
        headers,
        payload: { phone, name: "Ledger Patient", practitionerId },
      });
      ids.push(walk.json().appointmentId as string);
      patientId = walk.json().patientId as string;
    }
    clinicId = await withSuperuser(async (client) => {
      const row = await client.query<{ clinic_id: string }>(
        `SELECT clinic_id FROM appointments WHERE id = $1`,
        [ids[0]],
      );
      const clinic = row.rows[0].clinic_id;
      const evidence = ["rcpt-1", "pay-1", "recall-1", "wo-1", "issue-1"];
      const types = ["no_show_prevented", "deposit_converted", "plan_resumed", "remake_avoided", "consumable_billed"];
      for (let i = 0; i < 3; i += 1) {
        await client.query(
          `INSERT INTO recovered_revenue (clinic_id, appointment_id, event_type, amount_paise, evidence_ref)
           VALUES ($1, $2, 'no_show_prevented', 80000, $3)`,
          [clinic, ids[i], evidence[i]],
        );
      }
      await client.query(
        `INSERT INTO recovered_revenue (clinic_id, appointment_id, event_type, amount_paise, evidence_ref)
         VALUES ($1, $2, $3, 140000, $4), ($1, $2, $5, 6000, $6)`,
        [clinic, ids[0], types[3], evidence[3], types[4], evidence[4]],
      );
      await assert.rejects(
        client.query(
          `INSERT INTO recovered_revenue (clinic_id, appointment_id, event_type, amount_paise, evidence_ref)
           VALUES ($1, $2, 'deposit_converted', 80000, 'pay-dup')`,
          [clinic, ids[1]],
        ),
      );
      return clinic;
    });

    const ledger = await app.inject({ method: "GET", url: "/api/owner", headers });
    assert.equal(ledger.statusCode, 200);
    const body = ledger.json();
    assert.equal(body.subscriptionPaise, 199900);
    assert.equal(body.breakEvenCount, 3);
    assert.equal(body.valueSource, "default");
    assert.equal(body.recoveredPaise, 80000 * 3 + 140000 + 6000);
    for (const event of body.events) {
      assert.equal(typeof event.evidenceRef, "string");
      assert.equal(event.evidenceRef.length > 0, true);
    }

    await app.inject({
      method: "POST",
      url: "/api/owner/settings",
      headers,
      payload: { valueSource: "clinic" },
    });
    const overridden = await app.inject({ method: "GET", url: "/api/owner", headers });
    assert.equal(overridden.json().valueSource, "clinic");

    await withSuperuser(async (client) => {
      await client.query(
        `INSERT INTO payment_events (provider, provider_event_id, clinic_id, payload, received_at)
         VALUES ('local', 'upi-1', $1, '{"status":"settled","amountPaise":40000}', '2026-09-24 12:00:00+05:30')`,
        [clinicId],
      );
    });
    const day = await app.inject({
      method: "POST",
      url: "/api/owner/handover",
      headers,
      payload: { day: "2026-09-24", cashPaise: 100000 },
    });
    assert.equal(day.json().upiPaise, 40000);
    assert.equal(day.json().differencePaise, 60000);

    await app.inject({
      method: "POST",
      url: "/api/owner/settings",
      headers,
      payload: { overheadPaise: 2600000 },
    });
    await app.inject({
      method: "POST",
      url: "/api/owner/spans",
      headers,
      payload: { practitionerId, sessionType: "clinic", minutes: 120 },
    });
    const margin = await app.inject({ method: "GET", url: "/api/owner", headers });
    const chairs = margin.json().chairs;
    assert.equal(chairs.availableMinutes > chairs.utilisedMinutes, true);
    assert.equal(chairs.perUtilisedMinutePaise > chairs.perAvailableMinutePaise, true);

    await withSuperuser(async (client) => {
      await client.query(`UPDATE patients SET preferred_lang = 'mr' WHERE id = $1`, [patientId]);
    });
    const care = await app.inject({
      method: "POST",
      url: "/api/care",
      headers,
      payload: { patientId, procedureKey: "extraction" },
    });
    assert.equal(care.json().delayHours, 3);
    assert.match(care.json().body, /औषध/);

    const before = await withSuperuser(async (client) => {
      const row = await client.query(`SELECT count(*)::int AS n FROM vault_notes`);
      return row.rows[0].n as number;
    });
    await app.inject({
      method: "POST",
      url: "/api/care/mood",
      headers,
      payload: { patientId, reply: "okay" },
    });
    const after = await withSuperuser(async (client) => {
      const row = await client.query(`SELECT count(*)::int AS n FROM vault_notes`);
      return row.rows[0].n as number;
    });
    assert.equal(after, before);

    const runbook = readFileSync("docs/evidence/m5/breach-runbook.md", "utf8");
    assert.match(runbook, /statutory window/);
    const certificate = readFileSync("docs/evidence/m5/abdm-certification.md", "utf8");
    assert.match(certificate, /NOT GRANTED/);
  } finally {
    await shutdown(app);
  }
});
