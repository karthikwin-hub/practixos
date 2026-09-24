import assert from "node:assert/strict";
import { test } from "node:test";
import { auth, boot, owner, shutdown } from "./api.ts";
import { withSuperuser } from "./harness.ts";

/** @spec FR-1.7 — dry run, no silent merge, one commit, reversible for a day. */
test("csv import reports duplicates and can be reversed", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "importer");
    const headers = auth(token);
    const patient = await app.inject({
      method: "POST",
      url: "/api/portal/otp",
      headers: { host: "importer.localhost" },
      payload: { phone: "9822005550", lang: "en" },
    });
    assert.equal(patient.statusCode, 202);
    const code = await withSuperuser(async (client) => {
      const res = await client.query<{ body: string }>(
        `SELECT body FROM message_outbox WHERE template = 'otp' ORDER BY created_at DESC LIMIT 1`,
      );
      return res.rows[0].body.match(/(\d{6})\s*$/)?.[1];
    });
    await app.inject({
      method: "POST",
      url: "/api/portal/otp/verify",
      headers: { host: "importer.localhost" },
      payload: { phone: "9822005550", code, name: "Existing" },
    });
    const dry = await app.inject({
      method: "POST",
      url: "/api/imports/dry-run",
      headers,
      payload: {
        filename: "patients.csv",
        text: "Patient Name,Mobile\nNew Person,9822006660\nExisting,9822005550\nBad,\n",
      },
    });
    assert.equal(dry.statusCode, 200);
    const summary = dry.json();
    assert.equal(summary.create.length, 1);
    assert.equal(summary.merge.length, 1);
    assert.equal(summary.reject.length, 1);
    const before = await withSuperuser(async (client) => {
      const res = await client.query(`SELECT count(*)::int AS n FROM patients`);
      return res.rows[0].n as number;
    });
    assert.equal(before, 1);
    const committed = await app.inject({
      method: "POST",
      url: `/api/imports/${summary.batchId}/commit`,
      headers,
    });
    assert.equal(committed.json().created, 1);
    const reversed = await app.inject({
      method: "POST",
      url: `/api/imports/${summary.batchId}/reverse`,
      headers,
    });
    assert.equal(reversed.statusCode, 200);
    const after = await withSuperuser(async (client) => {
      const res = await client.query(`SELECT count(*)::int AS n FROM patients`);
      return res.rows[0].n as number;
    });
    assert.equal(after, 1);
  } finally {
    await shutdown(app);
  }
});
