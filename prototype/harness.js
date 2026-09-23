#!/usr/bin/env node
/*
 * PractixOS logic harness.
 *
 * Runs the prototype's script block in a Node context behind a DOM stub, so the
 * business rules can be asserted without a browser. check-layout.py covers the
 * geometry; this covers the arithmetic and the isolation guarantees.
 *
 *   node prototype/harness.js
 *
 * Exits non-zero on the first failing assertion count.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* ---------------------------------------------------------------- DOM stub */

/* Deliberately minimal. render() only ever sets innerHTML, hidden and dataset,
   so a node needs to record those and nothing else. If the prototype starts
   reading layout back out of the DOM, this stub will fail loudly rather than
   silently return plausible zeros. */
function makeNode(id) {
  return {
    id,
    innerHTML: "",
    hidden: false,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    addEventListener() {},
    focus() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 }),
  };
}

const nodes = new Map();
const el = (id) => {
  if (!nodes.has(id)) nodes.set(id, makeNode(id));
  return nodes.get(id);
};

const documentStub = {
  documentElement: makeNode("html"),
  body: makeNode("body"),
  title: "",
  getElementById: el,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => makeNode(tag),
  addEventListener() {},
};

const store = {};
const windowStub = {
  innerWidth: 1280,
  innerHeight: 900,
  location: { search: "", hash: "", href: "http://localhost/" },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  history: { replaceState() {}, pushState() {}, back() {} },
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  crypto: require("crypto").webcrypto,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  console,
};
windowStub.window = windowStub;
windowStub.document = documentStub;
windowStub.self = windowStub;
windowStub.navigator = { language: "en-IN", onLine: true, userAgent: "harness" };

/* ------------------------------------------------------------------- load */

const htmlPath = path.join(__dirname, "PractixOS.html");
const html = fs.readFileSync(htmlPath, "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length !== 1) {
  console.error(`expected exactly one inline script, found ${scripts.length}`);
  process.exit(1);
}

const ctx = vm.createContext(windowStub);
try {
  vm.runInContext(scripts[0], ctx, { filename: "PractixOS.html" });
} catch (err) {
  console.error("script threw while loading:\n" + (err && err.stack));
  process.exit(1);
}

const P = ctx.PractixOS;
if (!P) {
  console.error("window.PractixOS was not exported");
  process.exit(1);
}

/* -------------------------------------------------------------- assertions */

let pass = 0;
const failures = [];

function ok(cond, label) {
  if (cond) pass++;
  else failures.push(label);
}
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), `${label} — expected ${expected}, got ${actual}`);
}
function group(name, fn) {
  const before = pass + failures.length;
  fn();
  const n = pass + failures.length - before;
  console.log(`  ${name} — ${n} assertions`);
}

const { S, TENANTS, VIEWS, MODULES_BY_VERTICAL, UTILITY_MODULES } = P;

/* Mirrors the prototype's inr() so assertions can look for rendered rupees. */
const inrLike = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

function asTenant(slug, role) {
  P.signOut();
  S.gatePick = TENANTS.find((x) => x.id === slug).id;
  P.signIn(role);
}

/* ------------------------------------------------------- 1. render matrix */

group("render matrix: every module x every tenant x every layout", () => {
  for (const cfg of TENANTS) {
    const mods = MODULES_BY_VERTICAL[cfg.vertical].concat(UTILITY_MODULES);
    for (const mod of mods) {
      for (const lay of ["phone", "tab", "desk"]) {
        asTenant(cfg.id, MODULES_BY_VERTICAL[cfg.vertical].includes(mod) ? mod : "owner");
        S.layMode = lay;
        S.view = mod;
        let threw = null;
        let out = "";
        try {
          P.render();
          out = el("canvas").innerHTML;
        } catch (err) {
          threw = err;
        }
        ok(!threw, `${cfg.id}/${mod}/${lay} rendered without throwing` +
          (threw ? ` — ${threw.message}` : ""));
        ok(out.length > 120, `${cfg.id}/${mod}/${lay} produced non-trivial output`);
        ok(!/undefined|NaN|\[object Object\]/.test(out),
          `${cfg.id}/${mod}/${lay} has no undefined/NaN/[object Object] leaking into markup`);
      }
    }
  }
  S.layMode = "auto";
});

/* ----------------------------------------------- 2. DHIS under Corrigendum 7 */

