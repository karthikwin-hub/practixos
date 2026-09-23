import assert from "node:assert/strict";
import { test } from "node:test";
import { localMessaging } from "../src/modules/messaging/index.ts";
import { materialiseRecalls } from "../src/modules/vertical/index.ts";
import { auth, boot, finishDental, owner, shutdown } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/**
 * @spec §4.6.1, §4.6.2, §4.6.3, §4.6.4, §4.6.5 — an eye clinic stands up from configuration.
 */
test("an ophthalmology tenant is provisioned without a code change", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "drishti", "ophthalmology");
    const headers = auth(token);
    const { practitionerId } = await finishDental(app, token);
    const board = await app.inject({ method: "GET", url: "/api/queue", headers });
    const dilation = board.json().stages.find((stage: { label_key: string }) => stage.label_key === "stageDilation");
    assert.equal(dilation.role, "waiting");
    assert.equal(dilation.dwell_alert_mins, 20);
    const chart = await app.inject({ method: "GET", url: "/api/odontogram", headers });
    assert.equal(chart.statusCode, 404);

    const walkIn = await app.inject({
      method: "POST",
      url: "/api/walk-ins",
      headers,
      payload: { phone: "9822010101", name: "Eye Patient", practitionerId },
    });
    assert.equal(walkIn.statusCode, 200);
    const patientId = walkIn.json().patientId as string;
    const appointmentId = walkIn.json().appointmentId as string;
    const clinic = await withSuperuser(async (client) => {
      const row = await client.query<{ clinic_id: string }>(
        `SELECT clinic_id FROM appointments WHERE id = $1`,
        [appointmentId],
      );
      await client.query(
        `UPDATE appointments SET state = 'done', attended_at = now() - interval '400 days' WHERE id = $1`,
        [appointmentId],
      );
      return row.rows[0].clinic_id;
    });

    const incomplete = await app.inject({
      method: "POST",
      url: "/api/lab-orders",
      headers,
      payload: { patientId, appointmentId, typeKey: "optical", fields: {} },
    });
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
        typeKey: "optical",
        dueOn: "2026-10-01",
        fields: { prescription: "-1.25", due: "2026-10-01" },
      },
    });
    const dispatched = await app.inject({
      method: "POST",
      url: `/api/lab-orders/${order.json().id}/dispatch`,
      headers,
    });
    assert.equal(dispatched.statusCode, 200);

    const messaging = localMessaging();
    assert.equal(await materialiseRecalls(clinic, messaging), 1);
    assert.equal(await materialiseRecalls(clinic, messaging), 0);
    const recalls = await withSuperuser(async (client) => {
      return client.query(`SELECT id FROM recalls WHERE clinic_id = $1`, [clinic]);
    });
    assert.equal(recalls.rowCount, 1);
    const messages = await withSuperuser(async (client) => {
      return client.query(`SELECT count(*)::int AS n FROM message_outbox WHERE template = 'refraction'`);
    });
    assert.equal(messages.rows[0].n, 1);

    const follow = await app.inject({
      method: "POST",
      url: "/api/walk-ins",
      headers,
      payload: { phone: "9822010101", name: "Eye Patient", practitionerId },
    });
    const resumed = await withSuperuser(async (client) => {
      return client.query<{ evidence_ref: string }>(
        `SELECT evidence_ref FROM recovered_revenue WHERE event_type = 'plan_resumed'`,
      );
    });
    assert.equal(resumed.rowCount, 1);
    assert.equal(resumed.rows[0].evidence_ref, recalls.rows[0].id);

    const definition = await app.inject({
      method: "POST",
      url: "/api/packages",
      headers,
      payload: { name: "Cataract review", sessions: 1, pricePaise: 500000 },
    });
    const purchased = await app.inject({
      method: "POST",
      url: "/api/packages/purchase",
      headers,
      payload: { patientId, definitionId: definition.json().id },
    });
    const firstRedeem = await app.inject({
      method: "POST",
      url: `/api/packages/${purchased.json().id}/redeem`,
      headers,
      payload: { appointmentId },
    });
    assert.equal(firstRedeem.statusCode, 200);
    const secondRedeem = await app.inject({
      method: "POST",
      url: `/api/packages/${purchased.json().id}/redeem`,
      headers,
      payload: { appointmentId: follow.json().appointmentId },
    });
    assert.equal(secondRedeem.statusCode, 409);

    const item = await app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers,
      payload: { name: "Lens solution" },
    });
    const early = await app.inject({
      method: "POST",
      url: "/api/inventory/batches",
      headers,
      payload: { itemId: item.json().id, batchNo: "EARLY", expiresOn: "2026-09-24", qty: 1 },
    });
    await app.inject({
      method: "POST",
      url: "/api/inventory/batches",
      headers,
      payload: { itemId: item.json().id, batchNo: "LATER", expiresOn: "2027-01-01", qty: 1 },
    });
    assert.equal(await materialiseRecalls(clinic, messaging), 0);
    const issued = await app.inject({
      method: "POST",
      url: "/api/inventory/issues",
      headers,
      payload: { itemId: item.json().id, appointmentId: follow.json().appointmentId, amountPaise: 15000 },
    });
    assert.equal(issued.json().batchId, early.json().id);
    const billed = await withSuperuser(async (client) => {
      return client.query(
        `SELECT evidence_ref FROM recovered_revenue WHERE event_type = 'consumable_billed'`,
      );
    });
    assert.equal(billed.rows[0].evidence_ref, issued.json().issueId);
    assert.equal(await materialiseRecalls(clinic, messaging), 0);
    const notices = await withSuperuser(async (client) => {
      return client.query(`SELECT count(*)::int AS n FROM message_outbox WHERE template = 'expiry'`);
    });
    assert.equal(notices.rows[0].n, 1);

    const child = await app.inject({
      method: "POST",
      url: "/api/dependants",
      headers,
      payload: { guardianId: patientId, name: "Young Patient", phone: "9822010101" },
    });
    assert.equal(child.statusCode, 200);
    const relation = await app.inject({
      method: "POST",
      url: "/api/relationships",
      headers,
      payload: { guardianId: patientId, dependantId: child.json().id, relationship: "parent" },
    });
    const denied = await app.inject({
      method: "POST",
      url: "/api/consents",
      headers,
      payload: { guardianId: patientId, dependantId: child.json().id },
    });
    assert.equal(denied.statusCode, 403);
    await app.inject({
      method: "PATCH",
      url: `/api/relationships/${relation.json().id}`,
      headers,
      payload: { mayConsent: true },
    });
    const consent = await app.inject({
      method: "POST",
      url: "/api/consents",
      headers,
      payload: { guardianId: patientId, dependantId: child.json().id },
    });
    assert.equal(consent.statusCode, 200);
    const snapshot = await withSuperuser(async (client) => {
      return client.query<{ snapshot: { may_consent: boolean; relationship: string } }>(
        `SELECT snapshot FROM proxy_consents WHERE id = $1`,
        [consent.json().id],
      );
    });
    assert.equal(snapshot.rows[0].snapshot.may_consent, true);
    assert.equal(snapshot.rows[0].snapshot.relationship, "parent");
    await app.inject({
      method: "PATCH",
      url: `/api/relationships/${relation.json().id}`,
      headers,
      payload: { validUntil: "2020-01-01" },
    });
    const expired = await app.inject({
      method: "POST",
      url: "/api/relationships/book",
      headers,
      payload: { guardianId: patientId, dependantId: child.json().id },
    });
    assert.equal(expired.statusCode, 403);
  } finally {
    await shutdown(app);
  }
});
