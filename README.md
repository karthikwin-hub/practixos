# PractixOS

A verticalized practice operating system for independent outpatient clinics in India. Phase 1 launches into a single vertical — dentistry — on an architecture where the operational differences between specialties are per-tenant configuration rather than code, so ophthalmology, dermatology, paediatrics and mental health counselling follow without a rebuild. The prototype now demonstrates that claim rather than stating it: a fourth workspace, an eye clinic, was added entirely as configuration.

This repository holds the product specification, the engineering plan, and a working interactive prototype.

## Try the prototype

`prototype/PractixOS.html` is a single self-contained file with no build step and no dependencies. Open it in a browser, or visit the deployment.

It opens on a workspace picker. Four tenants are seeded:

| Workspace | Vertical | Queue stages | Deep link |
| --- | --- | --- | --- |
| Aarav Dental Arts, Bengaluru | Dental | Expected → Waiting → In chair → Billing | `?clinic=aarav-dental` |
| Anandi Mind & Wellness, Pune | Counselling | Expected → Quiet wait → In session → Closing | `?clinic=anandi-wellness` |
| Sushrut Family Polyclinic, Hyderabad | Polyclinic | Expected → Waiting → In consult → Billing | `?clinic=sushrut-polyclinic` |
| Drishti Eye Care, Chennai | Eye care | Expected → Waiting → **Dilating** → With doctor → Optical & bill | `?clinic=drishti-eye` |

You can also create a fifth. The directory has a **Set up a new practice** entry: five steps, a specialty picker, a patient import, and at the end a working workspace you can sign into.

Append `&as=<module>` to land directly in a role, for example `?clinic=aarav-dental&as=reception`. Modules are `reception`, `nurse`, `dental`, `therapy`, `recalls`, `practice`, `consultant`, `owner`, `patient`, plus `isolation`, `whatsapp`, `coverage`, `roadmap` and `system`.

The therapy vault demo PIN is **1234**.

### What is real and what is simulated

Real: the fee rules, the double-booking conflict checks, AES-256-GCM encryption of session notes with a PBKDF2-derived key, per-tenant data scoping, the append-only audit trail, and every layout.

Simulated: persistence (all state is in memory and resets on reload), payments, WhatsApp delivery, and the workspace directory, which is a constant rather than a database table.

## What is worth looking at first

**Tenant isolation.** The same mobile number is seeded into two workspaces as two unrelated records. At Aarav Dental that patient carries a penicillin allergy and an in-progress root canal; at Sushrut he is a first-time visitor with no alerts and no chart, and the follow-up fee rule returns a different answer for him on the same day. Both are correct. The Isolation panel also runs a live cross-workspace read, which returns zero rows rather than an authorization error — a denial would confirm the record exists.

**Mobile first.** The phone is the design target. Tablet and desktop add density, never capability. Layout follows the viewport by default and can be pinned per device to Compact, Tablet or Full from the header or the More sheet.

**Verticalization is structural.** The dental workspace has no therapy module and the counselling practice has no odontogram. They are not hidden in navigation; they are not provisioned.

**A vertical costs configuration, not code.** Drishti Eye Care was added to this prototype without a single line of ophthalmology-specific logic. Its dilation lane with a 20-minute dwell alert, its acuity and intraocular-pressure triage tiles, its diabetic retinopathy recall and its cataract package are all rows. `harness.js` fails the build if the word `vertical` ever appears in a conditional, which is what keeps the claim honest.

**The owner ledger states its own worth.** Rather than assert a return on investment, the product records one: every no-show prevented by a confirmed reminder, every deposit that converted, every dormant treatment plan resumed by a recall, each with the evidence reference that justifies it. On the dental workspace this comes to ₹17,300 a month against a ₹1,999 subscription. Directly beneath it sits the ABDM incentive at ₹105, computed under the April 2026 rates. The contrast is the argument.

**Recovery is only credited when it happens.** In the Recalls module, sending a reminder credits nothing. Marking the resulting booking is what writes a row into the recovered-revenue ledger, with the recall id attached as evidence. A number that cannot be traced back is a number an owner stops believing.

