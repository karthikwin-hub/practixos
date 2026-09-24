import assert from "node:assert/strict";
import { test } from "node:test";
import { auth, boot, finishDental, otp, owner, shutdown, webhook } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/**
 * @spec FR-1.1, FR-1.1.1, FR-1.2, FR-1.4, FR-1.5, BR-04 — book, pay by webhook, Marathi confirmation.
 */
test("a patient books, pays and receives a Marathi confirmation", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "sharma", "mental_health");
    const { practitionerId } = await finishDental(app, token);
    const host = "sharma.localhost";
    const profile = await app.inject({
      method: "GET",
      url: "/api/portal/profile?lang=mr",
      headers: { host },
    });
    assert.equal(profile.statusCode, 200);
    assert.match(profile.json().policy, /२४ तासांपूर्वी/);
    const other = await app.inject({
      method: "GET",
      url: "/api/portal/profile",
      headers: { host: "other.localhost" },
    });
    assert.equal(other.statusCode, 404);

    const patient = await otp(app, host, "9822001110", "Asha", "mr");
    const slots = await app.inject({
      method: "GET",
      url: `/api/portal/slots?practitionerId=${practitionerId}&day=2026-09-28&mode=clinic`,
      headers: { host },
    });
    assert.equal(slots.statusCode, 200);
    const slot = slots.json()[0] as { start: string; end: string };
    const booked = await app.inject({
      method: "POST",
      url: "/api/portal/bookings",
      headers: { host, ...auth(patient) },
      payload: { practitionerId, start: slot.start, end: slot.end, mode: "clinic", lang: "mr" },
    });
    assert.equal(booked.statusCode, 200);
    const body = booked.json();
    assert.match(body.policy, /२४ तासांपूर्वी/);
    assert.equal(body.paid, false);
    assert.match(body.intent.uri, /^upi:\/\/pay/);

    const lied = await app.inject({
      method: "POST",
      url: `/api/portal/bookings/${body.appointmentId}/client-paid`,
    });
    assert.equal(lied.statusCode, 202);
    assert.equal(lied.json().accepted, false);

    const event = {
      provider: "local",
      providerEventId: "evt-1",
      appointmentId: body.appointmentId,
      clinicId: (await withSuperuser(async (client) => {
        const res = await client.query(`SELECT id FROM clinics WHERE slug = 'sharma'`);
        return res.rows[0].id as string;
      })),
    };
    const first = await webhook(app, event);
    const second = await webhook(app, event);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().duplicate, true);

    const messages = await withSuperuser(async (client) => {
      return client.query<{ body: string; receipt_id: string; lang: string; channel: string }>(
        `SELECT body, receipt_id, lang, channel FROM message_outbox
         WHERE template = 'confirmation' AND lang = 'mr'`,
      );
    });
    assert.equal(messages.rowCount, 1);
    assert.match(messages.rows[0].body, /नमस्कार/);
    assert.ok(messages.rows[0].receipt_id);
    assert.equal(messages.rows[0].channel, "whatsapp");

    const deposits = await withSuperuser(async (client) => {
      return client.query(`SELECT status FROM deposits WHERE appointment_id = $1`, [body.appointmentId]);
    });
    assert.equal(deposits.rows[0].status, "settled");

    const soonStart = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const soonEnd = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const soon = await app.inject({
      method: "POST",
      url: "/api/portal/bookings",
      headers: { host, ...auth(patient) },
      payload: { practitionerId, start: soonStart, end: soonEnd, mode: "clinic", lang: "mr" },
    });
    const soonId = soon.json().appointmentId as string;
    await webhook(app, { ...event, providerEventId: "evt-soon", appointmentId: soonId });
    const forfeited = await app.inject({
      method: "POST",
      url: `/api/portal/bookings/${soonId}/cancel?lang=mr`,
      headers: { host },
    });
    assert.equal(forfeited.json().instruction, "forfeit");

    const later = await app.inject({
      method: "POST",
      url: "/api/portal/bookings",
      headers: { host, ...auth(patient) },
      payload: {
        practitionerId,
        start: "2026-10-20T10:00:00+05:30",
        end: "2026-10-20T10:30:00+05:30",
        mode: "clinic",
        lang: "mr",
      },
    });
    const laterId = later.json().appointmentId as string;
    await webhook(app, { ...event, providerEventId: "evt-later", appointmentId: laterId });
    const refunded = await app.inject({
      method: "POST",
      url: `/api/portal/bookings/${laterId}/cancel?lang=mr`,
      headers: { host },
    });
    assert.equal(refunded.json().instruction, "refund");
    assert.equal(refunded.json().offerVideo, true);
    assert.match(refunded.json().videoOffer, /व्हिडिओ/);
  } finally {
    await shutdown(app);
  }
});
