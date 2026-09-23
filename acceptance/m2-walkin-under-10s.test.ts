import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeQueue, unsubscribeQueue } from "../src/db/tenant.ts";
import { auth, boot, finishDental, owner, shutdown } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/** @spec FR-2.2 — walk-in needs a mobile number and a name, and a per-practitioner token. */
test("a receptionist registers a walk-in in under 10 seconds", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "floor");
    const headers = auth(token);
    const { practitionerId } = await finishDental(app, token);
    const started = Date.now();
    const created = await app.inject({
      method: "POST",
      url: "/api/walk-ins",
      headers,
      payload: { phone: "9822007770", name: "Walk In", practitionerId },
    });
    assert.equal(created.statusCode, 200);
    assert.ok(Date.now() - started < 10_000);
    assert.equal(created.json().tokenNo, 1);
    const second = await app.inject({
      method: "POST",
      url: "/api/walk-ins",
      headers,
      payload: { phone: "9822007770", name: "Walk In", practitionerId },
    });
    assert.equal(second.json().tokenNo, 2);
  } finally {
    await shutdown(app);
  }
});

/** @spec FR-2.1, FR-2.4, FR-2.3, BR-05, FR-3.1, FR-3.2 — queue, unmask, vitals, alerts. */
test("the floor moves a card, masks the phone, and records vitals", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "desk");
    const headers = auth(token);
    const { practitionerId } = await finishDental(app, token);
    const created = await app.inject({
      method: "POST",
      url: "/api/walk-ins",
      headers,
      payload: { phone: "9822008880", name: "Nita", practitionerId },
    });
    const { appointmentId, patientId } = created.json();
    const board = await app.inject({ method: "GET", url: "/api/queue", headers });
    const stages = board.json().stages as { id: string; role: string; label_key: string }[];
    assert.deepEqual(stages.map((stage) => stage.label_key), [
      "stageExpected", "stageWaiting", "stageConsult", "stageBilling",
    ]);
    const masked = await app.inject({ method: "GET", url: `/api/patients/${patientId}`, headers });
    assert.match(masked.json().phoneMasked, /•••/);
    assert.equal(JSON.stringify(masked.json()).includes("9822008880"), false);

    const clinicId = await withSuperuser(async (client) => {
      const res = await client.query(`SELECT id FROM clinics WHERE slug = 'desk'`);
      return res.rows[0].id as string;
    });
    await withSuperuser(async (client) => {
      await client.query(
        `INSERT INTO staff_users (clinic_id, email, full_name, role, password_hash, password_salt)
         VALUES ($1,'desk@desk.test','Front','reception','x', decode('00','hex'))`,
        [clinicId],
      );
      await client.query(
        `INSERT INTO staff_sessions (token, clinic_id, user_id, expires_at)
         SELECT 'reception-token', clinic_id, id, now() + interval '1 day' FROM staff_users WHERE email = 'desk@desk.test'`,
      );
    });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/patients/${patientId}/unmask`,
      headers: auth("reception-token"),
    });
    assert.equal(blocked.statusCode, 403);
    const opened = await app.inject({
      method: "POST",
      url: `/api/patients/${patientId}/unmask`,
      headers,
    });
    assert.equal(opened.json().phone, "+919822008880");
    const audit = await withSuperuser(async (client) => {
      return client.query(`SELECT action FROM audit_log WHERE action = 'unmask' AND subject = $1`, [patientId]);
    });
    assert.equal(audit.rowCount, 1);

    await app.inject({
      method: "PUT",
      url: `/api/patients/${patientId}/alerts`,
      headers,
      payload: { alerts: ["penicillin"] },
    });
    const vitals = await app.inject({
      method: "POST",
      url: "/api/vitals",
      headers,
      payload: { patientId, appointmentId, bpSystolic: 120, bpDiastolic: 80, pulse: 72, sugar: 90, weightG: 60000 },
    });
    assert.equal(vitals.statusCode, 200);

    const consult = stages.find((stage) => stage.role === "in_service");
    const heard = new Promise<string>((resolve) => {
      const fn = (raw: string) => {
        unsubscribeQueue(fn);
        resolve(raw);
      };
      void subscribeQueue(fn);
    });
    const moved = await app.inject({
      method: "POST",
      url: `/api/queue/${appointmentId}/stage`,
      headers,
      payload: { stageId: consult?.id },
    });
    assert.equal(moved.statusCode, 200);
    const message = await heard;
    assert.match(message, /stage/);
    const after = await app.inject({ method: "GET", url: "/api/queue", headers });
    const card = after.json().cards.find((item: { id: string }) => item.id === appointmentId);
    assert.deepEqual(card.alerts, ["penicillin"]);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers,
      payload: {
        ops: [{
          id: "note-1",
          kind: "clinical_note",
          updatedAt: new Date().toISOString(),
          body: { text: "do not merge" },
        }],
      },
    });
    assert.equal(conflict.json().conflicts[0].reason, "clinical notes are not auto-merged");
  } finally {
    await shutdown(app);
  }
});
