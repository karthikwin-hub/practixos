import assert from "node:assert/strict";
import { test } from "node:test";
import { dhisStatement, quoteToken, recordBundles, reconcileDhis, repriceDhis, requestLater } from "../src/modules/admin/index.ts";
import { auth, boot, finishDental, owner, shutdown } from "../tests/gates/api.ts";
import { withSuperuser } from "../tests/gates/harness.ts";

/**
 * @spec FR-7.2 — DHIS accrual follows Corrigendum 7 and matches an NHA statement line for line.
 */
test("a clinic's DHIS accrual reconciles against the statement", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "dhis");
    const headers = auth(token);
    const { practitionerId } = await finishDental(app, token);
    const walk = await app.inject({
      method: "POST",
      url: "/api/walk-ins",
      headers,
      payload: { phone: "9811111199", name: "DHIS Patient", practitionerId },
    });
    const clinicId = await withSuperuser(async (client) => {
      const row = await client.query<{ clinic_id: string }>(
        `SELECT clinic_id FROM appointments WHERE id = $1`,
        [walk.json().appointmentId],
      );
      return row.rows[0].clinic_id;
    });

    const rows = Array.from({ length: 450 }, (_, index) => ({
      abhaId: `abha-${index}`,
      category: 2 as const,
      kycVerified: index < 405,
      bundleRef: `bundle-${index}`,
      occurredOn: "2026-09-01",
      kind: "OPConsultation",
    }));
    assert.equal(await recordBundles(clinicId, rows), 450);
    const first = await dhisStatement(clinicId);
    assert.equal(first.rowCount, 450);
    assert.equal(first.eligibleCount, 405);
    assert.equal(first.accruedPaise, (405 - 100) * 500);

    const again = await reconcileDhis(clinicId, first.lines.map((line) => ({
      bundleRef: line.bundleRef,
      paise: line.paise,
    })));
    assert.equal(again.ok, true);
    assert.equal(again.accruedPaise, 152500);

    await repriceDhis(clinicId, 2, 600);
    const repriced = await dhisStatement(clinicId);
    assert.equal(repriced.rowCount, 450);
    assert.equal(repriced.accruedPaise, (405 - 100) * 600);

    const capped = Array.from({ length: 6 }, (_, index) => ({
      abhaId: "same-abha",
      category: 2 as const,
      kycVerified: true,
      bundleRef: `cap-${index}`,
      occurredOn: `2026-08-${String(index + 1).padStart(2, "0")}`,
      kind: "Prescription",
    }));
    await recordBundles(clinicId, capped);
    const withCap = await dhisStatement(clinicId);
    assert.equal(withCap.eligibleCount, 405 + 5);
  } finally {
    await shutdown(app);
  }
});

/** @spec FR-7.2 — the quote is a median, and a later arrival swaps with someone waiting. */
test("the token estimate uses the median and a later arrival swaps places", async () => {
  const app = await boot();
  try {
    const token = await owner(app, "radar");
    const headers = auth(token);
    const { practitionerId } = await finishDental(app, token);
    const made: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const walk = await app.inject({
        method: "POST",
        url: "/api/walk-ins",
        headers,
        payload: { phone: `982200000${i}`, name: `Token ${i}`, practitionerId },
      });
      made.push(walk.json().appointmentId as string);
    }
    const clinicId = await withSuperuser(async (client) => {
      const row = await client.query<{ clinic_id: string; stage_id: string }>(
        `SELECT clinic_id, stage_id FROM appointments WHERE id = $1`,
        [made[0]],
      );
      const clinic = row.rows[0].clinic_id;
      const stage = row.rows[0].stage_id;
      for (let i = 0; i < made.length; i += 1) {
        await client.query(`UPDATE appointments SET token_no = $2, stage_id = $3 WHERE id = $1`, [made[i], i + 1, stage]);
      }
      await client.query(`UPDATE queue_stages SET role = 'waiting' WHERE id = $1`, [stage]);
      for (const minutes of [10, 10, 100]) {
        await client.query(
          `INSERT INTO consult_spans (clinic_id, practitioner_id, session_type, minutes) VALUES ($1, $2, 'clinic', $3)`,
          [clinic, practitionerId, minutes],
        );
      }
      return clinic;
    });

    const quote = await quoteToken(clinicId, made[3]);
    assert.equal(quote.hedged, false);
    assert.equal(quote.position, 3);
    assert.deepEqual(quote.range, [30, 40]);
    const repeat = await quoteToken(clinicId, made[3]);
    assert.equal(repeat.notified, false);

    const swapped = await requestLater(clinicId, made[3]);
    assert.equal(typeof swapped.swappedWith, "string");
  } finally {
    await shutdown(app);
  }
});