**Settlement has two sides.** The visiting consultant requests; the owner approves or disputes, line by line, and a dispute has to name a reason and carry a counter-offer the consultant can accept in one tap. Both parties read the same trail.

**Stock is batches, never a total.** A clinic that knows it holds nine vials but not that six expire on Friday will use them on a patient. Issue is first-expiry-first-out, expired lots are named and discarded against an audit entry, and the chairside console shows the lot it is about to consume.

## Building this

Production code does not exist yet. When it does, it gets built to a protocol rather than to taste, because several guarantees in the specification — tenant isolation, the append-only audit trail, the vault — are the only reason a clinic can be asked to put patient data in at all.

Start here, in this order:

1. **[AGENTS.md](AGENTS.md)** — the contract. Loaded automatically into every Cursor session. Source-of-truth order, the spec-driven and test-driven loops, the prohibition list, and when to stop and ask.
2. **[docs/plan/BUILD-PROTOCOL.md](docs/plan/BUILD-PROTOCOL.md)** — the long form. Bootstrap checklist, a worked example of the SDD loop, the four verification gates, and every milestone's exit criterion transcribed as a named acceptance test.
3. **[docs/plan/TRACEABILITY.md](docs/plan/TRACEABILITY.md)** — generated coverage of all 50 requirement ids.

Two rules carry most of the weight. **No code without a requirement id** — if the spec is silent or wrong, amend the spec first and log it in §0.1. And **no milestone is done until its acceptance test passes**, not when the code reads as though it should work.

```bash
./scripts/verify.sh            # lint, typecheck, tests, gates, layout, traceability
./scripts/verify.sh --fast     # same, minus the slow layout pass
```

On a clean checkout this **exits non-zero**, and that is correct: the traceability gate lists every requirement scheduled into M0 that no test claims yet. That red list is the starting to-do list. A build that were green before anything had been built would be telling you nothing.

## Repository layout

```
AGENTS.md                     the contract, auto-loaded by Cursor
.cursor/rules/                glob-scoped rules: tenancy, migrations, client, vault, tests
scripts/verify.sh             the single verification command
scripts/trace.py              requirement traceability gate
prototype/PractixOS.html      the prototype, one self-contained file
prototype/check-layout.py     layout regression check, headless Chrome
prototype/harness.js          logic harness, Node, no dependencies
docs/spec/Dr.App.txt          product specification, v2.2 (Markdown)
docs/spec/Dr.App.Spec.html    the same specification, indexed and searchable
docs/spec/build-spec-html.py  regenerates the HTML from the Markdown
docs/spec/Market-Opportunity-Corrections.md
                              corrections against the market analysis PDF
docs/spec/Market-Expansion-Thesis.md
                              why the market is larger than one subscription number
docs/pitch/                    investor one-pager
docs/plan/                    engineering plan, build protocol, traceability
docs/shots/                   review screenshots, phone and desktop
```

## Checks

**Layout**, across every view, every tenant and seven widths from 320 px to 1280 px — 630 screens, including the transient surfaces that only exist after a tap: the walk-in sheet, the vitals keypad, the print preview, the dispute sheet and all five onboarding steps. Asserts neither horizontal overflow nor collapsed content, and exits non-zero on failure. The tenant and module lists are parsed out of the prototype rather than restated here, so a new workspace is covered the moment it is added. Needs Chrome or Chromium; skips cleanly if neither is present.

```bash
python3 prototype/check-layout.py
python3 prototype/check-layout.py --shots docs/shots   # also refresh the screenshots
```

**Logic** — 786 assertions covering the render matrix, tenant isolation, the business rules, the DHIS accrual arithmetic, the recovered-revenue ledger, the configurable queue stages, the recall engine, the CSV import against a deliberately messy file, the printed artifacts, two-sided settlement, batch expiry, packages and proxy consent. Pure Node, no dependencies, no browser.

```bash
node prototype/harness.js
```

Regenerate the indexed specification after editing `Dr.App.txt`:

```bash
python3 docs/spec/build-spec-html.py
```

## Deployment

Static, no build step. `vercel.json` rewrites `/` to the prototype and `/spec` to the indexed specification.

## Status

Prototype and specification only. No production code, no database, no patient data.
