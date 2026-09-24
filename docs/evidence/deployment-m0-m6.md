# Deployment note — M0 through M6, local only

This is a local deployment record. Nothing here has been applied to OCI.
`docs/evidence/m0/terraform-apply.md` is still **NOT RUN**.
`docs/evidence/m5/abdm-certification.md` is **NOT GRANTED**.

`./scripts/verify.sh` is green with `current: M6`: 7 passed, 1 skipped, 0 failed.
The skipped step is the standalone client layout script. The same measurement
runs inside the verification gates, against the built client, and that gate
passed. Traceability covers every id scheduled from M0 through M6.
`FR-1.3` stays in Phase 2 and is not in the build.

The earlier checkpoint is [deployment-m0-m4.md](deployment-m0-m4.md).

## What is running

One Node process and one PostgreSQL database on the host port published by
Docker Compose (`55432`). Jobs are pg-boss inside that database, started from
`src/server.ts`, not from `buildApp()`. There is no Redis, no Kubernetes, no
API gateway, and no payment provider.

```bash
docker compose up -d postgres
```

Copy `.env.example` into the environment. `DATABASE_URL` is the migration
role. `APP_DATABASE_URL` is `app_rw`. Set `LOCAL_ADAPTER_SECRET` to any local
string or booking, messaging and calendar routes fail closed. Set
`VAULT_SERVER_SECRET_PATH` to a file outside the database. The vault will not
open without it, and the file must not be committed.

```bash
npx tsx src/server.ts
```

In `web/`:

```bash
npx vite --host 127.0.0.1 --port 5177
```

Set `VITE_API` to the API origin before starting Vite. The process that was
already bound to an older port does not have later routes. The copy opened
for this note is `http://localhost:5177/#/setup`, with the API on port 3120.

Create a clinic from that screen. The owner password the wizard uses in tests
is `correct horse battery` at `owner@<slug>.test`. A Mental health clinic is
the one that provisions the vault module. Dentistry does not.

WhatsApp, UPI and Google or Microsoft calendars are not called. The adapters
record a signed local dispatch, a UPI intent, or a masked calendar title.
The stored external title is exactly `Doctor Unavailable (External Sync)`.

## What each milestone contains

**M0.** Force row-level security, `withTenant` as the only application data
path, plain SQL migrations with a down, and the four gates: tenant isolation
on a pool of size 1, BR-02 under concurrency, vault non-recoverability, and
layout integrity. Layout is measured on `prototype/PractixOS.html` and on the
built client at seven widths. The 20-minute `terraform apply` transcript does
not exist. The weekly restore drill has a passing local transcript.

**M1.** Host-before-data, the onboarding wizard, five portal languages with
Konkani marked beta, OTP with a cap that falls back to a recorded SMS, slots
and the per-clinic follow-up window, deposits settled only by a signed webhook,
and the recovered-revenue ledger for `no_show_prevented` and `deposit_converted`.
CSV import is a dry run, one transaction, reversible. Staff passwords are
Argon2id. Better Auth was not added.

**M2.** Queue stages from the seed, walk-in with a per-practitioner token,
masked phone with audited unmask, vitals and alerts, and an offline desk
(Dexie, a service worker, a sync queue). A `clinical_note` sync op conflicts
and is not applied. `#/book` is the patient doorway and renders with no staff
token. Every other staff screen still requires a session. `#/setup` stays the
gate even when a token exists, so the offline test can still find
"Create clinic".

**M3.** FDI chart, the prototype's sitting protocols, lab dispatch only when
the work-order type's required fields are present, one `remake_avoided` row,
consultant membership with an explicit clinic switch, BR-03 settlement
(`requested` → `approved` → `paid`, or `disputed` on a line), and a browser
print sheet for A4 and A5. Charting routes exist only when the tenant's
modules include `charting`.

**M4.** Recall rules and a job that is a no-op the second time, packages with a
redemption trigger, first-expiry stock, proxy consent with independent
capabilities, and an ophthalmology tenant stood up from the seed. The same
work-order endpoint serves a dental restoration and an optical order. No code
branches on `clinics.vertical`.

**M5.** Owner ledger at `#/ledger`: monthly recovered total against the Clinic
Pro price (₹1,999), break-even at the third recovered no-show when the unit is
the ₹800 default, and a disclosed `valueSource` when the clinic overrides the
source. Cash handover against the day's settled UPI events, with the
difference explicit. A repeated payment webhook is still a no-op. Chair-minute
margin on minutes available and on minutes used; the two rates differ. DHIS
ledger with Corrigendum 7: Category 2 at ₹5, Category 1 at ₹10, KYC-only,
first 100 of the month earn nothing, Category 2 capped at 1 per ABHA per day
and 5 per month. The spec example accrues ₹1,525. Repricing changes the rate
and does not rebuild rows. Bundles are local structured records. There is no
JVM sidecar and no live NHA call. Token Radar estimates from the rolling
median, falls back to the slot length when history is thin, quotes a range
past 20 minutes, and sends a second message only when the estimate moves by
10 minutes or more. A later-arrival request swaps tokens with someone already
waiting. The care drip is a procedure-keyed template, three hours after an
extraction, in the patient's language. A mood reply is a message and does not
write a vault note. The breach runbook says a breach is reportable within the
statutory window and does not invent an hour count.

**M6.** Psychotherapy notes in `vault_notes` as AES-256-GCM ciphertext. The
key is Argon2id (`m = 64 MiB`, `t = 3`, `p = 1`) over the four-digit PIN
concatenated with the server secret. The PIN is not stored. The secret is the
file at `VAULT_SERVER_SECRET_PATH`, never a database column. There is no
administrator decrypt. Five wrong PINs lock further attempts. Every open and
every denial is appended to `audit_log`. Reception can read the patient's name
and payment flags and cannot unlock. SOAP text, the DSM-5 code and the scores
are inside the ciphertext. The Quiet Room shows the sealed PIN row, then the
four SOAP fields, the five DSM-5 codes from the prototype, and GAD-7 (0–21)
and PHQ-9 (0–27) totals. It re-seals after 10 minutes idle. The prototype's
on-screen "5 minutes" was not copied; FR-5.1 says 10. A weekly series is an
M4 package of N video sessions. Each session stays `prepaid = false` until the
existing settlement webhook, and a repeated webhook is a no-op.

## The client

`web/src/clinical.css` is the prototype's design system. The prototype file
was not edited. The shell is the workspace gate, the ink rail, and the phone
tab bar. Indic fonts are self-hosted subsets.

Screens wired to the API: setup and the short wizard, the patient doorway,
the reception board, the vitals slate, the chairside odontogram, the Quiet
Room, recalls, packages and stock, family consent, the consultant settlement,
the owner ledger, print, and a public token page at `#/radar`.

`#/radar` with no staff token is a doorway page ("Estimated entry"). The
median estimator itself is on the server. The public page does not yet call
`/api/portal/token/:id`.

Not on this client: the prototype's isolation, coverage and roadmap
explainers. Those are demonstration views in the prototype, not scheduled
product screens.

## How to see M5 and M6

1. Open `#/setup`, choose Dentistry, create the clinic, finish the wizard, then open `#/ledger`. An empty ledger is expected until recovered-revenue rows exist.
2. Create a second clinic with Mental health. Open `#/quiet`. The seal is the vault. The demo PIN used by the acceptance test is `1234`, but a clinic created from the screen has no note until one is saved after unlock.
3. Dentistry's Quiet Room says the workspace does not run a counselling service. That follows the module seed, not a `vertical` branch.