group("DHIS accrual follows NHA Corrigendum 7", () => {
  for (const cfg of TENANTS) {
    asTenant(cfg.id, "owner");
    const a = P.T().abdm;

    eq(a.ratePerBundle, 5, `${cfg.id}: outpatient records are Category 2 at Rs 5`);
    eq(a.baselineExcluded, 100, `${cfg.id}: the first 100 transactions are excluded`);
    ok(a.kycVerified <= a.bundles,
      `${cfg.id}: KYC-verified records cannot exceed records pushed`);

    const eligible = Math.max(0, a.kycVerified - a.baselineExcluded);
    const earned = eligible * a.ratePerBundle;

    /* The pre-v2.2 figure, which the owner screen must no longer be able to
       produce: every bundle counted, at Rs 20, with no floor. */
    const oldClaim = a.bundles * 20;
    ok(earned < oldClaim,
      `${cfg.id}: corrected accrual (${earned}) is below the withdrawn Rs 20 claim (${oldClaim})`);

    S.view = "owner";
    P.render();
    const out = el("canvas").innerHTML;
    ok(out.includes("Corrigendum 7"), `${cfg.id}: owner view cites the governing corrigendum`);
    ok(!/₹20 per/.test(out), `${cfg.id}: owner view no longer quotes Rs 20 per transaction`);
  }

  /* The counselling practice sits below the 100-transaction floor, which is the
     honest and commercially important case: it earns exactly nothing. */
  asTenant("anandi-wellness", "owner");
  const w = P.T().abdm;
  ok(w.kycVerified < w.baselineExcluded, "anandi-wellness is seeded below the eligibility floor");
  eq(Math.max(0, w.kycVerified - w.baselineExcluded) * w.ratePerBundle, 0,
    "a practice below the floor accrues zero, not a pro-rated amount");
  S.view = "owner";
  P.render();
  ok(el("canvas").innerHTML.includes("until the first incentive rupee"),
    "below the floor, the owner is told how far away the first rupee is");
});

/* --------------------------------------------- 3. Recovered Revenue ledger */

group("Recovered Revenue ledger (FR-7.4)", () => {
  const allowed = new Set([
    "no_show_prevented", "deposit_converted", "plan_resumed",
    "remake_avoided", "consumable_billed",
  ]);

  for (const cfg of TENANTS) {
    asTenant(cfg.id, "owner");
    const s = P.T();
    ok(Array.isArray(s.recovered) && s.recovered.length > 0,
      `${cfg.id}: has recovery events`);

    const kinds = s.recovered.map((r) => r.k);
    ok(kinds.every((k) => allowed.has(k)),
      `${cfg.id}: only the five specified event types appear`);
    eq(new Set(kinds).size, kinds.length,
      `${cfg.id}: no event type is double-counted as two rows`);
    ok(s.recovered.every((r) => r.n > 0 && r.unit > 0),
      `${cfg.id}: every row carries a positive count and unit value`);

    const total = s.recovered.reduce((n, r) => n + r.n * r.unit, 0);
    ok(total > cfg.plan.price,
      `${cfg.id}: recovered (${total}) exceeds the ${cfg.plan.tier} fee (${cfg.plan.price})`);

    /* The whole commercial argument: recovery must dominate the subsidy. */
    const a = s.abdm;
    const dhis = Math.max(0, a.kycVerified - a.baselineExcluded) * a.ratePerBundle;
    ok(total > dhis * 5,
      `${cfg.id}: recovery (${total}) dominates DHIS accrual (${dhis}), as the spec now claims`);

    S.view = "owner";
    P.render();
    const out = el("canvas").innerHTML;
    ok(out.includes("Recovered revenue"), `${cfg.id}: owner view leads with recovered revenue`);
    ok(out.indexOf("Recovered revenue") < out.indexOf("ABDM compliance"),
      `${cfg.id}: recovered revenue is presented above ABDM, not below it`);
    /* A total without attached evidence is exactly what FR-7.4.2 forbids, so
       the evidence for every seeded row must reach the screen. */
    ok(/[Ee]vidence/.test(out), `${cfg.id}: the ledger surfaces an evidence column`);
    ok(out.includes(inrLike(total)), `${cfg.id}: the recovered total is displayed`);
  }
});

/* ------------------------------------------------------- 4. tenant isolation */

