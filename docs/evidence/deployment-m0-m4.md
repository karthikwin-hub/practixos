# Deployment note — M0 through M4, local only

This is a local deployment record. Nothing here has been applied to OCI.
`docs/evidence/m0/terraform-apply.md` is still **NOT RUN**.

`./scripts/verify.sh` was green with `current: M4` before the staff shell was
restyled. The offline floor test was re-run after that restyle and passed.
Traceability covers every id scheduled for M0, M1, M2, M3 and M4.
`FR-1.3` stays in Phase 2 and is not in the build.

## What is running

One Node process and one PostgreSQL database. Jobs are pg-boss inside that
database, started from `src/server.ts`, not from `buildApp()`. There is no
Redis, no separate worker, and no payment provider.

Locally:

```bash
docker compose up -d postgres
```

Copy `.env.example` into the environment. `DATABASE_URL` is the migration role.
`APP_DATABASE_URL` is `app_rw`. Set `LOCAL_ADAPTER_SECRET` to any local string
or the booking, messaging and calendar routes fail closed. Then:

```bash
npx tsx src/server.ts
```

In `web/`:

```bash
npx vite --host 127.0.0.1 --port 5176
```

Set `VITE_API` to the API origin. Open `http://127.0.0.1:5176/#/setup`.

WhatsApp, UPI and Google or Microsoft calendars are not called. The adapters
record a signed local dispatch, a UPI intent, or a masked calendar title.
The stored external title is exactly `Doctor Unavailable (External Sync)`.

## What each milestone contains

**M0.** Force row-level security, `withTenant` as the only application data
path, plain SQL migrations with a down, the four gates (tenant isolation on a
pool of size 1, BR-02 under concurrency, vault non-recoverability, layout
integrity). The layout gate still measures `prototype/PractixOS.html`, not the
React client. The 20-minute `terraform apply` transcript does not exist.

**M1.** Host-before-data, the onboarding wizard, five portal languages with
Konkani marked beta, OTP with a cap that falls back to a recorded SMS, slots
and the per-clinic follow-up window, deposits settled only by a signed webhook,
and the recovered-revenue ledger for `no_show_prevented` and `deposit_converted`.
CSV import is a dry run, one transaction, reversible. Staff sessions are
Argon2id. Better Auth was not added.

**M2.** Queue stages from the seed, walk-in with a per-practitioner token,
masked phone with audited unmask, vitals and alerts, and an offline desk
(Dexie, a service worker, a sync queue). A `clinical_note` sync op conflicts
and is not applied.

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

## The client

`web/src/clinical.css` is the prototype's design system, copied out of
`prototype/PractixOS.html`. The prototype file was not edited. The shell is
the workspace gate, the ink rail, and the phone tab bar.

Screens wired to the API: setup and the short wizard, the patient doorway,
the reception board, the vitals slate, the chairside odontogram, recalls,
packages and stock, family consent, the consultant settlement, and print.

Not on this client, because the server does not have them yet: Quiet Room,
the owner recovered-revenue dashboard, ABDM, and the prototype's isolation,
coverage and roadmap explainers.

## Questions still open

1. Payment service provider. Until one is named, `paid` on a settlement is a
   ledger transition and not a payout.
2. Konkani reviewer. The language is shipped as beta.
3. OCI tenancy in `ap-mumbai-1`, pay-as-you-go, so the M0 rebuild clause can
   be timed. Do not run that apply on Azure credits or anywhere outside India.
4. Pilot clinics. The plan asks for two dental practices and one mental-health
   practice by M2. Mental health itself is M6.
5. The layout gate still scores the prototype file. Should the next change
   point that gate at this client, now that a real shell exists?
6. The client wears the prototype's tokens and chrome. It is not a
   screen-for-screen port: the wizard is a short list of actions, the
   odontogram does not draw the prototype's tooth glyphs, and the nurse slate
   reuses the board. Say if that remaining gap should be closed before M5.
