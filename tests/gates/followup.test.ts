import assert from "node:assert/strict";
import { test } from "node:test";
import { auth, boot, finishDental, otp, owner, shutdown } from "./api.ts";
import { withSuperuser } from "./harness.ts";

/** @spec BR-01, FR-1.1.3 — two clinics can charge different follow-up fees on the same day. */
test("follow-up fee follows each clinic's own window", async () => {
  const app = await boot();
  try {
    const wide = await owner(app, "wide");
    const narrow = await owner(app, "narrow");
    const wideReady = await finishDental(app, wide);
    const narrowReady = await finishDental(app, narrow);
    await app.inject({
      method: "PATCH",
      url: "/api/onboarding/fees",
      headers: auth(wide),
      payload: { standardFeePaise: 50000, followupDays: 15 },
    });
    await app.inject({
      method: "PATCH",
      url: "/api/onboarding/fees",
      headers: auth(narrow),
      payload: { standardFeePaise: 50000, followupDays: 3 },
    });
    const day = "2026-09-01T10:00:00+05:30";
    for (const [slug, ready, token] of [
      ["wide", wideReady, wide],
      ["narrow", narrowReady, narrow],
    ] as const) {
      const patient = await otp(app, `${slug}.localhost`, "9822004440", "Repeat");
      const first = await app.inject({
        method: "POST",
        url: "/api/portal/bookings",
        headers: { host: `${slug}.localhost`, ...auth(patient) },
        payload: {
          practitionerId: ready.practitionerId,
          start: "2026-09-20T10:00:00+05:30",
          end: "2026-09-20T10:30:00+05:30",
          mode: "video",
        },
      });
      await app.inject({
        method: "POST",
        url: `/api/appointments/${first.json().appointmentId}/attend`,
        headers: auth(token),
      });
      await withSuperuser(async (client) => {
        await client.query(
          `UPDATE appointments SET attended_at = $2::timestamptz,
             during = tstzrange($2::timestamptz, $2::timestamptz + interval '30 minutes', '[)')
           WHERE id = $1`,
          [first.json().appointmentId, day],
        );
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/portal/bookings",
        headers: { host: `${slug}.localhost`, ...auth(patient) },
        payload: {
          practitionerId: ready.practitionerId,
          start: "2026-09-08T10:00:00+05:30",
          end: "2026-09-08T10:30:00+05:30",
          mode: "video",
        },
      });
      const fee = second.json().feePaise as number;
      if (slug === "wide") assert.equal(fee, 0);
      if (slug === "narrow") assert.equal(fee, 50000);
    }
  } finally {
    await shutdown(app);
  }
});