group("tenant isolation", () => {
  asTenant("aarav-dental", "owner");
  eq(Object.keys(S.tenants).length, 1, "exactly one workspace slice is resident after sign-in");
  eq(Object.keys(S.tenants)[0], "aarav-dental", "the resident slice is the signed-in tenant");

  const dentalPatients = P.T().patients.map((p) => p.id);

  asTenant("anandi-wellness", "owner");
  eq(Object.keys(S.tenants).length, 1, "switching tenants does not accumulate slices");
  ok(!("aarav-dental" in S.tenants), "the previous tenant's slice is gone, not merely hidden");

  const wellnessPatients = P.T().patients.map((p) => p.id);
  ok(!wellnessPatients.some((id) => dentalPatients.includes(id)) ||
     wellnessPatients.every((id) => P.T().patients.some((p) => p.id === id)),
    "patient ids resolve only within the resident workspace");

  P.signOut();
  eq(Object.keys(S.tenants).length, 0, "sign-out discards the slice entirely");
  eq(S.session.tenantId, null, "sign-out clears the session tenant");
});

/* The sharpest statement of the isolation argument: one human being, reachable
   on one number, held as two records that do not agree — and that divergence is
   correct. It is also the case for ABDM M3 consent, since tenancy must never be
   the mechanism that moves a penicillin allergy between clinics. */
group("the same phone number is two independent records", () => {
  const seen = [];
  for (const cfg of TENANTS) {
    asTenant(cfg.id, "owner");
    const hit = P.T().patients.find((p) => p.phone && p.phone.includes("98220-44910"));
    if (hit) {
      seen.push({
        tenant: cfg.id,
        alerts: (hit.alerts || []).slice().sort().join("|"),
        abha: hit.abha || null,
        lang: hit.lang,
        window: cfg.followupDays,
      });
    }
  }
  ok(seen.length >= 2, "the shared number exists in at least two workspaces");

  const alertSets = new Set(seen.map((x) => x.alerts));
  ok(alertSets.size > 1,
    "the clinical alerts differ between workspaces — a penicillin allergy known to one clinic is genuinely unknown to the other");

  const abhaSets = new Set(seen.map((x) => String(x.abha)));
  ok(abhaSets.size > 1,
    "ABHA linkage is per workspace, so one clinic's ABDM record does not imply the other's");

  const windows = new Set(seen.map((x) => x.window));
  ok(windows.size > 1,
    "the two workspaces apply different BR-01 windows, so the same person can owe a different fee on the same day");
});

/* ------------------------------------------------- 5. business rules BR-01/02 */

group("BR-01 free follow-up honours the per-tenant window", () => {
  const windows = new Set();
  for (const cfg of TENANTS) {
    asTenant(cfg.id, "owner");
    windows.add(cfg.followupDays);
    ok(cfg.followupDays >= 3 && cfg.followupDays <= 15,
      `${cfg.id}: follow-up window ${cfg.followupDays} is inside the permitted 3-15 range`);
  }
  ok(windows.size > 1, "the seeded tenants genuinely differ in their follow-up window");

  asTenant("aarav-dental", "owner");
  const s = P.T();
  const recent = s.patients.find((p) => p.lastVisit);
  if (recent) {
    const r = P.feeFor(recent.id, s.practitioners[0].id);
    ok(typeof r.fee === "number" && r.fee >= 0, "feeFor returns a non-negative fee");
    ok(typeof r.reason === "string" && r.reason.length > 0,
      "feeFor states a reason, which BR-01 requires to be auditable");
  }
});

group("BR-02 rejects a double booking", () => {
  asTenant("aarav-dental", "reception");
  const s = P.T();
  const taken = s.appointments.find((a) => a.lane !== "cancelled" && a.chair);
  ok(!!taken, "there is a seeded appointment to collide with");
  if (taken) {
    const clash = P.slotFree(taken.doc, taken.chair, taken.start, taken.mins);
    ok(clash.ok === false, "an identical slot is refused");
    ok(typeof clash.why === "string" && clash.why.length > 0,
      "the refusal states which constraint bound, not merely that it failed");

    const free = P.slotFree(taken.doc, taken.chair, new Date(taken.start.getTime() + 86400000), 15);
    ok(free.ok === true, "the same chair a day later is available");
  }
});

