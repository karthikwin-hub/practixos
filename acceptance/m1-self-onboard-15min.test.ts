import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { auth, boot, owner, shutdown } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/** @spec FR-1.6, FR-1.1.6, FR-1.1.3, FR-1.1.4 — resumable wizard to a live test booking. */
test("an owner reaches a live test booking in under 15 minutes and can leave", async () => {
  const started = Date.now();
  const app = await boot();
  try {
    const token = await owner(app, "newclinic");
    const headers = auth(token);
    await app.inject({
      method: "PATCH",
      url: "/api/onboarding/languages",
      headers,
      payload: { skip: true },
    });
    await app.inject({
      method: "PATCH",
      url: "/api/onboarding/practitioners",
      headers,
      payload: { practitioners: [{ fullName: "Dr Sharma" }] },
    });
    const resumed = await app.inject({ method: "GET", url: "/api/onboarding", headers });
    assert.equal(resumed.json().practitioners[0].full_name, "Dr Sharma");
    assert.equal(resumed.json().clinic.wizard_draft.languages.skipped, true);
    await app.inject({
      method: "PATCH",
      url: "/api/onboarding/languages",
      headers,
      payload: { languages: ["en", "mr"] },
    });
    await app.inject({
      method: "PATCH",
      url: "/api/onboarding/profile",
      headers,
      payload: { displayName: "Sharma Dental", accent: "#14532d", address: "Panaji" },
    });
    const booked = await app.inject({ method: "POST", url: "/api/onboarding/test-booking", headers });
    assert.equal(booked.statusCode, 200);
    assert.ok(Date.now() - started < 15 * 60 * 1000);
    const page = readFileSync("web/portals/newclinic.html", "utf8");
    assert.match(page, /Sharma Dental/);

    const dental = await app.inject({ method: "GET", url: "/api/portal/profile", headers: { host: "newclinic.localhost" } });
    assert.equal(dental.json().modules.includes("vault"), false);
    assert.equal(dental.json().modules.includes("triage"), true);

    const counsel = await owner(app, "counsel", "mental_health");
    const counselProfile = await app.inject({
      method: "GET",
      url: "/api/portal/profile",
      headers: { host: "counsel.localhost", ...auth(counsel) },
    });
    assert.equal(counselProfile.json().modules.includes("vault"), true);
    assert.equal(counselProfile.json().modules.includes("triage"), false);
    assert.equal(counselProfile.json().modules.includes("charting"), false);
    assert.equal(counselProfile.json().prepayRequired, true);

    const other = await owner(app, "neighbour");
    const exported = await app.inject({ method: "GET", url: "/api/export", headers });
    assert.ok(exported.json().patients.length >= 1);
    const erased = await app.inject({ method: "POST", url: "/api/erase", headers });
    assert.equal(erased.statusCode, 200);
    const neighbour = await withSuperuser(async (client) => {
      return client.query(`SELECT slug FROM clinics WHERE slug = 'neighbour'`);
    });
    assert.equal(neighbour.rowCount, 1);
    const gone = await withSuperuser(async (client) => {
      return client.query(`SELECT slug FROM clinics WHERE slug = 'newclinic'`);
    });
    assert.equal(gone.rowCount, 0);
    assert.ok(other);
  } finally {
    await shutdown(app);
  }
});
