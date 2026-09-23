import assert from "node:assert/strict";
import { test } from "node:test";
import { auth, boot, finishDental, otp, owner, shutdown } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/** @spec BR-02 — concurrent bookings on one chair produce one appointment. */
test("concurrent booking attempts on one chair produce exactly one appointment", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "chairs");
    const { practitionerId } = await finishDental(app, token);
    const host = "chairs.localhost";
    const patients = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(async (n) => {
      const phone = `980000000${n}`;
      return otp(app, host, phone, `Patient ${n}`);
    }));
    const start = "2026-09-28T11:00:00+05:30";
    const end = "2026-09-28T11:30:00+05:30";
    const results = await Promise.all(patients.map((patient) => app.inject({
      method: "POST",
      url: "/api/portal/bookings",
      headers: { host, ...auth(patient) },
      payload: { practitionerId, start, end, mode: "clinic", lang: "en" },
    })));
    const ok = results.filter((res) => res.statusCode === 200);
    assert.equal(ok.length, 1);
    const count = await withSuperuser(async (client) => {
      const res = await client.query(`SELECT count(*)::int AS n FROM appointments WHERE state <> 'cancelled'`);
      return res.rows[0].n as number;
    });
    assert.equal(count, 1);
  } finally {
    await shutdown(app);
  }
});