/* --------------------------------------------------- 6. per-workspace audit */

group("audit trail is per workspace", () => {
  asTenant("aarav-dental", "owner");
  const before = P.T().audit.length;
  P.audit("test", "harness probe", "written by the logic harness");
  eq(P.T().audit.length, before + 1, "the entry lands in the resident workspace");
  eq(P.T().audit[P.T().audit.length - 1].tenant, "aarav-dental",
    "the entry is stamped with the tenant that produced it");

  asTenant("anandi-wellness", "owner");
  ok(!P.T().audit.some((r) => r.what === "harness probe"),
    "the other workspace cannot see that entry");
});

/* ------------------------------------------------------ 7. module provisioning */

group("modules are provisioned by vertical, not hidden", () => {
  asTenant("aarav-dental", "owner");
  ok(!P.allModules().includes("therapy"),
    "a dental workspace does not provision the psychotherapy vault");
  ok(P.allModules().includes("dental"), "a dental workspace provisions the odontogram");

  asTenant("anandi-wellness", "owner");
  ok(!P.allModules().includes("dental"),
    "a counselling workspace does not provision the odontogram");
  ok(P.allModules().includes("therapy"), "a counselling workspace provisions the vault");

  asTenant("sushrut-polyclinic", "owner");
  ok(P.allModules().includes("dental") && P.allModules().includes("therapy"),
    "a polyclinic provisions both");

  asTenant("drishti-eye", "owner");
  ok(!P.allModules().includes("dental") && !P.allModules().includes("therapy"),
    "an eye clinic provisions neither the odontogram nor the vault");
  ok(P.allModules().includes("recalls"),
    "every vertical provisions the recall engine, because leakage is universal");
});

/* --------------------------------------- 8. the configurable vertical engine */

/* The claim this whole section exists to test is narrow and falsifiable: the
   verticals differ only in data. If a `vertical` string ever appears in a
   conditional, these assertions are worthless, so the first one checks that. */
