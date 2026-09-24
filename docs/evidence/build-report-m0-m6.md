# Request versus build — M0 through M6

This report compares what was asked for with what is in the tree after
`current: M6`. The sources of the request are `docs/spec/Dr.App.txt`,
`docs/plan/IMPLEMENTATION-PLAN.md`, `docs/plan/BUILD-PROTOCOL.md`, and the
milestone plans that were implemented in order: M0, M1, M2, M3 then M4, the
prototype-faithful client, the M0–M4 handoff, M5, then M6.

`./scripts/verify.sh` is green at M6. Traceability says 71 of 71 scheduled
ids are claimed by a test. `FR-1.3` is defined and deliberately unscheduled.

## Milestone by milestone

| Asked | Built | Gap |
| --- | --- | --- |
| M0: four gates green before a business endpoint; `withTenant`; plain SQL; OCI `ap-mumbai-1`; restore drill; ABDM sandbox and WhatsApp templates started because of lead time | Isolation, BR-02, vault non-recoverability and layout gates run in CI. Migrations have a down. The host topology and the Mumbai region are in Terraform and Caddy config. A local restore drill has a passing transcript. | `terraform apply` is **NOT RUN**. ABDM sandbox and WhatsApp template submission are still unchecked in `docs/evidence/m0/lead-time.md`. No credentials were available. |
| M1: doorway, deposits, idempotent webhook, five languages, recovered-revenue capture for no-show and deposit | Booking, OTP, slots, follow-up window, signed webhook, ledger rows, CSV import, Argon2id staff passwords. | No live Meta or UPI call. The local adapter stands in. No payment provider was chosen. |
| M2: walk-in under 10 seconds, masked phone, vitals, offline floor | Walk-in, audited unmask, keypad vitals, Dexie plus a service worker. `#/book` is public. Other staff screens stay signed in. | The offline test's selectors were preserved on purpose (Create clinic, मराठी, Waiting Room, Vitals, Move to…). |
| M3: odontogram, lab order, settlement, print | FDI chart, sittings, conditional lab dispatch, two-sided settlement, A4/A5 print with the self-hosted fonts. | The chart is the production client, not a copy of the prototype's single file. Tooth glyphs are the states from the spec (colour, pattern, label), composed in the client. |
| M4: configuration instead of a vertical branch; ophthalmology without new code | Recalls, packages, FEFO stock, three-way proxy consent. Ophthalmology is a seed. A lint-level test rejects `clinics.vertical` branches. | Dermatology and paediatrics are named as later configuration exercises. They were not part of M4's exit. |
| The production client must look like `prototype/PractixOS.html` | Clinical Ink tokens, type scale, rail, tab bar, and the screens listed in the deployment note. The prototype file was not edited. | `#/radar` is the doorway layout with static copy. It does not yet show a live median for a token. The wizard is the short action list the API already had, not every prototype illustration. |
| M5: every rupee has evidence; cash versus UPI; two chair-minute rates; DHIS that reconciles; Token Radar; care drip; breach runbook; ABDM certificate | Acceptance tests `m5-every-rupee-has-evidence` and `m5-dhis-reconciles` pass. Owner screen `#/ledger`. Breach runbook names the statutory window and no hour count. | Certification is **NOT GRANTED**. Bundles are checked records, not a HAPI service. DEVIATION 3 is one Node process, so a JVM sidecar was refused. A clinic can mark the recovered-revenue source as its own; the substituted per-event amount is not a separate stored column. The ledger's break-even sentence says "3rd" by appending `rd` to the count. |
| M6: split-key Argon2id vault, SOAP and DSM-5, GAD-7/PHQ-9, weekly series on the M4 package engine, exit that a reviewer with the dump and the server secret cannot read a note | `acceptance/m6-vault-non-recoverable.test.ts` writes a note through the API, dumps the database, and fails to read it without the PIN. Reception is refused. The series stays unpaid until the existing webhook, and a repeat is a no-op. | The five DSM-5 codes are the prototype's list, not the whole manual. Scores are totals, not the copyrighted item stems. Re-lock is 10 minutes, as FR-5.1 says, not the prototype's 5. |

## What was explicitly not built

- `FR-1.3` natural-language matching. Moved to Phase 2 by revision 33. A test would have been a violation of the scope map.
- A payment service provider. Plan §8 leaves it open. Settlement `paid` records agreement, not a transfer.
- Production ABDM certification, a live gateway, and a HAPI FHIR process.
- A Konkani reviewer, an OCI tenancy apply, and named pilot clinics.
- An administrator path that decrypts a note without the PIN.

## Comments

The vault key is derived on the server for the duration of the unlock or save
request, then discarded. The PIN is not written to PostgreSQL, `localStorage`,
`sessionStorage`, or a cookie. The Quiet Room keeps the PIN in a ref until
the note is sealed or the 10-minute timer fires, because a later save has to
encrypt again. That is weaker than a key that never leaves the browser, and
it is the design the M0 gate already tests: `decryptNote` needs the PIN and
the server secret together, and neither factor alone works. A stolen database
still has no brute-forceable material.

Category 2 DHIS accrual matches the worked example `(450 × 0.90 − 100) × ₹5
= ₹1,525` for 405 KYC-verified bundles. The first 100 eligible transactions
of the month earn nothing. Repricing updates the rate row only.

The client layout gate now measures every route in `web/layout-screens.json`,
including `#/ledger` and `#/radar`, at 320, 375, 390, 414, 768, 1024 and
1280. The public token page used to render as the front desk whenever a staff
session existed, which made the board look unmeasured. It now stays on its
own route.

`printRoutes()` compresses a shared prefix, so the string `/vault` does not
appear even though `POST /api/vault/unlock` is registered. The route lock
asserts `unlock (POST)` for that reason.

## Open questions

1. Which payment provider settles UPI? Until one is named, webhooks are the local signed adapter.
2. Who reviews Konkani? It ships as beta.
3. When is there an OCI tenancy in `ap-mumbai-1`, pay-as-you-go, so the M0 rebuild can be timed? Do not run that apply on Azure credits or outside India.
4. Which two dental practices and which mental-health practice are the pilots?
5. Who holds the NHA sandbox credentials? Certification stays NOT GRANTED until they exist.
6. Should `#/radar` call the token estimator for a real appointment, or is the static doorway enough until a patient link is issued?
7. Should a clinic's substituted recovered-revenue amount be stored per event, or is disclosing `valueSource: clinic` enough?
8. Pull request #1 is the M0–M4 branch. This branch is the whole tree through M6. Say if #1 should be closed.