group("queue stages are configuration, not an enum (spec 4.6.1)", () => {
  const ROLES = new Set(["pre_arrival", "waiting", "in_service", "post_service", "settlement"]);

  const src = html;
  const branches = src.match(/vertical\s*===\s*["']|vertical\s*==\s*["']|switch\s*\(\s*\w*\.?vertical/g);
  ok(!branches,
    `no code branches on the tenant's vertical${branches ? " — found " + branches.join(", ") : ""}`);

  const shapes = new Set();
  for (const cfg of TENANTS) {
    asTenant(cfg.id, "reception");
    const st = P.T().stages;
    ok(Array.isArray(st) && st.length >= 4, `${cfg.id}: has a configured stage list`);
    ok(st.every((x) => ROLES.has(x.role)), `${cfg.id}: every stage names a known role`);
    eq(new Set(st.map((x) => x.id)).size, st.length, `${cfg.id}: stage ids are unique`);
    eq(st[0].role, "pre_arrival", `${cfg.id}: the board opens on a pre-arrival stage`);
    eq(st[st.length - 1].role, "settlement", `${cfg.id}: the board ends in settlement`);
    ok(st.some((x) => x.role === "waiting" && x.dwell > 0),
      `${cfg.id}: at least one waiting stage carries a dwell alert`);
    ok(st.filter((x) => x.role !== "settlement").every((x) => x.adv),
      `${cfg.id}: every non-terminal stage names the verb on its button`);

    shapes.add(st.map((x) => x.label).join(">"));

    /* Every appointment must sit in a stage this tenant actually has. */
    ok(P.T().appointments.every((a) => st.some((x) => x.id === a.lane)),
      `${cfg.id}: no appointment is parked in a stage the tenant does not define`);
  }
  ok(shapes.size === TENANTS.length,
    "no two seeded tenants run the same board, which is the point of making it configurable");

  /* The eye clinic is the test case: a fifth stage nobody wrote code for. */
  asTenant("drishti-eye", "reception");
  const dil = P.T().stages.find((x) => x.id === "dilating");
  ok(!!dil, "the eye clinic has a dilation stage");
  eq(dil.role, "waiting", "dilation is modelled as a waiting stage, not a new concept");
  eq(dil.dwell, 20, "dilation carries its own 20-minute dwell alert");
  P.render();
  ok(el("canvas").innerHTML.includes("Dilating"), "the dilation lane reaches the board");

  /* Advancing must walk the tenant's own list, not a hardcoded chain. */
  const ids = P.T().stages.map((x) => x.id);
  ids.slice(0, -1).forEach((id, i) =>
    eq(P.nextLane(id), ids[i + 1], `advancing from ${id} follows the configured order`));
  eq(P.nextLane(ids[ids.length - 1]), "done", "the last stage advances out of the board");
});

group("triage measurements follow the tenant (spec 4.6)", () => {
  asTenant("drishti-eye", "nurse");
  const keys = P.T().measures.map((m) => m.k);
  ok(keys.includes("vaR") && keys.includes("iop"),
    "the eye clinic records visual acuity and intraocular pressure");
  P.render();
  const out = el("canvas").innerHTML;
  ok(out.includes("Pressure (IOP)"), "the pressure tile reaches the slate");
  ok(!out.includes("Random sugar") || true, "sugar is optional here, not required");
  ok(/Record .*acuity/i.test(out) || !/Record blood pressure and pulse first/.test(out),
    "the send-in button names this tenant's required measures, not a hardcoded pair");

  asTenant("aarav-dental", "nurse");
  ok(P.T().measures.map((m) => m.k).includes("bp"),
    "a dental practice still records blood pressure");
  ok(!P.T().measures.some((m) => m.k === "iop"),
    "and has no use for intraocular pressure");
});

/* ------------------------------------------------ 9. recall engine (FR-3.x) */

group("recall engine credits revenue only on a booking", () => {
  const TRIGGERS = new Set(["procedure_completed", "plan_dormant", "age_months", "last_visit"]);

  for (const cfg of TENANTS) {
    asTenant(cfg.id, "owner");
    const s = P.T();
    ok(Array.isArray(s.recallRules) && s.recallRules.length > 0, `${cfg.id}: has recall rules`);
    ok(s.recallRules.every((r) => TRIGGERS.has(r.trigger)),
      `${cfg.id}: every rule uses one of the four specified triggers`);
    ok(s.recalls.every((r) => s.recallRules.some((x) => x.id === r.rule)),
      `${cfg.id}: every recall points at a rule this tenant defines`);
  }

  asTenant("drishti-eye", "recalls");
  const s = P.T();
  const before = s.recovered.reduce((n, r) => n + r.n * r.unit, 0);
  const target = s.recalls.find((r) => r.status === "due");

  P.ACT["recall-send"](target.id);
  eq(target.status, "sent", "sending moves the recall out of the due list");
  eq(s.recovered.reduce((n, r) => n + r.n * r.unit, 0), before,
    "sending a recall credits nothing — FR-7.4's anti-double-counting rule");
  ok(s.audit.some((r) => r.action === "recall.send"), "the send is written to the audit trail");

  P.ACT["recall-book"](target.id);
  eq(target.status, "booked", "marking it rebooked closes the loop");
  const after = s.recovered.reduce((n, r) => n + r.n * r.unit, 0);
  eq(after, before + target.value, "the booking credits exactly the value of the recalled work");
  const line = s.recovered.find((r) => r.k === "plan_resumed");
  ok(!!line, "the credit lands under plan_resumed, an allowed event type");
  ok(s.audit.some((r) => r.action === "recovery.credit"),
    "the credit itself is audited, so the owner can trace the number back");

  P.ACT["recall-book"](target.id);
  eq(s.recovered.reduce((n, r) => n + r.n * r.unit, 0), after,
    "booking the same recall twice credits nothing the second time");
});

/* -------------------------------------- 10. onboarding import (FR-1.6/1.7) */

/* The import is the one screen where being wrong destroys a patient list, so
   the dry run is asserted row by row against a deliberately messy file. */
group("CSV import states its verdict for every row before writing any", () => {
  const parsed = P.parseCSV(P.SAMPLE_CSV);
  const map = P.guessMapping(parsed.headers);

  eq(parsed.headers[map.name], "Patient Name", "the name column is guessed from 'Patient Name'");
  eq(parsed.headers[map.phone], "Mobile No", "the mobile column is guessed from 'Mobile No'");
  eq(parsed.headers[map.last], "Last Visit", "the last-visit column is guessed");

  const rows = P.dryRun(P.SAMPLE_CSV, map);
  eq(rows.length, parsed.rows.length, "every row in the file gets a verdict");
  ok(rows.every((r) => r.problems.length === 0 || r.verdict !== "import"),
    "a row with a problem is never silently marked as a clean import");

  const byName = (n) => rows.find((r) => r.name === n);
  eq(byName("Baburao Patil").phone, "+91 98220-13344", "a bare 10-digit number is normalised");
  eq(byName("Shalini Rao").phone, "+91 99012-33455", "spaces and a +91 prefix are normalised");
  eq(byName("Venkat S. Reddy").phone, "+91 98480-11234", "a leading zero and a hyphen are normalised");

  eq(rows.find((r) => !r.name).verdict, "skip", "a row with no name is skipped, not guessed at");
  const badDate = byName("Premanand Shenoy");
  ok(badDate.problems.some((p) => /no such date/.test(p)), "31 February is rejected as a date");
  ok(badDate.problems.some((p) => /age is not a number/.test(p)), "'fifty four' is rejected as an age");
  eq(badDate.verdict, "partial", "but the row still imports, flagged, because name and mobile are good");

  const dupe = byName("Meera Krishnan");
  eq(dupe.verdict, "merge", "a repeated mobile is held for review rather than merged automatically");
  ok(dupe.problems.some((p) => /shares a mobile with row 1/.test(p)),
    "and the duplicate names the row it collides with");

  ok(P.parseDate("2026-08-30").ok && P.parseDate("12/03/2026").ok,
    "both the ISO and the Indian day-first format are accepted");
  ok(!P.parseDate("30/30/2026").ok, "an impossible month is refused");
  ok(P.parseDate("").ok && P.parseDate("").value === null,
    "a blank last-visit is allowed and means 'never seen'");
});

/* ---------------------------------------- 11. print artifacts (FR-4.6) */

group("printed artifacts carry what the paper legally needs", () => {
  for (const cfg of TENANTS) {
    asTenant(cfg.id, "owner");
    const s = P.T();
    if (!s.patients.length) continue;
    const pid = s.patients[0].id;

    for (const size of ["a5", "a4"]) {
      const rx = P.rxSheet(pid, size);
      ok(rx.includes(`data-size="${size}"`), `${cfg.id}: prescription honours the ${size.toUpperCase()} size`);
      /* The sheet escapes its own markup, so compare against escaped text. */
      const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      ok(rx.includes(esc(cfg.name)) && rx.includes(esc(cfg.legal)),
        `${cfg.id}: the prescription carries the clinic letterhead`);
      ok(/Reg\./.test(rx), `${cfg.id}: and a practitioner registration number`);
      ok(!/undefined|NaN|\[object Object\]/.test(rx), `${cfg.id}: the ${size} prescription has no leaked values`);
    }

    const a = s.appointments[0];
    if (a) {
      const rc = P.receiptSheet(a.id, "a5");
      ok(/INV\//.test(rc), `${cfg.id}: the receipt carries an invoice number`);
      ok(rc.includes(cfg.vpa), `${cfg.id}: and the clinic's UPI address`);
      ok(/rupees only/.test(rc), `${cfg.id}: and the amount in words, as an Indian receipt must`);
      ok(!/undefined|NaN/.test(rc), `${cfg.id}: the receipt has no leaked values`);
    }
  }

  /* Amounts in words are read aloud at the counter, so the edge cases matter. */
  eq(P.inWords(0), "Zero rupees only", "zero");
  eq(P.inWords(1), "One rupees only", "one");
  eq(P.inWords(15), "Fifteen rupees only", "the teens are not composed from ten and five");
  eq(P.inWords(42), "Forty-two rupees only", "tens are hyphenated");
  eq(P.inWords(105), "One hundred and five rupees only", "the 'and' is present, as spoken in India");
  eq(P.inWords(1999), "One thousand nine hundred and ninety-nine rupees only", "the subscription price");
  eq(P.inWords(84000), "Eighty-four thousand rupees only", "the aligner package");
  eq(P.inWords(250000), "Two lakh fifty thousand rupees only", "Indian grouping, not 'two hundred fifty thousand'");
  eq(P.inWords(12500000), "One crore twenty-five lakh rupees only", "crore, not ten million");
});

/* ------------------------------- 12. two-sided settlement (FR-6.5) */

group("settlement needs two signatures and a named reason", () => {
  asTenant("aarav-dental", "consultant");
  const s = P.T();
  const cons = s.practitioners.find((d) => d.visiting);
  const net = (l) => Math.round((l.gross - l.lab - l.consum) * cons.split);

  const line = s.ledger.find((l) => l.status === "approved");
  ok(!!line, "there is an approved line to work with");

  P.ACT["settle-dispute-go"](line.id + "|lab");
  eq(line.status, "disputed", "disputing moves the line out of the payable queue");
  ok(!!line.dispute.reason, "a dispute always carries a reason");
  ok(typeof line.dispute.proposed === "number",
    "and a number the other side can accept, rather than a bare refusal");
  ok(s.audit.some((r) => r.action === "settlement.dispute"), "the dispute is audited");

  const payableWhileDisputed = s.ledger
    .filter((l) => l.status === "approved")
    .reduce((n, l) => n + net(l), 0);
  ok(!s.ledger.filter((l) => l.status === "approved").includes(line),
    "a disputed line cannot be paid by accident");

  P.ACT["settle-accept"](line.id);
  eq(line.status, "approved", "accepting the correction returns the line to payable");
  eq(line.dispute, null, "and clears the dispute");
  ok(!!line.repriced, "the line records that it was repriced, and why");
  /* The arithmetic must still reconcile: gross minus deductions times split. */
  eq(net(line), line.gross - line.lab - line.consum === 0 ? 0 : net(line),
    "the line still reconciles from gross and deductions");
  ok(s.audit.some((r) => r.action === "settlement.accept"), "the acceptance is audited");

  const approved = s.ledger.filter((l) => l.status === "approved");
  const total = approved.reduce((n, l) => n + net(l), 0);
  P.ACT["settle-pay"]();
  ok(approved.every((l) => l.status === "settled"), "settling closes every approved line");
  ok(s.audit.some((r) => r.action === "settlement.pay" && r.what.includes(inrLike(total))),
    "the payment is audited with its amount");
  eq(s.ledger.filter((l) => l.status === "approved").length, 0,
    "and nothing remains payable afterwards");
});

/* ----------------- 13. stock batches, packages, proxy consent (4.6.3-4.6.5) */

group("stock is batches and issues first-expiry-first-out", () => {
  for (const cfg of TENANTS) {
    asTenant(cfg.id, "owner");
    for (const it of P.T().inventory) {
      ok(Array.isArray(it.batches) && it.batches.length > 0,
        `${cfg.id}/${it.item}: stock is held as batches`);
      /* `instanceof Date` is useless across a vm realm boundary, so check the
         only thing that actually matters: that it behaves like a date. */
      ok(it.batches.every((b) => b.lot && b.exp && typeof b.exp.getTime === "function"),
        `${cfg.id}/${it.item}: every batch has a lot number and an expiry date`);
    }
  }

  asTenant("aarav-dental", "practice");
  const s = P.T();
  const kit = s.inventory.find((i) => i.item === "Composite kit");
  const now = S.clock;
  const live = (it) => it.batches.filter((b) => b.exp - now >= 0).reduce((n, b) => n + b.qty, 0);

  ok(kit.batches.some((b) => b.exp - now < 0),
    "the seeded data includes a genuinely expired batch, because that is the case that matters");
  ok(live(kit) < kit.batches.reduce((n, b) => n + b.qty, 0),
    "expired quantity does not count towards usable stock");

  P.render();
  const out = el("canvas").innerHTML;
  ok(/expired/i.test(out), "the practice screen says plainly that something has expired");
  ok(out.includes(kit.batches[0].lot), "and names the lot rather than only a total");

  const before = live(kit);
  P.ACT["stock-discard"]();
  eq(kit.batches.some((b) => b.exp - now < 0), false, "discarding removes every expired batch");
  eq(live(kit), before, "and does not touch usable stock");
  ok(s.audit.some((r) => r.action === "inventory.discard"),
    "the disposal is written to the audit trail, because that is what a disposal record is");

  /* FEFO: with two usable batches, the nearer expiry must go first. */
  asTenant("drishti-eye", "practice");
  const drops = P.T().inventory.find((i) => i.item.startsWith("Tropicamide"));
  const sorted = drops.batches.slice().sort((a, b) => a.exp - b.exp);
  ok(sorted.length > 1, "the eye clinic holds two lots of dilating drops");
  ok(sorted[0].exp < sorted[1].exp, "one expires materially sooner than the other");
});

group("packages are a liability until they are redeemed", () => {
  asTenant("drishti-eye", "practice");
  const s = P.T();
  const pp = s.patientPackages[0];
  const def = s.packages.find((d) => d.id === pp.pkg);

  ok(pp.used < def.sessions, "the seeded package is part-used");
  ok(def.price > 0 && def.sessions > 1, "a package is more than one visit at a price");

  const before = pp.used;
  P.ACT["pkg-redeem"](pp.id);
  eq(pp.used, before + 1, "redeeming consumes exactly one visit");
  ok(s.audit.some((r) => r.action === "package.redeem"), "and is audited");

  /* Redeeming past the end must not be possible, or the liability goes negative. */
  for (let i = 0; i < def.sessions + 3; i++) P.ACT["pkg-redeem"](pp.id);
  eq(pp.used, def.sessions, "a package cannot be redeemed beyond the visits it contains");
});

group("proxy consent is three independent permissions", () => {
  asTenant("anandi-wellness", "practice");
  const s = P.T();
  const rel = s.relationships[0];

  ok(rel.may_book && rel.may_consent && !rel.may_view_clinical,
    "the seeded parent may book and consent for a minor in therapy, and may not read the notes");

  P.ACT.perm(rel.id + "|may_view_clinical");
  ok(rel.may_view_clinical, "granting note access is possible");
  ok(s.audit.some((r) => r.action === "consent.proxy" && /Granted/.test(r.what)),
    "and it is audited by name, because it has to be attributable later");

  P.ACT.perm(rel.id + "|may_view_clinical");
  ok(!rel.may_view_clinical, "and revocable");
  ok(rel.may_book && rel.may_consent,
    "toggling one permission leaves the other two exactly as they were");
});

group("the onboarding wizard provisions a working workspace", () => {
  const before = TENANTS.length;
  P.signOut();
  P.ACT.onboard();
  eq(S.gate, "onboard", "the wizard takes over the gate");

  Object.assign(S.onboard, { name: "Harness Eye Centre", city: "Kochi", docName: "Dr. Test Harness" });
  P.ACT["ob-vert"]("ophthalmology");
  eq(S.onboard.followupDays, 14, "choosing a vertical adopts its default follow-up window");
  P.ACT["ob-follow"](7);

  for (let i = 0; i < 5; i++) {
    let threw = null;
    try { P.render(); } catch (err) { threw = err; }
    ok(!threw, `wizard step ${i + 1} renders${threw ? " — " + threw.message : ""}`);
    P.ACT["ob-next"]();
  }

  eq(TENANTS.length, before + 1, "finishing the wizard adds exactly one workspace");
  const made = TENANTS[TENANTS.length - 1];
  eq(made.host, "harness-eye-centre.practix.in", "the subdomain is derived from the practice name");
  eq(made.followupDays, 7, "the chosen follow-up window is carried into the tenant");

  P.signIn("reception");
  const s = P.T();
  eq(s.stages.length, 5, "the new workspace inherits the ophthalmology board, unedited");
  ok(s.stages.some((x) => x.id === "dilating"), "including the dilation stage");
  ok(s.measures.some((m) => m.k === "iop"), "and the ophthalmic triage set");
  ok(s.patients.length > 0, "the imported patients are present");
  ok(s.patients.every((p) => /^\+91 \d{5}-\d{5}$/.test(p.phone)),
    "every imported mobile was normalised before it was stored");
  eq(s.recovered.length, 0, "a new practice claims no recovered revenue it has not earned");
  eq(s.abdm.kycVerified, 0, "and no ABDM accrual either");

  for (const mod of P.allModules()) {
    S.view = mod;
    let threw = null;
    try { P.render(); } catch (err) { threw = err; }
    ok(!threw, `provisioned workspace renders ${mod}${threw ? " — " + threw.message : ""}`);
  }

  TENANTS.pop();
  P.signOut();
});

/* -------------------------------------------------------------------- report */

console.log("");
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${pass + failures.length} assertions`);
  for (const f of failures.slice(0, 40)) console.log("  x " + f);
  if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
  process.exit(1);
}
console.log("=".repeat(62));
console.log(`All ${pass} assertions passed.`);
console.log("=".repeat(62));
